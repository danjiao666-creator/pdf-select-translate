import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchExtension, screenshot } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Optional live test; never put the local key in source, logs, or the extension snapshot.
const config = JSON.parse(await fs.readFile(path.join(root, 'config.local.json'), 'utf8'));
const engine = process.env.REAL_TRANSLATION_ENGINE || 'custom';
const input = process.env.REAL_TRANSLATION_PDF ? path.resolve(process.env.REAL_TRANSLATION_PDF) : path.join(root, 'dev/tests/academic.pdf');
const outputName = `${path.basename(input).replace(/\.pdf$/i, '')}-zh-CN.pdf`;
const artifacts = path.join(root, 'dev/test/artifacts');
const downloads = path.join(artifacts, 'real-downloads');
await fs.mkdir(downloads, { recursive: true });
const harness = await launchExtension(root);
const { browser, id } = harness;
const origin = `chrome-extension://${id}/src/`;
try {
  const options = await browser.newPage(); await options.goto(origin + 'options.html');
  const saved = await options.evaluate(({ custom, engine }) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { engine, fastFirst: true, targetLang: 'zh-CN', custom } }), {
    engine, custom: { baseUrl: config.baseUrl || 'https://api.deepseek.com/v1', model: config.model || 'deepseek-chat', apiKey: engine === 'custom' ? config.apiKey : '' }
  });
  assert.equal(saved.ok, true);
  const viewer = await browser.newPage(); await viewer.setViewport({ width: 1440, height: 1000 });
  await viewer.goto(origin + 'viewer.html'); await viewer.bringToFront();
  await (await viewer.$('#fileInput')).uploadFile(input);
  await viewer.waitForFunction(() => !document.getElementById('openFullTranslation').disabled);
  await viewer.click('#openFullTranslation');
  const started = Date.now(); await viewer.click('#startDocumentTranslation');
  await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成') || document.getElementById('documentTranslationStatus').textContent.includes('失败'), { timeout: 600000 });
  const result = await viewer.$eval('#documentTranslationStatus', (e) => e.textContent);
  if (!result.includes('已完成')) {
    const errors = await viewer.evaluate(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('pdf-translation-library'); r.onsuccess = () => resolve(r.result); });
      const rows = await new Promise((resolve) => { const r = db.transaction('translations').objectStore('translations').getAll(); r.onsuccess = () => resolve(r.result); }); db.close();
      return rows.flatMap((row) => row.pages.flatMap((p) => p.blocks.filter((b) => b.error).map((b) => ({ source: b.text, error: b.error }))));
    });
    console.log('Provider errors:', JSON.stringify(errors).replaceAll(config.apiKey, '[redacted]'));
  }
  assert.ok(result.includes('已完成'), result);
  console.log(`Live document translation (${engine}): ${Date.now() - started} ms; ${result}`);
  const docs = await viewer.evaluate(async () => {
    const { library } = await import('./library.mjs');
    return (await library.list()).map(({ data, ...metadata }) => metadata);
  });
  assert.equal(docs.length, 1); assert.equal(docs[0].translation.done, docs[0].translation.total);
  await viewer.click('[data-mode="compare"]'); await viewer.waitForSelector('.original-reference canvas'); await viewer.waitForSelector('.translation-hit');
  if (process.env.REAL_PREVIEW_PAGE) {
    await viewer.$eval('#pageInput', (e, value) => { e.value = value; }, process.env.REAL_PREVIEW_PAGE);
    await viewer.focus('#pageInput'); await viewer.keyboard.press('Enter');
  }
  await screenshot(viewer, path.join(artifacts, 'live-full-translation.png'));
  if (process.env.UPDATE_PREVIEWS === '1') await fs.copyFile(path.join(artifacts, 'live-full-translation.png'), path.join(root, 'docs/full-translation.png'));
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await viewer.click('#exportTranslatedPdf'); await viewer.click('#confirmExport');
  await viewer.waitForFunction(() => document.getElementById('exportStatus').textContent.includes('已生成'), { timeout: 60000 });
  for (let i = 0; i < 100; i++) { try { await fs.access(path.join(downloads, outputName)); break; } catch (_) { await new Promise((resolve) => setTimeout(resolve, 100)); } }
  assert.ok((await fs.stat(path.join(downloads, outputName))).size > 10000);
  await viewer.keyboard.press('Escape');
  await viewer.click('#openLibrary'); await viewer.waitForSelector('.library-row', { visible: true });
  await screenshot(viewer, path.join(artifacts, 'live-library.png'));
  if (process.env.UPDATE_PREVIEWS === '1') await fs.copyFile(path.join(artifacts, 'live-library.png'), path.join(root, 'docs/library.png'));
  const before = Date.now(); await viewer.reload(); await viewer.bringToFront();
  await viewer.waitForSelector('.library-row', { visible: true });
  await viewer.click('.library-document');
  await viewer.waitForFunction(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成'));
  console.log(`Persistent library reopen: ${Date.now() - before} ms; saved final translation restored`);
  console.log('PASS live full-document translation, PDF export, and persistent library reopen');
  await session.detach();
} finally { await harness.cleanup(); }
