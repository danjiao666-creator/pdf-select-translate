import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension } from './browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = await launchExtension(root), { browser, id } = harness;
const page = await browser.newPage();
const errors = []; page.on('pageerror', (error) => errors.push(error.message));
let count = 0;
async function check(name, action) {
  let timer;
  try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 45000); })]); }
  finally { clearTimeout(timer); }
  console.log(`PASS ${++count} ${name}`);
}
async function draft(value) { await page.$eval('#chatInput', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value); }
async function flushError() { return page.evaluate(async () => { try { await window.chatFault.api.flush(); return ''; } catch (error) { return error.message; } }); }
try {
  await page.goto(`chrome-extension://${id}/src/options.html`);
  await page.waitForFunction(() => Boolean(document.getElementById('customModel').value));
  await page.evaluate(async () => {
    document.body.replaceChildren();
    const toggle = document.createElement('button'); toggle.id = 'openArticleChat';
    const panel = document.createElement('aside'); panel.id = 'articleChatPanel'; document.body.append(toggle, panel);
    const { createArticleChat } = await import('./article-chat.mjs');
    const fault = window.chatFault = { readFail: false, saveFail: false, removed: false, saved: null, calls: 0 };
    const library = {
      async loadState() { if (fault.readFail) throw new Error('read blocked'); return structuredClone(fault.saved); },
      async saveState(_id, _kind, value) { fault.calls++; if (fault.saveFail) throw new Error('quota'); if (fault.removed) return false; fault.saved = structuredClone(value); return true; }
    };
    fault.api = createArticleChat({ state: { pdf: { numPages: 1 }, currentPage: 1, settings: { custom: { model: 'test', baseUrl: 'http://127.0.0.1/v1' } } },
      send: async () => ({ ok: false }), library, goToPage() {}, toast() {} });
    await fault.api.loaded({ id: 'storage-fixture', name: 'fixture.pdf', numPages: 1 }); fault.api.open();
  });
  await check('unchanged hydrated chat does not report unsaved data or block closing', async () => {
    assert.equal(await page.evaluate(() => window.chatFault.api.hasUnsaved()), false);
    assert.equal(await flushError(), ''); assert.equal(await page.evaluate(() => window.chatFault.calls), 0);
  });
  await check('quota failure keeps a changed draft exportable and strict flush rejects', async () => {
    await page.evaluate(() => { window.chatFault.saveFail = true; }); await draft('不能静默丢失的草稿');
    assert.match(await flushError(), /未能保存/); assert.equal(await page.evaluate(() => window.chatFault.api.hasUnsaved()), true);
    assert.match(await page.$eval('#chatStorageError', (node) => node.textContent), /未能保存/);
    assert.equal(await page.$eval('#chatInput', (node) => node.value), '不能静默丢失的草稿');
  });
  await check('strict flush retries after recovery and clears the dirty flag only on successful write', async () => {
    await page.evaluate(() => { window.chatFault.saveFail = false; }); assert.equal(await flushError(), '');
    assert.equal(await page.evaluate(() => window.chatFault.api.hasUnsaved()), false);
    assert.equal(await page.evaluate(() => window.chatFault.saved.draft), '不能静默丢失的草稿');
  });
  await check('a deleted document return value cannot be mistaken for successful persistence', async () => {
    await page.evaluate(() => { window.chatFault.removed = true; }); await draft('已删除文档的临时草稿');
    assert.match(await flushError(), /未能保存/); assert.match(await page.$eval('#chatStorageError', (node) => node.textContent), /已从文档库删除/);
    assert.equal(await page.evaluate(() => window.chatFault.api.hasUnsaved()), true);
  });
  await check('failed hydration never blindly overwrites unread old conversation data', async () => {
    await page.evaluate(async () => {
      const fault = window.chatFault; fault.removed = false; fault.readFail = true;
      fault.saved = { version: 1, updatedAt: 100, draft: 'Unread old draft', messages: [{ id: 'old', role: 'user', content: 'Unread old conversation', status: 'done' }] };
      await fault.api.loaded({ id: 'another-storage-fixture', name: 'unread.pdf', numPages: 1 });
      fault.beforeBlocked = fault.calls;
    });
    await draft('读取失败后的临时草稿'); assert.match(await flushError(), /读取失败/);
    assert.equal(await page.evaluate(() => window.chatFault.calls), await page.evaluate(() => window.chatFault.beforeBlocked));
    assert.equal(await page.evaluate(() => window.chatFault.saved.messages[0].content), 'Unread old conversation');
    await page.evaluate(() => { window.chatFault.readFail = false; });
    assert.match(await flushError(), /读取失败/);
  });
  await check('replacing unread history requires explicit confirmation, not merely opening the reset dialog', async () => {
    await page.click('#chatNew'); assert.match(await page.$eval('#chatResetDialog', (node) => node.textContent), /覆盖/);
    await page.click('#chatResetCancel'); assert.equal(await page.evaluate(() => window.chatFault.saved.messages.length), 1);
    await page.click('#chatNew'); await page.click('#chatResetConfirm'); assert.equal(await flushError(), '');
    assert.equal(await page.evaluate(() => window.chatFault.saved.messages.length), 0); assert.equal(await page.evaluate(() => window.chatFault.api.hasUnsaved()), false);
  });
  await check('foreign-window edits stop stale autosave instead of replacing the newer shared session', async () => {
    await page.evaluate(async () => {
      await window.chatFault.api.loaded({ id: 'conflict-fixture', name: 'conflict.pdf', numPages: 1 });
      window.chatFault.saved = { version: 1, updatedAt: Date.now() + 1, draft: 'Newer draft from another window', messages: [{ id: 'foreign', role: 'user', content: 'Foreign question', status: 'done' }] };
    });
    await draft('This window has an older draft'); assert.match(await flushError(), /另一窗口/);
    assert.equal(await page.evaluate(() => window.chatFault.saved.draft), 'Newer draft from another window');
    assert.equal(await page.$eval('#chatInput', (node) => node.value), 'This window has an older draft');
    assert.match(await page.$eval('#chatStorageError', (node) => node.textContent), /避免覆盖/);
  });
  await check('an explicitly confirmed new conversation can resolve a shared-history conflict', async () => {
    await page.click('#chatNew'); assert.match(await page.$eval('#chatResetDialog', (node) => node.textContent), /另一窗口的新内容/);
    await page.click('#chatResetConfirm'); assert.equal(await flushError(), ''); assert.equal(await page.evaluate(() => window.chatFault.saved.messages.length), 0);
  });
  await check('two real reader windows serialize simultaneous writes and preserve the losing draft', async () => {
    const a = await browser.newPage(), b = await browser.newPage();
    for (const current of [a, b]) current.on('pageerror', (error) => errors.push(error.message));
    for (const current of [a, b]) await current.setViewport({ width: 1440, height: 1000 });
    await a.bringToFront(); await a.goto(`chrome-extension://${id}/src/viewer.html`);
    await (await a.$('#fileInput')).uploadFile(path.join(root, 'dev/tests/academic.pdf'));
    await a.waitForFunction(() => !document.getElementById('fileInput').files.length && !document.getElementById('openArticleChat').disabled);
    await b.bringToFront(); await b.goto(a.url()); await b.waitForFunction(() => !document.getElementById('openArticleChat').disabled);
    for (const current of [a, b]) { await current.bringToFront(); assert.equal(await current.evaluate(() => Boolean(navigator.locks?.request)), true); await current.click('#openArticleChat'); }
    await Promise.all([[a, 'Window A simultaneous draft'], [b, 'Window B simultaneous draft']].map(([current, value]) => current.$eval('#chatInput', (node, value) => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); }, value)));
    await a.bringToFront(); await a.waitForFunction(async () => { const { library } = await import('./library.mjs'); const id = new URL(location.href).searchParams.get('document'); return Boolean((await library.loadState(id, 'chat'))?.draft); });
    await new Promise((resolve) => setTimeout(resolve, 350));
    const warnings = await Promise.all([a, b].map((current) => current.$eval('#chatStorageError', (node) => node.hidden ? '' : node.textContent)));
    assert.equal(warnings.filter((value) => /另一窗口/.test(value)).length, 1);
    const drafts = await Promise.all([a, b].map((current) => current.$eval('#chatInput', (node) => node.value)));
    assert.deepEqual(drafts, ['Window A simultaneous draft', 'Window B simultaneous draft']);
    const saved = await a.evaluate(async () => { const { library } = await import('./library.mjs'); return library.loadState(new URL(location.href).searchParams.get('document'), 'chat'); });
    assert.ok(drafts.includes(saved.draft));
  });
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`PASS ${count} chat storage failure/conflict browser checks`);
} finally { await harness.cleanup(); }
