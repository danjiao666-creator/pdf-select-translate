import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchExtension, screenshot } from './browser.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(root, 'config.local.json');
const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/pdf' });
  res.end(fs.readFileSync(path.join(root, 'dev/tests/sample.pdf')));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let harness;
try {
  harness = await launchExtension(root);
  const { browser, id } = harness;
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${id}/src/options.html`);
  await page.evaluate(async ({ cfg }) => chrome.runtime.sendMessage({ type: 'saveSettings', settings: {
    engine: 'auto', targetLang: 'zh-CN', autoTranslate: true, sentenceMode: true, fastFirst: true,
    ...(cfg ? { custom: cfg } : {})
  } }), { cfg });
  const pdf = `http://127.0.0.1:${server.address().port}/sample.pdf`;
  await page.goto(`chrome-extension://${id}/src/viewer.html?file=${encodeURIComponent(pdf)}`);
  await page.bringToFront();
  await page.waitForSelector('.textLayer span');
  await page.evaluate(() => {
    window.measurement = { started: performance.now(), first: null, stream: null, finished: null, engine: null };
    chrome.runtime.onMessage.addListener((m) => {
      if (m?.type === 'translate-stream' && m.text && measurement.stream === null) measurement.stream = Math.round(performance.now() - measurement.started);
      if (m?.type === 'translate-upgrade') { measurement.finished = Math.round(performance.now() - measurement.started); measurement.engine = m.engine; measurement.ok = m.ok; }
    });
    const out = document.getElementById('cardOut');
    const observer = new MutationObserver(() => {
      if (measurement.first === null && out.textContent && !out.classList.contains('loading')) measurement.first = Math.round(performance.now() - measurement.started);
    });
    observer.observe(out, { childList: true, characterData: true, subtree: true });
    const span = [...document.querySelectorAll('.textLayer span')].find((s) => s.textContent.includes('quick brown fox'));
    const i = span.textContent.indexOf('fox'); const range = document.createRange();
    range.setStart(span.firstChild, i); range.setEnd(span.firstChild, i + 9);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForFunction((expectCustom) => {
    const badge = document.getElementById('cardBadge').textContent;
    return !document.getElementById('card').hidden && !/生成中|优化中|翻译中/.test(badge) && (!expectCustom || badge.includes('自定义 API'));
  }, { timeout: 45000 }, Boolean(cfg));
  const result = await page.evaluate(() => ({ ...measurement, source: document.getElementById('cardSrc').textContent, translation: document.getElementById('cardOut').textContent, badge: document.getElementById('cardBadge').textContent }));
  if (cfg && !result.badge.includes('自定义 API')) throw new Error('Configured custom API did not complete');
  await screenshot(page, path.join(root, 'docs/screenshot.png'));
  console.log(JSON.stringify({ browser: await browser.version(), realAPIConfigured: Boolean(cfg), ...result }, null, 2));
  console.log('Saved docs/screenshot.png');
} finally {
  if (harness) await harness.cleanup();
  server.closeAllConnections(); await new Promise((r) => server.close(r));
}
