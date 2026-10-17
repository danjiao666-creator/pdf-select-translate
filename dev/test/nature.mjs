import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchExtension } from './browser.mjs';

// Real user reproduction, not bundled/published with the extension. Reviewed
// target text tests rendering only; it does not certify any live model output.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = process.env.PDF_REPRO_FILE || path.join(os.homedir(), 'Downloads/s41467-020-18353-4.pdf');
const bytes = await fs.readFile(file);
const reference = JSON.parse(await fs.readFile(path.join(root, 'dev/tests/nature-reference-zh.json'), 'utf8'));
const artifacts = path.join(root, 'dev/test/artifacts');
await fs.mkdir(artifacts, { recursive: true });
const harness = await launchExtension(root);
try {
  const page = await harness.browser.newPage();
  await page.goto(`chrome-extension://${harness.id}/src/options.html`);
  const results = await page.evaluate(async ({ base64, reference }) => {
    const pdfjs = await import('../vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.mjs');
    const { extractPageLayout, finalizeDocumentLayout, paintTranslations } = await import('./pdf-layout.mjs');
    const pdf = await pdfjs.getDocument({ data: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      cMapUrl: chrome.runtime.getURL('vendor/cmaps/'), cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('vendor/standard_fonts/') }).promise;
    const layouts = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const p = await pdf.getPage(n);
      layouts.push(extractPageLayout(await p.getTextContent(), p.getViewport({ scale: 1 }), pdfjs.Util.transform));
    }
    finalizeDocumentLayout(layouts);
    const results = { numPages: pdf.numPages, pages: [], audit: [] };
    for (let n = 1; n <= layouts.length; n++) {
      const layout = layouts[n - 1], blocks = layout.blocks.filter((b) => b.status !== 'preserved');
      const separators = layout.blocks.filter((b) => b.column === -1 && b.width > layout.width * .6);
      const columnBands = {};
      for (const block of blocks.filter((b) => b.column >= 0)) {
        const band = separators.filter((s) => s.y + s.height <= block.y + 1).length;
        (columnBands[band] ||= []).push(block.column);
      }
      results.audit.push({ page: n, gutter: layout.gutter, blocks: blocks.length,
        isolated: blocks.filter((b) => /^(fi|fl|car|inner|outer)$/.test(b.text)).map((b) => b.text),
        crossesColumns: blocks.filter((b) => layout.gutter && b.width < layout.width * .6 && b.x < layout.gutter - 20 && b.x + b.width > layout.gutter + 20).length,
        columnBands });
    }
    const unchanged = (a, b, box, scale) => {
      const [x,y,w,h] = box.map((v) => Math.round(v * scale));
      const source = a.getContext('2d').getImageData(x,y,w,h).data;
      const target = b.getContext('2d').getImageData(x,y,w,h).data;
      return source.every((v, i) => v === target[i]);
    };
    for (const n of [2, 3]) {
      const p = await pdf.getPage(n), layout = layouts[n - 1];
      const canvas = document.createElement('canvas'), viewport = p.getViewport({ scale: 2 });
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await p.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const target = document.createElement('canvas'); target.width = canvas.width; target.height = canvas.height;
      target.getContext('2d').drawImage(canvas, 0, 0);
      const missing = [];
      for (const block of layout.blocks.filter((b) => b.status !== 'preserved')) {
        const match = reference.pages[String(n)].find(([prefix]) => block.text.startsWith(prefix));
        if (!match) { missing.push(block.text); continue; }
        block.status = 'done'; block.translation = match[1];
      }
      const placements = paintTranslations(target, layout, canvas);
      results.pages.push({ number: n, missing, sources: layout.blocks.filter((b) => b.status === 'done').map((b) => b.text),
        unfitted: placements.filter((p) => !p.layout).map((p) => p.block.text),
        fonts: placements.filter((p) => p.layout).map((p) => p.layout.fontSize),
        graphicsUnchanged: n === 2 ? unchanged(canvas, target, [390,636,165,34], canvas.width / layout.width) : unchanged(canvas,target,[110,42,380,248],canvas.width / layout.width),
        original: canvas.toDataURL('image/png').split(',')[1], translated: target.toDataURL('image/png').split(',')[1] });
    }
    await pdf.destroy(); return results;
  }, { base64: bytes.toString('base64'), reference });
  assert.equal(results.numPages, 13);
  assert.equal(results.audit[1].blocks, 14);
  for (const audit of results.audit) {
    assert.deepEqual(audit.isolated, [], `isolated fragments on page ${audit.page}`);
    assert.equal(audit.crossesColumns, 0, `cross-column block on page ${audit.page}`);
    for (const columns of Object.values(audit.columnBands)) assert.deepEqual(columns, [...columns].sort(), `reading order on page ${audit.page}`);
  }
  for (const result of results.pages) {
    assert.deepEqual(result.missing, [], `reviewed references missing on page ${result.number}`);
    assert.deepEqual(result.unfitted, [], `unfitted reference text on page ${result.number}`);
    assert.equal(result.graphicsUnchanged, true, `formula/figure was changed on page ${result.number}`);
    for (const type of ['original','translated']) {
      await fs.writeFile(path.join(artifacts, `nature-page-${result.number}-${type === 'translated' ? 'reference-zh' : type}.png`), Buffer.from(result[type], 'base64'));
      delete result[type];
    }
  }
  await fs.writeFile(path.join(artifacts, 'nature-audit.json'), JSON.stringify(results, null, 2));
  console.log('PASS real 13-page PDF: column reading order, isolated-fragment guard, and no cross-column blocks');
  console.log('PASS reviewed page 2-3 text: all paragraphs fit without tiny type; formulas/figure pixels unchanged');
  console.log('Layout references only, NOT current API translations. Inspect nature-page-*-reference-zh.png.');
} finally { await harness.cleanup(); }
