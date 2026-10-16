/**
 * PDF 划词翻译 —— 自带阅读器（基于本地 pdf.js）
 *
 * 思路：pdf.js 会把页面渲染成 canvas，同时我们可以用 page.getTextContent()
 * 自己铺一层「透明文字层」叠在 canvas 上。这样浏览器原生的选区/Range 就能作用在
 * PDF 文字上 —— 于是「选中即翻译」是真正可实现的（内置阅读器做不到这一点）。
 *
 * 关键点：
 *  - 文字层 span 用 viewport.transform 定位，布局完成后按 item.width 做 scaleX 校正，保证选区贴合。
 *  - 划词后可选「整句」：把选区扩展到句子边界（基于文字层 DOM 的 Range）。
 *  - 翻译请求全部发给 background（service worker），避免页面 CORS / 泄露 API Key。
 */

import * as pdfjsLib from '../vendor/pdf.min.mjs';

const WORKER_URL = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
const CMAP_URL = chrome.runtime.getURL('vendor/cmaps/');
const STD_FONTS_URL = chrome.runtime.getURL('vendor/standard_fonts/');
pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;

const $ = (id) => document.getElementById(id);
const els = {
  viewport: $('viewport'),
  pages: $('pages'),
  empty: $('empty'),
  emptyPick: $('emptyPick'),
  emptyClose: $('emptyClose'),
  docName: $('docName'),
  pageInput: $('pageInput'),
  pageCount: $('pageCount'),
  prevPage: $('prevPage'),
  nextPage: $('nextPage'),
  zoomIn: $('zoomIn'),
  zoomOut: $('zoomOut'),
  zoomLabel: $('zoomLabel'),
  fitWidth: $('fitWidth'),
  targetLang: $('targetLang'),
  engine: $('engine'),
  sentenceMode: $('sentenceMode'),
  autoTranslate: $('autoTranslate'),
  openLocal: $('openLocal'),
  fileInput: $('fileInput'),
  openOriginal: $('openOriginal'),
  openOptions: $('openOptions'),
  status: $('status'),
  toast: $('toast'),
  card: $('card'),
  cardBadge: $('cardBadge'),
  cardTitle: $('cardTitle'),
  cardSrc: $('cardSrc'),
  cardOut: $('cardOut'),
  cardCopy: $('cardCopy'),
  cardRetry: $('cardRetry'),
  cardClose: $('cardClose')
};

const state = {
  pdf: null,
  numPages: 0,
  scale: 1,
  fit: true,
  currentPage: 1,
  gen: 0,
  entries: new Map(),
  pages: new Map(),
  defaultW: 612,
  defaultH: 792,
  settings: {
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    engine: 'auto',
    sentenceMode: true,
    autoTranslate: true,
    defaultZoom: 'fit',
    cardFontSize: 15
  }
};

const MAX_RENDERED = 10;
const MAX_CONCURRENT = 3;
let activeRenders = 0;
const pending = new Set();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/* ------------------------------------------------------------ 与后台通信 */

function sendMsg(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ ok: false, error: err.message });
        else resolve(res === undefined ? { ok: false, error: '扩展后台未响应' } : res);
      });
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

async function loadSettings() {
  const res = await sendMsg({ type: 'getSettings' });
  if (res && res.ok && res.settings) state.settings = { ...state.settings, ...res.settings };
  syncToolbarFromSettings();
}

function syncToolbarFromSettings() {
  const s = state.settings;
  if (s.targetLang) els.targetLang.value = s.targetLang;
  if (s.engine) els.engine.value = s.engine;
  els.sentenceMode.checked = Boolean(s.sentenceMode);
  els.autoTranslate.checked = Boolean(s.autoTranslate);
  els.card.style.fontSize = `${Number(s.cardFontSize) || 15}px`;
}

function patchSettings(patch) {
  state.settings = { ...state.settings, ...patch };
  sendMsg({ type: 'saveSettings', settings: patch });
}

/* ------------------------------------------------------------------ 状态 */

let statusTimer = null;
function setStatus(text, isError) {
  clearTimeout(statusTimer);
  if (!text) {
    els.status.hidden = true;
    return;
  }
  els.status.textContent = text;
  els.status.className = `status${isError ? ' error' : ''}`;
  els.status.hidden = false;
  if (!isError) statusTimer = setTimeout(() => (els.status.hidden = true), 4000);
}

let toastTimer = null;
function toast(text, ms = 4200) {
  els.toast.textContent = text;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), ms);
}

/* ------------------------------------------------------------- 文本处理 */

function cleanText(input) {
  return (input || '')
    .replace(/\u00ad/g, '')
    .replace(/([A-Za-z])-\s*\n\s*([a-z])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .replace(
      /(?<=[\u3400-\u9fff\u3040-\u30ff\u3000-\u303f\uff00-\uffef])\s+(?=[\u3400-\u9fff\u3040-\u30ff\u3000-\u303f\uff00-\uffef])/g,
      ''
    )
    .trim();
}

const MAX_EXPAND = 220;

function currentNode(node) {
  return node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
}

/** 安全版 closest：事件目标可能是 document / window，没有 closest 方法 */
function closestOf(target, selector) {
  if (!target || typeof target.closest !== 'function') return null;
  try {
    return target.closest(selector);
  } catch (_) {
    return null;
  }
}

function rangeOf(node, offset) {
  return { node, offset };
}

/**
 * 为文字层建立「文本模型」。
 *
 * pdf.js 的文本是很多个独立 span，直接把它们拼起来会出现
 * "…documentThe quick brown fox…" 这种单词粘连，句子边界也无从判断。
 * 所以这里按 span 的 offsetTop 判断是否换行，换行处补一个虚拟空格，
 * 同时记录每段文本对应的真实 DOM 文本节点与偏移，保证能映射回 Range。
 */
const SAME_LINE_TOLERANCE = 6;

function sameLine(a, b) {
  return Math.abs(a - b) <= SAME_LINE_TOLERANCE;
}

function buildLayerModel(layer) {
  const map = [];
  let text = '';
  let prevTop = null;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT, null);
  let node = walker.nextNode();
  while (node) {
    const value = node.nodeValue || '';
    if (value) {
      const parent = node.parentElement;
      const top = parent ? parent.offsetTop : 0;
      if (map.length && prevTop !== null && !sameLine(prevTop, top) && !/\s$/.test(text)) {
        text += ' ';
      }
      const start = text.length;
      text += value;
      map.push({ node, start, end: text.length, top });
      prevTop = top;
    }
    node = walker.nextNode();
  }
  return { text, map };
}

function offsetOfPoint(model, node, nodeOffset) {
  for (const seg of model.map) {
    if (seg.node === node) {
      return seg.start + Math.min(Math.max(nodeOffset, 0), seg.end - seg.start);
    }
  }
  return -1;
}

function pointAtOffset(model, offset) {
  const { map } = model;
  for (const seg of map) {
    if (offset <= seg.end) {
      return rangeOf(seg.node, Math.min(Math.max(offset - seg.start, 0), seg.end - seg.start));
    }
  }
  const last = map[map.length - 1];
  return last ? rangeOf(last.node, (last.node.nodeValue || '').length) : null;
}

function lineStartOffset(model, offset) {
  let idx = model.map.findIndex((seg) => offset <= seg.end);
  if (idx < 0) idx = model.map.length - 1;
  const top = model.map[idx] ? model.map[idx].top : 0;
  while (idx > 0 && sameLine(model.map[idx - 1].top, top)) idx--;
  return model.map[idx] ? model.map[idx].start : offset;
}

function lineEndOffset(model, offset) {
  let idx = model.map.findIndex((seg) => offset < seg.end);
  if (idx < 0) idx = model.map.length - 1;
  const top = model.map[idx] ? model.map[idx].top : 0;
  while (idx + 1 < model.map.length && sameLine(model.map[idx + 1].top, top)) idx++;
  return model.map[idx] ? model.map[idx].end : offset;
}

function isSentenceBoundary(text, index) {
  const ch = text[index];
  if (!ch) return false;
  if ('。！？!?；;'.includes(ch)) return true;
  if (ch === '\n' || ch === '\r') return true;
  if (ch === '.' || ch === '!' || ch === '?') {
    const next = text[index + 1];
    return next === undefined || /\s/.test(next);
  }
  return false;
}

/** 把 Range 扩展到所在句子的首尾，返回新 Range（失败返回 null） */
function expandRangeToSentence(range) {
  const layer = closestOf(currentNode(range.startContainer), '.textLayer');
  if (!layer) return null;
  if (!layer.contains(currentNode(range.endContainer))) return null;

  const model = buildLayerModel(layer);
  const text = model.text;
  if (!text || text.length > 20000) return null;

  const selStart = offsetOfPoint(model, range.startContainer, range.startOffset);
  const selEnd = offsetOfPoint(model, range.endContainer, range.endOffset);
  if (selStart < 0 || selEnd < 0 || selEnd <= selStart) return null;

  let from = selStart;
  const backLimit = Math.max(0, selStart - MAX_EXPAND);
  for (let i = selStart - 1; i >= backLimit; i--) {
    if (isSentenceBoundary(text, i)) {
      from = i + 1;
      break;
    }
  }
  if (from === selStart) {
    // 附近没有句读：退一步，至少补全当前这一行
    const start = lineStartOffset(model, selStart);
    if (start < selStart) from = start;
  }

  let to = selEnd;
  const forwardLimit = Math.min(text.length, selEnd + MAX_EXPAND);
  for (let i = selEnd; i < forwardLimit; i++) {
    if (isSentenceBoundary(text, i)) {
      to = i + 1;
      break;
    }
  }
  if (to === selEnd) {
    const end = lineEndOffset(model, selEnd);
    if (end > selEnd) to = end;
  }

  while (from < to && /\s/.test(text[from])) from++;
  while (to > from && /\s/.test(text[to - 1])) to--;
  if (to <= from || to - from > 600) return null;

  const a = pointAtOffset(model, from);
  const b = pointAtOffset(model, to);
  if (!a || !b) return null;

  const expanded = document.createRange();
  try {
    expanded.setStart(a.node, a.offset);
    expanded.setEnd(b.node, b.offset);
  } catch (_) {
    return null;
  }
  const out = cleanText(expanded.toString());
  if (!out || out.length > 600) return null;
  return { range: expanded, text: out };
}

/* --------------------------------------------------------------- 文字层 */

function buildTextLayer(textContent, viewport) {
  const layer = document.createElement('div');
  layer.className = 'textLayer';
  const frag = document.createDocumentFragment();
  const spans = [];

  for (const item of textContent.items) {
    if (!item || typeof item.str !== 'string' || item.str.length === 0) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const fontHeight = Math.hypot(tx[2], tx[3]);
    if (!fontHeight) continue;
    const angle = Math.atan2(tx[1], tx[0]);

    const span = document.createElement('span');
    span.textContent = item.str === ' ' ? '\u00a0' : item.str;
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5] - fontHeight}px`;
    span.style.fontSize = `${fontHeight}px`;
    span.style.fontFamily = 'sans-serif';
    if (angle) span.style.transform = `rotate(${angle}rad)`;
    span.dataset.tw = String((item.width || 0) * viewport.scale);
    frag.appendChild(span);
    spans.push(span);
  }

  layer.appendChild(frag);

  // 布局完成后校正宽度，让选区贴合 PDF 原文
  for (const span of spans) {
    const target = Number(span.dataset.tw);
    const measured = span.offsetWidth;
    if (!target || !measured) continue;
    const k = target / measured;
    if (Math.abs(k - 1) > 0.02) {
      const rot = span.style.transform;
      span.style.transform = `${rot ? `${rot} ` : ''}scaleX(${k.toFixed(4)})`;
    }
  }
  return layer;
}

/* -------------------------------------------------------------- 文档加载 */

async function getPage(n) {
  if (state.pages.has(n)) return state.pages.get(n);
  const promise = state.pdf.getPage(n);
  state.pages.set(n, promise);
  return promise;
}

function makeEntry(n) {
  const container = document.createElement('div');
  container.className = 'page';
  container.dataset.page = String(n);
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.textContent = `第 ${n} 页`;
  container.appendChild(ph);
  const entry = {
    n,
    container,
    canvas: null,
    layer: null,
    rendered: false,
    rendering: false,
    w: state.defaultW,
    h: state.defaultH
  };
  state.entries.set(n, entry);
  applySize(entry);
  els.pages.appendChild(container);
  io.observe(container);
  return entry;
}

function applySize(entry) {
  entry.container.style.width = `${Math.round(entry.w * state.scale)}px`;
  entry.container.style.height = `${Math.round(entry.h * state.scale)}px`;
}

function buildPlaceholders(numPages) {
  els.pages.replaceChildren();
  state.entries.clear();
  for (let n = 1; n <= numPages; n++) makeEntry(n);
}

const io = new IntersectionObserver(
  (records) => {
    for (const rec of records) {
      if (!rec.isIntersecting) continue;
      const n = Number(rec.target.dataset.page);
      ensureSize(n);
      queueRender(n);
    }
  },
  { root: els.viewport, rootMargin: '900px 0px' }
);

async function ensureSize(n) {
  const entry = state.entries.get(n);
  if (!entry || entry.sizeKnown) return;
  entry.sizeKnown = true;
  try {
    const page = await getPage(n);
    const vp = page.getViewport({ scale: 1 });
    entry.w = vp.width;
    entry.h = vp.height;
    if (!entry.rendered) applySize(entry);
  } catch (_) {}
}

function queueRender(n) {
  const entry = state.entries.get(n);
  if (!entry || entry.rendered || entry.rendering || pending.has(n)) return;
  pending.add(n);
  (async () => {
    while (activeRenders >= MAX_CONCURRENT) await sleep(50);
    activeRenders++;
    try {
      await renderPage(n);
    } catch (err) {
      const ph = entry.container.querySelector('.placeholder');
      if (ph) ph.textContent = `第 ${n} 页渲染失败：${err && err.message ? err.message : err}`;
      entry.rendering = false;
    } finally {
      activeRenders--;
      pending.delete(n);
    }
  })();
}

async function renderPage(n) {
  const entry = state.entries.get(n);
  if (!entry || entry.rendered || entry.rendering) return;
  entry.rendering = true;
  const gen = state.gen;

  try {
    const page = await getPage(n);
    if (gen !== state.gen) return;

    const vp1 = page.getViewport({ scale: 1 });
    entry.w = vp1.width;
    entry.h = vp1.height;
    entry.sizeKnown = true;

    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const viewport = page.getViewport({ scale: state.scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d', { alpha: false });

    const task = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
    });
    entry.task = task;
    await task.promise;
    if (gen !== state.gen) return;

    const textContent = await page.getTextContent();
    if (gen !== state.gen) return;

    const layer = buildTextLayer(textContent, viewport);
    entry.container.replaceChildren(canvas, layer);
    entry.canvas = canvas;
    entry.layer = layer;
    entry.rendered = true;
    applySize(entry);
    trimRendered();
  } finally {
    entry.rendering = false;
  }
}

function trimRendered() {
  const rendered = [...state.entries.values()].filter((e) => e.rendered);
  if (rendered.length <= MAX_RENDERED) return;
  rendered
    .sort((a, b) => Math.abs(b.n - state.currentPage) - Math.abs(a.n - state.currentPage))
    .slice(0, rendered.length - MAX_RENDERED)
    .forEach((entry) => unrender(entry));
}

function unrender(entry) {
  if (!entry.rendered) return;
  try {
    if (entry.task && entry.task.cancel) entry.task.cancel();
  } catch (_) {}
  entry.rendered = false;
  entry.canvas = null;
  entry.layer = null;
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.textContent = `第 ${entry.n} 页`;
  entry.container.replaceChildren(ph);
  applySize(entry);
}

async function destroyCurrent() {
  state.gen++;
  io.disconnect();
  for (const entry of state.entries.values()) {
    try {
      if (entry.task && entry.task.cancel) entry.task.cancel();
    } catch (_) {}
  }
  state.entries.clear();
  state.pages.clear();
  els.pages.replaceChildren();
  if (state.pdf) {
    try {
      await state.pdf.destroy();
    } catch (_) {}
  }
  state.pdf = null;
  state.numPages = 0;
  els.pageCount.textContent = '-';
  els.pageInput.value = '1';
  els.docName.textContent = '未打开文件';
  state.currentPage = 1;
}

async function setupDocument(pdf, name) {
  state.pdf = pdf;
  state.numPages = pdf.numPages;
  els.docName.textContent = name || 'document.pdf';
  els.docName.title = name || '';
  els.pageCount.textContent = String(pdf.numPages);
  els.empty.hidden = true;

  const first = await getPage(1);
  const vp = first.getViewport({ scale: 1 });
  state.defaultW = vp.width;
  state.defaultH = vp.height;

  io.disconnect();
  buildPlaceholders(pdf.numPages);
  applyScale(fitScale(), true);
  goToPage(1, false);
  prefetchSizes(1);
}

function fitScale() {
  const available = els.viewport.clientWidth - 36;
  return clamp(available / state.defaultW, 0.25, 4);
}

function applyScale(scale, keepFit) {
  state.scale = clamp(scale, 0.25, 5);
  state.fit = Boolean(keepFit);
  els.fitWidth.classList.toggle('active', state.fit);
  els.zoomLabel.textContent = `${Math.round(state.scale * 100)}%`;
  state.gen++;

  for (const entry of state.entries.values()) {
    if (entry.rendered) unrender(entry);
    else applySize(entry);
  }
  const vpRect = els.viewport.getBoundingClientRect();
  for (const entry of state.entries.values()) {
    const r = entry.container.getBoundingClientRect();
    if (r.bottom > vpRect.top - 900 && r.top < vpRect.bottom + 900) queueRender(entry.n);
  }
}

function goToPage(n, smooth = true) {
  const target = clamp(Math.round(n), 1, Math.max(1, state.numPages));
  const entry = state.entries.get(target);
  if (!entry) return;
  state.currentPage = target;
  els.pageInput.value = String(target);
  entry.container.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
}

async function prefetchSizes(from) {
  const pdf = state.pdf;
  const start = Math.max(1, from - 2);
  const end = Math.min(state.numPages, from + 14);
  for (let n = start; n <= end; n++) {
    if (pdf !== state.pdf) return;
    const entry = state.entries.get(n);
    if (!entry || entry.sizeKnown) continue;
    await ensureSize(n);
  }
}

/* ---------------------------------------------------------------- 打开 PDF */

async function openUrl(url, name) {
  await destroyCurrent();
  setStatus('正在加载 PDF…');
  const task = pdfjsLib.getDocument({
    url,
    withCredentials: true,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STD_FONTS_URL,
    onPassword: (callback, reason) => {
      const message = reason === 2 ? '密码错误，请重新输入 PDF 密码：' : '该 PDF 需要密码：';
      const pwd = window.prompt(message, '');
      if (pwd === null) callback(null);
      else callback(pwd);
    }
  });
  task.onProgress = (p) => {
    if (p && p.total) setStatus(`正在加载 PDF… ${Math.round((p.loaded / p.total) * 100)}%`);
    else if (p && p.loaded) setStatus(`正在加载 PDF… ${Math.round(p.loaded / 1024)} KB`);
  };
  try {
    const pdf = await task.promise;
    await setupDocument(pdf, name || guessName(url));
    setStatus(null);
  } catch (err) {
    setStatus(null);
    showLoadError(err, url);
  }
}

async function openData(data, name) {
  await destroyCurrent();
  setStatus('正在解析文件…');
  try {
    const pdf = await pdfjsLib.getDocument({
      data,
      cMapUrl: CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: STD_FONTS_URL
    }).promise;
    state.fileUrl = '';
    els.openOriginal.hidden = true;
    await setupDocument(pdf, name || '本地文件.pdf');
    setStatus(null);
  } catch (err) {
    setStatus(null);
    showLoadError(err, '');
  }
}

function guessName(url) {
  try {
    const clean = url.split('#')[0].split('?')[0];
    const last = decodeURIComponent(clean.split('/').pop() || '');
    return last || 'document.pdf';
  } catch (_) {
    return 'document.pdf';
  }
}

function showLoadError(err, url) {
  const message = err && err.message ? err.message : String(err);
  els.empty.hidden = false;
  els.empty.querySelector('h1').textContent = '无法打开这个 PDF';
  els.empty.querySelector('p').innerHTML =
    `原因：<code>${escapeHtml(message)}</code><br />` +
    '常见情况：需要登录/带 Cookie 才能下载、被服务器拒绝跨域读取、或者链接已失效。<br />' +
    '你仍然可以用「选择本地 PDF」把文件拖进来（本地文件一定能翻译）。';
  setStatus(`加载失败：${message}`, true);
  if (url) {
    els.openOriginal.hidden = false;
    els.openOriginal.href = url;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------ 卡片 */

let floatBtn = null;
let requestSeq = 0;
/** 当前这次翻译的请求标识：用来识别「升级」消息 */
let currentRequestKey = '';
let lastText = '';
let lastRect = null;

function ensureFloatButton() {
  if (floatBtn) return floatBtn;
  floatBtn = document.createElement('button');
  floatBtn.textContent = '译';
  floatBtn.style.cssText = [
    'position:fixed', 'z-index:60', 'display:none', 'width:30px', 'height:30px',
    'border:1px solid rgba(255,255,255,.3)', 'border-radius:8px', 'cursor:pointer',
    'background:#1f6feb', 'color:#fff', 'font:700 14px/1 system-ui,sans-serif',
    'box-shadow:0 3px 10px rgba(0,0,0,.28)', 'padding:0'
  ].join(';');
  floatBtn.addEventListener('mousedown', (e) => e.preventDefault());
  floatBtn.addEventListener('click', () => {
    hideFloatButton();
    translateNow(lastText, lastRect);
  });
  document.body.appendChild(floatBtn);
  return floatBtn;
}

function showFloatButton(rect, text) {
  ensureFloatButton();
  lastText = text;
  lastRect = rect;
  const x = clamp((rect ? rect.right : 60) + 6, 8, window.innerWidth - 40);
  const y = clamp((rect ? rect.top : 60) - 6, 8, window.innerHeight - 40);
  floatBtn.style.left = `${x}px`;
  floatBtn.style.top = `${y}px`;
  floatBtn.style.display = 'block';
}

function hideFloatButton() {
  if (floatBtn) floatBtn.style.display = 'none';
}

function placeCard(rect) {
  const box = els.card.getBoundingClientRect();
  const width = box.width || 440;
  const height = box.height || 200;
  let left;
  let top;
  if (rect && rect.width) {
    left = rect.left;
    top = rect.bottom + 10;
    if (top + height > window.innerHeight - 10) top = Math.max(10, rect.top - height - 10);
  } else {
    left = (window.innerWidth - width) / 2;
    top = Math.max(10, window.innerHeight - height - 40);
  }
  els.card.style.left = `${clamp(left, 8, Math.max(8, window.innerWidth - width - 8))}px`;
  els.card.style.top = `${clamp(top, 8, Math.max(8, window.innerHeight - height - 8))}px`;
}

function showCard(text, rect) {
  els.cardSrc.textContent = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  els.card.hidden = false;
  placeCard(rect);
}

function setCardLoading() {
  els.cardBadge.textContent = '翻译中…';
  els.cardTitle.textContent = '划词翻译';
  els.cardOut.className = 'pt-out loading';
  els.cardOut.textContent = '正在请求翻译引擎…';
}

function setCardResult(res) {
  if (res && res.ok) {
    els.cardBadge.textContent = res.engineLabel
      ? `${res.engineLabel}${res.elapsedMs ? ` · ${(res.elapsedMs / 1000).toFixed(1)}s` : ''}${res.provisional ? ' · AI 优化中…' : ''}`
      : 'AI';
    els.cardTitle.textContent = res.cached ? '划词翻译（缓存）' : '划词翻译';
    els.cardOut.className = 'pt-out';
    els.cardOut.textContent = res.translation;
    els.cardOut.dataset.copy = res.translation;
  } else {
    els.cardBadge.textContent = '失败';
    els.cardTitle.textContent = '翻译失败';
    els.cardOut.className = 'pt-out error';
    els.cardOut.textContent =
      `${(res && res.error) || '未知错误'}\n\n` +
      '提示：免费的 Google / Microsoft 接口在部分网络下不可达，可在「设置」里配置 DeepSeek 等自定义 API。';
    els.cardOut.dataset.copy = '';
  }
  placeCard(lastRect);
}

/** 自定义 API 的流式片段：边生成边显示，首屏时间 = 首字时间(TTFT) */
function applyStream(msg) {
  if (!msg || !currentRequestKey || msg.requestId !== currentRequestKey) return;
  if (msg.reset) {
    els.cardBadge.textContent = 'AI 生成中…';
    return;
  }
  if (typeof msg.text !== 'string' || !msg.text) return;
  els.cardOut.className = 'pt-out';
  els.cardOut.textContent = msg.text;
  els.cardOut.dataset.copy = msg.text;
  els.cardBadge.textContent = `AI 生成中… ${msg.text.length} 字`;
  placeCard(lastRect);
}

/** 自定义 API 的升级结果到了：替换卡片内容（只认当前这次请求） */
function applyUpgrade(msg) {
  if (!msg || !currentRequestKey || msg.requestId !== currentRequestKey) return;
  if (msg.ok) {
    els.cardBadge.textContent = msg.engineLabel
      ? `${msg.engineLabel}${msg.elapsedMs ? ` · ${(msg.elapsedMs / 1000).toFixed(1)}s` : ''}`
      : 'AI';
    els.cardTitle.textContent = '划词翻译（已优化）';
    els.cardOut.className = 'pt-out';
    els.cardOut.textContent = msg.translation;
    els.cardOut.dataset.copy = msg.translation;
  } else {
    els.cardBadge.textContent = `${els.cardBadge.textContent.replace(/ · AI 优化中…$/, '')} · 优化失败`;
  }
  placeCard(lastRect);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg) return false;
  if (msg.type === 'translate-upgrade') applyUpgrade(msg);
  else if (msg.type === 'translate-stream') applyStream(msg);
  return false;
});

async function translateNow(text, rect) {
  const payload = cleanText(text);
  if (!payload) {
    toast('没有检测到可翻译的文本');
    return;
  }
  lastText = payload;
  lastRect = rect || lastRect;
  const id = ++requestSeq;
  currentRequestKey = `r${id}-${Date.now()}`;
  showCard(payload, lastRect);
  setCardLoading();
  const res = await sendMsg({
    type: 'translate',
    text: payload,
    to: state.settings.targetLang,
    from: state.settings.sourceLang,
    engine: state.settings.engine,
    requestId: currentRequestKey
  });
  if (id !== requestSeq) return;
  setCardResult(res);
}

/* -------------------------------------------------------------- 划词交互 */

let selectionTimer = null;

function onSelectionMouseUp(event) {
  if (closestOf(event.target, '#card') || event.target === floatBtn) return;
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      hideFloatButton();
      return;
    }
    const range = sel.getRangeAt(0);
    const inLayer = Boolean(closestOf(currentNode(range.startContainer), '.textLayer'));
    let text = cleanText(sel.toString());
    let rect = range.getBoundingClientRect();
    if (!rect || !rect.width) {
      const rects = range.getClientRects();
      if (rects && rects.length) rect = rects[rects.length - 1];
    }
    if (!text) {
      hideFloatButton();
      return;
    }
    if (inLayer && state.settings.sentenceMode) {
      const expanded = expandRangeToSentence(range);
      if (expanded) {
        try {
          sel.removeAllRanges();
          sel.addRange(expanded.range);
          rect = expanded.range.getBoundingClientRect() || rect;
        } catch (_) {}
        text = expanded.text;
      }
    }
    if (state.settings.autoTranslate) {
      hideFloatButton();
      translateNow(text, rect);
    } else {
      showFloatButton(rect, text);
    }
  }, 40);
}

document.addEventListener('mouseup', onSelectionMouseUp, true);

document.addEventListener(
  'mousedown',
  (event) => {
    if (closestOf(event.target, '#card') || event.target === floatBtn) return;
    hideFloatButton();
    if (!els.card.hidden) els.card.hidden = true;
  },
  true
);

document.addEventListener('keydown', (event) => {
  const tag = (event.target && event.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (event.key === 'Escape') {
    els.card.hidden = true;
    hideFloatButton();
    return;
  }
  if (typing) return;
  if (event.ctrlKey && (event.key === '=' || event.key === '+')) {
    event.preventDefault();
    applyScale(state.scale + 0.15, false);
  } else if (event.ctrlKey && event.key === '-') {
    event.preventDefault();
    applyScale(state.scale - 0.15, false);
  } else if (event.key === 'PageDown' || event.key === 'ArrowRight') {
    goToPage(state.currentPage + 1);
  } else if (event.key === 'PageUp' || event.key === 'ArrowLeft') {
    goToPage(state.currentPage - 1);
  }
});

els.viewport.addEventListener(
  'wheel',
  (event) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    applyScale(state.scale + (event.deltaY < 0 ? 0.12 : -0.12), false);
  },
  { passive: false }
);

/* ------------------------------------------------------------- 工具栏绑定 */

els.prevPage.addEventListener('click', () => goToPage(state.currentPage - 1));
els.nextPage.addEventListener('click', () => goToPage(state.currentPage + 1));
els.pageInput.addEventListener('change', () => goToPage(Number(els.pageInput.value) || 1, false));
els.pageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') goToPage(Number(els.pageInput.value) || 1, false);
});
els.zoomIn.addEventListener('click', () => applyScale(state.scale + 0.15, false));
els.zoomOut.addEventListener('click', () => applyScale(state.scale - 0.15, false));
els.fitWidth.addEventListener('click', () => applyScale(fitScale(), true));
window.addEventListener('resize', () => {
  if (state.fit && state.pdf) applyScale(fitScale(), true);
});

els.targetLang.addEventListener('change', () => patchSettings({ targetLang: els.targetLang.value }));
els.engine.addEventListener('change', () => patchSettings({ engine: els.engine.value }));
els.sentenceMode.addEventListener('change', () => patchSettings({ sentenceMode: els.sentenceMode.checked }));
els.autoTranslate.addEventListener('change', () => patchSettings({ autoTranslate: els.autoTranslate.checked }));

els.openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.openLocal.addEventListener('click', () => els.fileInput.click());
els.emptyPick.addEventListener('click', () => els.fileInput.click());
els.emptyClose.addEventListener('click', () => (els.empty.hidden = true));
els.cardClose.addEventListener('click', () => (els.card.hidden = true));
els.cardRetry.addEventListener('click', () => translateNow(lastText, lastRect));
els.cardCopy.addEventListener('click', async () => {
  const text = els.cardOut.dataset.copy || '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('译文已复制');
  } catch (_) {
    toast('复制失败，请手动选择文本');
  }
});

els.fileInput.addEventListener('change', async () => {
  const file = els.fileInput.files && els.fileInput.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  await openData(buf, file.name);
  els.fileInput.value = '';
});

/* 拖拽本地 PDF */
['dragenter', 'dragover'].forEach((type) =>
  document.addEventListener(type, (e) => {
    e.preventDefault();
    els.empty.hidden = false;
    els.empty.classList.add('dragover');
  })
);
document.addEventListener('dragleave', () => els.empty.classList.remove('dragover'));
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.empty.classList.remove('dragover');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (file.type && !/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name)) {
    toast('请拖入 PDF 文件');
    return;
  }
  const buf = await file.arrayBuffer();
  await openData(buf, file.name);
});

/* 当前页码跟随滚动 */
let scrollTicking = false;
els.viewport.addEventListener(
  'scroll',
  () => {
    if (scrollTicking || !state.pdf) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      scrollTicking = false;
      const top = els.viewport.getBoundingClientRect().top + 40;
      let best = state.currentPage;
      let bestDist = Infinity;
      for (const entry of state.entries.values()) {
        const r = entry.container.getBoundingClientRect();
        if (r.bottom < top - 200) continue;
        const dist = Math.abs(r.top - top);
        if (dist < bestDist) {
          bestDist = dist;
          best = entry.n;
        }
      }
      if (best !== state.currentPage) {
        state.currentPage = best;
        els.pageInput.value = String(best);
      }
    });
  },
  { passive: true }
);

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  await loadSettings();
  const params = new URLSearchParams(location.search);
  const file = params.get('file') || params.get('url');
  const page = Number(params.get('page') || '0');
  if (file) {
    state.fileUrl = file;
    els.openOriginal.href = file;
    els.openOriginal.hidden = false;
    await openUrl(file, guessName(file));
    if (page > 1) goToPage(page, false);
  } else {
    els.empty.hidden = false;
    els.docName.textContent = '未打开文件';
  }
}

boot();
