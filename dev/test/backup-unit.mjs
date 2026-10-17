import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchive, readArchive, crc32, createLibraryBackup, parseLibraryBackup } from '../../src/library-backup.mjs';
import { digest } from '../../src/library.mjs';

const bytes = new TextEncoder().encode('%PDF-1.7\nbackup fixture\n%%EOF');
const id = await digest(bytes), translationId = `${id}:${'a'.repeat(64)}`;
const doc = { id, name: 'test.pdf', numPages: 1, data: new Blob([bytes]), size: bytes.length, page: 1, lastOpened: 100, addedAt: 50 };
const block = { id: 0, text: 'Source text.', translation: '译文。', status: 'done', x: 50, y: 60, width: 200, height: 30, fontSize: 12, lines: [{ x: 50, y: 60, fontSize: 12 }] };
const translation = { id: translationId, documentId: id, target: 'zh-CN', engine: 'custom', layoutVersion: 3, total: 1, done: 1, updatedAt: 123, status: 'complete', pages: [{ width: 612, height: 792, blocks: [block] }] };
const state = { id: `${id}:reading`, documentId: id, kind: 'reading', value: { bookmarks: [{ page: 1, title: 'bookmark' }], notes: [{ page: 1, text: 'note' }] }, updatedAt: 120 };
function snapshot() { return { documents: [doc], translations: [structuredClone(translation)], documentState: [structuredClone(state)] }; }
async function backup(data = snapshot()) { return (await createLibraryBackup({ snapshot: async () => data })).blob; }
async function edited(change) {
  const entries = readArchive(new Uint8Array(await (await backup()).arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(entries.get('manifest.json')));
  change(manifest, entries);
  entries.set('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  return createArchive([...entries].map(([name, bytes]) => ({ name, bytes })));
}

test('ZIP CRC matches standard vector and archive round-trips binary data', async () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const zip = createArchive([{ name: 'manifest.json', bytes }]);
  assert.deepEqual(readArchive(new Uint8Array(await zip.arrayBuffer())).get('manifest.json'), bytes);
});
test('complete library backup restores PDF bytes, translations and reading state without settings', async () => {
  const blob = await backup(), result = await parseLibraryBackup(blob);
  assert.equal(result.documents.length, 1); assert.equal(result.documents[0].id, id);
  assert.deepEqual(new Uint8Array(await result.documents[0].data.arrayBuffer()), bytes);
  assert.equal(result.translations[0].pages[0].blocks[0].translation, '译文。');
  assert.equal(result.documentState[0].value.notes[0].text, 'note');
  assert.deepEqual(Object.keys(result).sort(), ['documentState', 'documents', 'translations']);
  assert.equal(result.documents[0].translation.done, 1);
  assert.ok(!new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer())).includes('apiKey'));
});
test('single-document backup filters unrelated translation and chat data', async () => {
  const data = snapshot(); data.documents.push({ ...doc, id: 'b'.repeat(64) });
  data.documentState.push({ ...state, id: `${'b'.repeat(64)}:chat`, documentId: 'b'.repeat(64), kind: 'chat' });
  const { blob, count } = await createLibraryBackup({ snapshot: async () => data }, () => {}, id);
  assert.equal(count, 1); assert.equal((await parseLibraryBackup(blob)).documentState.length, 1);
});
test('backup verifies CRC and PDF fingerprint before accepting any data', async () => {
  const raw = new Uint8Array(await (await backup()).arrayBuffer()); raw[40] ^= 1;
  assert.throws(() => readArchive(raw));
  const modified = await edited((_, entries) => entries.set(`pdfs/${id}.pdf`, new TextEncoder().encode('%PDF-1.7\nother bytes')));
  await assert.rejects(parseLibraryBackup(modified), /指纹/);
});
test('archive refuses traversal, duplicate paths, unsupported compression and truncation', async () => {
  for (const name of ['../config.local.json', 'pdfs/../../secret', '/manifest.json']) {
    const zip = createArchive([{ name, bytes }]);
    await assert.rejects(async () => readArchive(new Uint8Array(await zip.arrayBuffer())), /路径/);
  }
  const duplicate = createArchive([{ name: 'manifest.json', bytes }, { name: 'manifest.json', bytes }]);
  const duplicateBytes = new Uint8Array(await duplicate.arrayBuffer());
  assert.throws(() => readArchive(duplicateBytes), /重复/);
  const raw = new Uint8Array(await (await backup()).arrayBuffer()), view = new DataView(raw.buffer), end = raw.length - 22;
  view.setUint16(view.getUint32(end + 16, true) + 10, 8, true);
  assert.throws(() => readArchive(raw), /不受支持/);
  assert.throws(() => readArchive(raw.subarray(0, raw.length - 1)));
});
test('manifest schema, ownership and impossible layout are rejected', async () => {
  for (const change of [
    (m) => { m.version = 99; },
    (m) => { m.documents[0].numPages = 0; },
    (m) => { m.translations[0].documentId = 'c'.repeat(64); },
    (m) => { m.translations[0].pages[0].blocks[0].lines = []; },
    (m) => { m.translations[0].status = 'unknown'; },
    (m) => { m.translations[0].createdAt = 'Infinity'; },
    (m) => { m.documentState[0].kind = 'settings'; },
    (m) => { m.documentState[0].updatedAt = 'Infinity'; },
    (m) => { m.documentState[0].value = {}; },
    (m) => { m.documentState[0].value.notes[0].page = 999; },
    (m) => { m.documents.push({ ...m.documents[0] }); }
  ]) await assert.rejects(parseLibraryBackup(await edited(change)));
});
test('restored interrupted translation is paused, not silently restarted', async () => {
  const result = await parseLibraryBackup(await edited((m) => { m.translations[0].status = 'running'; }));
  assert.equal(result.translations[0].status, 'paused');
});
test('empty library exports and imports cleanly; missing selected document fails clearly', async () => {
  assert.equal((await parseLibraryBackup(await backup({ documents: [], translations: [], documentState: [] }))).documents.length, 0);
  await assert.rejects(createLibraryBackup({ snapshot: async () => snapshot() }, () => {}, 'b'.repeat(64)), /已删除/);
});
