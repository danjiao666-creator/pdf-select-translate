/**
 * 用「全新、不重复」的文本测量 DeepSeek 真实延迟（避免服务端前缀缓存干扰）。
 * 同时测 TTFT（首字时间），因为流式输出能把「首屏」提前到 TTFT。
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

const SYS =
  'You are a professional translator. Translate the user text into Simplified Chinese (简体中文). Output ONLY the translation.';

/** 生成一段全新的英文段落（带随机 nonce，绝不可能命中缓存） */
function freshText(nonce, sentences) {
  const pool = [
    'The experimental results indicate a consistent improvement across all evaluation sets.',
    'We observe that the proposed method reduces latency while preserving accuracy.',
    'However, the ablation study suggests the gain mainly comes from the retrieval stage.',
    'Readers should note that the dataset was collected under controlled conditions.',
    'A second limitation is the reliance on a single annotated corpus.',
    'Future work will explore multilingual transfer and longer context windows.',
    'The baseline remains competitive when the training budget is increased.',
    'Overall, the findings support the hypothesis stated in the introduction.',
  ];
  const parts = [];
  for (let i = 0; i < sentences; i++) parts.push(pool[i % pool.length]);
  return `Nonce ${nonce}. ` + parts.join(' ');
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

try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), {
    timeout: 20000
  });
  const extId = new URL(sw.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/src/options.html`, { waitUntil: 'domcontentloaded' });

  const out = await page.evaluate(
    async ({ key, sys, cases }) => {
      const lines = [];
      for (const { label, text, model } of cases) {
        // 非流式：总时长
        let t0 = performance.now();
        let totalMs = -1;
        let chars = 0;
        try {
          const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              stream: false,
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: text }
              ]
            })
          });
          totalMs = Math.round(performance.now() - t0);
          const data = await res.json();
          chars = (((data.choices || [])[0] || {}).message || {}).content.length;
        } catch (err) {
          lines.push(`${label}: FAIL ${String(err).slice(0, 80)}`);
          continue;
        }

        // 流式：首字时间（换一段新文本，避免被上一步的缓存影响）
        const text2 = text.replace('Nonce', 'Nonce2');
        t0 = performance.now();
        let ttft = -1;
        let streamChars = 0;
        try {
          const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              stream: true,
              messages: [
                { role: 'system', content: sys },
                { role: 'user', content: text2 }
              ]
            })
          });
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split('\n');
            buf = parts.pop();
            for (const line of parts) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const piece = JSON.parse(payload).choices[0].delta.content || '';
                if (piece) {
                  if (ttft < 0) ttft = Math.round(performance.now() - t0);
                  streamChars += piece.length;
                }
              } catch (_) {}
            }
          }
        } catch (err) {
          lines.push(`${label}: 流式 FAIL ${String(err).slice(0, 80)}`);
        }

        lines.push(
          `${label}（输入 ${text.length} 字符）: 非流式总时长 ${totalMs}ms（输出 ${chars} 字）｜流式首字 ${ttft}ms，流式总时长 ${Math.round(
            performance.now() - t0
          )}ms（输出 ${streamChars} 字）`
        );
      }
      return lines;
    },
    {
      key: cfg.apiKey,
      sys: SYS,
      cases: [
        { label: 'A 一句话', text: freshText('A1', 1), model: 'deepseek-flash' },
        { label: 'B 三句话', text: freshText('B1', 3), model: 'deepseek-flash' },
        { label: 'C 一段(~600字符)', text: freshText('C1', 6), model: 'deepseek-flash' },
        { label: 'D 长段(~1300字符)', text: freshText('D1', 13), model: 'deepseek-flash' },
        { label: 'E 长段 chat 模型', text: freshText('E1', 13), model: 'deepseek-chat' }
      ]
    }
  );

  console.log('=== 全新文本（无缓存）真实延迟 ===');
  for (const l of out) console.log('  ' + l);
} catch (err) {
  console.error('测试异常：', err);
} finally {
  await browser.close().catch(() => {});
}
