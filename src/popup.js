/** PDF 划词翻译 —— 扩展弹窗 */

const $ = (id) => document.getElementById(id);

const els = {
  tabInfo: $('tabInfo'),
  pdfBlock: $('pdfBlock'),
  notPdfBlock: $('notPdfBlock'),
  notPdfHint: $('notPdfHint'),
  openCurrent: $('openCurrent'),
  openCurrentNew: $('openCurrentNew'),
  openAnyWay: $('openAnyWay'),
  openLocal: $('openLocal'),
  targetLang: $('targetLang'),
  engine: $('engine'),
  autoTranslate: $('autoTranslate'),
  sentenceMode: $('sentenceMode'),
  autoOpenPdf: $('autoOpenPdf'),
  clipboardWatch: $('clipboardWatch'),
  translateClip: $('translateClip'),
  clipResult: $('clipResult'),
  copyClipResult: $('copyClipResult'),
  shortcuts: $('shortcuts'),
  openOptions: $('openOptions')
};

let currentTab = null;
let currentFileUrl = '';
let clipSequence = 0;

function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(res === undefined ? { ok: false, error: '后台未响应' } : res);
    });
  });
}

function viewerUrl(fileUrl) {
  const base = chrome.runtime.getURL('src/viewer.html');
  return fileUrl ? `${base}?file=${encodeURIComponent(fileUrl)}` : base;
}

function looksLikePdf(url) {
  return typeof url === 'string' && /\.pdf([?#].*)?$/i.test(url);
}

/** 有些 PDF 链接不带 .pdf 后缀，用 content type 兜底判断 */
async function detectPdfByContentType(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType
    });
    const type = results && results[0] && results[0].result;
    return typeof type === 'string' && type.toLowerCase().includes('pdf');
  } catch (_) {
    return false;
  }
}

async function init() {
  const res = await sendMsg({ type: 'getSettings' });
  const settings = (res && res.settings) || {};
  els.targetLang.value = settings.targetLang || 'zh-CN';
  els.engine.value = settings.engine || 'auto';
  els.autoTranslate.checked = settings.autoTranslate !== false;
  els.sentenceMode.checked = settings.sentenceMode !== false;
  els.autoOpenPdf.checked = Boolean(settings.autoOpenPdf);
  els.clipboardWatch.checked = Boolean(settings.clipboardWatch);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  const url = tab && tab.url ? tab.url : '';
  const isReader = url.startsWith(chrome.runtime.getURL('src/viewer.html'));
  currentFileUrl = isReader ? new URL(url).searchParams.get('file') || '' : url;
  let isPdf = looksLikePdf(url) && !isReader;
  if (!isPdf && tab && tab.id != null && /^https?:|^file:/.test(url)) {
    isPdf = await detectPdfByContentType(tab.id);
  }

  els.openAnyWay.closest('details').hidden = isReader || !/^https?:|^file:/.test(url);
  els.tabInfo.textContent = isReader ? '翻译阅读器已打开' : url.startsWith(chrome.runtime.getURL('')) ? 'PDF 划词翻译' : (tab?.title || url.replace(/^https?:\/\//, '') || '未知页面');
  els.tabInfo.title = url;
  els.pdfBlock.hidden = !isPdf;
  els.notPdfBlock.hidden = isPdf;
  if (!isPdf) {
    els.notPdfHint.textContent = isReader ? '阅读器已就绪。在 PDF 中选中句子即可翻译。' : /^(chrome|edge|about):/.test(url)
      ? '此页面不支持划词。可打开本地 PDF，或切换到普通网页。'
      : '在网页上选中文字即可翻译；也可以打开一份 PDF 开始阅读。';
  }

  try {
    const commands = await chrome.commands.getAll();
    els.shortcuts.textContent =
      commands
        .filter((c) => c.name === 'translate-selection' || c.name === 'open-in-viewer')
        .map((c) => `${c.name === 'translate-selection' ? '翻译选区' : '阅读器打开'} ${c.shortcut || '（未设置）'}`)
        .join('；') || '未设置';
  } catch (_) {
    els.shortcuts.textContent = '请在扩展设置中查看快捷键';
  }
}

function openViewer(fileUrl, newTab) {
  if (!fileUrl) {
    chrome.tabs.create({ url: viewerUrl('') });
    window.close();
    return;
  }
  const target = viewerUrl(fileUrl);
  if (newTab) chrome.tabs.create({ url: target });
  else if (currentTab && currentTab.id != null) chrome.tabs.update(currentTab.id, { url: target });
  else chrome.tabs.create({ url: target });
  window.close();
}

els.openCurrent.addEventListener('click', () => openViewer(currentFileUrl, false));
els.openCurrentNew.addEventListener('click', () => openViewer(currentFileUrl, true));
els.openAnyWay.addEventListener('click', () => openViewer(currentFileUrl, true));
els.openLocal.addEventListener('click', () => openViewer('', true));
els.openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

function bindSetting(el, key, read) {
  el.addEventListener('change', () => {
    sendMsg({ type: 'saveSettings', settings: { [key]: read(el) } });
  });
}

bindSetting(els.targetLang, 'targetLang', (el) => el.value);
bindSetting(els.engine, 'engine', (el) => el.value);
bindSetting(els.autoTranslate, 'autoTranslate', (el) => el.checked);
bindSetting(els.sentenceMode, 'sentenceMode', (el) => el.checked);
bindSetting(els.autoOpenPdf, 'autoOpenPdf', (el) => el.checked);
bindSetting(els.clipboardWatch, 'clipboardWatch', (el) => el.checked);

/* ------------------------------------------- 内置阅读器：翻译剪贴板内容 */

let clipTranslation = '';

function showClipResult(html, isError) {
  els.clipResult.hidden = false;
  els.clipResult.innerHTML = html;
  els.clipResult.className = `clip-result${isError ? ' err' : ''}`;
}

els.translateClip.addEventListener('click', async () => {
  const sequence = ++clipSequence;
  els.copyClipResult.hidden = true;
  clipTranslation = '';
  let text = '';
  try {
    text = (await navigator.clipboard.readText()).replace(/\s+/g, ' ').trim();
  } catch (err) {
    showClipResult(`读取剪贴板失败：${escapeHtml((err && err.message) || err)}<br />请确认已授予剪贴板权限。`, true);
    return;
  }
  if (!text) {
    showClipResult('剪贴板是空的。请先在 PDF 里选中文字并按 Ctrl+C。', true);
    return;
  }
  showClipResult(`<span class="muted">正在翻译：</span>${escapeHtml(text.slice(0, 120))}${text.length > 120 ? '…' : ''}`);
  const res = await sendMsg({
    type: 'translate',
    text,
    to: els.targetLang.value,
    engine: els.engine.value,
    // 弹窗不是标签页，收不到异步的「升级」消息 → 直接等最终结果
    quality: true
  });
  if (sequence !== clipSequence) return;
  if (res && res.ok) {
    clipTranslation = res.translation;
    const time = res.elapsedMs ? ` · ${(res.elapsedMs / 1000).toFixed(1)}s` : '';
    showClipResult(
      `<div class="muted small">${escapeHtml(res.engineLabel || '')}${time}${res.cached ? ' · 缓存' : ''}</div><div>${escapeHtml(res.translation)}</div>`
    );
    els.copyClipResult.hidden = false;
  } else {
    showClipResult(`翻译失败：${escapeHtml((res && res.error) || '未知错误')}`, true);
  }
});

els.copyClipResult.addEventListener('click', async () => {
  if (!clipTranslation) return;
  try {
    await navigator.clipboard.writeText(clipTranslation);
    els.copyClipResult.textContent = '已复制 ✓';
    setTimeout(() => (els.copyClipResult.textContent = '复制译文'), 1500);
  } catch (_) {}
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
