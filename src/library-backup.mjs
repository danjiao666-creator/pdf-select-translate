import { digest } from './library.mjs';

const MAX_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 5002;
const MAX_MANIFEST = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const idPattern = /^[a-f0-9]{64}$/;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Store-only ZIP keeps backups inspectable without a network dependency or ZIP bombs.
export function createArchive(entries) {
  if (!entries.length || entries.length > MAX_ENTRIES) throw new Error('备份文件数量超出限制');
  const parts = [], central = [];
  let offset = 0, centralSize = 0;
  for (const { name, bytes } of entries) {
    const filename = encoder.encode(name), crc = crc32(bytes);
    if (offset + bytes.byteLength > MAX_BYTES) throw new Error('单份备份最多 512 MB，请分批备份文档');
    const header = new Uint8Array(30 + filename.length), local = new DataView(header.buffer);
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x800, true);
    local.setUint32(14, crc, true); local.setUint32(18, bytes.length, true); local.setUint32(22, bytes.length, true);
    local.setUint16(26, filename.length, true); header.set(filename, 30);
    const index = new Uint8Array(46 + filename.length), record = new DataView(index.buffer);
    record.setUint32(0, 0x02014b50, true); record.setUint16(4, 20, true); record.setUint16(6, 20, true);
    record.setUint16(8, 0x800, true); record.setUint32(16, crc, true);
    record.setUint32(20, bytes.length, true); record.setUint32(24, bytes.length, true);
    record.setUint16(28, filename.length, true); record.setUint32(42, offset, true); index.set(filename, 46);
    parts.push(header, bytes); central.push(index);
    offset += header.length + bytes.length; centralSize += index.length;
  }
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, entries.length, true); view.setUint16(10, entries.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

export function readArchive(bytes) {
  if (bytes.length < 22 || bytes.length > MAX_BYTES + 2 * 1024 * 1024) throw new Error('备份文件大小无效（上限 512 MB）');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 20, true) || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('不是受支持的文档库备份');
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), size = view.getUint32(end + 12, true);
  if (!count || count > MAX_ENTRIES || view.getUint16(end + 8, true) !== count || start + size !== end) throw new Error('备份目录损坏');
  const entries = new Map();
  let position = start, total = 0;
  for (let n = 0; n < count; n++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) throw new Error('备份条目损坏');
    const packed = view.getUint32(position + 20, true), unpacked = view.getUint32(position + 24, true);
    const length = view.getUint16(position + 28, true), extra = view.getUint16(position + 30, true), comment = view.getUint16(position + 32, true);
    const local = view.getUint32(position + 42, true), crc = view.getUint32(position + 16, true);
    if (position + 46 + length + extra + comment > end || local + 30 > start || view.getUint16(position + 10, true) || (view.getUint16(position + 8, true) & ~0x800) || packed !== unpacked || view.getUint16(position + 34, true)) throw new Error('备份格式不受支持，请使用软件导出的 ZIP');
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + length));
    if (!/^(manifest\.json|pdfs\/[a-f0-9]{64}\.pdf)$/.test(name) || entries.has(name)) throw new Error('备份含有不安全或重复的路径');
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) || view.getUint32(local + 18, true) !== packed || view.getUint32(local + 22, true) !== unpacked || view.getUint32(local + 14, true) !== crc) throw new Error('备份条目校验失败');
    const localLength = view.getUint16(local + 26, true), dataStart = local + 30 + localLength + view.getUint16(local + 28, true);
    if (dataStart + unpacked > start || decoder.decode(bytes.subarray(local + 30, local + 30 + localLength)) !== name) throw new Error('备份长度或文件名校验失败');
    const value = bytes.subarray(dataStart, dataStart + unpacked);
    total += unpacked;
    if (total > MAX_BYTES || crc32(value) !== crc) throw new Error('备份已损坏，请勿继续导入');
    entries.set(name, value); position += 46 + length + extra + comment;
  }
  if (position !== end || !entries.has('manifest.json')) throw new Error('备份缺少文档目录');
  return entries;
}

const finite = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
function timestamp(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8640000000000000) throw new Error('备份中的记录时间无效');
  return value;
}

function readingState(value, pageCount) {
  const validPage = (page) => Number.isInteger(page) && page > 0 && page <= pageCount;
  if (!Array.isArray(value.bookmarks) || !Array.isArray(value.notes) || value.bookmarks.length > 1000 || value.notes.length > 1000) throw new Error('备份中的书签或笔记无效');
  return { version: 1,
    bookmarks: value.bookmarks.map((item) => {
      if (!item || !validPage(item.page)) throw new Error('备份中的书签页码无效');
      return { page: item.page, createdAt: timestamp(item.createdAt) };
    }),
    notes: value.notes.map((item) => {
      if (!item || !validPage(item.page) || typeof item.text !== 'string' || item.text.length > 4000) throw new Error('备份中的笔记内容无效');
      return { page: item.page, text: item.text, updatedAt: timestamp(item.updatedAt) };
    }) };
}

function chatState(value, pageCount) {
  const validPage = (page) => Number.isInteger(page) && page > 0 && page <= pageCount;
  if (!Array.isArray(value.messages) || value.messages.length > 120 || (value.draft != null && (typeof value.draft !== 'string' || value.draft.length > 4000))) throw new Error('备份中的对话内容无效');
  const messages = value.messages.map((message, index) => {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || message.content.length > 24000 || (message.evidence != null && (!Array.isArray(message.evidence) || message.evidence.length > 12))) throw new Error('备份中的对话消息无效');
    const evidence = (message.evidence || []).map((item) => {
      if (!item || !validPage(item.page) || typeof item.text !== 'string' || item.text.length > 3200) throw new Error('备份中的对话引用无效');
      return { page: item.page, text: item.text };
    });
    return { id: typeof message.id === 'string' ? message.id.slice(0, 100) : `restored-${index}`, role: message.role, content: message.content,
      status: message.role === 'user' ? 'done' : ['done', 'error', 'cancelled'].includes(message.status) ? message.status : 'cancelled',
      createdAt: timestamp(message.createdAt), error: typeof message.error === 'string' ? message.error.slice(0, 1000) : '', evidence };
  });
  let selection = null;
  if (value.selection != null) {
    if (!validPage(value.selection.page) || typeof value.selection.text !== 'string' || value.selection.text.length > 3000) throw new Error('备份中的选中原文无效');
    selection = { page: value.selection.page, text: value.selection.text };
  }
  return { version: 1, updatedAt: timestamp(value.updatedAt), messages, draft: value.draft || '', selection };
}

function validTranslationLayout(record) {
  if (typeof record.target !== 'string' || record.target.length > 20 || typeof record.engine !== 'string' || record.engine.length > 40 || !Number.isInteger(record.layoutVersion)) return false;
  return record.pages.every((page) => {
    if (!page || !Number.isFinite(page.width) || !Number.isFinite(page.height) || page.width <= 0 || page.height <= 0 || page.width > 100000 || page.height > 100000 || !Array.isArray(page.blocks) || page.blocks.length > 20000) return false;
    return page.blocks.every((block) => {
      if (!block || typeof block.text !== 'string' || block.text.length > 100000 || !['pending', 'working', 'done', 'error', 'preserved'].includes(block.status)) return false;
      if (block.status === 'done' && (typeof block.translation !== 'string' || !block.translation.trim())) return false;
      if (!['x', 'y', 'width', 'height', 'fontSize'].every((key) => Number.isFinite(block[key])) || block.width < 0 || block.height < 0 || block.fontSize <= 0) return false;
      if (!Array.isArray(block.lines) || !block.lines.length || block.lines.some((line) => !line || !['x', 'y', 'fontSize'].every((key) => Number.isFinite(line[key])))) return false;
      return block.translation == null || (typeof block.translation === 'string' && block.translation.length <= 100000);
    });
  });
}

export async function createLibraryBackup(library, progress = () => {}, documentId = '') {
  const snapshot = await library.snapshot(), entries = [];
  if (documentId) {
    snapshot.documents = snapshot.documents.filter((row) => row.id === documentId);
    snapshot.translations = snapshot.translations.filter((row) => row.documentId === documentId);
    snapshot.documentState = snapshot.documentState.filter((row) => row.documentId === documentId);
    if (!snapshot.documents.length) throw new Error('文档已删除，请刷新文档库后重试');
  }
  const documents = [];
  let bytes = 0;
  for (const [index, row] of snapshot.documents.entries()) {
    progress(`正在备份 ${index + 1} / ${snapshot.documents.length} 份文档…`);
    bytes += row.size || row.data.size;
    if (bytes > MAX_BYTES) throw new Error('文档库超过 512 MB，请使用单份文档备份或先分批整理');
    const { data, ...metadata } = row;
    documents.push(metadata); entries.push({ name: `pdfs/${row.id}.pdf`, bytes: new Uint8Array(await data.arrayBuffer()) });
  }
  const manifest = { format: 'pdf-translation-library', version: 1, exportedAt: Date.now(), documents, translations: snapshot.translations, documentState: snapshot.documentState };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST) throw new Error('文字记录超过 32 MB，请选择单份文档分批备份');
  entries.unshift({ name: 'manifest.json', bytes: manifestBytes });
  return { blob: createArchive(entries), count: documents.length };
}

export async function parseLibraryBackup(file, progress = () => {}) {
  if (file.size > MAX_BYTES + 2 * 1024 * 1024) throw new Error('单份备份最多 512 MB');
  const entries = readArchive(new Uint8Array(await file.arrayBuffer()));
  if (entries.get('manifest.json').length > MAX_MANIFEST) throw new Error('备份中的文字记录过大，请使用软件分批导出的备份');
  const manifest = JSON.parse(decoder.decode(entries.get('manifest.json')));
  if (manifest?.format !== 'pdf-translation-library' || manifest.version !== 1 || !Array.isArray(manifest.documents) || manifest.documents.length > 5000 || !Array.isArray(manifest.translations) || manifest.translations.length > 20000 || !Array.isArray(manifest.documentState) || manifest.documentState.length > 10000) throw new Error('备份版本或目录无效');
  const documents = [], ids = new Set(), documentMap = new Map();
  for (const [index, row] of manifest.documents.entries()) {
    if (!idPattern.test(row?.id) || ids.has(row.id) || typeof row.name !== 'string' || !Number.isInteger(row.numPages) || row.numPages < 1 || row.numPages > 100000) throw new Error('备份中的文档信息无效');
    const data = entries.get(`pdfs/${row.id}.pdf`);
    if (!data || data.length < 5 || !String.fromCharCode(...data.subarray(0, 1024)).includes('%PDF-')) throw new Error('备份缺少有效 PDF');
    progress(`正在校验 ${index + 1} / ${manifest.documents.length} 份文档…`);
    if (await digest(data) !== row.id) throw new Error('PDF 指纹不匹配，备份已损坏');
    ids.add(row.id);
    const document = { id: row.id, name: row.name.slice(0, 500), size: data.length, data: new Blob([data], { type: 'application/pdf' }), numPages: row.numPages,
      page: Math.max(1, Math.min(row.numPages, Math.round(finite(row.page, 1)))), mode: ['original', 'translated', 'compare'].includes(row.mode) ? row.mode : 'original',
      fit: row.fit !== false, fitMode: row.fitMode === 'page' ? 'page' : 'width', scale: Math.max(.25, Math.min(5, finite(row.scale, 1))),
      sourceUrl: typeof row.sourceUrl === 'string' && /^(https?|file):/i.test(row.sourceUrl) ? row.sourceUrl.slice(0, 8192) : '', addedAt: timestamp(row.addedAt), lastOpened: timestamp(row.lastOpened) };
    documents.push(document); documentMap.set(row.id, document);
  }
  if (entries.size !== documents.length + 1) throw new Error('备份包含目录之外的文件');
  const seen = new Set(), translations = [], documentState = [];
  for (const row of manifest.translations) {
    const document = documentMap.get(row?.documentId);
    if (!document || typeof row.id !== 'string' || !row.id.startsWith(`${row.documentId}:`) || !idPattern.test(row.id.slice(65)) || seen.has(row.id) || !Array.isArray(row.pages) || row.pages.length !== document.numPages || !['paused', 'running', 'complete', 'error'].includes(row.status)) throw new Error('备份中的译文数据无效');
    seen.add(row.id);
    if (!validTranslationLayout(row)) throw new Error('备份中的译文布局无效');
    const blocks = row.pages.flatMap((page) => page.blocks).filter((block) => block.status !== 'preserved');
    const record = { id: row.id, documentId: row.documentId, target: row.target, source: typeof row.source === 'string' ? row.source.slice(0, 20) : 'auto', engine: row.engine,
      layoutVersion: row.layoutVersion, pages: row.pages, status: row.status === 'running' ? 'paused' : row.status,
      createdAt: timestamp(row.createdAt), updatedAt: timestamp(row.updatedAt, timestamp(row.createdAt)),
      total: blocks.length, done: blocks.filter((block) => block.status === 'done').length, failed: blocks.filter((block) => block.status === 'error').length,
      unfitted: blocks.filter((block) => block.status === 'done' && block.unfitted).length,
      context: { title: typeof row.context?.title === 'string' ? row.context.title.slice(0, 400) : '', abstract: typeof row.context?.abstract === 'string' ? row.context.abstract.slice(0, 3000) : '' },
      lastError: typeof row.lastError === 'string' ? row.lastError.slice(0, 1000) : '' };
    translations.push(record);
    if (!document.translation || document.translation.updatedAt < record.updatedAt) document.translation = { target: record.target, done: record.done, total: record.total, status: record.status, layoutVersion: record.layoutVersion, updatedAt: record.updatedAt };
  }
  seen.clear();
  for (const row of manifest.documentState) {
    if (!ids.has(row?.documentId) || !['reading', 'chat'].includes(row.kind) || row.id !== `${row.documentId}:${row.kind}` || seen.has(row.id) || !row.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('备份中的阅读记录无效');
    seen.add(row.id);
    const pageCount = documentMap.get(row.documentId).numPages;
    documentState.push({ id: row.id, documentId: row.documentId, kind: row.kind, updatedAt: timestamp(row.updatedAt),
      value: row.kind === 'reading' ? readingState(row.value, pageCount) : chatState(row.value, pageCount) });
  }
  return { documents, translations, documentState };
}
