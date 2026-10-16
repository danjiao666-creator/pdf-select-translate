/**
 * 从浏览器内部（扩展页面）测量 DeepSeek，和命令行 Python 的结果对比，
 * 判断「9 秒」是模型/参数问题，还是 Chrome 网络路径（代理/DNS/DoH）问题。
 *
 * 会使用真实 API Key（config.local.json），只发很短的请求。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const devDir = path.dirname(here);
const extDir = path.dirname(devDir); // the extension root: dev/ lives inside it
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const cfg = JSON.parse(fs.readFileSync(path.join(extDir, 'config.local.json'), 'utf8'));
const KEY = cfg.apiKey;

const TEXT =
  'Machine translation quality depends heavily on the engine you choose. Free endpoints are fast but they often lose nuance, while a large language model can follow instructions about tone and terminology.';
const SYS = 'You are a professional translator. Translate into Simplified Chinese. Output ONLY the translation.';

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

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), {
    timeout: 20000
  });
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/src/options.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('targetLang').value !== '', { timeout: 8000 });

  const results = await page.evaluate(
    async ({ key, text, sys }) => {
      const out = [];
      const call = async (label, body) => {
        const t0 = performance.now();
        try {
          const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify(body)
          });
          const ms = Math.round(performance.now() - t0);
          if (!res.ok) {
            const detail = await res.text();
            out.push(`${label}: HTTP ${res.status} ${ms}ms ${detail.slice(0, 120)}`);
            return;
          }
          const data = await res.json();
          const content = (((data.choices || [])[0] || {}).message || {}).content || '';
          out.push(`${label}: ${ms}ms，输出 ${content.length} 字  model=${data.model}`);
        } catch (err) {
          out.push(`${label}: FAIL ${Math.round(performance.now() - t0)}ms ${String(err).slice(0, 120)}`);
        }
      };

      const base = { temperature: 0.2, stream: false, messages: [{ role: 'system', content: sys }, { role: 'user', content: text }] };
      await call('① flash + enable_thinking:false（扩展现在的参数）', { ...base, model: 'deepseek-flash', enable_thinking: false });
      await call('② flash 不带额外参数', { ...base, model: 'deepseek-flash' });
      await call('③ chat 不带额外参数', { ...base, model: 'deepseek-chat' });

      // 扩展自己的完整链路
      const t1 = performance.now();
      const viaExtension = await chrome.runtime.sendMessage({
        type: 'translate',
        text,
        engine: 'custom',
        to: 'zh-CN',
        from: 'auto'
      });
      out.push(
        `④ 走扩展 translate（engine=custom）: ${Math.round(performance.now() - t1)}ms，` +
          `后端计时 ${viaExtension && viaExtension.elapsedMs}ms，引擎=${viaExtension && viaExtension.engineLabel}，` +
          `结果=${viaExtension && viaExtension.ok ? 'OK' : 'FAIL ' + (viaExtension && viaExtension.error)}`
      );
      return out;
    },
    { key: KEY, text: TEXT, sys: SYS }
  );

  console.log('=== 浏览器内的测量（Chrome 网络栈）===');
  for (const line of results) console.log('  ' + line);
} catch (err) {
  console.error('测试异常：', err);
} finally {
  await browser.close().catch(() => {});
}
