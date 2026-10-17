import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchExtension } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-document-storage-'));
const downloads = path.join(temporary, 'downloads');
await fs.mkdir(downloads);
let holdResponses = true;
const waitingResponses = [];
const server = http.createServer((request, response) => {
  let text = '';
  request.on('data', (chunk) => { text += chunk; });
  request.on('end', () => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    let body;
    try { body = JSON.parse(text); } catch (_) { response.writeHead(400); response.end(); return; }
    const answer = () => {
      if (response.destroyed) return;
      const content = '研究结果表明，风险指标的变化能够解释实验结果。';
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
      }
    };
    if (holdResponses) waitingResponses.push(answer); else answer();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const harness = await launchExtension(root);
const { browser, id } = harness;
const origin = `chrome-extension://${id}/src/`;
const errors = [];
let count = 0;
let viewer;
const check = async (name, action) => {
  let timer;
  try {
    await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 30000); })]);
  } catch (error) {
    if (viewer && !viewer.isClosed()) console.error(await viewer.evaluate(() => ({
      name: document.getElementById('docName')?.textContent,
      view: document.body.dataset.view,
      status: document.getElementById('documentTranslationStatus')?.textContent,
      error: document.getElementById('libraryError')?.textContent,
      dialogs: [...document.querySelectorAll('dialog[open]')].map((element) => element.id)
    })).catch(() => ({})));
    throw error;
  } finally { clearTimeout(timer); }
  console.log(`PASS ${++count} ${name}`);
};
const wait = (fn, ...args) => viewer.waitForFunction(fn, { polling: 50, timeout: 25000 }, ...args);
const currentName = (name) => wait((name) => document.body.dataset.view === 'reader' && document.getElementById('docName').textContent === name && !document.getElementById('openFullTranslation').disabled, name);
async function nativeOpen(filename) {
  const encoded = (await fs.readFile(path.join(root, 'dev/tests', filename))).toString('base64');
  await viewer.evaluate(({ filename, encoded }) => {
    const data = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)).buffer;
    window.dispatchEvent(new CustomEvent('desktop-open-pdf', { detail: { name: filename, data } }));
  }, { filename, encoded });
}
async function inputOpen(filename) {
  await (await viewer.$('#fileInput')).uploadFile(path.join(root, 'dev/tests', filename));
  await currentName(filename);
  await wait(() => !document.getElementById('fileInput').files.length);
}
async function storedTranslations(documentId) {
  return viewer.evaluate(async (documentId) => (await (await import('./library.mjs')).library.snapshot()).translations.filter((record) => record.documentId === documentId), documentId);
}
async function staleDialog(name, open) {
  if (await viewer.$eval('#docName', (element) => element.textContent) !== 'sample.pdf') await nativeOpen('sample.pdf');
  await currentName('sample.pdf');
  await open();
  assert.equal(await viewer.$eval(`#${name}`, (dialog) => dialog.open), true);
  await nativeOpen('multipage.pdf'); await currentName('multipage.pdf');
  assert.equal(await viewer.$eval(`#${name}`, (dialog) => dialog.open), false);
}

try {
  viewer = await browser.newPage();
  viewer.on('pageerror', (error) => errors.push(error.message));
  // Exercise the shared native-close callback without exposing native IPC or touching user data.
  // The real executable's sandbox, IPC, password and close behavior have their own smoke suite.
  await viewer.evaluateOnNewDocument(() => {
    window.desktopBridge = {
      isDesktop: true,
      onBeforeClose(callback) { window.testBeforeClose = callback; },
      ready() { window.testReaderReady = true; }
    };
    window.testDownloads = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (...args) {
      if (this.download) window.testDownloads.push(this.download);
      return click.apply(this, args);
    };
  });
  await viewer.setViewport({ width: 1440, height: 1000 });
  await viewer.goto(origin + 'viewer.html'); await viewer.bringToFront();
  await wait(() => window.testReaderReady && typeof window.testBeforeClose === 'function');
  const cdp = await viewer.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const settings = await viewer.evaluate((baseUrl) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: {
    engine: 'custom', targetLang: 'zh-CN', sourceLang: 'en', fastFirst: false,
    custom: { baseUrl, model: 'controlled-storage-test', apiKey: 'test-only-not-a-real-key' }
  } }), `http://127.0.0.1:${server.address().port}/v1`);
  assert.equal(settings.ok, true);
  await inputOpen('sample.pdf');
  const documentId = new URL(viewer.url()).searchParams.get('document');
  assert.ok(documentId);

  await check('full translation remains visible when completed output cannot be persisted', async () => {
    await viewer.click('#openFullTranslation'); await viewer.click('#startDocumentTranslation');
    await wait(() => document.getElementById('documentTranslationStatus').textContent.includes('翻译中'));
    await viewer.evaluate(async () => {
      const { library } = await import('./library.mjs');
      window.testSaveTranslation = library.saveTranslation;
      library.saveTranslation = async () => { throw new DOMException('controlled quota failure', 'QuotaExceededError'); };
    });
    holdResponses = false;
    for (const answer of waitingResponses.splice(0)) answer();
    await wait(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成'));
    assert.ok(await viewer.$('.translation-hit'));
    const stored = await storedTranslations(documentId);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].done, 0, 'Only the pre-request checkpoint should be on disk');
  });
  await check('document switching warns about unsaved full translation and cancel retains its output', async () => {
    await nativeOpen('multipage.pdf');
    await wait(() => document.getElementById('unsavedDataDialog').open);
    assert.equal(await viewer.$eval('#docName', (element) => element.textContent), 'sample.pdf');
    await viewer.click('#unsavedDataDialog button[value="cancel"]');
    await wait(() => !document.getElementById('unsavedDataDialog').open);
    await currentName('sample.pdf');
    assert.match(await viewer.$eval('#documentTranslationStatus', (element) => element.textContent), /已完成/);
    assert.ok(await viewer.$('.translation-hit'));
  });
  await check('the shared native-close hook blocks unsaved translation and cancellation keeps the reader usable', async () => {
    await viewer.evaluate(() => {
      window.testCloseResult = 'pending';
      window.testBeforeClose().then((value) => { window.testCloseResult = value; }, (error) => { window.testCloseResult = `error:${error.message}`; });
    });
    await wait(() => document.getElementById('unsavedDataDialog').open || document.getElementById('closeAppDialog').open);
    if (await viewer.$eval('#closeAppDialog', (dialog) => dialog.open)) await viewer.click('#closeAppDialog button[value="close"]');
    await wait(() => document.getElementById('unsavedDataDialog').open);
    await viewer.click('#unsavedDataDialog button[value="cancel"]');
    await wait(() => window.testCloseResult !== 'pending');
    assert.equal(await viewer.evaluate(() => window.testCloseResult), false);
    await currentName('sample.pdf');
    assert.ok(await viewer.$('.translation-hit'));
  });
  await check('backup failure cannot download an archive missing valuable in-memory translation', async () => {
    await viewer.click('#openLibrary');
    await wait(() => document.body.dataset.view === 'library');
    const before = await viewer.evaluate(() => window.testDownloads.length);
    await viewer.click('#exportLibrary');
    await wait(() => !document.getElementById('exportLibrary').disabled && document.getElementById('libraryError').textContent.includes('备份失败'));
    assert.equal(await viewer.evaluate(() => window.testDownloads.length), before);
    assert.deepEqual(await fs.readdir(downloads), []);
    await viewer.click('#emptyClose'); await currentName('sample.pdf');
    assert.match(await viewer.$eval('#documentTranslationStatus', (element) => element.textContent), /已完成/);
  });
  await check('emergency Markdown export retains page numbers, original text and unsaved translated output', async () => {
    await viewer.click('#exportTranslationText');
    let filename;
    const deadline = Date.now() + 10000;
    while (!filename && Date.now() < deadline) {
      filename = (await fs.readdir(downloads)).find((name) => name.endsWith('.md'));
      if (!filename) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(filename, 'The emergency translation export must download an actual Markdown file');
    const content = await fs.readFile(path.join(downloads, filename), 'utf8');
    assert.match(content, /^# sample\.pdf/m); assert.match(content, /## 第 1 页/);
    assert.match(content, /原文：[\s\S]+译文：/); assert.match(content, /研究结果表明，风险指标的变化能够解释实验结果。/);
    assert.equal((await storedTranslations(documentId))[0].done, 0);
  });
  await check('retry-save writes the full in-memory translation after storage becomes available', async () => {
    await viewer.evaluate(async () => { (await import('./library.mjs')).library.saveTranslation = window.testSaveTranslation; });
    assert.equal(await viewer.$eval('#retryTranslationSave', (button) => button.hidden), false);
    await viewer.click('#retryTranslationSave');
    await wait(() => document.getElementById('retryTranslationSave').hidden && !document.getElementById('documentTranslationStatus').textContent.includes('尚未保存'));
    const stored = await storedTranslations(documentId);
    assert.equal(stored.length, 1); assert.ok(stored[0].total > 0); assert.equal(stored[0].done, stored[0].total);
  });
  await check('a safely saved translation survives document switching and reopens in translated mode', async () => {
    await nativeOpen('multipage.pdf'); await currentName('multipage.pdf');
    assert.equal(await viewer.$eval('#unsavedDataDialog', (dialog) => dialog.open), false);
    const stored = await storedTranslations(documentId);
    assert.equal(stored.length, 1); assert.ok(stored[0].total > 0); assert.equal(stored[0].done, stored[0].total);
    await nativeOpen('sample.pdf'); await currentName('sample.pdf');
    await wait(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成') && document.querySelector('.translation-hit'));
    assert.equal(await viewer.evaluate(() => document.body.dataset.documentMode), 'translated');
  });
  await check('same-file reimport keeps the saved translation without duplicating the document', async () => {
    await inputOpen('sample.pdf');
    await wait(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成'));
    const matches = await viewer.evaluate(async (documentId) => (await (await import('./library.mjs')).library.list()).filter((row) => row.id === documentId).length, documentId);
    assert.equal(matches, 1); assert.ok(await viewer.$('.translation-hit'));
  });
  await check('a successful document switch dismisses the previous full-translation confirmation', async () => {
    await staleDialog('fullTranslationDialog', () => viewer.click('#openFullTranslation'));
  });
  await check('a successful document switch dismisses stale paragraph translation', async () => {
    await staleDialog('paragraphDialog', async () => {
      await wait(() => document.querySelector('.translation-hit'));
      await viewer.$eval('.translation-hit', (button) => button.click());
    });
  });
  await check('a successful document switch dismisses the previous PDF export modal', async () => {
    await staleDialog('exportDialog', () => viewer.click('#exportTranslatedPdf'));
  });
  await check('a successful document switch dismisses rename without applying the old title', async () => {
    await staleDialog('renameDocumentDialog', async () => {
      await viewer.click('#openLibrary');
      await viewer.waitForSelector(`.library-row[data-document-id="${documentId}"] .library-rename`);
      await viewer.$eval(`.library-row[data-document-id="${documentId}"] .library-rename`, (button) => button.click());
      await viewer.$eval('#renameInput', (input) => { input.value = 'must-not-be-applied.pdf'; });
    });
    assert.equal(await viewer.evaluate(async (documentId) => (await (await import('./library.mjs')).library.get(documentId)).name, documentId), 'sample.pdf');
  });
  await check('switching away from an encrypted PDF dismisses its password modal and releases the pending import', async () => {
    await (await viewer.$('#fileInput')).uploadFile(path.join(root, 'dev/tests/protected.pdf'));
    await wait(() => document.getElementById('passwordDialog').open);
    await viewer.evaluate(() => document.getElementById('openLibrary').click());
    await viewer.waitForSelector(`.library-row[data-document-id="${documentId}"] .library-document`);
    await viewer.$eval(`.library-row[data-document-id="${documentId}"] .library-document`, (button) => button.click());
    await currentName('sample.pdf');
    assert.equal(await viewer.$eval('#passwordDialog', (dialog) => dialog.open), false);
    await wait(() => !document.getElementById('fileInput').files.length);
    assert.equal(await viewer.$eval('#pdfPassword', (input) => input.value), '');
  });
  await check('explicit discard permits leaving an unsaved translation without falsely marking it saved', async () => {
    holdResponses = true;
    await nativeOpen('academic.pdf'); await currentName('academic.pdf');
    const discardId = new URL(viewer.url()).searchParams.get('document');
    await viewer.click('#openFullTranslation'); await viewer.click('#startDocumentTranslation');
    await wait(() => document.getElementById('documentTranslationStatus').textContent.includes('翻译中'));
    await viewer.evaluate(async () => {
      const { library } = await import('./library.mjs');
      library.saveTranslation = async () => { throw new DOMException('controlled discard quota', 'QuotaExceededError'); };
    });
    holdResponses = false;
    for (const answer of waitingResponses.splice(0)) answer();
    await wait(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成') && document.getElementById('documentTranslationStatus').textContent.includes('尚未保存'));
    await nativeOpen('multipage.pdf'); await wait(() => document.getElementById('unsavedDataDialog').open);
    await viewer.click('#unsavedDataDialog button[value="discard"]'); await currentName('multipage.pdf');
    assert.equal(await viewer.$eval('#unsavedDataDialog', (dialog) => dialog.open), false);
    const stored = await storedTranslations(discardId);
    assert.equal(stored.length, 1); assert.ok(stored[0].done < stored[0].total);
    await viewer.evaluate(async () => { (await import('./library.mjs')).library.saveTranslation = window.testSaveTranslation; });
    await nativeOpen('sample.pdf'); await currentName('sample.pdf');
    await wait(() => document.getElementById('documentTranslationStatus').textContent.includes('已完成'));
  });
  await check('translation writes report a missing document instead of silently claiming to save', async () => {
    const result = await viewer.evaluate(async (documentId) => {
      const { library } = await import('./library.mjs');
      const record = (await library.snapshot()).translations.find((row) => row.documentId === documentId);
      await library.remove(documentId);
      const saved = await library.saveTranslation(record);
      const snapshot = await library.snapshot();
      return { saved, document: snapshot.documents.some((row) => row.id === documentId), translation: snapshot.translations.some((row) => row.documentId === documentId) };
    }, documentId);
    assert.equal(result.saved, false); assert.equal(result.document, false); assert.equal(result.translation, false);
  });
  await check('document persistence and modal flows report no uncaught frontend errors', async () => { assert.deepEqual(errors, []); });
  console.log(`\nDocument storage: ${count}/${count} passed. Controlled provider output is not a real translation-quality acceptance.`);
} finally {
  await harness.cleanup();
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('pdf-document-storage-')) throw new Error('Invalid document test cleanup path');
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
