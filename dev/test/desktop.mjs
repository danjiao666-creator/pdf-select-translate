import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = process.env.DESKTOP_SOURCE === '1';
const requestedExecutable = process.env.DESKTOP_EXE || path.join(root, source ? 'node_modules/electron/dist/electron.exe' : 'dist/desktop/win-unpacked/PaperTranslator.exe');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'paper-desktop-smoke-'));
const dataDirectory = path.join(temporary, 'profile');
const artifacts = path.join(root, 'dev/test/artifacts');
await fs.mkdir(artifacts, { recursive: true });
await fs.access(requestedExecutable);
// Test the package from an ASCII, non-OneDrive runtime path without touching user data.
const runtimeDirectory = path.join(temporary, 'runtime');
let executable;
if (process.env.DESKTOP_PACKAGE_ZIP && !source) {
  const { extract } = await import('@electron-internal/extract-zip');
  await fs.mkdir(runtimeDirectory);
  await extract(path.resolve(process.env.DESKTOP_PACKAGE_ZIP), { dir: runtimeDirectory });
  executable = path.join(runtimeDirectory, 'PaperTranslator', 'PaperTranslator.exe');
  await fs.access(executable);
} else {
  await fs.cp(path.dirname(requestedExecutable), runtimeDirectory, { recursive: true });
  executable = path.join(runtimeDirectory, path.basename(requestedExecutable));
}

let rejectApi = false;
let delayApi = 0;
const received = [];
const server = http.createServer((request, response) => {
  let text = '';
  request.on('data', (chunk) => { text += chunk; });
  request.on('end', () => {
    if (request.method !== 'POST') { response.writeHead(404); response.end(); return; }
    const body = JSON.parse(text);
    received.push(body);
    if (rejectApi) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'controlled test rejection' } }));
      return;
    }
    const content = body.messages[0].content.includes('scientific-paper reading assistant')
      ? '依据原文，研究比较文献翻译结果。[p. 1] 分析需结合更多原文核对。'
      : '研究结果表明，翻译质量有所提高。';
    setTimeout(() => {
      if (response.destroyed) return;
      if (body.stream) {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(0, 12) } }] })}\n\n`);
        setTimeout(() => {
          if (response.destroyed) return;
          response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(12) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
        }, 120);
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
      }
    }, delayApi);
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/v1`;
const portServer = http.createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const debugPort = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const args = [...(source ? [root] : []), `--app-data-dir=${dataDirectory}`, `--remote-debugging-port=${debugPort}`, '--test-hidden', path.join(root, 'dev/tests/academic.pdf')];
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: environment });
let diagnostics = '';
child.stdout.on('data', (chunk) => { diagnostics += chunk; });
child.stderr.on('data', (chunk) => { diagnostics += chunk; });
const errors = [];
let browser;
let count = 0;
async function check(name, action) {
  let timer;
  try { await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 45000); })]); }
  finally { clearTimeout(timer); }
  console.log(`PASS ${++count} ${name}`);
}
async function waitFunction(page, fn, ...args) { return page.waitForFunction(fn, { timeout: 30000, polling: 100 }, ...args); }
try {
  const deadline = Date.now() + 45000;
  while (!browser && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Desktop exited ${child.exitCode}: ${diagnostics}`);
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${debugPort}`, defaultViewport: null }); }
    catch (_) { await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!browser) throw new Error('Desktop debugging endpoint did not start: ' + diagnostics);
  const target = await browser.waitForTarget((target) => target.type() === 'page' && target.url().startsWith('pdf-translator://app/src/viewer.html'), { timeout: 30000 });
  const viewer = await target.page();
  viewer.on('pageerror', (error) => errors.push(error.message));
  await check('native executable opens PDF from argv after reader initialization', async () => {
    await viewer.waitForSelector('.textLayer span', { timeout: 30000 });
    assert.equal(await viewer.$eval('#docName', (element) => element.textContent), 'academic.pdf');
    assert.equal(await viewer.$eval('#pageCount', (element) => element.textContent), '3');
    assert.equal(await viewer.evaluate(() => window.desktopBridge.isDesktop), true);
    assert.equal(await viewer.evaluate(() => isSecureContext && Boolean(navigator.locks)), true);
  });
  await check('renderer has no Node, generic filesystem, or packaged credential access', async () => {
    const value = await viewer.evaluate(async () => ({
      require: typeof window.require, process: typeof window.process, genericInvoke: typeof window.paperDesktop.invoke,
      keyFile: (await fetch(chrome.runtime.getURL('config.local.json'))).status,
      backend: (await fetch(chrome.runtime.getURL('desktop/main.cjs'))).status,
      badMessage: await chrome.runtime.sendMessage({ type: 'readFile', filename: 'config.local.json' })
    }));
    assert.equal(value.require, 'undefined'); assert.equal(value.process, 'undefined'); assert.equal(value.genericInvoke, 'undefined');
    assert.equal(value.keyFile, 404); assert.equal(value.backend, 404); assert.equal(value.badMessage.ok, false);
  });
  await check('native secure storage saves settings without key echo or plaintext disk', async () => {
    const result = await viewer.evaluate((baseUrl) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: {
      engine: 'custom', fastFirst: false, theme: 'light', targetLang: 'zh-CN',
      custom: { baseUrl, model: 'controlled-test', apiKey: 'desktop-test-only-not-a-real-key' }
    } }), base);
    assert.equal(result.ok, true); assert.equal(result.settings.custom.apiKey, ''); assert.equal(result.settings.custom.apiKeyConfigured, true);
    const publicRead = await viewer.evaluate(() => chrome.storage.local.get('settings'));
    assert.equal(publicRead.settings.custom.apiKey, '');
    const disk = await fs.readFile(path.join(dataDirectory, 'preferences.json'), 'utf8');
    assert.ok(!disk.includes('desktop-test-only-not-a-real-key'));
    assert.ok(JSON.parse(disk).credential.length > 40);
  });
  await check('shared provider translates through native proxy-aware network bridge', async () => {
    const result = await viewer.evaluate(() => chrome.runtime.sendMessage({ type: 'testTranslate', engine: 'custom', text: 'The findings suggest an improvement in translation quality.', to: 'zh-CN', from: 'en' }));
    assert.equal(result.ok, true, result.error); assert.match(result.translation, /研究结果/);
  });
  await check('article conversation streams grounded text and page links in actual desktop renderer', async () => {
    await viewer.click('#openArticleChat');
    await viewer.type('#chatInput', '请概括文章的研究方法。');
    await viewer.click('#chatSend');
    await waitFunction(viewer, () => document.querySelector('.chat-message-assistant')?.textContent.includes('依据原文') && document.getElementById('chatStop').hidden);
    assert.ok(await viewer.$('.chat-message-content .chat-citation'));
    await viewer.screenshot({ path: path.join(artifacts, source ? 'desktop-source-chat.png' : 'desktop-packaged-chat.png') });
  });
  await check('401 stays an explicit failure without free-provider fallback', async () => {
    rejectApi = true;
    const requestCount = received.length;
    const result = await viewer.evaluate(() => chrome.runtime.sendMessage({ type: 'testTranslate', engine: 'custom', text: 'A different scientific sentence for the failed service test.', to: 'zh-CN', from: 'en' }));
    assert.equal(result.ok, false); assert.match(result.error, /401/);
    assert.equal(received.length, requestCount + 1);
    rejectApi = false;
  });
  await check('native settings window uses shared options without renderer credentials', async () => {
    await viewer.evaluate(() => chrome.runtime.openOptionsPage());
    const optionsTarget = await browser.waitForTarget((target) => target.type() === 'page' && target.url().endsWith('/src/options.html'));
    const options = await optionsTarget.page();
    await waitFunction(options, () => document.getElementById('apiState').textContent === '已配置');
    assert.equal(await options.$eval('#customApiKey', (element) => element.value), '');
    assert.equal(await options.$eval('#customBaseUrl', (element) => element.value), base);
    await options.close();
  });
  await check('document library and article discussion survive renderer reload', async () => {
    await viewer.reload({ waitUntil: 'domcontentloaded' });
    await viewer.waitForSelector('.textLayer span');
    await viewer.click('#openArticleChat');
    await waitFunction(viewer, () => document.querySelector('.chat-message-assistant')?.textContent.includes('依据原文'));
    const documents = await viewer.evaluate(async () => (await import('./library.mjs')).library.list());
    assert.equal(documents.length, 1); assert.equal(documents[0].name, 'academic.pdf');
  });
  await check('in-flight article request can be stopped over allowlisted IPC', async () => {
    delayApi = 3000;
    await viewer.type('#chatInput', '停止测试：请解释结果。');
    await viewer.click('#chatSend');
    await waitFunction(viewer, () => !document.getElementById('chatStop').hidden);
    await new Promise((resolve) => setTimeout(resolve, 250));
    await viewer.click('#chatStop');
    await waitFunction(viewer, () => document.getElementById('chatStop').hidden);
    delayApi = 0;
  });
  await check('native close requests consult asynchronous task guard and can be cancelled', async () => {
    delayApi = 3000;
    await viewer.type('#chatInput', '关闭测试：请解释结论。');
    await viewer.click('#chatSend');
    await waitFunction(viewer, () => !document.getElementById('chatStop').hidden);
    await viewer.evaluate(() => window.desktopBridge.requestClose());
    await waitFunction(viewer, () => document.getElementById('closeAppDialog').open);
    await viewer.click('#closeAppDialog button[value="cancel"]');
    assert.equal(viewer.isClosed(), false);
    await viewer.click('#chatStop');
    await waitFunction(viewer, () => document.getElementById('chatStop').hidden);
    delayApi = 0;
  });
  await check('native close dialog also protects an actual full-document translation task', async () => {
    delayApi = 1800;
    await viewer.click('#chatClose');
    await viewer.click('#openFullTranslation');
    await viewer.click('#startDocumentTranslation');
    await waitFunction(viewer, () => !document.getElementById('pauseDocumentTranslation').hidden);
    await viewer.evaluate(() => window.desktopBridge.requestClose());
    await waitFunction(viewer, () => document.getElementById('closeAppDialog').open);
    await viewer.click('#closeAppDialog button[value="cancel"]');
    assert.equal(viewer.isClosed(), false);
    await viewer.click('#pauseDocumentTranslation');
    await waitFunction(viewer, () => document.getElementById('documentTranslationStatus').textContent.includes('已暂停'));
    delayApi = 0;
  });
  await check('native password dialog retries without unsupported window.prompt and does not retain passwords', async () => {
    await (await viewer.$('#fileInput')).uploadFile(path.join(root, 'dev/tests/protected.pdf'));
    await waitFunction(viewer, () => document.getElementById('passwordDialog').open);
    await viewer.type('#pdfPassword', 'incorrect-test');
    await viewer.click('#passwordForm button[type="submit"]');
    await waitFunction(viewer, () => document.getElementById('passwordDialog').open && document.getElementById('passwordLabel').textContent.includes('错误'));
    await viewer.type('#pdfPassword', 'reader-test');
    await viewer.click('#passwordForm button[type="submit"]');
    await waitFunction(viewer, () => !document.getElementById('passwordDialog').open && document.getElementById('docName').textContent === 'protected.pdf' && document.querySelector('.textLayer span'));
    await viewer.reload({ waitUntil: 'domcontentloaded' });
    await waitFunction(viewer, () => document.getElementById('passwordDialog').open);
    assert.equal(await viewer.$eval('#pdfPassword', (element) => element.value), '');
    await viewer.click('#passwordDialog button[data-close-dialog]');
    await waitFunction(viewer, () => !document.getElementById('passwordDialog').open && document.body.dataset.view === 'library');
    const publicDocuments = await viewer.evaluate(async () => (await import('./library.mjs')).library.list());
    assert.equal(publicDocuments.length, 2);
    assert.ok(!JSON.stringify(publicDocuments).includes('reader-test'));
  });
  await check('desktop renderer reports no JavaScript errors', async () => { assert.deepEqual(errors, []); });
  await check('idle application closes normally after flushing saved state', async () => {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await viewer.evaluate(() => window.desktopBridge.requestClose()).catch(() => {});
    const code = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Application did not close')), 15000))]);
    assert.equal(code, 0);
  });
  console.log(`${count} desktop executable checks passed (${source ? 'development runtime' : 'packaged executable'}). API output is controlled test data, not real translation acceptance.`);
} catch (error) {
  if (diagnostics) console.error(diagnostics.slice(-6000));
  throw error;
} finally {
  browser?.disconnect();
  if (child.exitCode == null) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode != null) { resolve(); return; }
    child.once('exit', resolve); setTimeout(resolve, 8000).unref();
  });
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('paper-desktop-smoke-'));
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
}
