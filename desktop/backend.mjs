import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const pending = new Map();
const network = new Map();
let serial = 0;
function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    fire(...args) { for (const listener of listeners) { try { listener(...args); } catch (_) {} } },
    listeners
  };
}
function rpc(operation, payload) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('应用后台响应超时')); }, 30000);
    pending.set(id, { resolve, reject, timer });
    parentPort.postMessage({ kind: 'rpc', id, operation, payload });
  });
}

const runtimeMessage = event();
const storageChanged = event();
const startup = event();
const command = event();
globalThis.chrome = {
  runtime: {
    getURL(value = '') { return 'pdf-translator://app/' + String(value).replace(/^\/+/, ''); },
    onMessage: runtimeMessage,
    onInstalled: event(), onStartup: startup,
    lastError: undefined
  },
  storage: {
    local: {
      get(keys) { return rpc('storage:get', { keys }); },
      set(value) { return rpc('storage:set', { value }); }
    },
    onChanged: storageChanged
  },
  tabs: {
    query(query) { return rpc('tabs:query', { query }); },
    create(properties) { return rpc('tabs:create', { properties }); },
    update(tabId, properties) { return rpc('tabs:update', { tabId, properties }); },
    sendMessage(tabId, message) { return rpc('tabs:send', { tabId, message }); },
    onUpdated: event()
  },
  contextMenus: { removeAll(callback) { callback?.(); }, create() {}, onClicked: event() },
  commands: { onCommand: command },
  scripting: { async executeScript() { throw new Error('桌面版不向外部页面注入脚本'); } }
};

// Electron's main-process network stack preserves system proxy settings and streams bodies.
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url === 'pdf-translator://app/config.local.json') {
    return new Response(workerData.developerConfig ? JSON.stringify(workerData.developerConfig) : '', {
      status: workerData.developerConfig ? 200 : 404,
      headers: { 'content-type': 'application/json' }
    });
  }
  const id = ++serial;
  if (init.signal?.aborted) throw new DOMException('The operation was aborted', 'AbortError');
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, controller: null, signal: init.signal };
    entry.abort = () => {
      parentPort.postMessage({ kind: 'fetch-abort', id });
      const error = new DOMException('The operation was aborted', 'AbortError');
      if (entry.controller) entry.controller.error(error); else reject(error);
      entry.signal?.removeEventListener('abort', entry.abort);
      network.delete(id);
    };
    network.set(id, entry);
    init.signal?.addEventListener('abort', entry.abort, { once: true });
    parentPort.postMessage({ kind: 'fetch', id, url, init: {
      method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body
    } });
  });
};

parentPort.on('message', (message) => {
  if (message.kind === 'rpc-result') {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
  } else if (message.kind === 'request') {
    let answered = false;
    const reply = (result) => {
      if (answered) return;
      answered = true;
      parentPort.postMessage({ kind: 'response', id: message.id, result });
    };
    for (const listener of runtimeMessage.listeners) {
      try { listener(message.message, message.sender, reply); }
      catch (error) { reply({ ok: false, error: error.message }); }
    }
    if (!runtimeMessage.listeners.size) reply({ ok: false, error: '应用后台尚未就绪' });
  } else if (message.kind === 'storage-changed') storageChanged.fire(message.changes, 'local');
  else if (message.kind === 'command') command.fire(message.command);
  else if (message.kind === 'fetch-head') {
    const entry = network.get(message.id);
    if (!entry) return;
    const noBody = [101, 204, 205, 304].includes(message.status);
    const body = noBody ? null : new ReadableStream({
      start(controller) { entry.controller = controller; },
      cancel() { entry.abort(); }
    });
    entry.resolve(new Response(body, { status: message.status, statusText: message.statusText, headers: message.headers }));
  } else if (message.kind === 'fetch-chunk') {
    network.get(message.id)?.controller?.enqueue(new Uint8Array(message.chunk));
  } else if (message.kind === 'fetch-end' || message.kind === 'fetch-error') {
    const entry = network.get(message.id);
    if (!entry) return;
    network.delete(message.id);
    entry.signal?.removeEventListener('abort', entry.abort);
    if (message.kind === 'fetch-error') {
      const error = new Error(message.error || '网络请求失败');
      if (entry.controller) entry.controller.error(error); else entry.reject(error);
    } else entry.controller?.close();
  }
});

try {
  await import(pathToFileURL(path.join(workerData.root, 'src', 'background.js')).href);
  startup.fire();
  parentPort.postMessage({ kind: 'ready' });
} catch (error) {
  parentPort.postMessage({ kind: 'fatal', error: error.message });
}
