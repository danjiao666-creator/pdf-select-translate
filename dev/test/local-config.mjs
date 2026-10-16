/**
 * 验证 config.local.json（本地 Key）这条路径真的通：
 *   1. 扩展能读到该文件，设置里出现 apiKeySource
 *   2. auto 模式直接用自定义 API（DeepSeek）翻译成功
 *   3. 记录真实耗时
 *
 * 注意：这会用真实 API Key 发一次请求（很短的句子）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const devDir = path.dirname(here);
const extDir = path.dirname(devDir); // the extension root: dev/ lives inside it
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const configPath = path.join(extDir, 'config.local.json');

if (!fs.existsSync(configPath)) {
  console.error('缺少 config.local.json，跳过');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: [
    `--disable-extensions-except=${extDir}`,
    `--load-extension=${extDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ]
});

let ok = true;
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), {
    timeout: 20000
  });
  const extId = new URL(sw.url()).host;

  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/src/options.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('targetLang').value !== '', { timeout: 8000 });

  const settings = await page.evaluate(() =>
    new Promise((resolve) => chrome.runtime.sendMessage({ type: 'getSettings' }, resolve))
  );
  const source = settings && settings.settings && settings.settings.custom && settings.settings.custom.apiKeySource;
  console.log(`1) 本地 Key 是否被读到 : ${source || '(没有)'}`);
  if (source !== 'config.local.json') ok = false;

  const keyLen = (settings.settings.custom.apiKey || '').length;
  console.log(`   Key 长度            : ${keyLen}（不回显内容）`);

  const t = await page.evaluate(async () => {
    const upgrades = [];
    const streams = [];
    const t0 = Date.now();
    chrome.runtime.onMessage.addListener((m) => {
      if (!m) return;
      if (m.type === 'translate-upgrade') upgrades.push({ ...m, at: Date.now() - t0 });
      else if (m.type === 'translate-stream' && m.text) streams.push({ at: Date.now() - t0, len: m.text.length });
    });
    const requestId = `real-${Date.now()}`;
    const first = await chrome.runtime.sendMessage({
      type: 'translate',
      text: 'Selecting a sentence in a PDF should give you the translation instantly.',
      engine: 'auto',
      to: 'zh-CN',
      from: 'auto',
      requestId
    });
    const firstMs = Date.now() - t0;
    for (let i = 0; i < 80 && !upgrades.length; i++) await new Promise((r) => setTimeout(r, 100));
    return { first, firstMs, upgrade: upgrades[0] || null, streams };
  });
  console.log(`2) 第一段（先秒出）      : ${t.first && t.first.ok ? 'OK' : 'FAIL'}  ${t.first && t.first.engineLabel}  ${t.firstMs}ms  provisional=${t.first && t.first.provisional}`);
  console.log(`   译文                  : ${t.first && t.first.translation}`);
  const firstChunk = t.streams[0];
  console.log(`3) 大模型流式首字        : ${firstChunk ? `${firstChunk.at}ms` : '(没收到流式片段)'}（共 ${t.streams.length} 段）`);
  console.log(`4) 升级完成              : ${t.upgrade && t.upgrade.ok ? 'OK' : 'FAIL'}  ${t.upgrade && t.upgrade.engineLabel}  ${t.upgrade && t.upgrade.elapsedMs}ms`);
  console.log(`   译文                  : ${t.upgrade && t.upgrade.translation}`);
  if (!t.first || !t.first.ok) ok = false;
  if (!t.upgrade || !t.upgrade.ok || t.upgrade.engine !== 'custom') ok = false;

  console.log(`\n结论：${ok ? 'PASS —— 免费引擎秒出 + 本地 Key 的大模型译文自动升级' : 'FAIL'}`);
} catch (err) {
  console.error('测试异常：', err);
  ok = false;
} finally {
  await browser.close().catch(() => {});
}
process.exit(ok ? 0 : 1);
