import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension, screenshot } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'dev/test/artifacts');
await fs.mkdir(artifacts, { recursive: true });
const harness = await launchExtension(root), { browser, id } = harness;
const origin = `chrome-extension://${id}/src/`;
const errors = [];
let checks = 0;
async function check(name, action) {
  let timer;
  try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 30000); })]); }
  finally { clearTimeout(timer); }
  console.log(`PASS ${++checks} ${name}`);
}
async function page(file) {
  const p = await browser.newPage(); p.on('pageerror', (error) => errors.push(error.message));
  await p.setViewport({ width: 1440, height: 960 }); await p.goto(origin + file); await p.bringToFront(); return p;
}
async function docs(p) { return p.evaluate(async () => (await import('./library.mjs')).library.list().then((rows) => rows.map(({ data, ...row }) => row))); }
async function showLibrary(p) { await p.click('#openLibrary'); await p.waitForSelector('.library-row', { visible: true }); }

try {
  const options = await page('options.html');
  const pdfBytes = [...await fs.readFile(path.join(root, 'dev/tests/academic.pdf'))];
  const oldId = await options.evaluate(async (raw) => {
    const bytes = new Uint8Array(raw), id = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('pdf-translation-library', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('documents', { keyPath: 'id' });
        request.result.createObjectStore('translations', { keyPath: 'id' }).createIndex('documentId', 'documentId');
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite');
      tx.objectStore('documents').put({ id, name: 'previous-version.pdf', data: new Blob([bytes], { type: 'application/pdf' }), size: bytes.length, numPages: 3, page: 2, addedAt: 100, lastOpened: 200 });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close(); return id;
  }, pdfBytes);
  const viewer = await page('viewer.html');
  await check('v1 library migrates in place without losing PDF or reading position', async () => {
    await viewer.waitForSelector('.library-row');
    assert.equal((await docs(viewer))[0].id, oldId);
    const schema = await viewer.evaluate(async () => {
      const db = await new Promise((resolve) => { const r = indexedDB.open('pdf-translation-library'); r.onsuccess = () => resolve(r.result); });
      const result = { version: db.version, stores: [...db.objectStoreNames] }; db.close(); return result;
    });
    assert.equal(schema.version, 2); assert.ok(schema.stores.includes('documentState'));
    await viewer.click('.library-document');
    await viewer.waitForFunction(() => document.getElementById('pageInput').value === '2' && !document.getElementById('openOutline').disabled);
  });
  await check('whole-page fit and manual zoom persist with reading location', async () => {
    await viewer.click('#fitPage'); await showLibrary(viewer);
    assert.equal((await docs(viewer))[0].fitMode, 'page');
    await viewer.click('.library-document'); await viewer.waitForFunction(() => document.body.dataset.view === 'reader' && !document.getElementById('openOutline').disabled && document.getElementById('fitPage').classList.contains('active'));
    await viewer.click('#zoomOut'); await showLibrary(viewer);
    const saved = (await docs(viewer))[0]; assert.equal(saved.fit, false);
    await viewer.click('.library-document');
    await viewer.waitForFunction((percent) => document.body.dataset.view === 'reader' && !document.getElementById('openOutline').disabled && document.getElementById('zoomLabel').textContent === `${percent}%`, {}, Math.round(saved.scale * 100));
  });
  await check('library rename uses a normal accessible dialog and preserves the original file', async () => {
    await showLibrary(viewer); await viewer.click('.library-rename');
    await viewer.waitForSelector('#renameDocumentDialog[open]');
    await viewer.$eval('#renameInput', (input) => { input.value = '我的测试文献.pdf'; });
    await viewer.click('#renameDocumentForm button[type="submit"]');
    await viewer.waitForFunction(() => document.querySelector('.library-document strong').textContent === '我的测试文献.pdf');
    assert.equal((await docs(viewer))[0].id, oldId);
    assert.deepEqual([...await fs.readFile(path.join(root, 'dev/tests/academic.pdf'))], pdfBytes);
  });
  await check('batch import validates files and merges duplicate PDF bytes', async () => {
    await (await viewer.$('#fileInput')).uploadFile(path.join(root, 'dev/tests/academic.pdf'), path.join(root, 'dev/tests/multipage.pdf'));
    await viewer.waitForFunction(() => !document.getElementById('fileInput').files.length);
    assert.equal((await docs(viewer)).length, 2);
    assert.equal((await docs(viewer)).find((row) => row.id === oldId).name, '我的测试文献.pdf');
    await showLibrary(viewer); await viewer.select('#librarySort', 'name');
    await viewer.waitForFunction(() => document.querySelectorAll('.library-row').length === 2);
    await viewer.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['not a pdf'], 'readme.txt', { type: 'text/plain' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await viewer.waitForFunction(() => document.getElementById('toast').textContent.includes('未导入'));
    assert.equal(await viewer.$eval('#empty', (node) => node.hidden), false);
    assert.equal((await docs(viewer)).length, 2);
  });
  await check('manual appearance updates the reader and overrides OS dark preference', async () => {
    await options.bringToFront(); await options.select('#theme', 'dark');
    await viewer.waitForFunction(() => document.documentElement.dataset.theme === 'dark', { polling: 50 });
    assert.equal(await viewer.evaluate(() => getComputedStyle(document.body).getPropertyValue('--ink').trim()), '#e5ece3');
    await options.select('#theme', 'light'); await viewer.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await viewer.waitForFunction(() => document.documentElement.dataset.theme === 'light', { polling: 50 });
    assert.equal(await viewer.evaluate(() => getComputedStyle(document.body).getPropertyValue('--ink').trim()), '#23342e');
    await viewer.bringToFront();
  });
  let backupBytes;
  await check('a verified backup includes PDFs, notes and chats but never configured credentials', async () => {
    const result = await viewer.evaluate(async (id) => {
      const { library } = await import('./library.mjs');
      await library.saveState(id, 'reading', { bookmarks: [{ page: 2 }], notes: [{ page: 2, text: 'backup-note' }] });
      await library.saveState(id, 'chat', { messages: [{ role: 'user', content: 'backup-question' }], draft: 'draft' });
      await chrome.runtime.sendMessage({ type: 'saveSettings', settings: { custom: { apiKey: 'test-private-not-for-backup' } } });
      const { createLibraryBackup, parseLibraryBackup } = await import('./library-backup.mjs');
      const { blob } = await createLibraryBackup(library), bytes = new Uint8Array(await blob.arrayBuffer());
      const parsed = await parseLibraryBackup(blob);
      return { bytes: [...bytes], documentCount: parsed.documents.length, stateCount: parsed.documentState.length };
    }, oldId);
    assert.equal(result.documentCount, 2); assert.equal(result.stateCount, 2);
    backupBytes = result.bytes; assert.ok(!Buffer.from(backupBytes).includes(Buffer.from('test-private-not-for-backup')));
  });
  await check('backup UI downloads a real ZIP file rather than a placeholder', async () => {
    const downloads = path.join(artifacts, 'backup-downloads'); await fs.mkdir(downloads, { recursive: true });
    const cdp = await browser.target().createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await viewer.click('#exportLibrary');
    await viewer.waitForFunction(() => document.getElementById('libraryTransferStatus').textContent.includes('已生成'));
    const filename = `文献翻译器-备份-${new Date().toISOString().slice(0, 10)}.zip`;
    let file;
    for (let n = 0; n < 40; n++) { try { file = await fs.readFile(path.join(downloads, filename)); break; } catch (_) { await new Promise((resolve) => setTimeout(resolve, 100)); } }
    assert.ok(file?.length > 5000); assert.equal(file.readUInt32LE(0), 0x04034b50); await cdp.detach();
  });
  await check('deletion cascades to state and late writes cannot resurrect removed documents', async () => {
    const result = await viewer.evaluate(async (id) => {
      const { library } = await import('./library.mjs'); await library.remove(id);
      const saved = await library.saveState(id, 'reading', { notes: [{ page: 1, text: 'late' }] });
      const snapshot = await library.snapshot();
      return { saved, rows: snapshot.documents.length, states: snapshot.documentState.length };
    }, oldId);
    assert.equal(result.saved, false); assert.equal(result.rows, 1); assert.equal(result.states, 0);
  });
  await check('backup restore atomically merges files, restores state and leaves API settings untouched', async () => {
    const result = await viewer.evaluate(async (raw) => {
      const { library } = await import('./library.mjs'), { parseLibraryBackup } = await import('./library-backup.mjs');
      await library.restore(await parseLibraryBackup(new Blob([new Uint8Array(raw)])));
      const snapshot = await library.snapshot(), settings = await chrome.runtime.sendMessage({ type: 'getSettings' });
      return { rows: snapshot.documents.length, notes: snapshot.documentState.find((row) => row.kind === 'reading').value.notes[0].text, keyConfigured: settings.settings.custom.apiKeyConfigured, key: settings.settings.custom.apiKey };
    }, backupBytes);
    assert.equal(result.rows, 2); assert.equal(result.notes, 'backup-note'); assert.equal(result.keyConfigured, true); assert.equal(result.key, '');
    await showLibrary(viewer); await viewer.waitForSelector('.library-row');
  });
  await check('damaged backup is rejected without changing any library record', async () => {
    const bad = path.join(artifacts, 'damaged-backup.zip'), raw = Buffer.from(backupBytes); raw[60] ^= 1; await fs.writeFile(bad, raw);
    const before = await docs(viewer); await (await viewer.$('#backupInput')).uploadFile(bad);
    await viewer.waitForFunction(() => !document.getElementById('libraryError').hidden && document.getElementById('libraryError').textContent.includes('恢复失败'));
    assert.deepEqual(await docs(viewer), before);
  });
  await check('narrow library keeps sorting, backup actions and long names within the window', async () => {
    await viewer.setViewport({ width: 390, height: 844 });
    assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const controls = await viewer.evaluate(() => [...document.querySelectorAll('#empty button,#empty select')].filter((node) => node.getClientRects().length).map((node) => ({ id: node.id, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right })));
    assert.ok(controls.every((rect) => rect.left >= 0 && rect.right <= 390), JSON.stringify(controls));
    await screenshot(viewer, path.join(artifacts, 'usability-library-mobile.png'));
  });
  await check('all usability flows complete without uncaught browser errors', async () => assert.deepEqual(errors, []));
  console.log(`\nUsability: ${checks}/${checks} passed`);
} finally { await harness.cleanup(); }
