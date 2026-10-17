/**
 * PDF 划词翻译 —— 内容脚本
 *
 * 两种工作场景：
 *  A. 普通网页 / 本扩展自己的阅读器之外的页面：鼠标划词 → 即时翻译（或先显示“译”按钮）。
 *  B. Chrome / Edge 内置 PDF 阅读器：PDF 由插件渲染，页面拿不到选区也收不到鼠标事件，
 *     因此改为「快捷键 / 右键菜单 → 触发翻译」。触发时先尝试读取 DOM 选区，
 *     失败则用 document.execCommand('copy') 让内置阅读器把选中内容写进剪贴板，
 *     再用 navigator.clipboard.readText() 读回来（需要 clipboardRead 权限）。
 *     也可以打开「剪贴板监听」：在内置阅读器里 Ctrl+C 后自动翻译。
 */

(() => {
  'use strict';

  const HOST_ID = 'pt-selection-host';
  if (window.top !== window) return; // 只在顶层文档工作，避免重复注入
  if (document.getElementById(HOST_ID)) return;

  const IS_PDF = (() => {
    try {
      if (document.contentType === 'application/pdf') return true;
    } catch (_) {}
    return Boolean(document.querySelector('embed[type="application/pdf"], embed[type="text/pdf"]'));
  })();

  const FALLBACK_SETTINGS = {
    engine: 'auto',
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    autoTranslate: true,
    sentenceMode: true,
    clipboardWatch: false,
    cardFontSize: 15
  };
  let settings = { ...FALLBACK_SETTINGS };

  /* ------------------------------------------------------------ 消息工具 */

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (res) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, error: err.message });
          else resolve(res === undefined ? { ok: false, error: '扩展未响应' } : res);
        });
      } catch (e) {
        resolve({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  (async () => {
    const res = await send({ type: 'getSettings' });
    if (res && res.ok && res.settings) settings = { ...settings, ...res.settings };
    applyFontSize();
  })();

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings && changes.settings.newValue) {
        settings = { ...settings, ...changes.settings.newValue };
        applyFontSize();
        hideCard();
      }
    });
  } catch (_) {}

  /* ---------------------------------------------------------------- UI */

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.setAttribute('data-pt', 'root');
  host.style.cssText = 'all: initial; position: fixed; inset: 0 auto auto 0; width: 0; height: 0; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .pt-btn {
        position: fixed; display: none; align-items: center; justify-content: center;
        width: 30px; height: 30px; border-radius: 8px; cursor: pointer; user-select: none;
        background: #21665c; color: #fff; font: 700 14px/1 system-ui, "Segoe UI", sans-serif;
        box-shadow: 0 3px 10px rgba(0,0,0,.28); border: 1px solid rgba(255,255,255,.25);
      }
      .pt-btn:hover { background: #184e46; }
      .pt-card {
        position: fixed; display: none; width: min(440px, calc(100vw - 24px));
        background: #ffffff; color: #1f2328; border: 1px solid #dce1da; border-radius: 16px;
        box-shadow: 0 10px 32px rgba(0,0,0,.22); font: 400 15px/1.8 "Bahnschrift", "Microsoft YaHei UI", sans-serif;
        overflow: hidden;
      }
      .pt-head {
        display: flex; align-items: center; gap: 8px; padding: 8px 10px;
        background: #f6f7f3; border-bottom: 1px solid #e6e9ee; cursor: default;
      }
      .pt-badge {
        font-size: 11px; font-weight: 700; color: #21665c; background: #e8f2ee;
        padding: 2px 7px; border-radius: 999px; white-space: nowrap;
      }
      .pt-title { font-size: 12px; color: #57606a; flex: 1; }
      .pt-act {
        border: 0; background: transparent; color: #57606a; cursor: pointer;
        font-size: 12px; padding: 3px 6px; border-radius: 6px;
      }
      .pt-act:hover { background: #e6e9ee; color: #1f2328; }
      .pt-body { padding: 10px 12px 12px; max-height: 45vh; overflow: auto; }
      .pt-src { color: #6e7781; font-size: 12.5px; border-left: 3px solid #dce1da; padding-left: 8px; margin-bottom: 8px; white-space: pre-wrap; }
      .pt-out { white-space: pre-wrap; }
      .pt-out.pt-loading { color: #6e7781; }
      .pt-out.pt-error { color: #c0392b; font-size: 13px; }
      .pt-toast {
        position: fixed; display: none; left: 50%; top: 16px; transform: translateX(-50%);
        background: rgba(33,38,45,.94); color: #fff; padding: 8px 14px; border-radius: 8px;
        font: 400 13px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 70vw;
      }
      @media (prefers-color-scheme: dark) {
        .pt-card { background: #1c2128; color: #e6edf3; border-color: #30363d; }
        .pt-head { background: #22272e; border-bottom-color: #30363d; }
        .pt-badge { color: #9ecbff; background: #1b3a63; }
        .pt-title, .pt-act { color: #8b949e; }
        .pt-act:hover { background: #30363d; color: #e6edf3; }
        .pt-src { color: #8b949e; border-left-color: #30363d; }
      }
    </style>
    <div class="pt-btn" part="btn" title="翻译选中文本">译</div>
    <div class="pt-card">
      <div class="pt-head">
        <span class="pt-badge">…</span>
        <span class="pt-title">划词翻译</span>
        <button class="pt-act" data-act="copy">复制</button>
        <button class="pt-act" data-act="close">关闭</button>
      </div>
      <div class="pt-body">
        <div class="pt-src"></div>
        <div class="pt-out"></div>
      </div>
    </div>
    <div class="pt-toast"></div>
  `;

  const btn = shadow.querySelector('.pt-btn');
  const card = shadow.querySelector('.pt-card');
  const badge = shadow.querySelector('.pt-badge');
  const srcEl = shadow.querySelector('.pt-src');
  const outEl = shadow.querySelector('.pt-out');
  const toastEl = shadow.querySelector('.pt-toast');

  function mountHost() {
    const parent = document.documentElement || document.body;
    if (parent && !host.isConnected) parent.appendChild(host);
  }
  mountHost();
  document.addEventListener('DOMContentLoaded', mountHost, { once: true });
  setTimeout(mountHost, 500);

  let toastTimer = null;
  function toast(message, ms = 3600) {
    toastEl.textContent = message;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.style.display = 'none'), ms);
  }

  function applyFontSize() {
    const size = Number(settings.cardFontSize) || 15;
    card.style.fontSize = `${size}px`;
  }
  applyFontSize();

  function showButton(rect, onClick) {
    const x = Math.min(Math.max(rect.right + 6, 8), window.innerWidth - 40);
    const y = Math.min(Math.max(rect.top - 6, 8), window.innerHeight - 40);
    btn.style.left = `${x}px`;
    btn.style.top = `${y}px`;
    btn.style.display = 'flex';
    btn.onmousedown = (e) => e.preventDefault(); // 保住选区
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideButton();
      onClick();
    };
  }
  function hideButton() {
    btn.style.display = 'none';
  }

  function placeCard(rect) {
    const width = card.offsetWidth || 420;
    const height = card.offsetHeight || 180;
    let left;
    let top;
    if (rect && rect.width) {
      left = rect.left;
      top = rect.bottom + 8;
    } else {
      left = (window.innerWidth - width) / 2;
      top = 60;
    }
    left = Math.min(Math.max(left, 8), Math.max(8, window.innerWidth - width - 8));
    if (top + height > window.innerHeight - 8) {
      top = rect && rect.top ? Math.max(8, rect.top - height - 8) : Math.max(8, window.innerHeight - height - 8);
    }
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    card.style.display = 'block';
  }

  function hideCard() {
    lastRequestId++;
    currentRequestKey = '';
    card.style.display = 'none';
  }

  card.addEventListener('mousedown', (e) => e.stopPropagation());
  card.addEventListener('mouseup', (e) => e.stopPropagation());
  card.querySelector('[data-act="close"]').addEventListener('click', hideCard);
  card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
    const text = outEl.dataset.copy || outEl.textContent || '';
    try {
      await navigator.clipboard.writeText(text);
      toast('译文已复制');
    } catch (_) {
      toast('复制失败，请手动选择');
    }
  });

  /* ------------------------------------------------------- 选区与整句扩展 */

  function selectionRect(sel) {
    try {
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      if (rect && rect.width) return rect;
      const rects = range.getClientRects();
      if (rects && rects.length) return rects[rects.length - 1];
    } catch (_) {}
    return null;
  }

  function currentNodeOf(node) {
    return node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  }

  /** 安全版 closest：事件目标是 document/window 或纯文本节点时没有 closest */
  function closestOf(target, selector) {
    if (!target || typeof target.closest !== 'function') return null;
    try {
      return target.closest(selector);
    } catch (_) {
      return null;
    }
  }

  function sentenceBoundary(text, i) {
    if (/[。！？!?；;\n\r]/.test(text[i] || '')) return true;
    if (text[i] !== '.' || (text[i + 1] && !/\s/.test(text[i + 1]))) return false;
    return !/\b(?:Dr|Mr|Mrs|Ms|Prof|Fig|Eq|et al|vs)\.$/i.test(text.slice(0, i + 1));
  }
  const MAX_EXPAND = 220;

  /** 把选区扩展到所在完整句子（基于 DOM Range，尽量少改动语义） */
  function expandSelectionToSentence(sel) {
    let range;
    try {
      range = sel.getRangeAt(0);
    } catch (_) {
      return null;
    }
    const startEl = currentNodeOf(range.startContainer);
    const endEl = currentNodeOf(range.endContainer);
    if (!startEl || !endEl) return null;

    let block = closestOf(startEl, 'p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, div') || startEl;
    while (
      block &&
      block.parentElement &&
      !block.contains(endEl) &&
      block !== document.body
    ) {
      block = block.parentElement;
    }
    if (!block || !block.contains(endEl)) {
      block = closestOf(startEl, 'p, li, td, th, h1, h2, h3, h4, h5, h6, div, span') || startEl;
    }
    if (!block || typeof block.contains !== 'function') return null;

    const full = block.textContent || '';
    if (!full) return null;

    const pre = document.createRange();
    pre.selectNodeContents(block);
    try {
      pre.setEnd(range.startContainer, range.startOffset);
    } catch (_) {
      return null;
    }
    const selStart = pre.toString().length;
    const selLength = range.toString().length;
    if (selLength <= 0) return null;
    const selEnd = selStart + selLength;

    if (full.length > 4000) return null;

    let from = Math.max(0, selStart - MAX_EXPAND);
    let to = Math.min(full.length, selEnd + MAX_EXPAND);

    for (let i = selStart - 1; i >= from; i--) {
      if (sentenceBoundary(full, i)) { from = i + 1; break; }
    }
    if (!sentenceBoundary(full, selEnd - 1)) {
      for (let i = selEnd; i < to; i++) {
        if (sentenceBoundary(full, i)) { to = i + 1; break; }
      }
    } else { to = selEnd; }

    while (from < to && /\s/.test(full[from])) from++;
    while (to > from && /\s/.test(full[to - 1])) to--;
    if (to <= from) return null;

    const pointAt = (offset) => {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
      let seen = 0;
      let node = walker.nextNode();
      let last = null;
      while (node) {
        const len = node.nodeValue ? node.nodeValue.length : 0;
        if (seen + len >= offset) return { node, offset: offset - seen };
        seen += len;
        last = node;
        node = walker.nextNode();
      }
      return last ? { node: last, offset: last.nodeValue.length } : null;
    };

    const a = pointAt(from);
    const b = pointAt(to);
    if (!a || !b) return null;

    const expanded = document.createRange();
    try {
      expanded.setStart(a.node, a.offset);
      expanded.setEnd(b.node, b.offset);
    } catch (_) {
      return null;
    }
    const text = expanded.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    // 扩展后太短（几乎没变化）或太长都直接用原选区
    if (text.length > 600) return null;
    return { range: expanded, text };
  }

  function cleanText(text) {
    return (text || '')
      .replace(/\u00ad/g, '') // 软连字符
      .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, '$1$2') // 跨行断词
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* -------------------------------------------------------------- 翻译 */

  let lastRequestId = 0;
  /** 当前这次翻译的请求标识：用于识别「升级」消息是不是属于它 */
  let currentRequestKey = '';
  let streamed = false;
  let provisionalResult = null;
  let upgradeResult = null;

  async function translateText(text, rect) {
    const payload = cleanText(text);
    if (!payload) {
      toast('没有检测到可翻译的文本');
      return;
    }
    const requestId = ++lastRequestId;
    const requestKey = `r${requestId}-${Date.now()}`;
    currentRequestKey = requestKey;
    streamed = false;
    provisionalResult = null;
    upgradeResult = null;
    badge.textContent = '翻译中…';
    srcEl.textContent = payload.length > 400 ? `${payload.slice(0, 400)}…` : payload;
    outEl.dataset.copy = '';
    outEl.className = 'pt-out pt-loading';
    outEl.textContent = '正在翻译…';
    placeCard(rect);

    const res = await send({
      type: 'translate',
      text: payload,
      to: settings.targetLang,
      from: settings.sourceLang,
      engine: settings.engine,
      requestId: requestKey
    });
    if (requestId !== lastRequestId) return;
    if (res?.provisional) provisionalResult = res;
    if (upgradeResult) { applyUpgrade(upgradeResult); return; }
    if (res?.provisional && streamed) return;

    if (res && res.ok) {
      const time = res.elapsedMs ? ` · ${(res.elapsedMs / 1000).toFixed(1)}s` : '';
      badge.textContent = res.engineLabel
        ? `${res.engineLabel}${time}${res.provisional ? ' · AI 优化中…' : ''}`
        : 'AI';
      outEl.className = 'pt-out';
      outEl.textContent = res.translation;
      outEl.dataset.copy = res.translation;
      outEl.dataset.provisional = res.provisional ? '1' : '';
      placeCard(rect);
    } else {
      badge.textContent = '失败';
      outEl.className = 'pt-out pt-error';
      outEl.textContent = `翻译失败：${(res && res.error) || '未知错误'}`;
      outEl.dataset.copy = '';
      placeCard(rect);
    }
  }

  /** 自定义 API 的升级结果到了：替换卡片内容（只认当前这次请求） */
  function applyUpgrade(msg) {
    if (!msg || msg.requestId !== currentRequestKey) return;
    upgradeResult = msg;
    if (msg.ok) {
      badge.textContent = msg.engineLabel
        ? `${msg.engineLabel}${msg.elapsedMs ? ` · ${(msg.elapsedMs / 1000).toFixed(1)}s` : ''}`
        : 'AI';
      outEl.className = 'pt-out';
      outEl.textContent = msg.translation;
      outEl.dataset.copy = msg.translation;
      outEl.dataset.provisional = '';
    } else {
      if (provisionalResult) {
        outEl.textContent = provisionalResult.translation;
        outEl.dataset.copy = provisionalResult.translation;
        badge.textContent = provisionalResult.engineLabel;
      }
      // Keep the complete free translation if an AI stream fails.
      badge.textContent = `${badge.textContent.replace(/ · AI 优化中…$/, '')} · 优化失败`;
    }
  }

  /** 自定义 API 的流式片段：边生成边显示，首屏时间 = 首字时间 */
  function applyStream(msg) {
    if (!msg || msg.requestId !== currentRequestKey) return;
    if (msg.reset) {
      badge.textContent = 'AI 生成中…';
      return;
    }
    if (typeof msg.text !== 'string' || !msg.text) return;
    streamed = true;
    outEl.className = 'pt-out';
    outEl.textContent = msg.text;
    outEl.dataset.copy = msg.text;
    outEl.dataset.provisional = '';
    badge.textContent = `AI 生成中… ${msg.text.length} 字`;
  }

  /* ------------------------------------------------- 场景 A：普通网页 */

  function domSelectionText() {
    try {
      return window.getSelection() ? window.getSelection().toString() : '';
    } catch (_) {
      return '';
    }
  }

  function handleMouseUp(event) {
    if (IS_PDF) return;
    if (closestOf(event.target, `#${HOST_ID}`) || closestOf(event.target, 'input, textarea, [contenteditable="true"]')) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      hideButton();
      return;
    }
    let rect = selectionRect(sel);
    let text = sel.toString();
    if (!text || !text.trim()) {
      hideButton();
      return;
    }
    if (settings.sentenceMode) {
      const expanded = expandSelectionToSentence(sel);
      if (expanded) {
        text = expanded.text;
        try {
          sel.removeAllRanges();
          sel.addRange(expanded.range);
          rect = selectionRect(sel) || rect;
        } catch (_) {}
      }
    }
    if (settings.autoTranslate) {
      translateText(text, rect);
    } else {
      showButton(rect || { right: 40, top: 60, left: 0, bottom: 0, width: 0 }, () => translateText(text, rect));
    }
  }

  let mouseUpTimer = null;
  document.addEventListener(
    'mouseup',
    (event) => {
      if (IS_PDF) return;
      clearTimeout(mouseUpTimer);
      mouseUpTimer = setTimeout(() => handleMouseUp(event), 30);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    (event) => {
      if (closestOf(event.target, `#${HOST_ID}`)) return;
      hideButton();
      if (!card.contains(event.target)) hideCard();
    },
    true
  );

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideButton();
      hideCard();
      return;
    }
    // 快捷键兜底：即使 chrome.commands 没注册成功（组合键被系统/输入法占用），
    // 普通网页上仍然可以用 Alt+Z 触发。内置阅读器里这招无效（页面收不到键盘事件）。
    if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyZ') {
      event.preventDefault();
      triggerExternal({ via: 'keydown' });
    }
  });

  /* ------------------------------------ 场景 B：Chrome/Edge 内置 PDF */

  /**
   * 内置 PDF 阅读器里读选区。
   *
   * 事实：内置阅读器把 PDF 交给插件渲染，页面 DOM 里没有文字、也收不到鼠标事件，
   * window.getSelection() 恒为空；document.execCommand('copy') 在这个页面同样没有选区可复制
   * （乱调还可能把用户已复制的剪贴板内容清掉）。所以这里只做「读」：
   * 用户自己按 Ctrl+C 后，我们从剪贴板把内容读回来（扩展有 clipboardRead 权限）。
   */
  async function readPdfSelection() {
    const domText = cleanText(domSelectionText());
    if (domText) return { text: domText, via: 'dom' };
    try {
      const clip = cleanText(await navigator.clipboard.readText());
      if (clip) return { text: clip, via: 'clipboard' };
    } catch (_) {}
    return { text: '', via: 'none' };
  }

  const PDF_HINT =
    '内置 PDF 阅读器不把选区暴露给扩展：请先用 Ctrl+C 复制选中文字再按快捷键，' +
    '或按 Alt+X 用本扩展自己的阅读器打开该 PDF —— 在那里才是真正的「选中即翻译」。';

  async function translateSelectionExternal(msg) {
    if (IS_PDF) {
      const { text, via } = await readPdfSelection();
      if (!text) {
        toast(PDF_HINT, 6000);
        return { ok: false, error: PDF_HINT };
      }
      await translateText(text, null);
      return { ok: true, via, length: text.length };
    }
    const sel = window.getSelection();
    let rect = sel ? selectionRect(sel) : null;
    let text = cleanText((sel && !sel.isCollapsed ? sel.toString() : '') || (msg && msg.text) || '');
    if (!text) {
      toast('没有选中的文本');
      return { ok: false, error: 'no selection' };
    }
    await translateText(text, rect);
    return { ok: true, length: text.length };
  }

  /** 带去重的触发入口：chrome.commands 与页面 keydown 兜底可能同时到达 */
  let lastTriggerAt = 0;
  function triggerExternal(msg) {
    const now = Date.now();
    if (now - lastTriggerAt < 700) return Promise.resolve({ ok: false, error: 'duplicate trigger' });
    lastTriggerAt = now;
    return translateSelectionExternal(msg || {});
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'translate-upgrade') {
      applyUpgrade(msg);
      return false;
    }
    if (msg && msg.type === 'translate-stream') {
      applyStream(msg);
      return false;
    }
    if (msg && msg.type === 'translate-selection') {
      triggerExternal(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));
      return true;
    }
    if (msg && msg.type === 'ping') {
      sendResponse({ ok: true, pdf: IS_PDF });
      return false;
    }
    return false;
  });

  /* --------------------------- 内置阅读器：剪贴板监听（Ctrl+C 即翻译） */

  let lastClipboard = null;
  let watching = false;
  setInterval(async () => {
    if (!IS_PDF || watching) return; // 只在内置 PDF 阅读器里需要它
    if (!settings.clipboardWatch) return;
    if (!document.hasFocus()) return;
    watching = true;
    try {
      const clip = cleanText(await navigator.clipboard.readText());
      if (lastClipboard === null) {
        lastClipboard = clip;
      } else if (clip && clip !== lastClipboard && clip.length <= 1500) {
        lastClipboard = clip;
        const sel = window.getSelection();
        await translateText(clip, sel && !sel.isCollapsed ? selectionRect(sel) : null);
      }
    } catch (_) {
    } finally {
      watching = false;
    }
  }, 900);
})();
