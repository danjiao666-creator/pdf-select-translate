/**
 * PDF 划词翻译 —— background service worker
 *
 * 职责：
 *  1. 读取/保存设置
 *  2. 翻译引擎抽象（Google 免费接口 / 微软 Edge 免费接口 / 自定义 OpenAI 兼容接口）
 *  3. 右键菜单、快捷键、把 PDF 交给自带的 pdf.js 阅读器打开
 *
 * 所有网络请求都放在 service worker 里，页面/内容脚本只负责发消息，
 * 这样既能绕开网页的 CORS 限制，也能把 API Key 留在扩展内部。
 */

const VIEWER_PAGE = 'src/viewer.html';

const DEFAULTS = {
  /** auto | google | microsoft | custom */
  engine: 'auto',
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  /** 选中后自动翻译（true）还是先显示“译”按钮（false） */
  autoTranslate: true,
  /** 配了自定义 API 时：先用免费引擎秒出，随后用自定义 API 的结果替换 */
  fastFirst: true,
  /** 自动把选中的片段扩展到完整句子 */
  sentenceMode: true,
  /** 打开 .pdf 链接时自动改用自带阅读器 */
  autoOpenPdf: false,
  /** 自带阅读器的默认缩放：fit | number */
  defaultZoom: 'fit',
  /** 在内置 PDF 阅读器中监听剪贴板（Ctrl+C 后自动翻译） */
  clipboardWatch: false,
  /** 悬浮卡片字号 */
  cardFontSize: 15,
  custom: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    /** 额外请求参数（JSON）：用来关闭「思考」或调低思考强度，见 README */
    extraBody: '',
    prompt: 'You are a professional translator. Translate the user text into {target}. Output ONLY the translation without quotes or explanations. Keep numbers, formulas, code and proper nouns accurate.'
  }
};

const LANG_LABEL = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  ru: 'Русский',
  pt: 'Português',
  it: 'Italiano',
  ar: 'العربية'
};

/** 传给大模型的自然语言目标语言名 */
const LANG_PROMPT_NAME = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  'zh-TW': 'Traditional Chinese (繁體中文)',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
  ar: 'Arabic'
};

const ENGINE_LABEL = {
  google: 'Google',
  microsoft: 'Microsoft',
  youdao: '有道',
  mymemory: 'MyMemory',
  custom: '自定义 API'
};

/* ------------------------------------------------------------------ 设置 */

function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  s.custom = { ...DEFAULTS.custom, ...((raw && raw.custom) || {}) };
  return s;
}

/**
 * 本地密钥文件（可选）：扩展目录下的 config.local.json
 *   { "baseUrl": "...", "apiKey": "sk-...", "model": "deepseek-chat" }
 * 只在设置里的 apiKey 为空时兜底使用，方便「不想把 Key 存进浏览器配置」或用脚本批量部署。
 * 这个文件不会被打进分发包（tools/package.py 会跳过它）。
 */
let localConfigCache;
async function getLocalConfig() {
  if (localConfigCache !== undefined) return localConfigCache;
  localConfigCache = null;
  try {
    const res = await fetch(chrome.runtime.getURL('config.local.json'), { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      if (data && typeof data === 'object') localConfigCache = data;
    }
  } catch (_) {
    localConfigCache = null;
  }
  return localConfigCache;
}

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const s = normalizeSettings(stored.settings);
  const local = await getLocalConfig();
  if (local) {
    if (!s.custom.apiKey && local.apiKey) {
      s.custom.apiKey = local.apiKey;
      s.custom.apiKeySource = 'config.local.json';
    }
    if (!s.custom.baseUrl && local.baseUrl) s.custom.baseUrl = local.baseUrl;
    if ((!s.custom.model || s.custom.model === DEFAULTS.custom.model) && local.model) s.custom.model = local.model;
  }
  return s;
}

async function saveSettings(patch) {
  // 注意：不把 config.local.json 里的 Key 写进浏览器配置
  const stored = await chrome.storage.local.get('settings');
  const current = normalizeSettings(stored.settings);
  const next = normalizeSettings({
    ...current,
    ...(patch || {}),
    custom: { ...current.custom, ...((patch && patch.custom) || {}) }
  });
  delete next.custom.apiKeySource;
  await chrome.storage.local.set({ settings: next });
  return getSettings();
}

/* ------------------------------------------------ 引擎健康度（提速关键） */

/**
 * 记住上次成功的引擎，并给「网络不可达/超时」的引擎一段冷却时间。
 * 这样 auto 模式不会每次翻译都重新去撞被墙的 Google。
 */
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;
let engineHealth = { lastGood: null, cooldown: {}, latency: {}, loaded: false };

async function loadEngineHealth() {
  if (engineHealth.loaded) return engineHealth;
  try {
    const stored = await chrome.storage.local.get('engineHealth');
    if (stored.engineHealth && typeof stored.engineHealth === 'object') {
      engineHealth = {
        lastGood: stored.engineHealth.lastGood || null,
        cooldown: stored.engineHealth.cooldown || {},
        latency: stored.engineHealth.latency || {},
        loaded: true
      };
      return engineHealth;
    }
  } catch (_) {}
  engineHealth = { lastGood: null, cooldown: {}, latency: {}, loaded: true };
  return engineHealth;
}

function persistEngineHealth() {
  chrome.storage.local
    .set({
      engineHealth: {
        lastGood: engineHealth.lastGood,
        cooldown: engineHealth.cooldown,
        latency: engineHealth.latency
      }
    })
    .catch(() => {});
}

/** 记录每个引擎的实际耗时（指数滑动平均），用来把最快的排到前面 */
function noteEngineLatency(key, ms) {
  if (!engineHealth.latency) engineHealth.latency = {};
  const prev = engineHealth.latency[key];
  engineHealth.latency[key] = prev ? Math.round(prev * 0.6 + ms * 0.4) : Math.round(ms);
  persistEngineHealth();
}

function engineLatency(key) {
  const table = engineHealth.latency || {};
  const v = table[key];
  if (typeof v === 'number' && v > 0) return v;
  // 还没测过：上次成功的那个先试，其余给一个中庸值
  return engineHealth.lastGood === key ? 150 : 600;
}

function markEngineGood(key) {
  engineHealth.lastGood = key;
  delete engineHealth.cooldown[key];
  persistEngineHealth();
}

function markEngineBad(key) {
  engineHealth.cooldown[key] = Date.now() + FAIL_COOLDOWN_MS;
  if (engineHealth.lastGood === key) engineHealth.lastGood = null;
  persistEngineHealth();
}

function isCoolingDown(key) {
  const until = engineHealth.cooldown[key];
  if (!until) return false;
  if (Date.now() > until) {
    delete engineHealth.cooldown[key];
    return false;
  }
  return true;
}

/** 该错误是否属于「这个引擎现在不可用」（网络层失败、超时、限流、5xx） */
function isEngineUnavailable(err) {
  const msg = String((err && err.message) || err);
  return /超时|timeout|Failed to fetch|NetworkError|load failed|HTTP (4\d\d|5\d\d)/i.test(msg);
}

/* ------------------------------------------------------------- 翻译引擎 */

const cache = new Map();
const CACHE_LIMIT = 500;

function cacheGet(key) {
  if (!cache.has(key)) return null;
  const value = cache.get(key);
  // 简易 LRU：命中后挪到末尾
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function msLang(code) {
  if (code === 'zh-CN') return 'zh-Hans';
  if (code === 'zh-TW') return 'zh-Hant';
  return code;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带超时、可外部取消的 fetch。
 *
 * 免费接口必须给一个较短的超时：在国内网络下对 translate.googleapis.com 的
 * TCP 连接往往要挂十几秒才失败 —— 这正是「翻译很慢」的主因（每个请求都先等 Google）。
 */
async function fetchWithSignal(url, options = {}, timeoutMs = 6000, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 简单语种猜测：MyMemory / 有道演示接口不支持 auto，需要我们给出源语言 */
function guessSource(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  if (/[\u0600-\u06ff]/.test(text)) return 'ar';
  if (/[\u0e00-\u0e7f]/.test(text)) return 'th';
  return 'en';
}

/** Google 免费接口（translate_a/single，无需 Key） */
async function googleTranslate(text, from, to, settings, signal) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dj=1' +
    `&sl=${encodeURIComponent(from || 'auto')}&tl=${encodeURIComponent(to)}` +
    `&q=${encodeURIComponent(text)}`;
  const res = await fetchWithSignal(url, { method: 'GET' }, 5000, signal);
  if (!res.ok) throw new Error(`Google 接口 HTTP ${res.status}`);
  const data = await res.json();
  const out = (data && data.sentences ? data.sentences : [])
    .map((s) => s.trans || '')
    .join('')
    .trim();
  if (!out) throw new Error('Google 接口返回空结果');
  return out;
}

/** 有道智云公开演示接口（无需 Key，国内网络通常可达） */
const YOUDAO_LANG = {
  'zh-CN': 'zh-CHS',
  'zh-TW': 'zh-CHT',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  ru: 'ru',
  pt: 'pt',
  it: 'it',
  ar: 'ar'
};

async function youdaoTranslate(text, from, to, settings, signal) {
  const body = new URLSearchParams({
    q: text,
    from: from && from !== 'auto' ? YOUDAO_LANG[from] || from : 'auto',
    to: YOUDAO_LANG[to] || to
  });
  const res = await fetchWithSignal(
    'https://aidemo.youdao.com/trans',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    },
    6000,
    signal
  );
  if (!res.ok) throw new Error(`有道接口 HTTP ${res.status}`);
  const data = await res.json();
  const out = Array.isArray(data.translation) ? data.translation.join(' ') : '';
  if (!out.trim()) throw new Error(`有道接口返回空结果${data && data.errorCode ? ` (${data.errorCode})` : ''}`);
  return out.trim();
}

/** MyMemory 免费接口（单次约 500 字节上限，需要按句子分片） */
const MYMEMORY_LIMIT = 450;

function splitForLimit(text, limit) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    const re = /[。！？!?.;；\n]\s*/g;
    let m;
    let cut = -1;
    while ((m = re.exec(rest)) !== null) {
      if (m.index + m[0].length <= limit) cut = m.index + m[0].length;
      else break;
    }
    if (cut <= 0) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function myMemoryTranslate(text, from, to, settings, signal) {
  const source = from && from !== 'auto' ? from : guessSource(text);
  const chunks = splitForLimit(text, MYMEMORY_LIMIT);
  // 分片并发（原来是一片一片串行，长文本会明显变慢）
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const url =
        'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(chunk) +
        `&langpair=${encodeURIComponent(source)}|${encodeURIComponent(to)}`;
      const res = await fetchWithSignal(url, { method: 'GET' }, 6000, signal);
      if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
      const data = await res.json();
      const out = data && data.responseData ? data.responseData.translatedText : '';
      if (!out || !String(out).trim()) {
        throw new Error(`MyMemory 返回空结果${data && data.responseDetails ? ` (${data.responseDetails})` : ''}`);
      }
      return String(out).trim();
    })
  );
  return results.join(' ');
}

/** 微软 Edge 免费接口：先取 JWT，再调 api-edge */
let msToken = null;
let msTokenExpire = 0;

async function microsoftToken(signal) {
  if (msToken && Date.now() < msTokenExpire) return msToken;
  const res = await fetchWithSignal('https://edge.microsoft.com/translate/auth', { method: 'GET' }, 4000, signal);
  if (!res.ok) throw new Error(`微软翻译鉴权 HTTP ${res.status}`);
  const token = (await res.text()).trim();
  if (!token) throw new Error('微软翻译鉴权返回空 token');
  msToken = token;
  msTokenExpire = Date.now() + 8 * 60 * 1000;
  return token;
}

async function microsoftTranslate(text, from, to, settings, signal) {
  const token = await microsoftToken(signal);
  const url =
    'https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0' +
    `&from=${encodeURIComponent(from === 'auto' ? '' : from)}&to=${encodeURIComponent(msLang(to))}`;
  const res = await fetchWithSignal(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify([{ Text: text }])
    },
    6000,
    signal
  );
  if (!res.ok) {
    msToken = null;
    throw new Error(`微软翻译接口 HTTP ${res.status}`);
  }
  const data = await res.json();
  const out = data && data[0] && data[0].translations && data[0].translations[0]
    ? data[0].translations[0].text
    : '';
  if (!out) throw new Error('微软翻译接口返回空结果');
  return out.trim();
}

function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url || '');
}

/** 自定义 OpenAI 兼容接口（DeepSeek / OpenAI / 硅基流动 / Ollama / LM Studio ...） */
async function customTranslate(text, from, to, custom, signal, onChunk) {
  const cfg = custom || {};
  const baseUrl = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new Error('未填写自定义 API 地址');
  if (!cfg.model) throw new Error('未填写模型名');
  if (!cfg.apiKey && !isLocalUrl(baseUrl)) throw new Error('未填写 API Key');

  const target = LANG_PROMPT_NAME[to] || to;
  const system = (cfg.prompt || DEFAULTS.custom.prompt).replace('{target}', target);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const makePayload = (stream) => {
    const payload = {
      model: cfg.model,
      temperature: 0.2,
      stream,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text }
      ]
    };
    // 额外参数：例如 {"enable_thinking": false} 或 {"reasoning_effort": "low"}
    if (cfg.extraBody && String(cfg.extraBody).trim()) {
      let extra;
      try {
        extra = JSON.parse(cfg.extraBody);
      } catch (_) {
        throw new Error('「额外请求参数」不是合法 JSON');
      }
      if (extra && typeof extra === 'object') Object.assign(payload, extra);
    }
    return payload;
  };

  const url = `${baseUrl}/chat/completions`;
  const cleanup = (out) => out.trim().replace(/^```[a-z]*\n?|```$/g, '').trim();

  // 有 onChunk 时优先用流式：边生成边显示，首屏时间 = 首字时间（TTFT）
  if (onChunk) {
    try {
      const res = await fetchWithSignal(
        url,
        { method: 'POST', headers: { ...headers, Accept: 'text/event-stream' }, body: JSON.stringify(makePayload(true)) },
        120000,
        signal
      );
      if (!res.ok || !res.body) throw new Error(`自定义接口 HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let out = '';
      const handleLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') return;
        try {
          const obj = JSON.parse(payload);
          const delta = (((obj.choices || [])[0] || {}).delta || {}).content || '';
          if (delta) {
            out += delta;
            onChunk(out);
          }
        } catch (_) {}
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        lines.forEach(handleLine);
      }
      if (buffer) handleLine(buffer);
      if (!out.trim()) throw new Error('流式返回空结果');
      return cleanup(out);
    } catch (err) {
      // 网关不支持 SSE / 中途出错 → 退回一次性请求（只要没被外部取消就值得重试）
      if (signal && signal.aborted) throw err;
      onChunk(null);
    }
  }

  const res = await fetchWithSignal(
    url,
    { method: 'POST', headers, body: JSON.stringify(makePayload(false)) },
    120000,
    signal
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`自定义接口 HTTP ${res.status}${detail ? ' ' + detail.slice(0, 180) : ''}`);
  }
  const data = await res.json();
  const out =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
  if (!out || !out.trim()) throw new Error('自定义接口返回空结果');
  return cleanup(out);
}

const PROVIDERS = {
  google: { label: ENGINE_LABEL.google, free: true, run: (t, f, o, s, sig) => googleTranslate(t, f, o, s, sig) },
  microsoft: { label: ENGINE_LABEL.microsoft, free: true, run: (t, f, o, s, sig) => microsoftTranslate(t, f, o, s, sig) },
  youdao: { label: ENGINE_LABEL.youdao, free: true, run: (t, f, o, s, sig) => youdaoTranslate(t, f, o, s, sig) },
  mymemory: { label: ENGINE_LABEL.mymemory, free: true, run: (t, f, o, s, sig) => myMemoryTranslate(t, f, o, s, sig) },
  custom: {
    label: ENGINE_LABEL.custom,
    free: false,
    run: (t, f, o, s, sig, onChunk) => customTranslate(t, f, o, s.custom, sig, onChunk)
  }
};

const FREE_ENGINES = ['google', 'microsoft', 'youdao', 'mymemory'];
/** 竞速：第一个引擎超过这个时间还没结果，就并行启动下一个 */
const HEDGE_DELAY_MS = 600;
/** 「先秒出」阶段：全部免费引擎一起发，谁快用谁（首屏最快，代价是几个并发请求） */
const FAST_RACE_DELAY_MS = 0;

function customConfigured(settings) {
  const c = settings.custom || {};
  return Boolean((c.baseUrl || '').trim() && (c.model || '').trim() && (c.apiKey || isLocalUrl(c.baseUrl)));
}

/** 免费引擎按「实测最快」排序，冷却中的排到最后 */
function freeCandidatesInOrder() {
  const free = FREE_ENGINES.slice().sort((a, b) => engineLatency(a) - engineLatency(b));
  const alive = free.filter((k) => !isCoolingDown(k));
  return alive.length ? alive.concat(free.filter((k) => !alive.includes(k))) : free;
}

/** auto 模式下的候选顺序：自定义 → 免费的按「实测最快」排序（跳过冷却中的） */
function autoCandidates(settings) {
  const free = freeCandidatesInOrder();
  return customConfigured(settings) ? ['custom', ...free] : free;
}

/**
 * 尝试候选引擎：先起第一个，超过 hedgeDelayMs 还没结果就并行起下一个，谁先成功用谁。
 * 全部失败则抛出错误集合。
 * hedgeDelayMs = Infinity 表示「不竞速，一个一个来」——自定义 API（质量最好）用这个，
 * 免得被免费引擎抢答。
 */
function runWithHedge(candidates, text, source, target, settings, hedgeDelayMs = HEDGE_DELAY_MS, onChunk = null) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let index = 0;
    let outstanding = 0; // 已发出、还没返回的请求数
    const errors = [];
    const attempted = [];
    const controllers = new Set();

    // 必须「候选都发完了 + 在飞请求都回来了」才判定失败，
    // 否则竞速计时器可能在请求还没返回时就误判为全部失败。
    const finishError = () => {
      if (settled) return;
      if (index < candidates.length || outstanding > 0) return;
      settled = true;
      const err = new Error(errors.join('；') || '没有可用的翻译引擎');
      err.attempted = attempted.slice();
      reject(err);
    };

    const launchNext = () => {
      if (settled) return;
      if (index >= candidates.length) {
        finishError();
        return;
      }
      const key = candidates[index++];
      const provider = PROVIDERS[key];
      if (!provider) {
        launchNext();
        return;
      }
      attempted.push(key);
      outstanding++;
      const attemptStart = Date.now();
      const controller = new AbortController();
      controllers.add(controller);
      provider
        .run(text, source, target, settings, controller.signal, provider.free ? null : onChunk)
        .then((translation) => {
          if (settled) return;
          settled = true;
          controllers.forEach((c) => c.abort());
          // 先 resolve，再做记录耗时这类副作用，避免副作用抛错把请求挂死
          resolve({ key, provider, translation });
          try {
            noteEngineLatency(key, Date.now() - attemptStart);
          } catch (_) {}
        })
        .catch((err) => {
          outstanding--;
          if (settled) return;
          errors.push(`${provider.label}: ${err && err.message ? err.message : err}`);
          if (isEngineUnavailable(err)) markEngineBad(key);
          launchNext();
        });
      if (Number.isFinite(hedgeDelayMs) && index < candidates.length) {
        setTimeout(() => {
          if (!settled) launchNext();
        }, hedgeDelayMs);
      }
    };

    launchNext();
  });
}

/** 同一段文本的并发请求合并成一次 */
const inflight = new Map();

/**
 * 后台用自定义 API「升级」译文：免费引擎先秒出，约 1 秒后用更好的结果替换。
 * 升级结果会写进缓存，所以同一句再划选时直接就拿到高质量译文。
 */
function startUpgrade(cacheKey, text, source, target, settings, requestId, onUpgrade, startedAt, onChunk) {
  const upgradeKey = `upgrade|${cacheKey}`;
  if (inflight.has(upgradeKey)) return;
  const task = runWithHedge(['custom'], text, source, target, settings, Infinity, onChunk)
    .then(({ key, provider, translation }) => {
      cacheSet(cacheKey, { translation, engine: key });
      markEngineGood(key);
      if (onUpgrade) {
        onUpgrade({
          ok: true,
          requestId,
          translation,
          engine: key,
          engineLabel: provider.label,
          elapsedMs: Date.now() - startedAt
        });
      }
    })
    .catch((err) => {
      if (onUpgrade) {
        onUpgrade({
          ok: false,
          requestId,
          error: err && err.message ? err.message : String(err),
          elapsedMs: Date.now() - startedAt
        });
      }
    })
    .finally(() => inflight.delete(upgradeKey));
  inflight.set(upgradeKey, task);
}

/** 统一入口：返回 { ok, translation, engine, engineLabel, elapsedMs } 或 { ok:false, error } */
async function translateText({ text, from, to, engine, requestId, quality }, onUpgrade, onChunk) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return { ok: false, error: '没有可翻译的文本' };
  const clipped = clean.length > 4000 ? clean.slice(0, 4000) : clean;

  await loadEngineHealth();
  const settings = await getSettings();
  const target = to || settings.targetLang;
  const source = from || settings.sourceLang;
  const requested = engine || settings.engine;

  const explicit = requested && requested !== 'auto' ? requested : null;
  if (explicit && !PROVIDERS[explicit]) return { ok: false, error: `未知引擎: ${explicit}` };

  // 显式指定引擎：只用它（可预期）；auto：按候选顺序竞速
  const candidates = explicit ? [explicit] : autoCandidates(settings);
  if (!candidates.length) return { ok: false, error: '没有可用的翻译引擎' };

  // auto 的缓存只记「最好的那次结果」：免费引擎秒出的结果先存，随后被自定义 API 升级覆盖
  const cacheKey = `${explicit || 'auto'}|${source}|${target}|${clipped}`;
  const hit = cacheGet(cacheKey);
  if (hit) {
    return {
      ok: true,
      translation: hit.translation,
      engine: hit.engine,
      engineLabel: PROVIDERS[hit.engine].label,
      cached: true,
      elapsedMs: 0
    };
  }

  const started = Date.now();

  // 「先秒出、再升级」：配了自定义 API 且开启了 fastFirst 时生效。
  // 注意：即使显式选了「自定义 API」也照旧——升级目标就是它，先给一版免费译文只会更快。
  // quality=true（例如扩展弹窗，它收不到异步的升级消息）表示「直接等最终结果」。
  const canUpgrade =
    quality !== true &&
    (explicit === null || explicit === 'custom') &&
    settings.fastFirst !== false &&
    customConfigured(settings);
  const freeList = explicit === 'custom' ? freeCandidatesInOrder() : candidates.filter((k) => k !== 'custom');

  if (canUpgrade && freeList.length) {
    let fast = null;
    try {
      // 全部免费引擎同时发：被墙的 Google 再慢也不影响你多快看到第一版译文
      fast = await runWithHedge(freeList, clipped, source, target, settings, FAST_RACE_DELAY_MS);
    } catch (_) {
      fast = null; // 免费引擎全挂 → 直接等自定义 API
    }
    if (fast) {
      cacheSet(cacheKey, { translation: fast.translation, engine: fast.key });
      markEngineGood(fast.key);
      startUpgrade(cacheKey, clipped, source, target, settings, requestId, onUpgrade, started, onChunk);
      return {
        ok: true,
        translation: fast.translation,
        engine: fast.key,
        engineLabel: fast.provider.label,
        provisional: true,
        requestId,
        elapsedMs: Date.now() - started
      };
    }
  }

  let run;
  if (candidates.length === 1) {
    // 显式指定引擎：不竞速
    run = () => runWithHedge(candidates, clipped, source, target, settings, Infinity, onChunk);
  } else if (candidates[0] === 'custom') {
    // 配了自定义 API 且没能先秒出：单独等它（质量最好），失败再退到免费引擎竞速
    run = () =>
      runWithHedge(['custom'], clipped, source, target, settings, Infinity, onChunk).catch(() =>
        runWithHedge(candidates.slice(1), clipped, source, target, settings)
      );
  } else {
    run = () => runWithHedge(candidates, clipped, source, target, settings);
  }

  const runner = inflight.get(cacheKey) || run().finally(() => inflight.delete(cacheKey));
  inflight.set(cacheKey, runner);

  try {
    const { key, provider, translation } = await runner;
    cacheSet(cacheKey, { translation, engine: key });
    markEngineGood(key);
    return {
      ok: true,
      translation,
      engine: key,
      engineLabel: provider.label,
      requestId,
      elapsedMs: Date.now() - started
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
      tried: candidates,
      elapsedMs: Date.now() - started
    };
  }
}

/* ---------------------------------------------------------------- 工具 */

function viewerUrl(fileUrl, extra) {
  let url = chrome.runtime.getURL(VIEWER_PAGE);
  if (fileUrl) url += `?file=${encodeURIComponent(fileUrl)}`;
  if (extra) url += (fileUrl ? '&' : '?') + extra;
  return url;
}

function isViewerUrl(url) {
  return typeof url === 'string' && url.startsWith(chrome.runtime.getURL(VIEWER_PAGE));
}

function looksLikePdfUrl(url) {
  if (!url || isViewerUrl(url)) return false;
  if (!/^(https?|file):/i.test(url)) return false;
  return /\.pdf([?#].*)?$/i.test(url);
}

async function openViewerInTab(fileUrl, options) {
  const target = viewerUrl(fileUrl, (options && options.extra) || '');
  if (options && options.tabId != null) {
    await chrome.tabs.update(options.tabId, { url: target });
    return { ok: true, url: target, mode: 'update' };
  }
  const tab = await chrome.tabs.create({ url: target, active: true });
  return { ok: true, url: target, mode: 'create', tabId: tab.id };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

/** 给内容脚本发消息，失败时按需注入一次 */
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
      await new Promise((r) => setTimeout(r, 80));
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
      return { ok: false, error: `无法与页面通信：${err && err.message ? err.message : err}` };
    }
  }
}

/* ------------------------------------------------------------ 消息处理 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'translate': {
          // 先秒出的结果由 sendResponse 返回；自定义 API 的流式片段与升级结果稍后推给同一标签页
          const tabId = sender && sender.tab && sender.tab.id != null ? sender.tab.id : null;
          const push = (payload) => {
            if (tabId == null) return;
            try {
              chrome.tabs.sendMessage(tabId, payload);
            } catch (_) {}
          };
          const onUpgrade = tabId == null ? null : (payload) => push({ type: 'translate-upgrade', ...payload });

          let lastSent = 0;
          let lastText = '';
          const onChunk =
            tabId == null
              ? null
              : (partial) => {
                  if (partial === null) {
                    // 流式失败，退回一次性请求：告诉前端回到「生成中」
                    push({ type: 'translate-stream', requestId: msg.requestId, reset: true });
                    return;
                  }
                  const now = Date.now();
                  if (now - lastSent < 140 && partial.length - lastText.length < 24) return;
                  lastSent = now;
                  lastText = partial;
                  push({ type: 'translate-stream', requestId: msg.requestId, text: partial });
                };

          sendResponse(await translateText(msg, onUpgrade, onChunk));
          return;
        }
        case 'getSettings':
          sendResponse({ ok: true, settings: await getSettings() });
          return;
        case 'saveSettings':
          sendResponse({ ok: true, settings: await saveSettings(msg.settings) });
          return;
        case 'openViewer': {
          const file = msg.fileUrl || (sender.tab && sender.tab.url) || '';
          const current = sender.tab ? sender.tab.id : null;
          const res = await openViewerInTab(file, {
            tabId: msg.newTab ? null : current,
            extra: msg.extra
          });
          sendResponse(res);
          return;
        }
        case 'getTabInfo': {
          const tab = sender.tab || (await activeTab());
          sendResponse({
            ok: true,
            tab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
            viewerUrl: tab ? viewerUrl(tab.url) : null
          });
          return;
        }
        case 'testTranslate': {
          const res = await translateText({
            text: msg.text || 'This is a translation engine test.',
            engine: msg.engine,
            to: msg.to,
            from: msg.from
          });
          sendResponse(res);
          return;
        }
        default:
          sendResponse({ ok: false, error: `未知消息类型: ${msg && msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    }
  })();
  return true; // 异步响应
});

/* -------------------------------------------------------- 右键菜单/快捷键 */

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'pt-translate-selection',
      title: '翻译选中文本（PDF 划词翻译）',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'pt-open-viewer-page',
      title: '用翻译阅读器打开本页 PDF',
      contexts: ['page'],
      documentUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*', 'file:///*.pdf']
    });
    chrome.contextMenus.create({
      id: 'pt-open-viewer-link',
      title: '用翻译阅读器打开这个 PDF',
      contexts: ['link'],
      targetUrlPatterns: ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.pdf#*', 'file:///*.pdf']
    });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ settings: await getSettings() });
  buildContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  buildContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'pt-translate-selection') {
    const target = tab && tab.id != null ? tab.id : (await activeTab())?.id;
    if (target == null) return;
    await sendToTab(target, {
      type: 'translate-selection',
      text: info.selectionText || '',
      via: 'context-menu'
    });
    return;
  }
  if (info.menuItemId === 'pt-open-viewer-link' && info.linkUrl) {
    await openViewerInTab(info.linkUrl);
    return;
  }
  if (info.menuItemId === 'pt-open-viewer-page') {
    const url = info.pageUrl || (tab && tab.url) || '';
    await openViewerInTab(url);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (command === 'translate-selection') {
    if (!tab || tab.id == null) return;
    await sendToTab(tab.id, { type: 'translate-selection', via: 'shortcut' });
    return;
  }
  if (command === 'open-in-viewer') {
    if (!tab || !tab.url) return;
    await openViewerInTab(tab.url);
  }
});

/* --------------------------------------------- 自动用阅读器打开 PDF 链接 */

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url;
  if (!url || isViewerUrl(url)) return;
  let settings;
  try {
    settings = await getSettings();
  } catch (_) {
    return;
  }
  if (!settings.autoOpenPdf) return;
  if (!/^(https?|file):/i.test(url)) return;
  if (!looksLikePdfUrl(url)) return;
  try {
    await chrome.tabs.update(tabId, { url: viewerUrl(url) });
  } catch (_) {
    /* 某些页面不允许改写，忽略 */
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    // 设置变化时清空译文缓存；并清掉引擎冷却，改完 API Key 能立刻生效
    cache.clear();
    engineHealth.cooldown = {};
    persistEngineHealth();
  }
  if (changes.engineHealth && changes.engineHealth.newValue) {
    engineHealth = {
      lastGood: changes.engineHealth.newValue.lastGood || null,
      cooldown: changes.engineHealth.newValue.cooldown || {},
      latency: changes.engineHealth.newValue.latency || {},
      loaded: true
    };
  }
});
