import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchExtension, screenshot } from './browser.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const artifacts = path.join(here, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const input = 'The quick brown fox jumps over the lazy dog.';
const translated = '敏捷的棕色狐狸跳过了那只懒狗。';
let calls = 0;
const server = http.createServer((req, res) => {
  if (['/sample.pdf', '/protected.pdf', '/multipage.pdf'].includes(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/pdf' });
    res.end(fs.readFileSync(path.join(root, 'dev/tests', req.url.slice(1)))); return;
  }
  if (req.method === 'POST') {
    calls++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/reject/')) { res.writeHead(401); res.end('{}'); return; }
      const payload = JSON.parse(body);
      const text = payload.messages.find((m) => m.role === 'user').content;
      const result = text === input ? translated : `译文：${text}`;
      if (!payload.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: result } }] })); return; }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const parts = result.match(/[\s\S]{1,4}/g) || [];
      let i = 0;
      const timer = setInterval(() => {
        if (i < parts.length) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] })}\n\n`);
        else { clearInterval(timer); res.end('data: [DONE]\n\n'); }
      }, 30);
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body style="font:20px/2 Georgia;margin:80px"><p id="sentence">${input} A second sentence follows.</p><p id="inline">The <em>quick brown fox</em> jumps over the lazy dog.</p></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const harness = await launchExtension(root);
const { browser, id } = harness;
const origin = `chrome-extension://${id}/src/`;
const errors = [];
let count = 0;
async function check(name, fn) {
  let timer;
  try { await Promise.race([fn(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timeout: ${name}`)), 20000); })]); }
  finally { clearTimeout(timer); }
  count++; console.log(`PASS ${count} ${name}`);
}
async function makePage(file, viewport = { width: 1280, height: 900 }) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.setViewport(viewport); await p.goto(origin + file); await p.bringToFront(); return p;
}
async function selectText(page, text, needle) {
  await page.evaluate(({ text, needle }) => {
    const span = [...document.querySelectorAll('.textLayer span')].find((s) => s.textContent.includes(text));
    const i = span.textContent.indexOf(needle); const range = document.createRange();
    range.setStart(span.firstChild, i); range.setEnd(span.firstChild, i + needle.length);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, { text, needle });
}
try {
  const options = await makePage('options.html');
  await options.evaluate(async (base) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { engine: 'custom', targetLang: 'zh-CN', autoTranslate: true, sentenceMode: true, fastFirst: false, custom: { baseUrl: `${base}/v1`, model: 'mock', apiKey: 'test-only' } } }), base);
  const viewerFile = `viewer.html?file=${encodeURIComponent(`${base}/sample.pdf`)}`;
  const viewer = await makePage(viewerFile);
  await viewer.waitForSelector('.textLayer span');
  await check('PDF text geometry matches the rendered width', async () => {
    const ratios = await viewer.evaluate(() => [...document.querySelectorAll('.textLayer span')].map((s) => s.getBoundingClientRect().width / Number(s.dataset.tw)));
    for (const ratio of ratios) assert.ok(Math.abs(ratio - 1) < .015, String(ratio));
  });
  await check('rapid repeated zoom always rerenders the visible page', async () => {
    for (let i = 0; i < 4; i++) {
      await viewer.evaluate(() => { document.getElementById('zoomIn').click(); document.getElementById('zoomIn').click(); document.getElementById('zoomOut').click(); });
      await viewer.waitForSelector('.textLayer span', { timeout: 10000 });
    }
    await viewer.click('#fitWidth'); await viewer.waitForSelector('.textLayer span');
  });
  await check('multiline sentence keeps word separators', async () => {
    for (const [line, word] of [['Second paragraph:', 'select'], ['translation card', 'card']]) {
      await viewer.evaluate(() => document.getElementById('cardClose').click());
      await selectText(viewer, line, word);
      await viewer.waitForFunction(() => !document.getElementById('card').hidden);
      const source = await viewer.$eval('#cardSrc', (e) => e.textContent);
      assert.match(source, /^Second paragraph:/); assert.match(source, /the translation card/);
      assert.ok(!source.includes('thetranslation'));
    }
    await selectText(viewer, 'quick brown fox', input);
    await viewer.waitForFunction((expected) => document.getElementById('cardSrc').textContent === expected, {}, input);
  });
  await check('actual mouse selection translates the complete sentence', async () => {
    await viewer.click('#cardClose');
    const points = await viewer.evaluate(() => {
      getSelection().removeAllRanges();
      const s = [...document.querySelectorAll('.textLayer span')].find((s) => s.textContent.includes('quick brown fox'));
      const n = s.firstChild, i = n.textContent.indexOf('fox'); const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 9); const b = r.getBoundingClientRect();
      return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 };
    });
    await viewer.mouse.move(points.x1, points.y); await viewer.mouse.down(); await viewer.mouse.move(points.x2, points.y, { steps: 12 }); await viewer.mouse.up();
    await viewer.waitForFunction((expected) => document.getElementById('cardOut').textContent === expected, {}, translated);
    assert.equal(await viewer.$eval('#cardSrc', (e) => e.textContent), input);
    await screenshot(viewer, path.join(artifacts, 'reader-redesign.png'));
  });
  await check('retry bypasses cached translation', async () => {
    const before = calls;
    await viewer.click('#cardRetry');
    await viewer.waitForFunction(() => !document.getElementById('cardBadge').textContent.includes('生成中') && !document.getElementById('cardOut').textContent.includes('正在请求'));
    assert.ok(calls > before);
  });
  await check('reader immediately follows language and font settings', async () => {
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { targetLang: 'en', cardFontSize: 22 } }));
    await viewer.waitForFunction(() => document.getElementById('targetLang').value === 'en');
    assert.equal(await viewer.$eval('#cardOut', (e) => getComputedStyle(e).fontSize), '22px');
    assert.equal(await viewer.$eval('#card', (e) => e.hidden), true);
  });
  await check('manual mode shows a translation button and respects dismissal', async () => {
    await options.evaluate(() => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { autoTranslate: false, targetLang: 'zh-CN', cardFontSize: 15 } }));
    await sleep(100); await selectText(viewer, 'quick brown fox', 'fox');
    await viewer.waitForFunction(() => [...document.querySelectorAll('body > button')].some((b) => b.textContent === '译' && b.style.display !== 'none'));
    const button = await viewer.$('body > button'); await button.click();
    await viewer.waitForFunction(() => !document.getElementById('card').hidden);
    await viewer.keyboard.press('Escape');
    await sleep(250); assert.equal(await viewer.$eval('#card', (e) => e.hidden), true);
  });
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { autoTranslate: true } }));
  await check('webpage first sentence expands across inline elements', async () => {
    const web = await browser.newPage(); web.on('pageerror', (e) => errors.push(e.message)); await web.goto(base);
    await web.waitForSelector('#pt-selection-host'); await sleep(100);
    for (const id of ['sentence', 'inline']) {
      await web.evaluate((id) => {
        const p = document.getElementById(id); const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let n;
        while ((n = walker.nextNode())) { const i = n.textContent.indexOf('fox'); if (i < 0) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 3); getSelection().removeAllRanges(); getSelection().addRange(r); break; }
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, id);
      await web.waitForFunction((expected) => document.getElementById('pt-selection-host').shadowRoot.querySelector('.pt-src').textContent === expected, {}, input);
    }
    await web.evaluate((input) => {
      document.getElementById('pt-selection-host').shadowRoot.querySelector('[data-act="close"]').click();
      const node = document.getElementById('sentence').firstChild; const r = document.createRange();
      r.setStart(node, 0); r.setEnd(node, input.length);
      getSelection().removeAllRanges(); getSelection().addRange(r);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, input);
    await web.waitForFunction(() => document.getElementById('pt-selection-host').shadowRoot.querySelector('.pt-card').style.display !== 'none');
    assert.equal(await web.evaluate(() => document.getElementById('pt-selection-host').shadowRoot.querySelector('.pt-src').textContent), input);
    await web.close();
  });
  await check('custom API test rejects bad credentials without free fallback', async () => {
    await options.evaluate((base) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { custom: { baseUrl: `${base}/reject/v1` } } }), base);
    const r = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'testTranslate', engine: 'custom', text: 'Check credentials.' }));
    assert.equal(r.ok, false); assert.match(r.error, /401/);
    await options.evaluate((base) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { custom: { baseUrl: `${base}/v1` } } }), base);
  });
  await check('settings never expose saved credentials or overwrite them on unrelated edits', async () => {
    await options.bringToFront();
    await options.reload(); await options.waitForFunction(() => document.getElementById('customApiKey').placeholder.includes('已配置'));
    assert.equal(await options.$eval('#customApiKey', (e) => e.value), '');
    await options.select('#targetLang', 'ja'); await sleep(150);
    const state = await options.evaluate(async () => {
      const r = await chrome.runtime.sendMessage({ type: 'getSettings' });
      const { settings } = await chrome.storage.local.get('settings');
      return { exposed: r.settings.custom.apiKey, preserved: settings.custom.apiKey === 'test-only' };
    });
    assert.equal(state.exposed, ''); assert.equal(state.preserved, true);
    await options.select('#targetLang', 'zh-CN'); await sleep(150);
    await options.waitForFunction(() => !document.getElementById('status').textContent);
    await screenshot(options, path.join(artifacts, 'settings-redesign.png'), true);
  });
  await check('popup clipboard uses final translation and shows compact defaults', async () => {
    const popup = await makePage('popup.html', { width: 360, height: 900 });
    await popup.evaluate(() => Object.defineProperty(navigator.clipboard, 'readText', { value: async () => 'The quick brown fox jumps over the lazy dog.', configurable: true }));
    await popup.click('#translateClip');
    await popup.waitForFunction((expected) => document.getElementById('clipResult').textContent.includes(expected), {}, translated);
    assert.equal(await popup.$eval('.quick-settings', (e) => e.open), false);
    await screenshot(popup, path.join(artifacts, 'popup-redesign.png'));
    await popup.close();
  });
  await check('local PDF upload renders without network access to the document', async () => {
    const local = await makePage('viewer.html');
    await local.$eval('#fileInput', (e) => { e.hidden = false; });
    const fileInput = await local.$('#fileInput'); await fileInput.uploadFile(path.join(root, 'dev/tests/sample.pdf'));
    await local.waitForSelector('.textLayer span');
    assert.equal(await local.$eval('#openOriginal', (e) => e.hidden), true);
    await local.close();
  });
  await check('password-protected PDF prompts and renders after authentication', async () => {
    const protectedPage = await browser.newPage();
    protectedPage.on('pageerror', (e) => errors.push(e.message));
    let prompts = 0;
    protectedPage.on('dialog', async (dialog) => { prompts++; await dialog.accept('reader-test'); });
    await protectedPage.goto(origin + `viewer.html?file=${encodeURIComponent(`${base}/protected.pdf`)}`);
    await protectedPage.bringToFront();
    await protectedPage.waitForSelector('.textLayer span');
    assert.equal(prompts, 1); await protectedPage.close();
  });
  await check('multipage navigation and zoom preserve the current page', async () => {
    const multi = await makePage(`viewer.html?file=${encodeURIComponent(`${base}/multipage.pdf`)}`);
    await multi.waitForSelector('.textLayer span');
    await multi.click('#pageInput', { clickCount: 3 }); await multi.type('#pageInput', '3'); await multi.keyboard.press('Enter');
    await multi.waitForSelector('.page[data-page="3"] .textLayer span');
    await multi.waitForFunction(() => document.getElementById('pageInput').value === '3');
    await multi.click('#zoomIn');
    await multi.waitForSelector('.page[data-page="3"] .textLayer span');
    await sleep(100);
    assert.equal(await multi.$eval('#pageInput', (e) => e.value), '3');
    await multi.close();
  });
  await check('narrow reader and settings have no clipped controls', async () => {
    await viewer.bringToFront();
    await viewer.setViewport({ width: 390, height: 844 });
    await viewer.click('.translation-menu summary');
    const layout = await viewer.evaluate(() => {
      const rect = document.querySelector('.preference-panel').getBoundingClientRect();
      return { doc: document.documentElement.scrollWidth, width: innerWidth, left: rect.left, right: rect.right, toolbar: document.querySelector('.toolbar').getBoundingClientRect().height };
    });
    assert.ok(layout.doc <= layout.width); assert.ok(layout.left >= 0 && layout.right <= 390); assert.ok(layout.toolbar < 175);
    await screenshot(viewer, path.join(artifacts, 'reader-mobile.png'));
    await options.setViewport({ width: 390, height: 844 });
    assert.ok(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await screenshot(options, path.join(artifacts, 'settings-mobile.png'));
  });
  await check('dark theme remains readable', async () => {
    await viewer.bringToFront();
    await viewer.setViewport({ width: 1280, height: 900 }); await viewer.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await viewer.click('.translation-menu summary');
    await screenshot(viewer, path.join(artifacts, 'reader-dark.png'));
    const theme = await viewer.evaluate(() => getComputedStyle(document.body).getPropertyValue('--ink').trim());
    assert.equal(theme, '#e5ece3');
  });
  const empty = await makePage('viewer.html'); await sleep(500); await screenshot(empty, path.join(artifacts, 'reader-empty.png'));
  await check('no uncaught frontend errors', async () => assert.deepEqual(errors, []));
  console.log(`\nRegression: ${count}/${count} passed`);
} finally {
  await harness.cleanup(); server.closeAllConnections(); await new Promise((r) => server.close(r));
}
