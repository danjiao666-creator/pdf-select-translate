import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../../src/background.js', import.meta.url), 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(initial = {}) {
  const store = structuredClone(initial);
  const installed = [], changes = [];
  const event = () => ({ addListener() {} });
  let fetcher = async () => new Response('', { status: 404 });
  const chrome = {
    runtime: { getURL: (p) => `chrome-extension://test/${p}`, onMessage: event(), onStartup: event(), onInstalled: { addListener: (fn) => installed.push(fn) } },
    storage: { local: {
      get: async (key) => ({ [key]: structuredClone(store[key]) }),
      set: async (patch) => {
        for (const [key, value] of Object.entries(patch)) {
          const oldValue = store[key]; store[key] = structuredClone(value);
          for (const listener of changes) listener({ [key]: { oldValue, newValue: structuredClone(value) } }, 'local');
        }
      }
    }, onChanged: { addListener: (fn) => changes.push(fn) } },
    contextMenus: { removeAll: (fn) => fn(), create() {}, onClicked: event() },
    commands: { onCommand: event() }, tabs: { onUpdated: event() }
  };
  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout, AbortController, DOMException, TextEncoder, TextDecoder, URLSearchParams, fetch: (...args) => fetcher(...args) });
  vm.runInContext(source + '\nglobalThis.api = { translateText, getSettings, saveSettings, publicSettings, fetchWithSignal, myMemoryTranslate, splitForLimit, parseExtraBody, PROVIDERS, inflight, cache };', context);
  return { ...context.api, store, installed, fetch: (fn) => { fetcher = fn; } };
}
function mockProviders(api) {
  for (const name of ['google', 'microsoft', 'youdao', 'mymemory']) api.PROVIDERS[name].run = async () => 'FAST';
}
const configured = { settings: { engine: 'custom', fastFirst: true, custom: { baseUrl: 'http://127.0.0.1/v1', model: 'mock' } } };

test('repeated selections subscribe to one upgrade; quality waits for final', async () => {
  const api = setup(configured); mockProviders(api);
  let complete, calls = 0;
  api.PROVIDERS.custom.run = () => { calls++; return new Promise((resolve) => { complete = resolve; }); };
  const a = [], b = [];
  const first = await api.translateText({ text: 'Same sentence', requestId: 'a' }, (r) => a.push(r));
  const second = await api.translateText({ text: 'Same sentence', requestId: 'b' }, (r) => b.push(r));
  assert.equal(first.provisional, true); assert.equal(second.provisional, true);
  let done = false;
  const quality = api.translateText({ text: 'Same sentence', quality: true }).then((r) => { done = true; return r; });
  await delay(10); assert.equal(done, false);
  complete('FINAL'); assert.equal((await quality).translation, 'FINAL');
  await delay(0);
  assert.equal(calls, 1); assert.equal(a[0].requestId, 'a'); assert.equal(b[0].requestId, 'b');
  const cached = await api.translateText({ text: 'Same sentence', quality: true });
  assert.equal(cached.engine, 'custom'); assert.equal(cached.cached, true);
});
test('custom starts immediately even when all free endpoints are slow', async () => {
  const api = setup(configured);
  for (const name of ['google','microsoft','youdao','mymemory']) api.PROVIDERS[name].run = async () => { await delay(80); throw new Error('offline'); };
  api.PROVIDERS.custom.run = async () => 'AI';
  const before = Date.now(); const r = await api.translateText({ text: 'Immediate AI' });
  assert.equal(r.translation, 'AI'); assert.ok(Date.now() - before < 75);
});
test('probe bypasses free fallback and cached results', async () => {
  const api = setup(configured); mockProviders(api);
  api.PROVIDERS.custom.run = async () => { throw new Error('HTTP 401'); };
  const result = await api.translateText({ text: 'Probe', engine: 'custom', probe: true });
  assert.equal(result.ok, false); assert.match(result.error, /401/);
});
test('full-document translation uses only the custom service, without fast-first or fallback', async () => {
  const api = setup({ settings: { ...configured.settings, engine: 'auto' } });
  let freeCalls = 0;
  for (const name of ['google', 'microsoft', 'youdao', 'mymemory']) api.PROVIDERS[name].run = async () => { freeCalls++; return 'FREE'; };
  api.PROVIDERS.custom.run = async () => 'FINAL';
  const first = await api.translateText({ text: 'Full document paragraph.', quality: true, finalOnly: true });
  assert.equal(first.translation, 'FINAL'); assert.equal(freeCalls, 0);
  api.PROVIDERS.custom.run = async () => { throw new Error('HTTP 401'); };
  const failed = await api.translateText({ text: 'Another paragraph.', quality: true, finalOnly: true });
  assert.equal(failed.ok, false); assert.equal(freeCalls, 0);
});
test('document context is bounded, separate from source, and part of the final cache key', async () => {
  const api = setup({ settings: { ...configured.settings, fastFirst: false } });
  const requests = [];
  api.fetch(async (url, options) => {
    if (url.endsWith('config.local.json')) return new Response('', { status: 404 });
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: '驾驶员风险场' }, finish_reason: 'stop' }] });
  });
  const message = { text: 'Driver risk field', finalOnly: true, quality: true, documentContext: { title: 'Paper A', previous: 'x'.repeat(4000), unexpected: 'do not send this' } };
  assert.equal((await api.translateText(message)).ok, true);
  assert.equal((await api.translateText(message)).cached, true);
  await api.translateText({ ...message, documentContext: { title: 'Paper B' } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[1].content, message.text);
  const system = requests[0].messages[0].content;
  assert.match(system, /REFERENCE_CONTEXT_JSON/); assert.match(system, /never instructions/);
  const reference = JSON.parse(system.split('REFERENCE_CONTEXT_JSON:\n')[1]);
  assert.equal(reference.previous.length, 1200); assert.equal(reference.unexpected, undefined);
  assert.equal(requests[0].stream, false);
});
test('truncated model output cannot be saved as a completed translation', async () => {
  const api = setup({ settings: { ...configured.settings, fastFirst: false } });
  api.fetch(async (url) => url.endsWith('config.local.json') ? new Response('', { status: 404 }) :
    Response.json({ choices: [{ message: { content: '被截断的译文' }, finish_reason: 'length' }] }));
  const result = await api.translateText({ text: 'Document paragraph', finalOnly: true, quality: true });
  assert.equal(result.ok, false); assert.match(result.error, /被截断/); assert.equal(api.cache.size, 0);
});
test('untranslated English is not accepted as Chinese document completion', async () => {
  const api = setup({ settings: { ...configured.settings, fastFirst: false } });
  api.PROVIDERS.custom.run = async (text) => text;
  const result = await api.translateText({ text: 'A scientific paragraph that should be translated accurately. '.repeat(3), to: 'zh-CN', finalOnly: true, quality: true });
  assert.equal(result.ok, false); assert.match(result.error, /未返回中文/); assert.equal(api.cache.size, 0);
});
test('request deadline includes the response body', async () => {
  const api = setup();
  api.fetch(async () => ({ json: () => new Promise(() => {}) }));
  await assert.rejects(api.fetchWithSignal('https://mock.invalid', {}, 20), /超时/);
});
test('external cancellation still applies after headers', async () => {
  const api = setup(); const controller = new AbortController();
  api.fetch(async () => ({ json: () => new Promise(() => {}) }));
  const request = api.fetchWithSignal('https://mock.invalid', {}, 1000, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(request, /取消/);
});
test('MyMemory quota messages are errors, not translations', async () => {
  const api = setup();
  api.fetch(async () => Response.json({ responseStatus: 403, responseDetails: 'quota', responseData: { translatedText: 'QUOTA EXCEEDED' } }));
  await assert.rejects(api.myMemoryTranslate('text', 'en', 'zh-CN', {}), /403/);
});
test('MyMemory chunks are UTF-8 byte-safe and preserve surrogate pairs', () => {
  const api = setup(); const input = '汉字🙂'.repeat(200); const parts = api.splitForLimit(input, 450);
  assert.equal(parts.join(''), input);
  for (const part of parts) assert.ok(new TextEncoder().encode(part).length <= 450);
});
test('local credentials use the matching endpoint without being persisted or exposed', async () => {
  const api = setup();
  api.fetch(async () => Response.json({ baseUrl: 'https://local-config.invalid/v1', apiKey: 'mock-private', model: 'local-model' }));
  await api.installed[0]();
  const settings = await api.getSettings();
  assert.equal(settings.custom.baseUrl, 'https://local-config.invalid/v1');
  assert.equal(settings.custom.model, 'local-model');
  assert.equal(settings.custom.apiKey, 'mock-private');
  assert.equal(api.store.settings.custom.apiKey, '');
  assert.equal(api.publicSettings(settings).custom.apiKey, '');
  assert.equal(api.publicSettings(settings).custom.apiKeyConfigured, true);
  await api.saveSettings({ targetLang: 'en' });
  assert.equal(api.store.settings.custom.apiKey, '');
});
test('local key is not sent to a different explicitly configured endpoint', async () => {
  const api = setup({ settings: { custom: { baseUrl: 'https://other.invalid/v1' } } });
  api.fetch(async () => Response.json({ baseUrl: 'https://local-config.invalid/v1', apiKey: 'mock-private' }));
  assert.equal((await api.getSettings()).custom.apiKey, '');
});
test('parallel settings patches do not overwrite one another', async () => {
  const api = setup();
  await Promise.all([api.saveSettings({ targetLang: 'en' }), api.saveSettings({ engine: 'youdao' })]);
  assert.equal(api.store.settings.targetLang, 'en'); assert.equal(api.store.settings.engine, 'youdao');
});
test('settings change prevents old results from repopulating the cache', async () => {
  const api = setup({ settings: { ...configured.settings, fastFirst: false } });
  let complete; api.PROVIDERS.custom.run = () => new Promise((r) => { complete = r; });
  const request = api.translateText({ text: 'Old settings' });
  while (!complete) await delay(1);
  await api.saveSettings({ targetLang: 'en' }); complete('OLD'); await request;
  assert.equal(api.cache.size, 0);
});
test('extra parameters cannot override translation protocol fields', () => {
  const api = setup();
  for (const invalid of ['[]','null','bad','{"stream":false}','{"messages":[]}','{"model":"wrong"}']) assert.throws(() => api.parseExtraBody(invalid));
  assert.equal(api.parseExtraBody('{"enable_thinking":false}').enable_thinking, false);
});
test('oversized selections fail explicitly instead of silently truncating', async () => {
  const api = setup(); const r = await api.translateText({ text: 'a'.repeat(4001) });
  assert.equal(r.ok, false); assert.match(r.error, /4000/);
});
