import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { digest } from '../../src/library.mjs';
import { launchExtension } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bytes = await fs.readFile(path.join(root, 'dev/tests/academic.pdf'));
const documentId = await digest(bytes);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-reader-backup-'));
const backupPath = path.join(temporary, 'library.zip');
const harness = await launchExtension(root);
const { browser, id } = harness;
const origin = `chrome-extension://${id}/src/`;
const errors = [];
let count = 0;
const check = async (name, action) => {
  let timer;
  try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 30000); })]); }
  finally { clearTimeout(timer); }
  console.log(`PASS ${++count} ${name}`);
};
try {
  const page = await browser.newPage(); page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + 'options.html'); await page.bringToFront();
  await check('IndexedDB v1 migration retains existing PDFs and translations while adding document state', async () => {
    const result = await page.evaluate(async ({ encoded, documentId }) => {
      const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('pdf-translation-library', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('documents', { keyPath: 'id' });
          request.result.createObjectStore('translations', { keyPath: 'id' }).createIndex('documentId', 'documentId');
        };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['documents', 'translations'], 'readwrite');
        tx.objectStore('documents').put({ id: documentId, name: 'academic.pdf', numPages: 3, data: new Blob([bytes], { type: 'application/pdf' }), size: bytes.length, addedAt: 100, lastOpened: 200, page: 1 });
        tx.objectStore('translations').put({ id: `${documentId}:${'a'.repeat(64)}`, documentId, target: 'zh-CN', engine: 'custom', pages: [], layoutVersion: 3, done: 1, total: 10, status: 'paused', updatedAt: 300 });
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
      }); db.close();
      const { library } = await import('./library.mjs');
      const record = await library.get(documentId), translation = await library.loadTranslation(`${documentId}:${'a'.repeat(64)}`);
      await library.saveState(documentId, 'reading', { version: 1, bookmarks: [{ page: 2 }], notes: [{ page: 2, text: 'local note' }] });
      const upgraded = await new Promise((resolve) => { const request = indexedDB.open('pdf-translation-library'); request.onsuccess = () => resolve(request.result); });
      const result = { name: record.name, byteLength: record.data.size, translated: translation.done, version: upgraded.version, stores: [...upgraded.objectStoreNames], state: await library.loadState(documentId, 'reading') }; upgraded.close(); return result;
    }, { encoded: bytes.toString('base64'), documentId });
    assert.equal(result.version, 2); assert.equal(result.name, 'academic.pdf'); assert.equal(result.byteLength, bytes.length); assert.equal(result.translated, 1);
    assert.ok(result.stores.includes('documentState')); assert.equal(result.state.notes[0].text, 'local note');
  });
  await check('a held reading lock refuses backup restoration without any partial document or state merge', async () => {
    const result = await page.evaluate(async (documentId) => {
      const { library, digest } = await import('./library.mjs');
      const before = await library.get(documentId), state = await library.loadState(documentId, 'reading');
      const other = new TextEncoder().encode('%PDF-1.7\nlock refusal fixture\n%%EOF'), otherId = await digest(other);
      const snapshot = { documents: [{ ...before, name: 'must not change', lastOpened: Date.now() + 10000 }, { id: otherId, name: 'must not appear.pdf', data: new Blob([other]), size: other.length, numPages: 1, addedAt: 1, lastOpened: 1 }], translations: [], documentState: [{ id: `${documentId}:reading`, documentId, kind: 'reading', updatedAt: Date.now() + 10000, value: { bookmarks: [], notes: [] } }] };
      let error = '';
      await navigator.locks.request(`pdf-reading-state:${documentId}`, async () => { try { await library.restore(snapshot); } catch (failure) { error = failure.message; } });
      return { error, name: (await library.get(documentId)).name, missing: !(await library.get(otherId)), state: await library.loadState(documentId, 'reading'), before: state };
    }, documentId);
    assert.match(result.error, /另一窗口/); assert.equal(result.name, 'academic.pdf'); assert.equal(result.missing, true); assert.deepEqual(result.state, result.before);
  });
  await check('restore recomputes library summaries from the winning newer translation inside the merge', async () => {
    const result = await page.evaluate(async (documentId) => {
      const { library } = await import('./library.mjs'), before = await library.get(documentId), id = `${documentId}:${'a'.repeat(64)}`;
      const translation = { ...(await library.loadTranslation(id)), done: 9, updatedAt: Date.now() + 5000 };
      await library.restore({ documents: [{ ...before, lastOpened: 100, translation: { target: 'zh-CN', done: 0, total: 10, status: 'paused', layoutVersion: 3 } }], translations: [translation], documentState: [] });
      return { summary: (await library.get(documentId)).translation, actual: await library.loadTranslation(id) };
    }, documentId);
    assert.equal(result.summary.done, 9); assert.equal(result.summary.done, result.actual.done); assert.equal(result.summary.target, result.actual.target);
  });
  await check('restoring an older snapshot preserves newer local reading records and translations', async () => {
    const result = await page.evaluate(async (documentId) => {
      const { library } = await import('./library.mjs'), before = await library.get(documentId), id = `${documentId}:${'a'.repeat(64)}`;
      await library.saveState(documentId, 'reading', { bookmarks: [{ page: 3 }], notes: [{ page: 3, text: 'newer local work' }] });
      await library.restore({ documents: [{ ...before, lastOpened: 1 }], translations: [{ ...(await library.loadTranslation(id)), done: 0, updatedAt: 1 }], documentState: [{ id: `${documentId}:reading`, documentId, kind: 'reading', updatedAt: 1, value: { bookmarks: [], notes: [] } }] });
      return { data: await library.loadState(documentId, 'reading'), translation: await library.loadTranslation(id), summary: (await library.get(documentId)).translation };
    }, documentId);
    assert.equal(result.data.notes[0].text, 'newer local work'); assert.equal(result.translation.done, 9); assert.equal(result.summary.done, 9);
  });
  await check('delete cascades state and translations; delayed writers cannot resurrect any document data', async () => {
    const result = await page.evaluate(async (documentId) => {
      const { library } = await import('./library.mjs'), record = await library.loadTranslation(`${documentId}:${'a'.repeat(64)}`);
      await library.saveState(documentId, 'chat', { messages: [], draft: 'old draft' });
      await library.remove(documentId);
      const saved = await library.saveState(documentId, 'reading', { notes: [{ page: 1, text: 'late write' }] }); await library.saveTranslation(record);
      const snapshot = await library.snapshot();
      return { saved, document: await library.get(documentId), state: await library.loadState(documentId, 'reading'), counts: Object.fromEntries(Object.entries(snapshot).map(([name, rows]) => [name, rows.length])) };
    }, documentId);
    assert.equal(result.saved, false); assert.equal(result.document, undefined); assert.equal(result.state, null); assert.deepEqual(result.counts, { documents: 0, translations: 0, documentState: 0 });
  });
  const viewer = await browser.newPage(); viewer.on('pageerror', (error) => errors.push(error.message));
  viewer.on('dialog', (dialog) => void dialog.accept());
  await viewer.setViewport({ width: 1440, height: 1000 }); await viewer.goto(origin + 'viewer.html'); await viewer.bringToFront();
  await (await viewer.$('#fileInput')).uploadFile(path.join(root, 'dev/tests/academic.pdf'));
  await viewer.waitForFunction(() => !document.getElementById('openBookmarks').disabled);
  await viewer.click('#openLibrary');
  const exported = await viewer.evaluate(async () => { const { library } = await import('./library.mjs'); const { createLibraryBackup } = await import('./library-backup.mjs'); return [...new Uint8Array(await (await createLibraryBackup(library)).blob.arrayBuffer())]; });
  await fs.writeFile(backupPath, Buffer.from(exported)); await viewer.click('#emptyClose');
  await check('restore UI preserves the current PDF and failed note draft when strict flushing fails', async () => {
    await viewer.click('#openBookmarks');
    await viewer.evaluate(async () => {
      const { library } = await import('./library.mjs'); window.originalSaveState = library.saveState;
      library.saveState = (...args) => args[1] === 'reading' ? Promise.reject(new Error('quota fixture')) : window.originalSaveState(...args);
    });
    await viewer.$eval('#readerNote', (input) => { input.value = 'failed note draft must survive restore'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await viewer.waitForFunction(() => document.getElementById('readerNoteStatus').textContent.includes('保存失败'));
    await viewer.click('#openLibrary'); await (await viewer.$('#backupInput')).uploadFile(backupPath);
    await viewer.waitForFunction(() => !document.getElementById('libraryError').hidden && document.getElementById('libraryError').textContent.includes('尚未保存'));
    assert.equal(await viewer.$eval('#emptyClose', (button) => button.hidden), false);
    assert.equal(await viewer.$eval('#pageCount', (label) => label.textContent), '3');
    assert.equal(await viewer.$eval('#readerNote', (input) => input.value), 'failed note draft must survive restore');
    await viewer.evaluate(async () => { (await import('./library.mjs')).library.saveState = window.originalSaveState; });
    await viewer.click('#emptyClose'); await viewer.click('.reader-save-retry');
    await viewer.waitForFunction(() => document.getElementById('readerNoteStatus').textContent === '已保存在本机');
  });
  await check('complete backup deletes and restores a real PDF plus notes through the actual library UI', async () => {
    await viewer.click('#addBookmark');
    await viewer.waitForFunction(async (documentId) => (await (await import('./library.mjs')).library.loadState(documentId, 'reading'))?.bookmarks.length > 0, {}, documentId);
    await viewer.click('#openLibrary');
    const exported = await viewer.evaluate(async () => { const { library } = await import('./library.mjs'); const { createLibraryBackup } = await import('./library-backup.mjs'); return [...new Uint8Array(await (await createLibraryBackup(library)).blob.arrayBuffer())]; });
    await fs.writeFile(backupPath, Buffer.from(exported));
    await viewer.click(`.library-row[data-document-id="${documentId}"] > button.quiet`);
    await viewer.waitForFunction(() => !document.querySelector('.library-row') && document.getElementById('emptyClose').hidden);
    await (await viewer.$('#backupInput')).uploadFile(backupPath);
    await viewer.waitForFunction(() => document.getElementById('libraryTransferStatus').textContent.includes('已恢复 1'));
    await viewer.click('.library-document'); await viewer.waitForFunction(() => !document.getElementById('openBookmarks').disabled);
    await viewer.click('#openBookmarks');
    assert.equal(await viewer.$eval('#readerNote', (input) => input.value), 'failed note draft must survive restore');
    assert.equal(await viewer.$eval('#addBookmark', (button) => button.getAttribute('aria-pressed')), 'true');
    assert.equal(await viewer.$eval('#pageCount', (label) => label.textContent), '3');
  });
  assert.deepEqual(errors, []);
  console.log(`All ${count} backup integration checks passed.`);
} finally {
  await harness.cleanup();
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('pdf-reader-backup-')) throw new Error('Invalid backup test cleanup target');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
