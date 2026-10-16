/**
 * 端到端冒烟测试：用 puppeteer-core 驱动本机 Edge，加载未打包扩展，验证：
 *   1. 扩展能加载（service worker 起来）、快捷键已注册
 *   2. 自带 pdf.js 阅读器能渲染 PDF 并生成可选中文字层
 *   3. 模拟划词 → 自动扩展到整句 → 弹出译文卡片 → 拿到译文
 *      （用本机 mock 的 OpenAI 兼容接口，结果可确定断言）
 *   4. 普通网页内容脚本划词翻译同样可用
 *   5. 各免费翻译引擎的真实可达性（信息性输出，不影响其它断言）
 *   6. 设置页 / 弹窗 无 JS 报错
 *
 * 运行：node test/smoke.mjs
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const devDir = path.dirname(here);
const extDir = path.dirname(devDir); // the extension root: dev/ lives inside it
const artifacts = path.join(here, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8791;
const MOCK_PREFIX = '【模拟译文】';

const TEST_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Selection test page</title>
<style>body{font:16px/1.8 system-ui;max-width:760px;margin:60px auto;padding:0 20px}</style></head>
<body>
<h1>Normal web page</h1>
<p id="p1">The quick brown fox jumps over the lazy dog. This second sentence is here so that sentence expansion has something to chew on.</p>
</body></html>`;

function startServer() {
  const pdfPath = path.join(devDir, 'tests', 'sample.pdf');
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];

    if (req.method === 'POST' && url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        let userText = '';
        let wantsStream = false;
        try {
          const parsed = JSON.parse(body);
          wantsStream = parsed.stream === true;
          const userMsg = (parsed.messages || []).find((m) => m.role === 'user');
          userText = (userMsg && userMsg.content) || '';
        } catch (_) {}
        const content = `${MOCK_PREFIX}${userText}`;

        // 流式（SSE）：分批吐字，模拟真实大模型「边生成边返回」
        if (wantsStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
          const pieces = content.match(/[\s\S]{1,6}/g) || [content];
          let i = 0;
          const timer = setInterval(() => {
            if (i >= pieces.length) {
              clearInterval(timer);
              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] })}\n\n`);
          }, 50);
          return;
        }

        // 非流式：故意慢 700ms，模拟真实大模型的延迟
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'mock-1',
              choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
            })
          );
        }, 700);
      });
      return;
    }

    if (url === '/sample.pdf') {
      const buf = fs.readFileSync(pdfPath);
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_HTML);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function info(message) {
  console.log(`INFO  ${message}`);
}

function attachLogs(page, bucket) {
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') bucket.push(`${type}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => bucket.push(`pageerror: ${err.message}`));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // 测试期间把本地私密配置移开：否则 auto 会带上真实 API Key，测试结果就不确定了
  const localConfig = path.join(extDir, 'config.local.json');
  const localConfigBak = `${localConfig}.test-bak`;
  let moved = false;
  if (fs.existsSync(localConfig)) {
    fs.renameSync(localConfig, localConfigBak);
    moved = true;
    // 万一被管道截断/异常终止，也要把文件放回去
    const restore = () => {
      try {
        if (moved && fs.existsSync(localConfigBak)) {
          fs.renameSync(localConfigBak, localConfig);
          moved = false;
        }
      } catch (_) {}
    };
    process.on('exit', restore);
    process.on('SIGINT', () => {
      restore();
      process.exit(130);
    });
  }

  const server = await startServer();
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

  let exitCode = 0;
  try {
    const swTarget = await browser.waitForTarget(
      (t) => t.type() === 'service_worker' && t.url().includes('background.js'),
      { timeout: 20000 }
    );
    const extId = new URL(swTarget.url()).host;
    record('扩展已加载（service worker 启动）', Boolean(extId), `extension id = ${extId}`);

    /* ------------------------------------------ 控制页：写设置 + 引擎体检 */
    const optLogs = [];
    const options = await browser.newPage();
    attachLogs(options, optLogs);
    await options.goto(`chrome-extension://${extId}/src/options.html`, { waitUntil: 'domcontentloaded' });
    await options.waitForFunction(() => document.getElementById('targetLang').value !== '', { timeout: 8000 });

    await options.evaluate(
      (settings) => new Promise((resolve) => chrome.storage.local.set({ settings }, resolve)),
      {
        engine: 'auto',
        targetLang: 'zh-CN',
        sourceLang: 'auto',
        autoTranslate: true,
        sentenceMode: true,
        autoOpenPdf: false,
        clipboardWatch: false,
        cardFontSize: 15,
        custom: { baseUrl: '', apiKey: '', model: '', prompt: 'Translate into {target}. Output ONLY the translation.' }
      }
    );
    await sleep(300);

    const optState = await options.evaluate(() => ({
      target: document.getElementById('targetLang').value,
      shortcuts: document.getElementById('shortcutList').textContent.trim()
    }));
    record(
      '设置页正常渲染且无脚本错误',
      optLogs.filter((l) => l.startsWith('pageerror')).length === 0,
      `目标语言=${optState.target}`
    );
    info(`快捷键：${optState.shortcuts}`);
    record(
      '快捷键已注册',
      /Alt\+[ZX]/i.test(optState.shortcuts),
      optState.shortcuts.replace(/\s+/g, ' ').slice(0, 90)
    );

    // 免费引擎真实可达性（未配置自定义 API 时的 auto 就是免费引擎链）
    const engReport = await options.evaluate(async () => {
      const out = {};
      for (const engine of ['auto', 'google', 'microsoft', 'youdao', 'mymemory']) {
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'translate',
            text: 'The quick brown fox jumps over the lazy dog.',
            engine,
            to: 'zh-CN',
            from: 'auto'
          });
          out[engine] = res && res.ok ? `OK [${res.engineLabel}] ${res.elapsedMs}ms ${res.translation}` : `FAIL ${(res && res.error) || ''}`;
        } catch (err) {
          out[engine] = `ERROR ${err && err.message}`;
        }
      }
      return out;
    });
    for (const [engine, status] of Object.entries(engReport)) {
      info(`引擎 ${engine}: ${String(status).slice(0, 150)}`);
    }
    record(
      '自动模式至少有一个免费引擎可用',
      String(engReport.auto).startsWith('OK'),
      String(engReport.auto).slice(0, 110)
    );

    // 提速关键：auto 要记住上次成功的引擎，第二次不再逐个试探
    const sticky = await options.evaluate(async () => {
      const health = (await chrome.storage.local.get('engineHealth')).engineHealth || {};
      const t0 = Date.now();
      const res = await chrome.runtime.sendMessage({
        type: 'translate',
        text: 'A second sentence used to check the sticky engine.',
        engine: 'auto',
        to: 'zh-CN',
        from: 'auto'
      });
      return {
        lastGood: health.lastGood,
        latency: health.latency || {},
        engine: res && res.engine,
        label: res && res.engineLabel,
        elapsedMs: res && res.elapsedMs,
        wallMs: Date.now() - t0,
        ok: Boolean(res && res.ok)
      };
    });
    record(
      'auto 按实测速度挑引擎（不再先撞被墙的 Google）',
      sticky.ok && !['google', 'microsoft'].includes(sticky.engine) && sticky.elapsedMs < 1500,
      `本次=${sticky.label} ${sticky.elapsedMs}ms；已记录耗时=${JSON.stringify(sticky.latency)}`
    );

    /* -------------------------------- 先秒出、再升级（slow LLM + fast free） */
    await options.evaluate(
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
        custom: {
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
          apiKey: 'test-key',
          model: 'mock-model',
          extraBody: '',
          prompt: 'Translate into {target}. Output ONLY the translation.'
        }
      }
    );
    await sleep(300);

    const twoStage = await options.evaluate(async () => {
      const upgrades = [];
      const streams = [];
      const listener = (msg) => {
        if (!msg) return;
        if (msg.type === 'translate-upgrade') upgrades.push(msg);
        else if (msg.type === 'translate-stream') streams.push(msg);
      };
      chrome.runtime.onMessage.addListener(listener);
      const requestId = `test-${Date.now()}`;
      const t0 = Date.now();
      const first = await chrome.runtime.sendMessage({
        type: 'translate',
        text: 'Two stage translation check for the PDF reader.',
        engine: 'auto',
        to: 'zh-CN',
        requestId
      });
      const firstMs = Date.now() - t0;
      for (let i = 0; i < 60 && !upgrades.length; i++) await new Promise((r) => setTimeout(r, 100));
      chrome.runtime.onMessage.removeListener(listener);
      return { first, firstMs, upgrades, streams };
    });

    const firstRes = twoStage.first || {};
    record(
      '① 免费引擎先秒出（不等大模型）',
      firstRes.ok === true && firstRes.provisional === true && firstRes.engine !== 'custom',
      `${firstRes.engineLabel} ${twoStage.firstMs}ms（后端计时 ${firstRes.elapsedMs}ms）：${String(firstRes.translation).slice(0, 30)}`
    );
    const up = twoStage.upgrades[0];
    record(
      '② 随后自定义 API 的结果自动替换',
      Boolean(up && up.ok && up.engine === 'custom' && String(up.translation).startsWith(MOCK_PREFIX)),
      up ? `${up.engineLabel} ${up.elapsedMs}ms：${String(up.translation).slice(0, 40)}` : '(没收到升级消息)'
    );
    const streamMsgs = twoStage.streams.filter((m) => !m.reset && m.text);
    record(
      '③ 大模型结果流式回传（边生成边显示）',
      streamMsgs.length >= 2 && String(streamMsgs[streamMsgs.length - 1].text).startsWith(MOCK_PREFIX),
      `收到 ${streamMsgs.length} 个片段，最后一段 ${String(streamMsgs[streamMsgs.length - 1] && streamMsgs[streamMsgs.length - 1].text).length} 字`
    );

    // 后面用本机 mock 的 OpenAI 兼容接口做确定性断言
    await options.evaluate(
      (settings) => new Promise((resolve) => chrome.storage.local.set({ settings }, resolve)),
      {
        engine: 'custom',
        targetLang: 'zh-CN',
        sourceLang: 'auto',
        autoTranslate: true,
        sentenceMode: true,
        autoOpenPdf: false,
        clipboardWatch: false,
        cardFontSize: 15,
        custom: {
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
          apiKey: 'test-key',
          model: 'mock-model',
          prompt: 'Translate into {target}. Output ONLY the translation.'
        }
      }
    );
    await sleep(300);

    /* ---------------------------------------------- 自带阅读器 + 划词整句 */
    const viewerLogs = [];
    const viewer = await browser.newPage();
    attachLogs(viewer, viewerLogs);
    await viewer.setViewport({ width: 1280, height: 900 });

    const viewerUrl = `chrome-extension://${extId}/src/viewer.html?file=${encodeURIComponent(
      `http://127.0.0.1:${PORT}/sample.pdf`
    )}`;
    await viewer.goto(viewerUrl, { waitUntil: 'domcontentloaded' });
    await viewer.waitForSelector('.textLayer span', { timeout: 30000 });

    const spanInfo = await viewer.evaluate(() => {
      const spans = [...document.querySelectorAll('.textLayer span')].map((s) => s.textContent);
      return { count: spans.length, sample: spans.slice(0, 3) };
    });
    record(
      'pdf.js 阅读器渲染出文字层',
      spanInfo.count >= 4 && spanInfo.sample.join(' ').includes('quick brown fox'),
      `${spanInfo.count} 个文本片段：${JSON.stringify(spanInfo.sample.slice(0, 2))}`
    );

    // 只划选句子中间的一小段（"fox jumps"），验证「整句」自动扩展
    const selectedPart = await viewer.evaluate(() => {
      const spans = [...document.querySelectorAll('.textLayer span')];
      const target = spans.find((s) => s.textContent.includes('quick brown fox'));
      if (!target) throw new Error('没有找到目标文本片段');
      const node = target.firstChild;
      const start = node.nodeValue.indexOf('fox');
      const end = start + 'fox jumps'.length;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return node.nodeValue.slice(start, end);
    });

    const cardAppeared = await viewer
      .waitForFunction(
        () => {
          const card = document.getElementById('card');
          return card && !card.hidden;
        },
        { timeout: 10000 }
      )
      .then(() => true)
      .catch(() => false);
    record('划词后弹出译文卡片', cardAppeared, `划选内容 = "${selectedPart}"`);

    let viewerOut = '';
    if (cardAppeared) {
      // 先等第一段（免费引擎/流式）出现
      await viewer
        .waitForFunction(
          () => {
            const out = document.getElementById('cardOut');
            return out && out.textContent && !out.textContent.includes('正在请求') && !out.textContent.includes('生成中');
          },
          { timeout: 25000 }
        )
        .catch(() => {});
      const provisional = await viewer.evaluate(() => document.getElementById('cardOut').textContent.trim());
      // 再等自定义 API 的最终结果（可能是流式片段，也可能是升级后的完整结果）
      await viewer
        .waitForFunction(
          (prefix) => {
            const out = document.getElementById('cardOut');
            const badge = document.getElementById('cardBadge');
            return (
              out &&
              out.textContent.startsWith(prefix) &&
              badge &&
              !badge.textContent.includes('生成中') &&
              !badge.textContent.includes('优化中')
            );
          },
          { timeout: 25000 },
          MOCK_PREFIX
        )
        .catch(() => {});
      const state = await viewer.evaluate(() => ({
        out: document.getElementById('cardOut').textContent.trim(),
        src: document.getElementById('cardSrc').textContent.trim(),
        badge: document.getElementById('cardBadge').textContent.trim()
      }));
      viewerOut = state.out;
      record(
        '整句模式把片段扩展成完整句子',
        state.src === 'The quick brown fox jumps over the lazy dog.',
        `原文 = "${state.src}"`
      );
      record(
        '阅读器划词拿到译文（免费引擎先出 → 自定义 API 最终结果）',
        viewerOut.startsWith(MOCK_PREFIX) && viewerOut.includes('The quick brown fox'),
        `第一段="${String(provisional).slice(0, 24)}" → 最终 [${state.badge}] ${viewerOut.slice(0, 60)}`
      );
      await viewer.screenshot({ path: path.join(artifacts, 'viewer-selection.png') });
    }

    /* ------------------------------------------------ 普通网页划词翻译 */
    const pageLogs = [];
    const page = await browser.newPage();
    attachLogs(page, pageLogs);
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`http://127.0.0.1:${PORT}/page.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#pt-selection-host', { timeout: 10000 });

    await page.evaluate(() => {
      const p = document.getElementById('p1');
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

    const shadowOk = await page
      .waitForFunction(
        (prefix) => {
          const host = document.getElementById('pt-selection-host');
          const out = host && host.shadowRoot && host.shadowRoot.querySelector('.pt-out');
          const badge = host && host.shadowRoot && host.shadowRoot.querySelector('.pt-badge');
          if (!out) return false;
          const text = out.textContent || '';
          return (
            text.startsWith(prefix) &&
            badge &&
            !badge.textContent.includes('生成中') &&
            !badge.textContent.includes('优化中')
          );
        },
        { timeout: 25000 },
        MOCK_PREFIX
      )
      .then(() => true)
      .catch(() => false);
    const shadowOut = shadowOk
      ? await page.evaluate(
          () => document.getElementById('pt-selection-host').shadowRoot.querySelector('.pt-out').textContent.trim()
        )
      : '';
    record('普通网页划词翻译可用', shadowOk && shadowOut.startsWith(MOCK_PREFIX), shadowOut.slice(0, 80));
    await page.screenshot({ path: path.join(artifacts, 'webpage-selection.png') });

    /* -------------------------------------------- 自动用阅读器打开 PDF */
    await options.evaluate(
      (settings) => new Promise((resolve) => chrome.storage.local.set({ settings }, resolve)),
      {
        engine: 'custom',
        targetLang: 'zh-CN',
        sourceLang: 'auto',
        autoTranslate: true,
        sentenceMode: true,
        autoOpenPdf: true,
        clipboardWatch: false,
        cardFontSize: 15,
        custom: {
          baseUrl: `http://127.0.0.1:${PORT}/v1`,
          apiKey: 'test-key',
          model: 'mock-model',
          prompt: 'Translate into {target}. Output ONLY the translation.'
        }
      }
    );
    await sleep(300);

    const pdfLogs = [];
    const pdfTab = await browser.newPage();
    attachLogs(pdfTab, pdfLogs);
    await pdfTab.goto(`http://127.0.0.1:${PORT}/sample.pdf`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    let redirected = false;
    for (let i = 0; i < 25 && !redirected; i++) {
      await sleep(200);
      redirected = pdfTab.url().startsWith(`chrome-extension://${extId}/src/viewer.html`);
    }
    record(
      '开启「自动打开 PDF」后 .pdf 链接被重定向到自带阅读器',
      redirected,
      pdfTab.url().slice(0, 100)
    );

    /* -------------------------------------------------------- 弹窗页面 */
    const popupLogs = [];
    const popup = await browser.newPage();
    attachLogs(popup, popupLogs);
    await popup.goto(`chrome-extension://${extId}/src/popup.html`, { waitUntil: 'domcontentloaded' });
    await sleep(900);
    const popupState = await popup.evaluate(() => ({
      buttons: document.querySelectorAll('button').length,
      hasClipButton: Boolean(document.getElementById('translateClip')),
      engineOptions: document.getElementById('engine').options.length
    }));
    const popupErrors = popupLogs.filter((l) => l.startsWith('pageerror'));
    record(
      '弹窗页面正常渲染（含剪贴板翻译入口）',
      popupState.buttons > 4 && popupState.hasClipButton && popupErrors.length === 0,
      `${popupState.buttons} 个按钮，${popupState.engineOptions} 个引擎选项`
    );

    // 内置阅读器场景：读剪贴板 → 翻译 → 在弹窗里显示译文
    await popup.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'readText', {
        configurable: true,
        value: async () => 'Selected text copied from the built-in PDF viewer.'
      });
    });
    await popup.click('#translateClip');
    const clipOk = await popup
      .waitForFunction(
        () => {
          const el = document.getElementById('clipResult');
          return el && !el.hidden && el.textContent.includes('模拟译文');
        },
        { timeout: 20000 }
      )
      .then(() => true)
      .catch(() => false);
    const clipOut = clipOk ? await popup.evaluate(() => document.getElementById('clipResult').textContent.trim()) : '';
    record('弹窗「翻译剪贴板内容」链路可用', clipOk, clipOut.slice(0, 90));
    await popup.screenshot({ path: path.join(artifacts, 'popup-clipboard.png') });

    /* ---------------------------------------------------- 全局错误检查 */
    const allErrors = [...viewerLogs, ...pageLogs, ...optLogs, ...popupLogs, ...pdfLogs].filter(
      (l) => l.startsWith('pageerror') || /Uncaught|Refused to/.test(l)
    );
    record('没有未捕获的脚本错误', allErrors.length === 0, allErrors.slice(0, 3).join(' | ').slice(0, 260));

    const warnings = [...viewerLogs, ...pageLogs, ...optLogs, ...popupLogs, ...pdfLogs].filter((l) =>
      l.startsWith('warning')
    );
    if (warnings.length) info(`控制台告警：${warnings.slice(0, 4).join(' | ').slice(0, 300)}`);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) exitCode = 1;
  } catch (err) {
    console.error('测试异常：', err);
    exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
    server.close();
    if (moved) {
      try {
        fs.renameSync(localConfigBak, localConfig);
      } catch (_) {}
    }
  }
  process.exit(exitCode);
}

main();
