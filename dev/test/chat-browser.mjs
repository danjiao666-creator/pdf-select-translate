import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchExtension, screenshot } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifacts = path.join(root, 'dev/test/artifacts');
await fs.mkdir(artifacts, { recursive: true });
const requests = [], failures = [];
let mode = 'normal', completed = 0, aborted = 0, count = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    const body = JSON.parse(raw), requestMode = mode;
    let envelope;
    try { envelope = JSON.parse(body.messages.at(-1).content); } catch (_) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: '受控翻译测试' }, finish_reason: 'stop' }] })); return;
    }
    requests.push({ body, envelope, mode: requestMode });
    if (requestMode === 'auth') { res.writeHead(401); res.end('{"error":"test authentication"}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const page = envelope.PDF_EVIDENCE_DATA[0].page;
    const chunk = (content, finish_reason) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, ...(finish_reason ? { finish_reason } : {}) }] })}\n\n`);
    chunk(`## 依据原文\n本轮提供了相关研究段落 [p. ${page}]。\n`);
    const timer = setTimeout(() => {
      chunk('\n## 分析/推断\n这是受控测试回答，不代表真实 AI 质量。\n<img src=x onerror="window.chatXss=true">\n[危险链接](javascript:window.chatXss=true)\n未提供的引用 [p. 999]。', 'stop');
      res.end('data: [DONE]\n\n'); completed++;
    }, requestMode === 'hold' ? 10000 : 1100);
    res.on('close', () => { clearTimeout(timer); if (!res.writableEnded) aborted++; });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const harness = await launchExtension(root), { browser, id } = harness;
const origin = `chrome-extension://${id}/src/`;
const page = await browser.newPage(); page.on('pageerror', (error) => failures.push(error.message));
await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
await page.setViewport({ width: 1440, height: 1040 });
async function check(name, action) {
  let timer;
  try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 45000); })]); }
  finally { clearTimeout(timer); }
  console.log(`PASS ${++count} ${name}`);
}
async function importPdf(name = 'academic.pdf') {
  await (await page.$('#fileInput')).uploadFile(path.join(root, 'dev/tests', name));
  await page.waitForFunction((name) => !document.getElementById('fileInput').files.length && document.getElementById('docName').textContent === name && !document.getElementById('openArticleChat').disabled, {}, name);
}
async function ask(text) { await page.$eval('#chatInput', (node, text) => { node.value = text; node.dispatchEvent(new Event('input', { bubbles: true })); }, text); await page.click('#chatSend'); }
async function latestChatState() { return page.evaluate(async () => { const { library } = await import('./library.mjs'); const id = new URL(location.href).searchParams.get('document'); return library.loadState(id, 'chat'); }); }
try {
  await page.goto(origin + 'viewer.html'); await page.bringToFront();
  await page.evaluate((base) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { custom: { baseUrl: base, apiKey: 'browser-test-key-only', model: 'chat-controlled-test' } } }), base);
  await importPdf();
  await check('integrated panel starts with grounded, functional copy and no automatic API request', async () => {
    await page.click('#openArticleChat'); await page.waitForSelector('#articleChatPanel:not([hidden])');
    assert.match(await page.$eval('#chatPrivacy', (node) => node.textContent), /不上传 PDF/); assert.equal(requests.length, 0);
    await page.click('[data-chat-prompt]'); assert.match(await page.$eval('#chatInput', (node) => node.value), /核心方法/); assert.equal(requests.length, 0);
  });
  await check('IME composition Enter does not accidentally submit a question', async () => {
    await page.$eval('#chatInput', (node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
    assert.equal(requests.length, 0);
  });
  await check('grounded streaming sends only bounded actual article excerpts and enables page navigation', async () => {
    await page.click('#chatSend');
    await page.waitForFunction(() => document.querySelector('.chat-message-assistant .chat-message-content')?.textContent.includes('依据原文'));
    assert.equal(requests.length, 1); assert.equal(requests[0].body.stream, true); assert.ok(requests[0].envelope.PDF_EVIDENCE_DATA.length > 0);
    assert.ok(requests[0].envelope.PDF_EVIDENCE_DATA.every((item) => item.page <= 3 && item.text.length <= 3200));
    assert.ok(requests[0].envelope.PDF_EVIDENCE_DATA.some((item) => /translation|retrieval|scientific|Introduction/i.test(item.text)));
    assert.equal(await page.$eval('#chatStop', (node) => node.hidden), false);
    await page.waitForFunction(() => document.querySelector('.chat-message-assistant')?.dataset.status === 'done');
    assert.match(await page.$eval('.chat-evidence', (node) => node.textContent), /实际提供给 AI/);
    await screenshot(page, path.join(artifacts, 'chat-controlled-response.png'));
    await page.click('.chat-message-content .chat-citation');
    await page.waitForFunction((page) => Number(document.getElementById('pageInput').value) === page, {}, requests[0].envelope.PDF_EVIDENCE_DATA[0].page);
  });
  await check('model HTML, javascript links and unsupported citations cannot execute or navigate', async () => {
    assert.equal(await page.evaluate(() => window.chatXss || false), false);
    assert.equal((await page.$$('.chat-message-content img,.chat-message-content a')).length, 0);
    assert.equal((await page.$$('.chat-citation-unverified')).length, 1);
    assert.match(await page.$eval('.chat-message-assistant', (node) => node.textContent), /<img src=x/);
  });
  await check('conversation and source evidence persist in the current document, including draft text', async () => {
    await page.$eval('#chatInput', (node) => { node.value = '保留未发送的问题'; node.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(async () => { const { library } = await import('./library.mjs'); const id = new URL(location.href).searchParams.get('document'); const saved = await library.loadState(id, 'chat'); return saved?.messages.length === 2 && saved.draft === '保留未发送的问题'; });
    const saved = await latestChatState(); assert.equal(saved.messages[1].status, 'done'); assert.ok(saved.messages[1].evidence.length);
    await page.reload(); await page.waitForFunction(() => !document.getElementById('openArticleChat').disabled);
    await page.click('#openArticleChat'); await page.waitForSelector('.chat-message-assistant');
    assert.equal(await page.$eval('#chatInput', (node) => node.value), '保留未发送的问题'); assert.equal((await page.$$('.chat-message')).length, 2);
  });
  await check('new conversation requires confirmation, and cancellation preserves records', async () => {
    await page.click('#chatNew'); await page.waitForSelector('#chatResetDialog[open]'); await page.click('#chatResetCancel'); assert.equal((await page.$$('.chat-message')).length, 2);
    await page.click('#chatNew'); await page.click('#chatResetConfirm'); await page.waitForFunction(() => !document.querySelector('.chat-message'));
    await page.waitForFunction(async () => { const { library } = await import('./library.mjs'); const id = new URL(location.href).searchParams.get('document'); return (await library.loadState(id, 'chat'))?.messages.length === 0; });
  });
  await check('cancelling a stream keeps a visibly incomplete answer and stops its transport', async () => {
    mode = 'hold'; await ask('请解释研究方法'); await page.waitForFunction(() => document.querySelector('.chat-message-assistant .chat-message-content')?.textContent.includes('依据原文'));
    await page.click('#chatStop'); await page.waitForFunction(() => document.querySelector('.chat-message-assistant')?.dataset.status === 'cancelled');
    assert.match(await page.$eval('.chat-message-assistant .chat-message-error', (node) => node.textContent), /仍可能产生用量/);
    const previous = requests.length; await new Promise((resolve) => setTimeout(resolve, 300)); assert.equal(requests.length, previous);
    const saved = await latestChatState(); assert.equal(saved.messages[1].status, 'cancelled'); assert.ok(saved.messages[1].content);
  });
  await check('switching PDFs fences late responses and preserves the old document conversation', async () => {
    await ask('另一个问题，解释实验'); await page.waitForFunction(() => document.querySelectorAll('.chat-message-assistant').length === 2 && document.querySelectorAll('.chat-message-assistant')[1].textContent.includes('依据原文'));
    const previousUrl = page.url();
    await importPdf('sample.pdf'); assert.notEqual(page.url(), previousUrl);
    await page.click('#openArticleChat'); assert.equal((await page.$$('.chat-message')).length, 0);
    await new Promise((resolve) => setTimeout(resolve, 300)); assert.equal((await page.$$('.chat-message')).length, 0);
  });
  await check('HTTP 401 is shown as authentication failure without a fake answer or retry', async () => {
    mode = 'auth'; const before = requests.length; await ask('这篇文章讲了什么？');
    await page.waitForFunction(() => document.querySelector('.chat-message-assistant')?.dataset.status === 'error');
    assert.match(await page.$eval('.chat-message-assistant .chat-message-error', (node) => node.textContent), /401/);
    assert.equal(await page.$eval('.chat-message-assistant .chat-message-content', (node) => node.textContent), '');
    assert.equal(requests.length, before + 1);
    await page.$eval('.chat-message-assistant .chat-message-actions', (node) => [...node.querySelectorAll('button')].find((button) => button.textContent === '重试').click());
    await page.waitForFunction(() => document.querySelectorAll('.chat-message-assistant').length === 2 && document.querySelectorAll('.chat-message-assistant')[1].dataset.status === 'error');
    assert.equal(requests.length, before + 2, 'only the explicit Retry action sends a second request');
  });
  await check('selection explanation previews actual text before sending, on the source PDF page', async () => {
    await page.click('#chatClose');
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'saveSettings', settings: { engine: 'custom', fastFirst: false, sentenceMode: true, autoTranslate: true } }));
    await page.waitForFunction(() => document.getElementById('engine').value === 'custom' && document.getElementById('autoTranslate').checked);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await page.waitForSelector('.textLayer span');
    await page.evaluate(() => {
      const span = [...document.querySelectorAll('.textLayer span')].find((node) => node.textContent.includes('quick brown fox'));
      const offset = span.textContent.indexOf('quick brown fox'), range = document.createRange();
      range.setStart(span.firstChild, offset); range.setEnd(span.firstChild, offset + 'quick brown fox'.length);
      getSelection().removeAllRanges(); getSelection().addRange(range); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForSelector('#card:not([hidden])'); await page.click('#cardAsk');
    await page.waitForSelector('#chatSelection:not([hidden])');
    assert.match(await page.$eval('#chatSelectionText', (node) => node.textContent), /quick brown fox/);
    assert.match(await page.$eval('#chatSelectionPage', (node) => node.textContent), /第 1 页/);
    assert.match(await page.$eval('#chatInput', (node) => node.value), /解释这段话/);
    await page.evaluate(async () => {
      const { appendChatText } = await import('./article-chat.mjs');
      const target = document.createElement('div'); document.body.append(target);
      appendChatText(target, '**safe** <svg onload="window.chatXss=true"> [p. 1] [第 999 页]', { pages: [1], goToPage() {} });
      if (target.querySelector('svg,img,a') || target.querySelectorAll('button').length !== 1) throw new Error('Unsafe chat renderer'); target.remove();
    });
    assert.equal(await page.evaluate(() => window.chatXss || false), false);
    await page.waitForFunction(async () => { const { library } = await import('./library.mjs'); const id = new URL(location.href).searchParams.get('document'); return (await library.loadState(id, 'chat'))?.selection?.page === 1; });
    await page.reload(); await page.waitForFunction(() => !document.getElementById('openArticleChat').disabled); await page.click('#openArticleChat');
    assert.match(await page.$eval('#chatSelectionText', (node) => node.textContent), /quick brown fox/);
  });
  await check('chat fits desktop and phone viewport with no offscreen composer', async () => {
    await screenshot(page, path.join(artifacts, 'chat-desktop.png'));
    await page.setViewport({ width: 390, height: 844 });
    await page.waitForFunction(() => {
      const rect = document.getElementById('articleChatPanel').getBoundingClientRect(), composer = document.querySelector('.chat-composer').getBoundingClientRect();
      return rect.x >= -1 && rect.right <= innerWidth + 1 && composer.bottom <= innerHeight + 1;
    });
    const box = await page.$eval('#articleChatPanel', (node) => { const rect = node.getBoundingClientRect(); const composer = node.querySelector('.chat-composer').getBoundingClientRect(); return { x: rect.x, width: rect.width, right: rect.right, bottom: composer.bottom }; });
    assert.ok(box.x >= -1 && box.right <= 391 && box.bottom <= 845, JSON.stringify(box));
    await screenshot(page, path.join(artifacts, 'chat-mobile.png'));
  });
  const naturePdf = process.env.PDF_REPRO_FILE || 'C:/Users/dingj/Downloads/s41467-020-18353-4.pdf';
  try {
    await fs.access(naturePdf);
    await check('real 13-page scientific PDF produces page-grounded, column-ordered retrieval evidence', async () => {
      await page.setViewport({ width: 1440, height: 1040 }); mode = 'normal';
      await (await page.$('#fileInput')).uploadFile(naturePdf);
      await page.waitForFunction(() => !document.getElementById('fileInput').files.length && document.getElementById('pageCount').textContent === '13' && !document.getElementById('openArticleChat').disabled);
      await page.click('#openArticleChat'); await ask('请概括这篇风险驾驶模型文章的核心方法、驾驶员风险场与研究局限。');
      await page.waitForFunction(() => document.querySelector('.chat-message-assistant')?.dataset.status === 'done');
      const evidence = requests.at(-1).envelope.PDF_EVIDENCE_DATA;
      assert.equal(requests.at(-1).envelope.DOCUMENT.totalPdfPages, 13); assert.ok(evidence.every((item) => item.page >= 1 && item.page <= 13));
      assert.ok(evidence.some((item) => /risk|driv|model/i.test(item.text))); assert.ok(evidence.every((item) => !/^fi$|^car$/i.test(item.text.trim())));
      assert.ok(new Set(evidence.map((item) => item.page)).size >= 3);
      await screenshot(page, path.join(artifacts, 'chat-real-paper-controlled-answer.png'));
    });
  } catch (error) { if (error.code === 'ENOENT') console.log('SKIP optional real paper file not present'); else throw error; }
  assert.equal(failures.length, 0, failures.join('\n')); assert.ok(aborted >= 1); assert.ok(completed >= 1);
  console.log(`PASS ${count} article-chat browser checks (controlled endpoint; not real AI quality acceptance)`);
} finally {
  await harness.cleanup(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
