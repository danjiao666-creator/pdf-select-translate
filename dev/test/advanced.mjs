import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchExtension, screenshot } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'dev/test/artifacts');
const downloads = path.join(artifacts, 'downloads');
const publishPreviews = process.env.UPDATE_PREVIEWS === '1';
await fs.mkdir(downloads, { recursive: true });
const requests = [];
let delay = 160, reject = false, active = 0, peak = 0;
const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (chunk) => { data += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(data), text = body.messages.find((m) => m.role === 'user').content;
    requests.push(text); active++; peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      if (reject) { res.writeHead(401); res.end('{}'); return; }
      const translated = text.includes('Retrieval-Augmented') ? '检索增强翻译' : text.includes('Introduction') ? '1. 引言' : text.includes('Methods') ? '2. 方法' : text.includes('Results and') ? '3. 结果与局限' : '本文评估科学文献的翻译质量，保留原始段落、图表和数值信息。';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: translated } }] })}\n\ndata: [DONE]\n\n`);
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: translated } }] })); }
    }, delay);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const harness = await launchExtension(root);
const { browser, id } = harness;
const origin = `chrome-extension://${id}/src/`;
const errors = [];
let count = 0;
async function check(name, action) {
  let timer;
  try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 30000); })]); }
  finally { clearTimeout(timer); }
  console.log(`PASS ${++count} ${name}`);
}
async function page(file = 'viewer.html') {
  const p = await browser.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.setViewport({ width: 1440, height: 1000 }); await p.goto(origin + file); await p.bringToFront(); return p;
}
async function documents(p) { return p.evaluate(async () => (await import('./library.mjs')).library.list().then((docs) => docs.map(({ data, ...rest }) => rest))); }
async function importPdf(p, file = 'academic.pdf') {
  await (await p.$('#fileInput')).uploadFile(path.join(root, 'dev/tests', file));
  await p.waitForSelector('.textLayer span');
  await p.waitForFunction((file) => !document.getElementById('fileInput').files.length && document.getElementById('docName').textContent === file && !document.getElementById('openFullTranslation').disabled, {}, file);
}
try {
  const options = await page('options.html');
  await options.evaluate((base) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { engine: 'auto', fastFirst: true, targetLang: 'zh-CN', custom: { baseUrl: `${base}/v1`, model: 'mock', apiKey: 'test-only' } } }), base);
  const viewer = await page();
  let documentId;
  await check('plain functional copy replaces decorative slogans', async () => {
    const text = await viewer.$eval('body', (e) => e.textContent);
    assert.ok(!/少一点打扰|多一点理解|让阅读|译文随之|思路不必/.test(text));
    await options.bringToFront(); assert.ok(!/少一点打扰|多一点理解|为专注阅读/.test(await options.$eval('body', (e) => e.textContent)));
    await viewer.bringToFront();
  });
  await check('local PDF imports a persistent copy with metadata', async () => {
    await importPdf(viewer);
    const rows = await documents(viewer); assert.equal(rows.length, 1); documentId = rows[0].id;
    assert.equal(rows[0].name, 'academic.pdf'); assert.equal(rows[0].numPages, 3);
    assert.ok(rows[0].size > 1000); assert.ok(viewer.url().includes(`document=${documentId}`));
  });
  await check('document analysis separates columns and preserves formulas/scans', async () => {
    await viewer.click('#openFullTranslation');
    assert.match(await viewer.$eval('#fullTranslationSummary', (e) => e.textContent), /3 页.*自定义 API/);
    delay = 500;
    await viewer.click('#startDocumentTranslation');
    await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('翻译中'));
    await viewer.click('#pauseDocumentTranslation');
    await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('已暂停'));
    const record = await viewer.evaluate(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('pdf-translation-library'); r.onsuccess = () => resolve(r.result); });
      const value = await new Promise((resolve) => { const r = db.transaction('translations').objectStore('translations').getAll(); r.onsuccess = () => resolve(r.result[0]); }); db.close(); return value;
    });
    assert.ok(record.total > 6); assert.equal(record.pages[2].blocks.length, 0);
    assert.equal(record.pages[1].blocks.find((b) => b.text.includes('x_i')).status, 'preserved');
    assert.ok(record.pages[0].blocks.some((b) => b.text.startsWith('Scientific translation') && !b.text.includes('We evaluate')));
    assert.ok(record.pages[0].blocks.some((b) => b.text.startsWith('We evaluate') && !b.text.includes('Scientific translation')));
  });
  await check('only one viewer can dispatch a document translation at a time', async () => {
    const blocker = await page(`viewer.html?document=${documentId}`);
    await blocker.waitForFunction(() => !document.getElementById('openFullTranslation').disabled);
    await blocker.evaluate(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('pdf-translation-library'); r.onsuccess = () => resolve(r.result); });
      const key = await new Promise((resolve) => { const r = db.transaction('translations').objectStore('translations').getAllKeys(); r.onsuccess = () => resolve(r.result[0]); }); db.close();
      window.lockReady = false;
      window.testLock = navigator.locks.request(`document-translation:${key}`, () => new Promise((resolve) => { window.releaseTranslationLock = resolve; window.lockReady = true; }));
      while (!window.lockReady) await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await viewer.bringToFront(); const before = requests.length;
    await viewer.click('#resumeDocumentTranslation');
    await viewer.waitForFunction(() => document.getElementById('toast').textContent.includes('另一阅读器'));
    assert.equal(requests.length, before);
    await blocker.evaluate(() => window.releaseTranslationLock()); await blocker.close(); await viewer.bringToFront();
  });
  await check('pause stops new dispatch; resume retains completed paragraphs with bounded concurrency', async () => {
    const before = requests.length; await new Promise((r) => setTimeout(r, 250)); assert.equal(requests.length, before);
    assert.ok(before <= 2); assert.ok(peak <= 2);
    delay = 80; await viewer.click('#resumeDocumentTranslation');
    await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成'));
    assert.ok(peak <= 2); assert.ok(!requests.some((text) => text.includes('x_i')));
    assert.equal(new Set(requests).size, requests.length);
  });
  await check('original, translated and side-by-side views preserve charts and geometry', async () => {
    await viewer.click('[data-mode="compare"]'); await viewer.waitForSelector('.original-reference canvas');
    await viewer.waitForSelector('.translation-hit');
    const layout = await viewer.evaluate(() => {
      const page = document.querySelector('.page[data-page="1"]'), translated = page.querySelector('.translation-layer canvas'), original = page.querySelector(':scope > canvas');
      const scale = original.width / 612;
      const pixel = (canvas) => [...canvas.getContext('2d').getImageData(Math.round(120 * scale), Math.round(400 * scale), 1, 1).data];
      return { original: pixel(original), translated: pixel(translated), references: document.querySelectorAll('.original-reference').length, hits: page.querySelectorAll('.translation-hit').length, overlayWidth: translated.width, pageWidth: original.width };
    });
    assert.deepEqual(layout.translated, layout.original); assert.ok(layout.hits >= 4); assert.ok(layout.references > 0); assert.equal(layout.overlayWidth, layout.pageWidth);
    await viewer.waitForFunction(() => document.getElementById('toast').hidden);
    await screenshot(viewer, path.join(artifacts, 'advanced-compare.png'));
    if (publishPreviews) await fs.copyFile(path.join(artifacts, 'advanced-compare.png'), path.join(root, 'docs/full-translation.png'));
    await viewer.click('[data-mode="original"]'); assert.equal(await viewer.$('.translation-layer'), null);
    await viewer.click('[data-mode="translated"]'); await viewer.waitForSelector('.translation-hit');
    await viewer.click('.translation-hit'); await viewer.waitForSelector('#paragraphDialog[open]');
    assert.ok((await viewer.$eval('#paragraphTranslation', (e) => e.textContent)).length > 0);
    await viewer.keyboard.press('Escape');
  });
  await check('translations and reading position survive a fresh viewer page without API requests', async () => {
    await viewer.click('#pageInput', { clickCount: 3 }); await viewer.type('#pageInput', '2'); await viewer.keyboard.press('Enter');
    await viewer.waitForFunction(() => document.getElementById('pageInput').value === '2');
    await viewer.click('#openLibrary'); await viewer.waitForSelector('.library-row');
    assert.match(await viewer.$eval('.library-document small', (e) => e.textContent), /第 2 页/);
    await screenshot(viewer, path.join(artifacts, 'advanced-library.png'));
    if (publishPreviews) await fs.copyFile(path.join(artifacts, 'advanced-library.png'), path.join(root, 'docs/library.png'));
    const before = requests.length;
    const fresh = await page(`viewer.html?document=${documentId}`);
    await fresh.waitForFunction(() => document.getElementById('pageInput').value === '2' && document.getElementById('documentTranslationStatus').textContent.includes('已完成'));
    assert.equal(requests.length, before); await fresh.close(); await viewer.bringToFront();
    await viewer.click('.library-document'); await viewer.waitForFunction(() => document.body.dataset.view === 'reader');
  });
  await check('PDF export keeps page count, dimensions and rasterized Chinese output', async () => {
    const session = await browser.target().createCDPSession();
    await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await viewer.click('#exportTranslatedPdf'); await viewer.click('#confirmExport');
    await viewer.waitForFunction(() => document.getElementById('exportStatus').textContent.includes('已生成'));
    const filename = path.join(downloads, 'academic-zh-CN.pdf');
    for (let i = 0; i < 50; i++) { try { await fs.access(filename); break; } catch (_) { await new Promise((r) => setTimeout(r, 100)); } }
    const bytes = await fs.readFile(filename);
    const result = await viewer.evaluate(async (bytes) => {
      const lib = await import('../vendor/pdf.min.mjs'); const pdf = await lib.getDocument({ data: new Uint8Array(bytes) }).promise;
      const first = await pdf.getPage(1), viewport = first.getViewport({ scale: 1 });
      const canvas = document.createElement('canvas'); canvas.width = viewport.width; canvas.height = viewport.height;
      await first.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const result = { count: pdf.numPages, width: viewport.width, height: viewport.height, image: canvas.toDataURL('image/png'), textItems: (await first.getTextContent()).items.length };
      await pdf.destroy(); return result;
    }, [...bytes]);
    assert.equal(result.count, 3); assert.equal(result.width, 612); assert.equal(result.height, 792); assert.equal(result.textItems, 0);
    await fs.writeFile(path.join(artifacts, 'advanced-export.png'), Buffer.from(result.image.split(',')[1], 'base64'));
    await viewer.keyboard.press('Escape'); await session.detach();
  });
  await check('importing the same bytes twice does not duplicate a library document', async () => {
    await importPdf(viewer); assert.equal((await documents(viewer)).length, 1);
  });
  await check('language changes use a separate translation cache and restore the previous one', async () => {
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { targetLang: 'en' } }));
    await viewer.waitForFunction(() => document.getElementById('targetLang').value === 'en' && document.getElementById('documentTranslationBar').hidden);
    assert.equal(await viewer.$eval('body', (e) => e.dataset.documentMode), 'original');
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { targetLang: 'zh-CN' } }));
    await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成') && !document.getElementById('documentTranslationBar').hidden);
  });
  await check('document search filters names and restores rows', async () => {
    await viewer.click('#openLibrary'); await viewer.waitForSelector('#librarySearch', { visible: true });
    await viewer.click('#librarySearch'); await viewer.keyboard.down('Control'); await viewer.keyboard.press('a'); await viewer.keyboard.up('Control');
    await viewer.type('#librarySearch', 'missing-document');
    await viewer.waitForFunction(() => document.querySelectorAll('.library-row').length === 0);
    await viewer.click('#librarySearch'); await viewer.keyboard.down('Control'); await viewer.keyboard.press('a'); await viewer.keyboard.up('Control');
    await viewer.keyboard.press('Backspace'); await viewer.type('#librarySearch', 'academic');
    await viewer.waitForSelector('.library-row');
    await viewer.click('#librarySearch'); await viewer.keyboard.down('Control'); await viewer.keyboard.press('a'); await viewer.keyboard.up('Control'); await viewer.keyboard.press('Backspace');
  });
  await check('library and translation controls fit a narrow window', async () => {
    await viewer.setViewport({ width: 390, height: 844 });
    assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot(viewer, path.join(artifacts, 'advanced-library-mobile.png'));
    await viewer.click('.library-document'); await viewer.waitForFunction(() => document.body.dataset.view === 'reader');
    const bounds = await viewer.evaluate(() => [...document.querySelectorAll('.toolbar button')].filter((b) => b.getClientRects().length).map((b) => ({ left: b.getBoundingClientRect().left, right: b.getBoundingClientRect().right })));
    assert.ok(bounds.every((b) => b.left >= 0 && b.right <= 390));
    await screenshot(viewer, path.join(artifacts, 'advanced-reader-mobile.png'));
  });
  await check('deleting a library document also deletes its persistent translations', async () => {
    await viewer.click('#openLibrary'); viewer.once('dialog', (dialog) => dialog.accept());
    await viewer.waitForSelector('.library-row', { visible: true });
    await viewer.click('.library-row > button.quiet');
    await viewer.waitForFunction(() => document.querySelectorAll('.library-row').length === 0);
    assert.equal((await documents(viewer)).length, 0);
    const remaining = await viewer.evaluate(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('pdf-translation-library'); r.onsuccess = () => resolve(r.result); });
      const result = await new Promise((resolve) => { const r = db.transaction('translations').objectStore('translations').count(); r.onsuccess = () => resolve(r.result); }); db.close(); return result;
    });
    assert.equal(remaining, 0);
  });
  await check('authentication failures stop the queue without producing fake completion', async () => {
    await viewer.setViewport({ width: 1440, height: 1000 }); await importPdf(viewer);
    await options.evaluate((base) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { custom: { baseUrl: `${base}/alternate/v1` } } }), base);
    await viewer.waitForFunction(() => document.getElementById('documentTranslationBar').hidden);
    reject = true; const before = requests.length;
    await viewer.click('#openFullTranslation'); await viewer.click('#startDocumentTranslation');
    await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('失败'));
    assert.ok(requests.length - before <= 2);
    assert.equal(await viewer.$eval('#exportTranslatedPdf', (e) => e.disabled), true);
    reject = false; await viewer.click('#resumeDocumentTranslation');
    await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成'));
  });
  await check('password PDFs reopen from the library without saving their password', async () => {
    viewer.once('dialog', (dialog) => dialog.accept('reader-test'));
    await importPdf(viewer, 'protected.pdf');
    const rows = await documents(viewer), encrypted = rows.find((r) => r.name === 'protected.pdf');
    assert.ok(encrypted); assert.ok(!JSON.stringify(encrypted).includes('reader-test'));
    const fresh = await browser.newPage(); fresh.on('pageerror', (e) => errors.push(e.message));
    let prompts = 0; fresh.on('dialog', async (dialog) => { prompts++; await dialog.accept('reader-test'); });
    await fresh.goto(origin + `viewer.html?document=${encrypted.id}`); await fresh.bringToFront();
    await fresh.waitForSelector('.textLayer span'); assert.equal(prompts, 1); await fresh.close(); await viewer.bringToFront();
  });
  await check('all advanced flows complete without uncaught frontend errors', async () => assert.deepEqual(errors, []));
  console.log(`\nAdvanced: ${count}/${count} passed`);
} finally {
  await harness.cleanup(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
