import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchExtension, screenshot } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'dev/test/artifacts');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-reader-check-'));
const pdfPath = path.join(temporary, 'everyday-reader.pdf');
const downloads = path.join(temporary, 'downloads');
await fs.mkdir(downloads); await fs.mkdir(artifacts, { recursive: true });

function readerPdf() {
  const escape = (value) => value.replace(/[\\()]/g, '\\$&');
  const pages = [
    ['Everyday reader test', 'Scientific translation keeps figures unchanged.', 'The risk-based driver model explains human-like driving.', 'An inter-', 'national collaboration studies behavior.', 'Literal symbols a+b [test] are searchable.'],
    ['Methods', 'Scientific translation uses the original paper context.', 'The driver model includes observed risk and steering.'],
    ['Results', 'Translation quality needs a real evaluation.', 'The model preserves equations and figures.'],
    ['Conclusion', 'Translation and reading records remain separate.']
  ];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 12 0 R /Names << /Dests << /Names [(methods) [6 0 R /Fit]] >> >> >>',
    '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R 10 0 R] /Count 4 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  for (let n = 0; n < pages.length; n++) {
    const stream = `BT /F1 12 Tf 50 730 Td ${pages[n].map((line, index) => `${index ? '0 -24 Td ' : ''}(${escape(line)}) Tj`).join('\n')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + n * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects.push(
    '<< /Type /Outlines /First 13 0 R /Last 16 0 R /Count 4 >>',
    '<< /Title (Introduction) /Parent 12 0 R /Dest [4 0 R /Fit] /Next 14 0 R >>',
    '<< /Title (Methods) /Parent 12 0 R /Dest (methods) /Prev 13 0 R /Next 16 0 R /First 15 0 R /Last 15 0 R /Count 1 >>',
    '<< /Title (Details) /Parent 14 0 R /Dest [8 0 R /Fit] >>',
    '<< /Title (Conclusion) /Parent 12 0 R /Dest [10 0 R /Fit] /Prev 14 0 R >>'
  );
  let output = '%PDF-1.4\n', offsets = [0];
  for (let n = 0; n < objects.length; n++) { offsets.push(Buffer.byteLength(output)); output += `${n + 1} 0 obj\n${objects[n]}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}
await fs.writeFile(pdfPath, readerPdf());
const harness = await launchExtension(root);
const { browser, id, extensionPath } = harness;
const origin = `chrome-extension://${id}/src/`;
let count = 0;
const errors = [];
const check = async (name, action) => {
  let timeout;
  try { await Promise.race([action(), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 30000); })]); }
  catch (error) {
    console.error(await Promise.all((await browser.pages()).map((page) => page.evaluate(() => ({ url: location.pathname, view: document.body?.dataset.view, page: document.getElementById('pageInput')?.value, disabled: document.getElementById('openBookmarks')?.disabled, note: document.getElementById('readerNote')?.value, status: document.getElementById('readerNoteStatus')?.textContent, dialog: document.querySelector('dialog[open]')?.id })).catch(() => ({})))));
    throw error;
  }
  finally { clearTimeout(timeout); }
  console.log(`PASS ${++count} ${name}`);
};
async function page(url = 'viewer.html') {
  const result = await browser.newPage();
  result.on('pageerror', (error) => errors.push(error.message));
  await result.setViewport({ width: 1440, height: 1000 }); await result.goto(origin + url); await result.bringToFront(); return result;
}
async function goPage(viewer, number) {
  await viewer.$eval('#pageInput', (input, number) => { input.value = String(number); input.dispatchEvent(new Event('change', { bubbles: true })); }, number);
  await viewer.waitForFunction((number) => document.getElementById('pageInput').value === String(number), {}, number);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
async function searchFor(viewer, query) {
  await viewer.$eval('#readerSearchInput', (input, query) => { input.value = query; input.dispatchEvent(new Event('input', { bubbles: true })); }, query);
  await viewer.click('.reader-search-form button[type="submit"]');
  await viewer.waitForFunction(() => document.getElementById('readerSearchStatus').textContent.includes('共找到') || document.getElementById('readerSearchStatus').textContent.includes('未找到匹配'));
}
async function readingData(viewer, documentId) { return viewer.evaluate(async (documentId) => (await import('./library.mjs')).library.loadState(documentId, 'reading'), documentId); }
try {
  const viewer = await page();
  await check('library does not consume browser find and document tools remain disabled', async () => {
    assert.equal(await viewer.$eval('#openSearch', (button) => button.disabled), true);
    assert.equal(await viewer.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event.defaultPrevented; }), false);
  });
  let documentId;
  await check('import enables tools without requiring any API service', async () => {
    await (await viewer.$('#fileInput')).uploadFile(pdfPath);
    await viewer.waitForFunction(() => !document.getElementById('openSearch').disabled);
    await viewer.waitForSelector('.textLayer span');
    documentId = new URL(viewer.url()).searchParams.get('document'); assert.ok(documentId);
    assert.equal(await viewer.$eval('#pageCount', (label) => label.textContent), '4');
  });
  await check('real PDF outlines navigate named and child destinations with unique accessible controls', async () => {
    await viewer.click('#openOutline');
    await viewer.waitForSelector('.reader-outline-jump');
    const methods = await viewer.$('.reader-outline li:nth-child(2) > .reader-outline-row .reader-outline-jump');
    assert.equal(await methods.evaluate((element) => element.textContent), 'Methods');
    await methods.click(); await viewer.waitForFunction(() => document.getElementById('pageInput').value === '2');
    await viewer.click('.reader-outline-expand:not([disabled])');
    assert.equal(await viewer.$eval('.reader-outline-expand:not([disabled])', (button) => button.getAttribute('aria-expanded')), 'true');
    await viewer.click('.reader-outline ul ul .reader-outline-jump');
    await viewer.waitForFunction(() => document.getElementById('pageInput').value === '3');
    assert.deepEqual(await viewer.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map((element) => element.id); return ids.filter((value, index) => ids.indexOf(value) !== index); }), []);
  });
  await check('Ctrl+F opens PDF find; line-hyphenated matches highlight the actual text spans', async () => {
    await viewer.click('#docName'); await viewer.keyboard.down('Control'); await viewer.keyboard.press('f'); await viewer.keyboard.up('Control');
    await viewer.waitForFunction(() => document.activeElement?.id === 'readerSearchInput');
    await searchFor(viewer, 'international');
    assert.equal(await viewer.$$eval('.reader-result', (elements) => elements.length), 1);
    await viewer.click('.reader-result');
    await viewer.waitForFunction(() => document.getElementById('pageInput').value === '1' && CSS.highlights.get('reader-find-active')?.size >= 2);
    await screenshot(viewer, path.join(artifacts, 'reader-search.png'));
  });
  await check('literal search and Enter navigation preserve original snippets and bounded page references', async () => {
    await searchFor(viewer, 'a+b');
    assert.equal(await viewer.$$eval('.reader-result', (elements) => elements.length), 1);
    assert.equal(await viewer.$eval('.reader-result mark', (element) => element.textContent), 'a+b');
    await searchFor(viewer, 'TRANSLATION');
    assert.equal(await viewer.$$eval('.reader-result', (elements) => elements.length), 4);
    await viewer.focus('#readerSearchInput'); await viewer.keyboard.press('Enter');
    assert.match(await viewer.$eval('.reader-result-position', (element) => element.textContent), /2 \/ 4/);
    await viewer.keyboard.down('Shift'); await viewer.keyboard.press('Enter'); await viewer.keyboard.up('Shift');
    assert.match(await viewer.$eval('.reader-result-position', (element) => element.textContent), /1 \/ 4/);
  });
  await check('Ctrl+D saves a page bookmark and notes do not silently move to another page during reading', async () => {
    await viewer.keyboard.press('Escape'); await goPage(viewer, 2);
    await viewer.click('#docName'); await viewer.keyboard.down('Control'); await viewer.keyboard.press('d'); await viewer.keyboard.up('Control');
    await viewer.waitForFunction(async (documentId) => { const data = await (await import('./library.mjs')).library.loadState(documentId, 'reading'); return data?.bookmarks.some((entry) => entry.page === 2); }, {}, documentId);
    await viewer.click('#openBookmarks'); await viewer.focus('#readerNote');
    await viewer.$eval('#readerNote', (input) => { input.value = '第 2 页：保留原始术语 <img src=x onerror=alert(1)>。'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await viewer.waitForFunction(() => document.getElementById('readerNoteStatus').textContent === '已保存在本机');
    await goPage(viewer, 3);
    assert.match(await viewer.$eval('label[for="readerNote"]', (label) => label.textContent), /第 2 页/);
    assert.match(await viewer.$eval('#readerNote', (input) => input.value), /第 2 页/);
    assert.equal(await viewer.$('#readerPanel-bookmarks img'), null);
    await viewer.click('.reader-note-heading button');
    assert.match(await viewer.$eval('label[for="readerNote"]', (label) => label.textContent), /第 3 页/);
  });
  await check('document switching flushes pending edits to the original document, not the next one', async () => {
    await viewer.$eval('#readerNote', (input) => { input.value = '第 3 页即时笔记'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await (await viewer.$('#fileInput')).uploadFile(path.join(root, 'dev/tests/academic.pdf'));
    await viewer.waitForFunction(() => document.getElementById('docName').textContent === 'academic.pdf' && !document.getElementById('openBookmarks').disabled);
    const data = await readingData(viewer, documentId);
    assert.ok(data.notes.some((entry) => entry.page === 2 && entry.text.includes('原始术语')));
    assert.ok(data.notes.some((entry) => entry.page === 3 && entry.text === '第 3 页即时笔记'));
    assert.equal(await readingData(viewer, new URL(viewer.url()).searchParams.get('document')), null);
  });
  const fresh = await page(`viewer.html?document=${documentId}`);
  await fresh.waitForFunction(() => !document.getElementById('openBookmarks').disabled);
  await check('a fresh reader restores notes, exports Markdown and preserves native browser shortcuts in the library', async () => {
    await fresh.click('#openBookmarks');
    assert.equal(await fresh.$$eval('.reader-bookmark-row', (elements) => elements.length), 2);
    const session = await browser.target().createCDPSession(); await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await fresh.click('.reader-bookmark-actions button:nth-child(2)');
    let files = [];
    for (let attempt = 0; attempt < 50; attempt++) { files = (await fs.readdir(downloads)).filter((file) => file.endsWith('.md')); if (files.length) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    assert.equal(files.length, 1); const markdown = await fs.readFile(path.join(downloads, files[0]), 'utf8');
    assert.match(markdown, /## 第 2 页/); assert.match(markdown, /第 3 页即时笔记/); assert.ok(!markdown.includes('<img'));
    await fresh.click('#openLibrary'); await fresh.waitForFunction(() => document.body.dataset.view === 'library');
    assert.equal(await fresh.$eval('#readerSidebar', (element) => getComputedStyle(element).display), 'none');
    assert.equal(await fresh.evaluate(() => { const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.body.dispatchEvent(event); return event.defaultPrevented; }), false);
    await session.detach();
  });
  await check('mobile sidebar stays within the screen and closes with Escape', async () => {
    await fresh.goto(origin + `viewer.html?document=${documentId}`); await fresh.setViewport({ width: 390, height: 844 });
    await fresh.waitForFunction(() => !document.getElementById('openBookmarks').disabled); await fresh.click('#openBookmarks');
    const bounds = await fresh.$eval('#readerSidebar', (element) => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }; });
    assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.height > 250);
    await screenshot(fresh, path.join(artifacts, 'reader-mobile.png'));
    await fresh.keyboard.press('Escape'); assert.equal(await fresh.$eval('#readerSidebar', (element) => element.hidden), true);
  });
  await check('two real reader windows merge independent page notes instead of overwriting each other', async () => {
    await fresh.setViewport({ width: 1440, height: 1000 }); await goPage(fresh, 1); await fresh.click('#openBookmarks');
    const another = await page(`viewer.html?document=${documentId}`);
    await another.waitForFunction(() => !document.getElementById('openBookmarks').disabled);
    await goPage(another, 4); await another.click('#openBookmarks');
    await Promise.all([[fresh, 'first window'], [another, 'second window']].map(([viewer, value]) => viewer.$eval('#readerNote', (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }, value)));
    await Promise.all([fresh, another].map((viewer) => viewer.waitForFunction(() => document.getElementById('readerNoteStatus').textContent === '已保存在本机', { polling: 50 })));
    const data = await readingData(fresh, documentId);
    assert.ok(data.notes.some((entry) => entry.page === 1 && entry.text === 'first window'));
    assert.ok(data.notes.some((entry) => entry.page === 4 && entry.text === 'second window'));
    assert.ok(data.notes.some((entry) => entry.page === 2 && entry.text.includes('原始术语')));
    await another.close();
  });

  // Failure and cancellation checks use only a disposable extension fixture, never the user's library.
  await fs.writeFile(path.join(extensionPath, 'src/reader-fixture.html'), '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><link rel="stylesheet" href="viewer.css"><link rel="stylesheet" href="reader-tools.css"><body data-view="reader" data-document-mode="original"><header><button id="openOutline">目录</button><button id="openSearch">查找</button><button id="openBookmarks">笔记</button><button id="addBookmark">书签</button></header><div id="readingWorkspace"><aside id="readerSidebar" hidden></aside><main id="viewport"></main></div><script type="module" src="reader-fixture.mjs"></script></body></html>');
  await fs.writeFile(path.join(extensionPath, 'src/reader-fixture.mjs'), `import {createReaderTools} from './reader-tools.mjs';
const records = new Map();
const flags = {delay:15, fail:false, deleted:false, writes:0};
const pdf = {numPages:400,getOutline:async()=>null,getPage:async()=>({getTextContent:async()=>{await new Promise(resolve=>setTimeout(resolve,flags.delay));return {items:[{str:'match page text',transform:[10,0,0,10,10,700],width:70}]};}})};
const state = {pdf,numPages:400,currentPage:1,entries:new Map()};
const library={loadState:async(id)=>structuredClone(records.get(id)||null),saveState:async(id,kind,value)=>{if(flags.fail)throw new Error('quota');if(flags.deleted)return false;flags.writes++;records.set(id,structuredClone(value));return true;}};
const tools=createReaderTools({state,library,goToPage(page){state.currentPage=page;tools.pageChanged();}});
window.fixture={records,flags,pdf,state,library,tools};await tools.loaded({id:'fixture-a',name:'fixture.pdf'});window.ready=true;`);
  const fixture = await page('reader-fixture.html'); await fixture.waitForFunction(() => window.ready);
  await check('large-document find stops promptly and never appends stale results after cancellation', async () => {
    await fixture.click('#openSearch'); await fixture.type('#readerSearchInput', 'match'); await fixture.click('.reader-search-form button');
    await fixture.waitForFunction(() => document.querySelectorAll('.reader-result').length > 3);
    await fixture.click('.reader-search-controls button:last-child');
    const count = await fixture.$$eval('.reader-result', (elements) => elements.length);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await fixture.$$eval('.reader-result', (elements) => elements.length), count);
    assert.match(await fixture.$eval('#readerSearchStatus', (element) => element.textContent), /已停止/);
    await fixture.evaluate(() => { window.fixture.flags.delay = 0; });
    await fixture.click('.reader-search-form button');
    await fixture.waitForFunction(() => document.getElementById('readerSearchStatus').textContent.includes('前 250'));
    assert.equal(await fixture.$$eval('.reader-result', (elements) => elements.length), 250);
  });
  await check('save failures are visible, retry works, and concurrent foreign notes survive a local save', async () => {
    await fixture.click('#openBookmarks'); await fixture.evaluate(() => { window.fixture.flags.fail = true; });
    await fixture.$eval('#readerNote', (input) => { input.value = 'local note'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await fixture.waitForFunction(() => document.getElementById('readerNoteStatus').textContent.includes('保存失败'));
    await fixture.evaluate(() => { window.fixture.flags.fail = false; window.fixture.records.set('fixture-a',{bookmarks:[{page:9}],notes:[{page:9,text:'foreign note'}]}); });
    await fixture.click('.reader-save-retry'); await fixture.waitForFunction(() => document.getElementById('readerNoteStatus').textContent === '已保存在本机');
    const data = await fixture.evaluate(() => window.fixture.records.get('fixture-a'));
    assert.ok(data.notes.some((entry) => entry.page === 1 && entry.text === 'local note'));
    assert.ok(data.notes.some((entry) => entry.page === 9 && entry.text === 'foreign note'));
  });
  await check('late writes cannot recreate a deleted document, and flush reports an unpersisted draft', async () => {
    const before = await fixture.evaluate(() => { window.fixture.flags.deleted = true; return window.fixture.flags.writes; });
    await fixture.$eval('#readerNote', (input) => { input.value = 'deleted document draft'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await fixture.waitForFunction(() => document.getElementById('readerNoteStatus').textContent.includes('文档已移除'));
    assert.equal(await fixture.evaluate(() => window.fixture.flags.writes), before);
    assert.equal(await fixture.evaluate(async () => { try { await window.fixture.tools.flush(); return false; } catch (_) { return true; } }), true);
    assert.equal(await fixture.evaluate(() => window.fixture.tools.hasUnsaved()), true);
  });
  await check('a slow previous document hydration cannot overwrite the current document notes', async () => {
    const note = await fixture.evaluate(async () => {
      const { tools, state, pdf, library } = window.fixture;
      await tools.beforeClose();
      let release;
      library.loadState = async (id) => id === 'slow' ? new Promise((resolve) => { release = resolve; }) : { notes: [{ page: 1, text: 'current document' }] };
      state.pdf = { ...pdf }; const previous = tools.loaded({ id: 'slow', name: 'old.pdf' });
      state.pdf = { ...pdf }; await tools.loaded({ id: 'fast', name: 'current.pdf' });
      release({ notes: [{ page: 1, text: 'stale previous document' }] }); await previous;
      return document.getElementById('readerNote').value;
    });
    assert.equal(note, 'current document');
  });
  assert.deepEqual(errors, []);
  console.log(`All ${count} reader browser checks passed.`);
} finally {
  await harness.cleanup();
  const resolved = path.resolve(temporary);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('pdf-reader-check-')) throw new Error('Invalid reader test cleanup target');
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
}
