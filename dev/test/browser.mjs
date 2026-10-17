import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

// Load an isolated snapshot: tests never rename or rewrite the user's local Key.
export async function launchExtension(root) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-translate-test-'));
  const extensionPath = path.join(temporary, 'extension');
  await fs.mkdir(extensionPath);
  for (const name of ['manifest.json', 'src', 'vendor', 'icons']) {
    await fs.cp(path.join(root, name), path.join(extensionPath, name), { recursive: true });
  }
  const candidates = process.env.BROWSER_PATH ? [process.env.BROWSER_PATH] : [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/google-chrome'
  ];
  const failures = [];
  for (const executablePath of candidates) {
    try { await fs.access(executablePath); } catch (_) { continue; }
    let browser;
    try {
      browser = await puppeteer.launch({
        executablePath, headless: true, userDataDir: path.join(temporary, `profile-${path.basename(executablePath)}`), ignoreDefaultArgs: ['--disable-extensions'],
        args: ['--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check']
      });
      const cdp = await browser.target().createCDPSession();
      const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
      const wake = await browser.newPage();
      await wake.goto(`chrome-extension://${id}/src/options.html`);
      await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(id), { timeout: 15000 });
      const cleanup = async () => {
        await browser.close().catch(() => {});
        // The sole deletion target is the exact mkdtemp directory created above.
        if (path.dirname(temporary) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith('pdf-translate-test-')) throw new Error('Invalid test cleanup path');
        await fs.rm(temporary, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
      };
      return { browser, id, extensionPath, cleanup };
    } catch (err) {
      failures.push(`${path.basename(executablePath)}: ${err.message.split('\n')[0]}`);
      if (browser) await browser.close().catch(() => {});
    }
  }
  if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('pdf-translate-test-')) await fs.rm(temporary, { recursive: true, force: true });
  throw new Error(`No extension-capable browser started. Set BROWSER_PATH. ${failures.join('; ')}`);
}

export async function screenshot(page, file, fullPage = false) {
  await page.bringToFront();
  const session = await page.createCDPSession();
  try {
    let clip;
    if (fullPage) {
      const { cssContentSize } = await session.send('Page.getLayoutMetrics');
      clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
    await fs.writeFile(file, Buffer.from(data, 'base64'));
  } finally { await session.detach(); }
}
