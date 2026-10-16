/** PDF 划词翻译 —— 设置页 */

const $ = (id) => document.getElementById(id);

const els = {
  targetLang: $('targetLang'),
  sourceLang: $('sourceLang'),
  engine: $('engine'),
  customBaseUrl: $('customBaseUrl'),
  customApiKey: $('customApiKey'),
  customModel: $('customModel'),
  customExtraBody: $('customExtraBody'),
  customPrompt: $('customPrompt'),
  thinkingPreset: $('thinkingPreset'),
  keySource: $('keySource'),
  modelHint: $('modelHint'),
  autoTranslate: $('autoTranslate'),
  fastFirst: $('fastFirst'),
  sentenceMode: $('sentenceMode'),
  autoOpenPdf: $('autoOpenPdf'),
  clipboardWatch: $('clipboardWatch'),
  cardFontSize: $('cardFontSize'),
  shortcutList: $('shortcutList'),
  save: $('save'),
  test: $('test'),
  speedTest: $('speedTest'),
  testResult: $('testResult'),
  status: $('status')
};

let settings = null;

function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (res) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(res === undefined ? { ok: false, error: '后台未响应' } : res);
    });
  });
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = `status small${kind ? ` ${kind}` : ''}`;
  if (text && kind === 'ok') setTimeout(() => (els.status.textContent = ''), 2500);
}

function fillForm(s) {
  els.targetLang.value = s.targetLang || 'zh-CN';
  els.sourceLang.value = s.sourceLang || 'auto';
  els.engine.value = s.engine || 'auto';
  const custom = s.custom || {};
  els.customBaseUrl.value = custom.baseUrl || '';
  els.customApiKey.value = custom.apiKey || '';
  els.customModel.value = custom.model || '';
  els.customExtraBody.value = custom.extraBody || '';
  els.customPrompt.value = custom.prompt || '';
  els.autoTranslate.checked = s.autoTranslate !== false;
  els.fastFirst.checked = s.fastFirst !== false;
  els.sentenceMode.checked = s.sentenceMode !== false;
  els.autoOpenPdf.checked = Boolean(s.autoOpenPdf);
  els.clipboardWatch.checked = Boolean(s.clipboardWatch);
  els.cardFontSize.value = String(s.cardFontSize || 15);

  // 预设下拉回填：能对上就选中，对不上就留「保持默认」
  let matched = '';
  for (const option of els.thinkingPreset.options) {
    if (option.value && option.value === (custom.extraBody || '').trim()) matched = option.value;
  }
  els.thinkingPreset.value = matched;

  if (custom.apiKeySource) {
    els.keySource.hidden = false;
    els.keySource.textContent = `API Key 来自扩展目录下的 ${custom.apiKeySource}（本机私密文件，不随分发包提供）。这里留空即可；填写会覆盖它。`;
  } else {
    els.keySource.hidden = true;
  }
  updateModelHint(custom.model || '');
}

/** 实测提示：实测 deepseek-flash 的首字时间比 deepseek-chat 慢 5 倍以上 */
function updateModelHint(model) {
  const name = String(model || '').toLowerCase();
  if (name.includes('reasoner')) {
    els.modelHint.hidden = false;
    els.modelHint.textContent = '⚠️ deepseek-reasoner 会先「思考」再翻译，明显更慢（数秒到数十秒）。只想要翻译就用 deepseek-chat。';
  } else if (name.includes('flash')) {
    els.modelHint.hidden = false;
    els.modelHint.textContent = '⚠️ 实测 deepseek-flash 的首字延迟约 2~4 秒，比 deepseek-chat（约 0.4 秒）慢很多，建议改成 deepseek-chat。';
  } else {
    els.modelHint.hidden = true;
  }
}

function collect() {
  return {
    targetLang: els.targetLang.value,
    sourceLang: els.sourceLang.value,
    engine: els.engine.value,
    autoTranslate: els.autoTranslate.checked,
    fastFirst: els.fastFirst.checked,
    sentenceMode: els.sentenceMode.checked,
    autoOpenPdf: els.autoOpenPdf.checked,
    clipboardWatch: els.clipboardWatch.checked,
    cardFontSize: Number(els.cardFontSize.value) || 15,
    custom: {
      baseUrl: els.customBaseUrl.value.trim(),
      apiKey: els.customApiKey.value.trim(),
      model: els.customModel.value.trim(),
      extraBody: els.customExtraBody.value.trim(),
      prompt: els.customPrompt.value.trim()
    }
  };
}

async function save(quiet) {
  const res = await sendMsg({ type: 'saveSettings', settings: collect() });
  if (res && res.ok) {
    settings = res.settings;
    if (!quiet) setStatus('已保存 ✓', 'ok');
  } else {
    setStatus(`保存失败：${(res && res.error) || '未知错误'}`, 'err');
  }
}

async function loadShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const labels = { 'translate-selection': '翻译选中文本', 'open-in-viewer': '用阅读器打开当前 PDF' };
    const parts = commands
      .filter((c) => labels[c.name])
      .map((c) => `${labels[c.name]}：<code>${c.shortcut || '未设置'}</code>`);
    els.shortcutList.innerHTML = parts.length ? parts.join('　') : '未设置快捷键';
  } catch (_) {
    els.shortcutList.textContent = '读取快捷键失败';
  }
}

async function init() {
  const res = await sendMsg({ type: 'getSettings' });
  settings = (res && res.settings) || {};
  fillForm(settings);
  loadShortcuts();

  // 除了 API Key / 提示词，其它改动即时保存，体验更顺
  ['targetLang', 'sourceLang', 'engine', 'autoTranslate', 'fastFirst', 'sentenceMode', 'autoOpenPdf', 'clipboardWatch', 'cardFontSize'].forEach(
    (id) => els[id].addEventListener('change', () => save(false))
  );
  ['customBaseUrl', 'customApiKey', 'customModel', 'customExtraBody', 'customPrompt'].forEach((id) =>
    els[id].addEventListener('change', () => {
      if (id === 'customModel') updateModelHint(els.customModel.value.trim());
      save(false);
    })
  );

  // 选预设 → 写进「额外请求参数」并保存
  els.thinkingPreset.addEventListener('change', () => {
    els.customExtraBody.value = els.thinkingPreset.value;
    save(false);
  });

  els.save.addEventListener('click', () => save(false));

  els.test.addEventListener('click', async () => {
    els.testResult.textContent = '测试中…';
    await save(true);
    const sample = 'The quick brown fox jumps over the lazy dog. 这是一句中文测试。';
    const r = await sendMsg({
      type: 'testTranslate',
      text: sample,
      engine: els.engine.value,
      to: els.targetLang.value,
      from: els.sourceLang.value
    });
    if (r && r.ok) {
      els.testResult.innerHTML = `✅ ${escapeHtml(r.engineLabel)}（${r.elapsedMs}ms）：${escapeHtml(r.translation)}`;
    } else {
      els.testResult.innerHTML = `❌ ${escapeHtml((r && r.error) || '未知错误')}`;
    }
  });

  // 一键测速：并发试所有可用引擎，把最快的固定下来（以后不再逐个试探）
  els.speedTest.addEventListener('click', async () => {
    await save(true);
    const engines = ['custom', 'google', 'microsoft', 'youdao', 'mymemory'];
    els.speedTest.disabled = true;
    els.testResult.textContent = '正在并发测速…';
    const sample = 'The quick brown fox jumps over the lazy dog.';
    const results = await Promise.all(
      engines.map(async (engine) => {
        const r = await sendMsg({
          type: 'testTranslate',
          text: sample,
          engine,
          to: els.targetLang.value,
          from: els.sourceLang.value
        });
        return {
          engine,
          ok: Boolean(r && r.ok),
          ms: r && r.elapsedMs != null ? r.elapsedMs : 99999,
          label: (r && r.engineLabel) || engine
        };
      })
    );
    const usable = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
    els.speedTest.disabled = false;
    const table = results.map((r) => `${r.ok ? '✅' : '❌'} ${r.label}${r.ok ? ` ${r.ms}ms` : ''}`).join('　');
    if (!usable.length) {
      els.testResult.innerHTML = `❌ 所有引擎都不可用：${escapeHtml(table)}`;
      return;
    }
    const best = usable[0];
    els.engine.value = best.engine;
    await save(true);
    els.testResult.innerHTML = `⚡ 已固定用最快的「${escapeHtml(best.label)}」（${best.ms}ms）<br /><span class="muted">${escapeHtml(table)}</span>`;
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
