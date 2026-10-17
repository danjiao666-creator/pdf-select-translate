/* The browser extension keeps its native chrome APIs; only the desktop app uses this bridge. */
(() => {
  'use strict';
  const native = window.paperDesktop;
  if (!native) return;
  const events = () => {
    const listeners = new Set();
    return {
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
      fire(...args) { for (const listener of listeners) { try { listener(...args); } catch (error) { console.error(error); } } }
    };
  };
  const onMessage = events();
  const onChanged = events();
  const commands = [
    { name: 'translate-selection', description: '翻译选区', shortcut: 'Alt+Z' },
    { name: 'open-in-viewer', description: '打开 PDF', shortcut: 'Ctrl+O' }
  ];
  window.chrome ||= {};
  window.chrome.runtime = {
    getURL(value = '') { return 'pdf-translator://app/' + String(value).replace(/^\/+/, ''); },
    sendMessage(message, callback) {
      const response = native.message(message).catch((error) => ({ ok: false, error: error.message || '应用后台未响应' }));
      if (typeof callback === 'function') { response.then(callback); return; }
      return response;
    },
    lastError: undefined,
    onMessage,
    openOptionsPage: () => native.openOptions()
  };
  window.chrome.storage = {
    local: {
      get: (keys) => native.storage(keys),
      set: async (patch) => {
        if (!patch || Object.keys(patch).some((key) => key !== 'settings')) throw new Error('不允许直接修改应用数据');
        const response = await native.message({ type: 'saveSettings', settings: patch.settings });
        if (!response?.ok) throw new Error(response?.error || '设置保存失败');
      }
    },
    onChanged
  };
  window.chrome.commands = { getAll: async () => commands };
  native.on('message', (message) => onMessage.fire(message, {}, () => {}));
  native.on('storage', (changes) => onChanged.fire(changes, 'local'));
  native.on('file', ({ data, name, files }) => {
    if (Array.isArray(files)) {
      const payload = files.map((file) => ({ name: file.name, data: file.data instanceof ArrayBuffer ? file.data : new Uint8Array(file.data).buffer }));
      window.dispatchEvent(new CustomEvent('desktop-open-pdfs', { detail: { files: payload } }));
      return;
    }
    const buffer = data instanceof ArrayBuffer ? data : new Uint8Array(data).buffer;
    window.dispatchEvent(new CustomEvent('desktop-open-pdf', { detail: { data: buffer, name } }));
  });
  const buttons = {
    library: 'openLibrary', find: 'openSearch', chat: 'openArticleChat', bookmarks: 'openBookmarks',
    bookmark: 'addBookmark', outline: 'openOutline', 'zoom-in': 'zoomIn', 'zoom-out': 'zoomOut',
    'fit-width': 'fitWidth', export: 'exportTranslatedPdf'
  };
  native.on('command', ({ command }) => {
    if (command === 'translate-selection') { onMessage.fire({ type: command }, {}, () => {}); return; }
    const event = new CustomEvent('desktop-command', { detail: { command }, cancelable: true });
    if (window.dispatchEvent(event)) document.getElementById(buttons[command])?.click();
  });
  native.on('notice', ({ text, error }) => {
    const target = document.getElementById('toast') || document.getElementById('status');
    if (!target) return;
    target.textContent = text;
    target.hidden = false;
    target.dataset.error = String(Boolean(error));
    setTimeout(() => { target.hidden = true; }, 7000);
  });

  let beforeClose = async () => true;
  let ready = false;
  window.desktopBridge = Object.freeze({
    isDesktop: true,
    async ready() {
      if (ready || !location.pathname.endsWith('/viewer.html')) return;
      ready = true;
      await native.ready();
    },
    onBeforeClose(callback) { if (typeof callback === 'function') beforeClose = callback; },
    openFile: () => native.openFile(),
    requestClose: () => native.requestClose()
  });
  native.on('close', async ({ token }) => {
    let allow = false;
    try { allow = (await beforeClose()) === true; } catch (_) {}
    await native.closeDecision(token, allow);
  });
  window.addEventListener('reader-ready', () => window.desktopBridge.ready());
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('#openLocal, #emptyPick');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    native.openFile();
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.dataset.platform = 'desktop';
    document.title = location.pathname.endsWith('/options.html') ? '设置 · 文献翻译器' : '文献翻译器';
    const shortcutHelp = document.querySelector('#help .note');
    if (shortcutHelp) shortcutHelp.textContent = '桌面快捷键见窗口上方菜单。应用版和浏览器插件的数据分别保存在本地，可通过备份导入导出。';
    const footer = document.querySelector('footer span');
    if (footer) footer.textContent = '设置保存在此 Windows 账户，API Key 使用系统加密';
    const librarySummary = document.querySelector('.library-heading p');
    if (librarySummary) librarySummary.textContent = '保存 PDF、阅读位置、译文与讨论，存于本机应用数据中。';
    const browserOnlySetting = document.getElementById('autoOpenPdf')?.closest('label');
    if (browserOnlySetting) browserOnlySetting.hidden = true;
    const optionsButton = document.getElementById('openOptions');
    if (optionsButton) optionsButton.title = '应用设置';
    for (const paragraph of document.querySelectorAll('#help .advanced-body p')) {
      if (paragraph.textContent.includes('Chrome / Edge 内置 PDF')) paragraph.textContent = '使用「打开 PDF」或拖入文件；也可将 PDF 拖到应用快捷方式上打开。搜索、书签、AI 对话和快捷键见「阅读」菜单。应用不会更改默认浏览器或 PDF 打开方式。';
    }
    const keySource = document.getElementById('keySource');
    if (keySource) new MutationObserver(() => {
      const text = 'API Key 由当前 Windows 账户加密保存，不回显；留空不会覆盖已有 Key。';
      if (!keySource.hidden && keySource.textContent !== text && !keySource.textContent.includes('本机配置文件')) keySource.textContent = text;
    }).observe(keySource, { childList: true });
    const original = document.getElementById('openOriginal');
    if (original) new MutationObserver(() => {
      if (original.href.startsWith('blob:') && !original.hidden) original.hidden = true;
    }).observe(original, { attributes: true, attributeFilter: ['href', 'hidden'] });
  });
})();
