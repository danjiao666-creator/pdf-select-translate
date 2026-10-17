'use strict';

const path = require('node:path');

const APP_ORIGIN = 'pdf-translator://app';
const PAGE_PATHS = new Set(['/src/viewer.html', '/src/options.html']);
const MESSAGE_TYPES = new Set([
  'getSettings', 'saveSettings', 'translate', 'testTranslate',
  'openViewer', 'getTabInfo', 'chat', 'chatCancel'
]);
const PUSH_TYPES = new Set([
  'translate-selection', 'translate-upgrade', 'translate-stream', 'chat-stream'
]);

function trustedPage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'pdf-translator:' && url.hostname === 'app'
      && !url.username && !url.password && !url.port && PAGE_PATHS.has(url.pathname);
  } catch (_) { return false; }
}

function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch (_) { return null; }
}

function resourcePath(root, value) {
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.protocol !== 'pdf-translator:' || url.hostname !== 'app' || url.username || url.password || url.port) return null;
  let relative;
  try { relative = decodeURIComponent(url.pathname); } catch (_) { return null; }
  if (/[\u0000-\u001f\\]/.test(relative) || relative.includes('..')) return null;
  if (!/^\/(?:src|vendor|icons)\//.test(relative)) return null;
  if (!/\.(?:html|js|mjs|css|png|ico|svg|bcmap|pfb|ttf|otf|woff2?|wasm)$/i.test(relative)) return null;
  const resolved = path.resolve(root, '.' + relative);
  const boundary = path.relative(path.resolve(root), resolved);
  return boundary && !boundary.startsWith('..') && !path.isAbsolute(boundary) ? resolved : null;
}

function boundedMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !MESSAGE_TYPES.has(value.type)) {
    throw new Error('不支持的应用请求');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 2 * 1024 * 1024) throw new Error('请求内容过大');
  return value;
}

function safeFilename(value, fallback = 'document.pdf') {
  const name = path.basename(String(value || fallback)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '');
  return name && !/^(?:CON|PRN|AUX|NUL|COM\d|LPT\d)(?:\.|$)/i.test(name) ? name.slice(0, 180) : fallback;
}

module.exports = { APP_ORIGIN, PAGE_PATHS, MESSAGE_TYPES, PUSH_TYPES, trustedPage, externalUrl, resourcePath, boundedMessage, safeFilename };
