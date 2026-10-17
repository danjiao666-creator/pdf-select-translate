'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, net, session, shell } = require('electron');
const { Worker } = require('node:worker_threads');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SecureStore } = require('./secure-store.cjs');
const { APP_ORIGIN, PUSH_TYPES, trustedPage, externalUrl, resourcePath, boundedMessage, safeFilename } = require('./security.cjs');

const ROOT = path.resolve(__dirname, '..');
const VIEWER_URL = APP_ORIGIN + '/src/viewer.html';
const OPTIONS_URL = APP_ORIGIN + '/src/options.html';
const MAX_PDF_BYTES = 200 * 1024 * 1024;
const windows = new Map();
const requests = new Map();
const network = new Map();
let store;
let backend;
let backendReady;
let nextRequest = 0;
let lastReader;
let optionsWindow;
let quitting = false;
let markInitialized;
const initialized = new Promise((resolve) => { markInitialized = resolve; });

app.setName('文献翻译器');
app.setAppUserModelId('org.papertranslator.reader');
const dataArgument = process.argv.find((value) => value.startsWith('--app-data-dir='));
if (dataArgument) {
  const directory = dataArgument.slice('--app-data-dir='.length);
  if (path.isAbsolute(directory)) app.setPath('userData', directory);
}
protocol.registerSchemesAsPrivileged([{
  scheme: 'pdf-translator',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true }
}]);

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', async (_event, argv) => {
    await initialized;
    const reader = readerWindow();
    if (reader.isMinimized()) reader.restore();
    reader.show();
    reader.focus();
    const file = pdfArgument(argv);
    if (file) openPdfPath(file, reader).catch((error) => showError(reader, error.message));
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox('文献翻译器无法启动', error.message || String(error));
    app.exit(1);
  });
}

function pdfArgument(argv) {
  return argv.find((value) => !value.startsWith('-') && /\.pdf$/i.test(value) && path.isAbsolute(value));
}

function readerWindow() {
  if (lastReader && !lastReader.isDestroyed()) return lastReader;
  return createWindow('viewer');
}

function trustedSender(event) {
  const state = windows.get(event.sender.id);
  if (!state || event.senderFrame !== event.sender.mainFrame || !trustedPage(event.senderFrame.url)) throw new Error('请求来源不受信任');
  return state;
}

function notice(window, text, error = false) {
  if (window && !window.isDestroyed()) window.webContents.send('desktop:notice', { text, error });
}

function showError(window, message) {
  if (window && !window.isDestroyed()) {
    dialog.showMessageBox(window, { type: 'error', title: '操作未完成', message: String(message).slice(0, 2000), buttons: ['确定'] });
  }
}

async function external(window, value) {
  const url = externalUrl(value);
  if (!url) { notice(window, '已阻止不安全或不支持的链接。', true); return; }
  const parsed = new URL(url);
  const answer = await dialog.showMessageBox(window, {
    type: 'question', title: '打开外部链接',
    message: '在系统默认浏览器或邮件应用中打开链接？',
    detail: parsed.protocol === 'mailto:' ? url.slice(0, 300) : parsed.origin + parsed.pathname.slice(0, 300),
    buttons: ['打开', '取消'], defaultId: 1, cancelId: 1, noLink: true
  });
  if (answer.response === 0) await shell.openExternal(url);
}

function sendCommand(command, target) {
  const window = target || BrowserWindow.getFocusedWindow() || readerWindow();
  if (command === 'open') return choosePdf(window);
  if (command === 'settings') return openOptions();
  const state = windows.get(window.webContents.id);
  const reader = state?.role === 'viewer' ? window : readerWindow();
  reader.webContents.send('desktop:command', { command });
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '打开 PDF…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
      { label: '新建阅读窗口', accelerator: 'CmdOrCtrl+N', click: () => createWindow('viewer') },
      { label: '文档库', accelerator: 'CmdOrCtrl+L', click: () => sendCommand('library') },
      { label: '导出译文 PDF…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('export') },
      { type: 'separator' },
      { label: '设置…', accelerator: 'CmdOrCtrl+,', click: openOptions },
      { label: '关闭窗口', role: 'close', accelerator: 'CmdOrCtrl+W' },
      { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } }
    ] },
    { label: '编辑', submenu: [
      { label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' }, { type: 'separator' },
      { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' },
      { label: '全选', role: 'selectAll' }, { type: 'separator' },
      { label: '搜索文章', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') }
    ] },
    { label: '阅读', submenu: [
      { label: '文章目录', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('outline') },
      { label: '书签与笔记', accelerator: 'CmdOrCtrl+Shift+B', click: () => sendCommand('bookmarks') },
      { label: '添加当前页书签', accelerator: 'CmdOrCtrl+D', click: () => sendCommand('bookmark') },
      { label: '与 AI 讨论文章', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendCommand('chat') },
      { label: '翻译选中文字', accelerator: 'Alt+Z', click: () => sendCommand('translate-selection') },
      { type: 'separator' },
      { label: '放大', accelerator: 'CmdOrCtrl+Plus', click: () => sendCommand('zoom-in') },
      { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => sendCommand('zoom-out') },
      { label: '适合页面宽度', accelerator: 'CmdOrCtrl+0', click: () => sendCommand('fit-width') },
      { label: '全屏', role: 'togglefullscreen' }
    ] },
    { label: '帮助', submenu: [
      { label: '数据与隐私', click: async () => {
        const window = BrowserWindow.getFocusedWindow() || readerWindow();
        await dialog.showMessageBox(window, {
          type: 'info', title: '数据与隐私', message: 'PDF、译文、书签和对话保存在本机。',
          detail: '翻译或 AI 对话时，仅所需文字会发送到所选服务。API Key 使用当前 Windows 账户的系统加密保存。应用版与插件版数据互不影响。请定期在文档库导出备份；卸载应用不会主动删除文档库。\n\n数据目录：\n' + app.getPath('userData'),
          buttons: ['确定', '打开数据目录'], defaultId: 0, noLink: true
        }).then((answer) => { if (answer.response === 1) shell.openPath(app.getPath('userData')); });
      } },
      { label: '关于文献翻译器', click: () => dialog.showMessageBox(BrowserWindow.getFocusedWindow() || readerWindow(), {
        type: 'info', title: '关于文献翻译器', message: '文献翻译器 ' + app.getVersion(),
        detail: '本地 PDF 阅读、翻译与文章讨论。\nElectron ' + process.versions.electron + ' · Chromium ' + process.versions.chrome + '\n未配置自动更新；不会更改默认浏览器或 PDF 打开方式。', buttons: ['确定']
      }) }
    ] }
  ]));
}

function createWindow(role) {
  const saved = store?.get('windowState').windowState || {};
  const window = new BrowserWindow({
    width: role === 'options' ? 1060 : Math.max(900, Math.min(1800, saved.width || 1280)),
    height: role === 'options' ? 850 : Math.max(640, Math.min(1300, saved.height || 900)),
    minWidth: role === 'options' ? 640 : 720, minHeight: 520,
    show: false, backgroundColor: '#f5f4f0', title: role === 'options' ? '设置 · 文献翻译器' : '文献翻译器',
    icon: path.join(ROOT, 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, nodeIntegrationInWorker: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false, spellcheck: false,
      navigateOnDragDrop: false, backgroundThrottling: false
    }
  });
  const state = { window, role, ready: false, pendingFile: null, closeToken: null, closeAllowed: false };
  windows.set(window.webContents.id, state);
  if (role === 'viewer') lastReader = window;
  window.setMenuBarVisibility(true);
  window.once('ready-to-show', () => {
    if (!process.argv.includes('--test-hidden')) window.show();
    if (saved.maximized && role === 'viewer') window.maximize();
    if (store.warning) notice(window, store.warning, true);
  });
  window.webContents.setWindowOpenHandler(({ url }) => { external(window, url).catch(() => {}); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => {
    if (trustedPage(url) && new URL(url).pathname === (role === 'viewer' ? '/src/viewer.html' : '/src/options.html')) return;
    event.preventDefault();
    external(window, url).catch(() => {});
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.selectionText && role === 'viewer') template.push({ label: '翻译选中文字', click: () => {
      window.webContents.send('desktop:push', { type: 'translate-selection', text: params.selectionText, via: 'context-menu' });
    } });
    if (params.isEditable) template.push({ label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' }, { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' });
    else if (params.selectionText) template.push({ label: '复制', role: 'copy' });
    if (params.linkURL && externalUrl(params.linkURL)) template.push({ label: '在浏览器中打开链接', click: () => external(window, params.linkURL) });
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || window.isDestroyed()) return;
    dialog.showMessageBox(window, { type: 'error', title: '阅读窗口已停止', message: '阅读窗口异常停止，已保存的数据仍留在文档库。', buttons: ['重新打开', '关闭窗口'], noLink: true }).then((answer) => {
      if (window.isDestroyed()) return;
      if (answer.response === 0) { state.ready = false; window.loadURL(role === 'options' ? OPTIONS_URL : VIEWER_URL); }
      else { state.closeAllowed = true; window.close(); }
    });
  });
  window.on('close', (event) => {
    if (state.closeAllowed || role !== 'viewer' || !state.ready || window.webContents.isDestroyed() || window.webContents.getOSProcessId() === 0) return;
    event.preventDefault();
    if (state.closeToken) return;
    state.closeToken = randomUUID();
    window.webContents.send('desktop:close-request', { token: state.closeToken });
    const token = state.closeToken;
    setTimeout(() => { if (state.closeToken === token) state.closeToken = null; }, 60000).unref();
  });
  window.on('resize', () => {
    if (role !== 'viewer' || window.isMinimized() || window.isDestroyed()) return;
    clearTimeout(state.saveBoundsTimer);
    state.saveBoundsTimer = setTimeout(() => {
      if (window.isDestroyed()) return;
      const bounds = window.getNormalBounds();
      store.set({ windowState: { width: bounds.width, height: bounds.height, maximized: window.isMaximized() } }).catch(() => {});
    }, 800);
  });
  window.on('closed', () => {
    clearTimeout(state.saveBoundsTimer);
    for (const [id, current] of windows) if (current === state) windows.delete(id);
    if (lastReader === window) lastReader = null;
    if (optionsWindow === window) optionsWindow = null;
  });
  window.loadURL(role === 'options' ? OPTIONS_URL : VIEWER_URL);
  return window;
}

async function openOptions() {
  if (!optionsWindow || optionsWindow.isDestroyed()) optionsWindow = createWindow('options');
  if (optionsWindow.isMinimized()) optionsWindow.restore();
  if (!process.argv.includes('--test-hidden')) optionsWindow.show();
  optionsWindow.focus();
  return true;
}

async function choosePdf(window) {
  const parent = window && !window.isDestroyed() ? window : readerWindow();
  const owner = windows.get(parent.webContents.id);
  if (owner?.fileDialogOpen) return { ok: false, cancelled: true };
  if (owner) owner.fileDialogOpen = true;
  let result;
  try {
    result = await dialog.showOpenDialog(parent, {
      title: '打开 PDF', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    });
  } finally { if (owner) owner.fileDialogOpen = false; }
  if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
  const target = windows.get(parent.webContents.id)?.role === 'viewer' ? parent : readerWindow();
  try {
    if (result.filePaths.length === 1) await openPdfPath(result.filePaths[0], target);
    else {
      if (result.filePaths.length > 50) throw new Error('一次最多选择 50 个 PDF，请分批导入');
      notice(target, `正在读取 ${result.filePaths.length} 个 PDF…`);
      let total = 0;
      const files = [];
      for (const filename of result.filePaths) {
        const metadata = await fs.stat(filename);
        total += metadata.size;
        if (total > 500 * 1024 * 1024) throw new Error('本次导入超过 500 MB，请分批选择');
        files.push(await readPdf(filename, metadata));
        app.addRecentDocument(filename);
      }
      const state = windows.get(target.webContents.id);
      state.pendingFile = { files };
      deliverPdf(state);
    }
    return { ok: true };
  }
  catch (error) { showError(parent, error.message); return { ok: false, error: error.message }; }
}

async function readPdf(filename, metadata) {
  if (!path.isAbsolute(filename) || !/\.pdf$/i.test(filename)) throw new Error('请选择 PDF 文件');
  metadata ||= await fs.stat(filename);
  if (!metadata.isFile()) throw new Error('这不是可读取的 PDF 文件');
  if (metadata.size > MAX_PDF_BYTES) throw new Error('PDF 超过 200 MB，请先拆分文档后打开');
  const bytes = await fs.readFile(filename);
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('文件缺少 PDF 标记，可能已损坏或类型不正确');
  return { name: path.basename(filename), data: new Uint8Array(bytes) };
}

async function openPdfPath(filename, window) {
  const file = await readPdf(filename);
  const state = windows.get(window.webContents.id);
  if (!state) return;
  state.pendingFile = file;
  app.addRecentDocument(filename);
  deliverPdf(state);
}

function deliverPdf(state) {
  if (!state.ready || !state.pendingFile || state.window.isDestroyed()) return;
  state.window.webContents.send('desktop:file', state.pendingFile);
  state.pendingFile = null;
}

async function serveResources() {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
  const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' blob: https: http:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
  protocol.handle('pdf-translator', async (request) => {
    const filename = resourcePath(ROOT, request.url);
    if (!filename || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    try {
      const data = request.method === 'HEAD' ? null : await fs.readFile(filename);
      return new Response(data, { headers: {
        'content-type': MIME[path.extname(filename).toLowerCase()] || 'application/octet-stream',
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-cache'
      } });
    } catch (_) { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(Boolean(windows.has(webContents.id) && trustedPage(webContents.getURL()) && webContents.isFocused()
      && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission)));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return Boolean(webContents && windows.has(webContents.id) && trustedPage(webContents.getURL())
      && ['clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  session.defaultSession.on('will-download', (event, item, webContents) => {
    if (!webContents || !windows.has(webContents.id) || !trustedPage(webContents.getURL())) { event.preventDefault(); return; }
    const window = BrowserWindow.fromWebContents(webContents);
    const filename = safeFilename(item.getFilename(), 'document.pdf');
    const extension = path.extname(filename).slice(1).toLowerCase();
    item.setSaveDialogOptions({
      title: '保存文件', defaultPath: path.join(app.getPath('downloads'), filename),
      filters: ['pdf', 'json', 'zip', 'txt', 'md'].includes(extension) ? [{ name: extension.toUpperCase() + ' 文件', extensions: [extension] }] : undefined
    });
    item.once('done', (_event, state) => {
      if (state === 'completed') notice(window, '文件已保存。');
      else if (state !== 'cancelled') notice(window, '保存失败，请检查可用磁盘空间并重试。', true);
    });
  });
}

function failBackend(message) {
  for (const request of requests.values()) { clearTimeout(request.timer); request.resolve({ ok: false, error: message }); }
  requests.clear();
  for (const task of network.values()) task.abort();
  network.clear();
  for (const state of windows.values()) notice(state.window, message, true);
}

async function networkFetch(message) {
  const controller = new AbortController();
  network.set(message.id, controller);
  const timeout = setTimeout(() => controller.abort(), 150000);
  try {
    const url = new URL(message.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('不支持的服务地址');
    if (network.size > 20) throw new Error('请求过多，请稍后重试');
    if (message.init.body && Buffer.byteLength(message.init.body) > 4 * 1024 * 1024) throw new Error('请求内容过大');
    const response = await net.fetch(url.href, { ...message.init, signal: controller.signal });
    backend.postMessage({ kind: 'fetch-head', id: message.id, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()) });
    if (response.body) {
      const reader = response.body.getReader();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 16 * 1024 * 1024) throw new Error('服务响应超过安全大小限制');
        const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        backend.postMessage({ kind: 'fetch-chunk', id: message.id, chunk }, [chunk]);
      }
    }
    backend.postMessage({ kind: 'fetch-end', id: message.id });
  } catch (error) {
    backend?.postMessage({ kind: 'fetch-error', id: message.id, error: error.name === 'AbortError' ? '请求已取消或超时' : error.message });
  } finally { clearTimeout(timeout); network.delete(message.id); }
}

async function backendRpc(message) {
  try {
    const payload = message.payload || {};
    let result;
    switch (message.operation) {
      case 'storage:get': result = store.get(payload.keys); break;
      case 'storage:set': {
        if (!payload.value || Object.keys(payload.value).some((key) => !['settings', 'engineHealth'].includes(key))) throw new Error('不支持的设置写入');
        const changes = await store.set(payload.value);
        backend.postMessage({ kind: 'storage-changed', changes });
        const publicChanges = store.publicChanges(changes);
        for (const current of windows.values()) current.window.webContents.send('desktop:storage', publicChanges);
        result = undefined;
        break;
      }
      case 'tabs:query': {
        const reader = readerWindow();
        result = [{ id: reader.webContents.id, url: reader.webContents.getURL(), title: reader.getTitle() }];
        break;
      }
      case 'tabs:send': {
        if (!PUSH_TYPES.has(payload.message?.type)) throw new Error('不支持的后台通知');
        const target = windows.get(payload.tabId);
        if (!target || target.window.isDestroyed()) throw new Error('阅读窗口已关闭');
        target.window.webContents.send('desktop:push', payload.message);
        result = { ok: true };
        break;
      }
      case 'tabs:create': case 'tabs:update': {
        const target = message.operation === 'tabs:create' ? createWindow('viewer') : windows.get(payload.tabId)?.window || readerWindow();
        const requested = new URL(payload.properties.url);
        if (!trustedPage(requested.href) || requested.pathname !== '/src/viewer.html') throw new Error('不允许打开外部应用页面');
        const file = requested.searchParams.get('file');
        if (file) {
          if (file.startsWith('file:')) throw new Error('请通过「打开 PDF」选择本地文件');
          if (!/^https?:\/\//i.test(file)) throw new Error('不支持的 PDF 地址');
        }
        await target.loadURL(requested.href);
        result = { id: target.webContents.id, url: requested.href };
        break;
      }
      default: throw new Error('未知后台操作');
    }
    backend.postMessage({ kind: 'rpc-result', id: message.id, result });
  } catch (error) { backend.postMessage({ kind: 'rpc-result', id: message.id, error: error.message }); }
}

async function startBackend() {
  let developerConfig = null;
  const configArgument = process.argv.find((value) => value.startsWith('--developer-config='));
  if (configArgument && !app.isPackaged) {
    const filename = configArgument.slice('--developer-config='.length);
    if (!path.isAbsolute(filename)) throw new Error('开发配置文件必须使用绝对路径');
    developerConfig = JSON.parse(await fs.readFile(filename, 'utf8'));
  }
  backend = new Worker(path.join(__dirname, 'backend.mjs'), { workerData: { root: ROOT, developerConfig } });
  backendReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('应用后台启动超时')), 30000);
    backend.on('message', (message) => {
      if (message.kind === 'ready') { clearTimeout(timeout); resolve(); }
      else if (message.kind === 'fatal') { clearTimeout(timeout); reject(new Error(message.error)); }
      else if (message.kind === 'response') {
        const request = requests.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        requests.delete(message.id);
        request.resolve(message.result);
      } else if (message.kind === 'rpc') backendRpc(message);
      else if (message.kind === 'fetch') networkFetch(message);
      else if (message.kind === 'fetch-abort') network.get(message.id)?.abort();
    });
    backend.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('应用后台无法启动'));
      failBackend('应用后台异常停止，请关闭并重新打开应用。已保存文档不受影响。');
    });
    backend.once('exit', (code) => { if (code && !quitting) failBackend('应用后台已停止，请重新打开应用。'); });
  });
  await backendReady;
}

function installIpc() {
  ipcMain.handle('desktop:message', async (event, raw) => {
    try {
      trustedSender(event);
      const message = boundedMessage(raw);
      await backendReady;
      const sender = { id: 'paper-translator-desktop', url: event.senderFrame.url, tab: { id: event.sender.id, url: event.senderFrame.url } };
      return await new Promise((resolve) => {
        const id = ++nextRequest;
        const timer = setTimeout(() => { requests.delete(id); resolve({ ok: false, error: '请求超时，请重试' }); }, 180000);
        requests.set(id, { resolve, timer });
        backend.postMessage({ kind: 'request', id, message, sender });
      });
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('desktop:storage-get', (event, keys) => {
    trustedSender(event);
    const requested = keys == null ? ['settings'] : typeof keys === 'string' ? [keys] : keys;
    if (!Array.isArray(requested) || requested.some((key) => !['settings', 'engineHealth'].includes(key))) throw new Error('不支持的数据读取');
    return store.get(requested, true);
  });
  ipcMain.handle('desktop:options', (event) => { trustedSender(event); return openOptions(); });
  ipcMain.handle('desktop:open-file', (event) => { const state = trustedSender(event); return choosePdf(state.window); });
  ipcMain.handle('desktop:close-window', (event) => { const state = trustedSender(event); state.window.close(); return true; });
  ipcMain.handle('desktop:ready', (event) => {
    const state = trustedSender(event);
    if (state.role === 'viewer') { state.ready = true; deliverPdf(state); }
    return true;
  });
  ipcMain.handle('desktop:close-decision', (event, value) => {
    const state = trustedSender(event);
    if (!value || value.token !== state.closeToken) return false;
    state.closeToken = null;
    if (value.allow === true) { state.closeAllowed = true; state.window.close(); }
    else quitting = false;
    return true;
  });
}

async function start() {
  store = new SecureStore(app.getPath('userData'), require('electron').safeStorage);
  await store.load();
  await serveResources();
  installIpc();
  await startBackend();
  buildMenu();
  const window = createWindow('viewer');
  const file = pdfArgument(process.argv);
  if (file) openPdfPath(file, window).catch((error) => showError(window, error.message));
  markInitialized();
  app.on('activate', () => readerWindow().show());
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  backend?.terminate();
  for (const task of network.values()) task.abort();
});
