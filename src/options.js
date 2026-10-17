/** Settings write only the changed field; credentials are never echoed back. */
const $ = (id) => document.getElementById(id);
const fields = ['targetLang', 'sourceLang', 'engine', 'theme', 'autoTranslate', 'fastFirst', 'sentenceMode', 'autoOpenPdf', 'clipboardWatch', 'cardFontSize'];
const customFields = { customBaseUrl: 'baseUrl', customModel: 'model', customExtraBody: 'extraBody', customPrompt: 'prompt' };
let settings = {};
let statusTimer;
function send(message) {
  return chrome.runtime.sendMessage(message).catch((err) => ({ ok: false, error: err.message }));
}
function status(text, error = false) {
  clearTimeout(statusTimer);
  $('status').textContent = text;
  $('status').className = `status${error ? ' err' : ''}`;
  if (!error) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2400);
}
function credentialState() {
  const c = settings.custom || {};
  $('customApiKey').placeholder = c.apiKeyConfigured ? '已配置 · 输入新 Key 可替换' : '输入 API Key；本地服务可留空';
  $('apiState').textContent = c.apiKeyConfigured ? '已配置' : '待配置';
  $('keySource').hidden = !c.apiKeyConfigured;
  $('keySource').textContent = c.apiKeySource === 'config.local.json' ? '凭据来自本机配置文件，不会复制到浏览器设置。' : window.desktopBridge ? '凭据在本机使用系统加密保存，不回显；留空不会覆盖已有 Key。' : '凭据保存在此浏览器中，不回显；留空不会覆盖已有 Key。';
}
function fillForm() {
  for (const id of fields) {
    const el = $(id);
    if (el === document.activeElement) continue;
    if (el.type === 'checkbox') el.checked = Boolean(settings[id]);
    else el.value = settings[id] ?? '';
  }
  for (const [id, key] of Object.entries(customFields)) {
    if ($(id) !== document.activeElement) $(id).value = settings.custom?.[key] || '';
  }
  const extra = settings.custom?.extraBody || '';
  $('thinkingPreset').value = [...$('thinkingPreset').options].some((o) => o.value === extra) ? extra : '';
  credentialState();
  modelHint();
}
function modelHint() {
  const name = $('customModel').value;
  $('modelHint').hidden = !/reasoner|flash/i.test(name);
  $('modelHint').textContent = '模型的思考模式可能增加等待时间；短句翻译建议选用不带推理的模型。';
}
async function save(patch, quiet = false) {
  const res = await send({ type: 'saveSettings', settings: patch });
  if (!res?.ok) { status(res?.error || '保存失败', true); return false; }
  settings = res.settings;
  credentialState();
  if (!quiet) status('已保存');
  return true;
}
function collect() {
  const patch = { custom: {} };
  for (const id of fields) patch[id] = $(id).type === 'checkbox' ? $(id).checked : id === 'cardFontSize' ? Number($(id).value) : $(id).value;
  for (const [id, key] of Object.entries(customFields)) patch.custom[key] = $(id).value.trim();
  if ($('customApiKey').value.trim()) patch.custom.apiKey = $('customApiKey').value.trim();
  return patch;
}
function testOutput(text, error = false) {
  $('testResult').hidden = false;
  $('testResult').className = `test-result${error ? ' err' : ''}`;
  $('testResult').textContent = text;
}
async function init() {
  if (window.desktopBridge) {
    document.querySelectorAll('.extension-only').forEach((node) => { node.hidden = true; });
    $('settingsLocation').textContent = '设置保存在本机应用数据目录';
    $('clearKey').title = '清除本机应用中保存的 API Key';
  }
  const res = await send({ type: 'getSettings' });
  if (!res?.ok) { status('无法加载设置，请重新加载扩展', true); return; }
  settings = res.settings;
  fillForm();
  for (const id of fields) $(id).addEventListener('change', () => save({ [id]: $(id).type === 'checkbox' ? $(id).checked : id === 'cardFontSize' ? Number($(id).value) : $(id).value }));
  for (const [id, key] of Object.entries(customFields)) $(id).addEventListener('change', () => { if (id === 'customModel') modelHint(); save({ custom: { [key]: $(id).value.trim() } }); });
  $('customApiKey').addEventListener('change', async () => {
    const value = $('customApiKey').value.trim();
    if (value && await save({ custom: { apiKey: value } })) $('customApiKey').value = '';
  });
  $('clearKey').addEventListener('click', async () => { if (await save({ custom: { apiKey: '' } })) $('customApiKey').value = ''; });
  $('thinkingPreset').addEventListener('change', () => {
    $('customExtraBody').value = $('thinkingPreset').value;
    save({ custom: { extraBody: $('customExtraBody').value } });
  });
  $('save').addEventListener('click', async () => { if (await save(collect())) $('customApiKey').value = ''; });
  $('test').addEventListener('click', async () => {
    if (!await save(collect(), true)) return;
    $('customApiKey').value = '';
    $('test').disabled = true;
    testOutput('正在测试当前引擎…');
    try {
      const r = await send({ type: 'testTranslate', text: 'The results suggest a consistent improvement in translation quality.', engine: $('engine').value, to: $('targetLang').value, from: $('sourceLang').value });
      testOutput(r?.ok ? `${r.engineLabel} · ${r.elapsedMs} ms\n${r.translation}` : `测试失败：${r?.error || '后台未响应'}`, !r?.ok);
    } finally { $('test').disabled = false; }
  });
  $('speedTest').addEventListener('click', async () => {
    if (!await save(collect(), true)) return;
    $('customApiKey').value = '';
    $('speedTest').disabled = true;
    testOutput('正在测速；不会更改你选择的引擎…');
    try {
      const rows = await Promise.all(['custom','google','microsoft','youdao','mymemory'].map(async (engine) => {
        const r = await send({ type: 'testTranslate', engine, text: 'A short sentence for measuring translation latency.', to: $('targetLang').value, from: $('sourceLang').value });
        return r?.ok ? `${r.engineLabel}  ${r.elapsedMs} ms` : `${engine}  不可用：${r?.error || '未响应'}`;
      }));
      testOutput(rows.join('\n'));
    } finally { $('speedTest').disabled = false; }
  });
  try {
    const commands = await chrome.commands.getAll();
    const labels = { 'translate-selection': '翻译选区', 'open-in-viewer': '打开阅读器' };
    $('shortcutList').textContent = commands.filter((c) => labels[c.name]).map((c) => `${labels[c.name]}  ${c.shortcut || '未设置'}`).join('　·　');
  } catch (_) { $('shortcutList').textContent = '请在浏览器扩展设置中查看快捷键。'; }
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const latest = await send({ type: 'getSettings' });
    if (latest?.ok) { settings = latest.settings; fillForm(); }
  });
}
init();
