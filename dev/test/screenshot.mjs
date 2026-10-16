/**
 * 生成 README 用的截图：用自带阅读器打开示例 PDF，划选一句话，等真实的译文出现后截图。
 *
 * 需要扩展目录下有 config.local.json（真实 Key 会走自定义 API）；没有也能跑，
 * 只是译文来自免费引擎。
 *
 * 运行：cd dev && node test/screenshot.mjs
 * 输出：<repo>/docs/screenshot.png
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const devDir = path.dirname(here);
const extDir = path.dirname(devDir); // extension root
const docsDir = path.join(extDir, 'docs');
fs.mkdirSync(docsDir, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8793;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pdfPath = path.join(devDir, 'tests', 'sample.pdf');
const server = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === '/sample.pdf') {
    const buf = fs.readFileSync(pdfPath);
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
    res.end(buf);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1.5'
  ]
});

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), {
    timeout: 20000
  });
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 760, deviceScaleFactor: 1.5 });

  // 干净的开局：只留「整句 + 选中即译」，避免截图里出现无关状态
  await page.goto(`chrome-extension://${extId}/src/options.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    (settings) => new Promise((resolve) => chrome.storage.local.set({ settings }, resolve)),
    {
      engine: 'auto',
      targetLang: 'zh-CN',
      sourceLang: 'auto',
      autoTranslate: true,
      fastFirst: true,
      sentenceMode: true,
      autoOpenPdf: false,
      clipboardWatch: false,
      cardFontSize: 15,
      custom: { baseUrl: '', apiKey: '', model: 'deepseek-chat', extraBody: '', prompt: '' }
    }
  );

  await page.goto(`chrome-extension://${extId}/src/viewer.html?file=${encodeURIComponent(`http://127.0.0.1:${PORT}/sample.pdf`)}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForSelector('.textLayer span', { timeout: 30000 });
  await sleep(600);

  await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.textLayer span')];
    const target = spans.find((s) => s.textContent.includes('quick brown fox'));
    if (!target) throw new Error('sample text not found');
    const node = target.firstChild;
    const start = node.nodeValue.indexOf('fox');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 'fox jumps'.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });

  // 等到有稳定的译文（不是「翻译中…」）
  await page
    .waitForFunction(
      () => {
        const out = document.getElementById('cardOut');
        const badge = document.getElementById('cardBadge');
        if (!out || !badge) return false;
        const text = out.textContent || '';
        return text.length > 4 && !text.includes('正在请求') && !badge.textContent.includes('生成中');
      },
      { timeout: 25000 }
    )
    .catch(() => {});
  // 再给「升级」一点时间（如果有自定义 API）
  await sleep(3500);

  const shown = await page.evaluate(() => ({
    src: document.getElementById('cardSrc').textContent.trim(),
    out: document.getElementById('cardOut').textContent.trim(),
    badge: document.getElementById('cardBadge').textContent.trim()
  }));

  await page.screenshot({ path: path.join(docsDir, 'screenshot.png') });
  console.log('原文:', shown.src);
  console.log('译文:', shown.out);
  console.log('引擎:', shown.badge);
  console.log('已保存:', path.join(docsDir, 'screenshot.png'));
} catch (err) {
  console.error('失败:', err);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
}
