import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPageLayout, finalizeDocumentLayout, wrapText, fitTranslation, translationPlacement, paintTranslations, shouldTranslate } from '../../src/pdf-layout.mjs';
import { createImagePdf } from '../../src/pdf-export.mjs';

const viewport = { transform: [1, 0, 0, -1, 0, 792], scale: 1, width: 612, height: 792 };
const transform = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const item = (text, x, y, width = 200) => ({ str: text, width, fontName: 'F1', transform: [12, 0, 0, 12, x, y] });
const extract = (items) => extractPageLayout({ items, styles: { F1: { ascent: .8 } } }, viewport, transform);
test('two-column paragraphs remain separate and preserve wrapped-word boundaries', () => {
  const page = extract([item('Left column para-', 50, 700), item('Right column text', 340, 700), item('graph continues here.', 50, 684), item('with a second line.', 340, 684)]);
  assert.equal(page.blocks.length, 2);
  assert.equal(page.blocks[0].text, 'Left column paragraph continues here.');
  assert.equal(page.blocks[1].text, 'Right column text with a second line.');
});
test('numbers and symbolic formulas are preserved, not sent to an engine', () => {
  assert.equal(shouldTranslate('123.40'), false);
  assert.equal(shouldTranslate('x_i = a_1 + b_2'), false);
  assert.equal(shouldTranslate('Results suggest a consistent improvement.'), true);
  assert.equal(shouldTranslate('研究目的'), true);
  assert.equal(extract([item('12345', 50, 700)]).blocks[0].status, 'preserved');
  for (const text of ['fi', 'fl', 'car', 'qffiffiffiffiffiffiffiffiffiffiffiffi', 'tanðδÞ']) assert.equal(shouldTranslate(text), false, text);
});
test('Nature-style narrow gutters cannot merge two justified columns', () => {
  const page = extract([item('Left column paragraph begins', 44, 700, 248), item('Right column paragraph begins', 304, 700, 248),
    item('and continues here.', 44, 686, 248), item('and continues independently.', 304, 686, 248)]);
  assert.ok(page.gutter >= 292 && page.gutter <= 304);
  assert.equal(page.blocks.length, 2);
  assert.ok(page.blocks.every((b) => b.width <= 248.1));
  assert.ok(!page.blocks[0].text.includes('Right'));
});
test('different column font sizes still have column-major reading order', () => {
  const items = [];
  for (let n = 0; n < 6; n++) {
    items.push(item(`Left paragraph line number ${n}`, 44, 700 - n * 14, 248));
    items.push({ ...item(`Right paragraph line number ${n}`, 304, 697 - n * 10, 248), transform: [8,0,0,8,304,697-n*10] });
  }
  const page = extract(items);
  assert.ok(page.gutter >= 292 && page.gutter <= 304);
  const texts = page.blocks.filter((b) => b.status === 'pending').map((b) => b.text);
  assert.ok(texts[0].startsWith('Left')); assert.ok(texts.at(-1).startsWith('Right'));
});
test('zero-ascent ligatures and punctuation follow the baseline, not their glyph top', () => {
  const page = extractPageLayout({ styles: { F1: { ascent: .712, descent: -.257 }, F2: { ascent: 0, descent: 0 } }, items: [
    item('A speci', 44, 700, 30), { ...item('fi', 74, 700, 5), fontName: 'F2' }, item('c finding about the driver', 79, 700, 130),
    { ...item('’', 209, 700, 2), fontName: 'F2' }, item('s behaviour.', 211, 700, 55)
  ] }, viewport, transform);
  assert.equal(page.blocks.length, 1);
  assert.equal(page.blocks[0].text, 'A specific finding about the driver’s behaviour.');
});
test('citations and variable subscripts stay inside prose and keep word spacing', () => {
  const page = extract([
    item('The driver', 44, 700, 45), { ...item('25', 89, 703, 7), transform: [8,0,0,8,89,703] },
    item(' and x', 96, 700, 28), { ...item('car', 124, 697, 9), transform: [7,0,0,7,124,697] }, item(' determine the path.', 136, 700, 90)
  ]);
  assert.equal(page.blocks.length, 1);
  assert.match(page.blocks[0].text, /driver\[25\] and x_car determine/);
});
test('initial drop cap is folded into its own column paragraph', () => {
  const page = extract([{ ...item('W', 44, 670, 30), transform: [40,0,0,40,44,670] },
    item('ith the introduction of vehicles', 75, 694, 217), item('people interact with automation.', 75, 680, 217),
    item('Trust is an important factor.', 44, 666, 248)]);
  assert.ok(page.blocks.some((b) => b.text.startsWith('With the introduction')));
  assert.ok(!page.blocks.some((b) => b.text === 'W'));
});
test('negative unit exponents are not mistaken for bibliography citations', () => {
  const page = extract([item('The speed is 10 m s', 44, 700, 90),
    { ...item('−1', 134, 703, 7), transform: [8,0,0,8,134,703] }, item(' during the test.', 142, 700, 80)]);
  assert.match(page.blocks[0].text, /m s\^−1/); assert.ok(!page.blocks[0].text.includes('[−1]'));
});
test('bibliographic entries retain their original names, titles and identifiers across pages', () => {
  const b = (text) => ({ text, status: 'pending' });
  const pages = [{ blocks: [b('References'), b('1. A. Author. Original title.')] }, { blocks: [b('2. B. Author. Another title.'), b('Acknowledgements'), b('This project was supported.')] }];
  finalizeDocumentLayout(pages);
  assert.equal(pages[0].blocks[1].status, 'preserved'); assert.equal(pages[1].blocks[0].status, 'preserved');
  assert.equal(pages[1].blocks[2].status, 'pending');
});
test('rotation and image-only pages are reported without inventing text', () => {
  const page = extract([{ ...item('Rotated caption', 50, 700), transform: [0, 12, -12, 0, 50, 700] }]);
  assert.equal(page.unplaced, 1); assert.equal(page.blocks.length, 0);
  assert.equal(extract([]).textItems, 0);
});
test('long columns split before the provider character limit', () => {
  const page = extract(Array.from({ length: 90 }, (_, i) => item('A paragraph line with about fifty characters of text.', 50, 1500 - i * 16)));
  assert.ok(page.blocks.length > 1);
  assert.ok(page.blocks.every((b) => b.text.length < 4000));
});
test('Chinese wrapping and long URLs do not exceed the available width', () => {
  const lines = wrapText('这是一段中文 https://example.com/very/long/path', 6, (t) => [...t].length);
  assert.ok(lines.every((line) => [...line].length <= 6));
  assert.equal(lines.join('').replace(/\s/g, ''), '这是一段中文https://example.com/very/long/path');
  const punctuated = '（中文标点）不能落在行首。第二句，检查换行。';
  const wrapped = wrapText(punctuated, 6, (t) => [...t].length);
  assert.equal(wrapped.join(''), punctuated);
  assert.ok(wrapped.every((l) => !/^[，。！？；：、）】》”’]/.test(l) && !/[（【《“‘]$/.test(l)));
});
test('fitting never truncates a translation; impossible placement is explicit', () => {
  const context = { font: '', measureText(text) { return { width: [...text].length * parseFloat(this.font) * .6 }; } };
  const block = { fontSize: 12, width: 100, height: 24 };
  const text = '这里是完整的翻译段落。';
  const fit = fitTranslation(block, text, context);
  assert.ok(fit); assert.equal(fit.lines.join(''), text);
  assert.equal(fitTranslation({ ...block, width: 1, height: 1 }, text, context), null);
  assert.equal(fitTranslation(block, '完整译文'.repeat(120), context), null);
  assert.ok(fit.fontSize >= block.fontSize * .72);
});
test('overlapping math is not covered; all source masks precede target drawing', () => {
  const calls = [];
  const context = { font: '', measureText(t) { return { width: t.length * parseFloat(this.font) * .6 }; }, save() {}, restore() {}, scale() {},
    getImageData() { return { data: [255,255,255,255] }; }, fillRect() { calls.push('mask'); }, fillText() { calls.push('text'); } };
  const block = (x) => ({ x, y: 20, width: 80, height: 30, fontSize: 12, lines: [{ x, y: 20, fontSize: 12 }], status: 'done', translation: '完整译文' });
  const page = { width: 300, blocks: [block(20), block(150)] };
  paintTranslations({ width: 600, height: 900, getContext() { return context; } }, page);
  assert.deepEqual(calls.slice(0, 2), ['mask','mask']); assert.equal(calls[2], 'text');
  page.blocks.push({ x: 30, y: 25, width: 20, height: 10, status: 'preserved' });
  assert.equal(translationPlacement(page.blocks[0], page, context), null);
});
test('PDF cross-reference offsets and page dimensions agree with the encoded objects', async () => {
  const blob = createImagePdf([{ width: 612, height: 792, pixelWidth: 2, pixelHeight: 2, bytes: new Uint8Array([255,216,255,217]) }]);
  const text = new TextDecoder('latin1').decode(await blob.arrayBuffer());
  assert.match(text, /\/MediaBox \[0 0 612 792\]/);
  const offset = Number(text.match(/startxref\n(\d+)/)[1]);
  assert.equal(text.slice(offset, offset + 4), 'xref');
  const xref = text.slice(offset).split('\n');
  for (let i = 1; i <= 5; i++) {
    const start = Number(xref[i + 2].slice(0,10)); assert.equal(text.slice(start, start + 7), `${i} 0 obj`);
  }
});
