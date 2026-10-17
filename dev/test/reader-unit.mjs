import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFindText, buildSearchPage, findPageMatches, resolveOutlinePage, normalizeReadingState, mergeReadingEdits, buildReadingMarkdown } from '../../src/reader-tools.mjs';

const item = (str, x = 0, y = 700, extra = {}) => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, ...extra });

test('literal PDF find never treats user input as a regular expression', () => {
  const page = buildSearchPage([item('a+b [test] (.+) a+b')]);
  assert.equal(findPageMatches(page, 'a+b').length, 2);
  assert.equal(findPageMatches(page, '[test]')[0].match, '[test]');
  assert.equal(findPageMatches(page, '(.+)')[0].match, '(.+)');
  assert.equal(findPageMatches(page, 'a.*b').length, 0);
  assert.equal(findPageMatches(page, '').length, 0);
  assert.equal(findPageMatches(page, '   ').length, 0);
});

test('Unicode find normalizes combining accents, ligatures, width and case without losing offsets', () => {
  const page = buildSearchPage([item('CAFÉ cafe\u0301 ofﬁce Straße Σίσυφος ＰＤＦ 中文😀')]);
  assert.equal(findPageMatches(page, 'café').length, 2);
  const ligature = findPageMatches(page, 'OFFICE')[0];
  assert.equal(ligature.match, 'ofﬁce');
  assert.deepEqual(ligature.ranges, [{ span: 0, start: 11, end: 16 }]);
  assert.equal(findPageMatches(page, 'STRASSE')[0].match, 'Straße');
  assert.equal(findPageMatches(page, 'σίσυφοσ')[0].match, 'Σίσυφος');
  assert.equal(findPageMatches(page, 'pdf')[0].match, 'ＰＤＦ');
  assert.equal(findPageMatches(page, '中文😀')[0].match, '中文😀');
  const normalized = normalizeFindText('e\u0301😀');
  assert.equal(normalized.text, 'é😀');
  assert.deepEqual([...normalized.starts], [0, 2, 2]);
  assert.deepEqual([...normalized.ends], [2, 4, 4]);
});

test('line hyphens and soft hyphens are searchable in whole words with source span ranges', () => {
  const page = buildSearchPage([
    item('inter-', 10, 700, { hasEOL: true }), item('national', 10, 688, { hasEOL: true }),
    item('risk- ', 10, 676, { hasEOL: true }), item('based', 10, 664, { hasEOL: true }), item('co\u00adoperate', 10, 652)
  ]);
  assert.equal(findPageMatches(page, 'international').length, 1);
  assert.deepEqual(findPageMatches(page, 'international')[0].ranges, [{ span: 0, start: 0, end: 6 }, { span: 1, start: 0, end: 8 }]);
  assert.equal(findPageMatches(page, 'inter-national').length, 1);
  assert.equal(findPageMatches(page, 'riskbased').length, 1);
  assert.equal(findPageMatches(page, 'risk-based').length, 1);
  assert.equal(findPageMatches(page, 'cooperate').length, 1);
});

test('text items reconstruct words, spaces and geometry line endings without crossing span offsets', () => {
  const page = buildSearchPage([item('of', 10), item('fi', 20), item('ce', 30), item('model', 50), item('next', 10, 688)]);
  assert.equal(page.text, 'office model\nnext');
  const match = findPageMatches(page, 'office model')[0];
  assert.deepEqual(match.ranges, [{ span: 0, start: 0, end: 2 }, { span: 1, start: 0, end: 2 }, { span: 2, start: 0, end: 2 }, { span: 3, start: 0, end: 5 }]);
  const hiddenItem = buildSearchPage([item('zero', 0, 700, { transform: [0, 0, 0, 0, 0, 700] }), item('visible', 30)]);
  assert.deepEqual(findPageMatches(hiddenItem, 'visible')[0].ranges, [{ span: 0, start: 0, end: 7 }]);
});

test('find bounds result counts and per-page extraction size', () => {
  const page = buildSearchPage([item('match '.repeat(1000))]);
  assert.equal(findPageMatches(page, 'match').length, 250);
  assert.equal(findPageMatches(page, 'match', 3).length, 3);
  assert.equal(findPageMatches(page, 'match', 0).length, 0);
  const large = buildSearchPage([item('x'.repeat(399990)), item('too long to include')]);
  assert.equal(large.truncated, true);
  assert.ok(large.text.length <= 400000);
});

test('outline resolves named, direct and indirect destinations and rejects invalid page references', async () => {
  const pdf = { numPages: 8, async getDestination(name) { assert.equal(name, 'chapter.2'); return [{ num: 6, gen: 0 }, { name: 'XYZ' }]; }, async getPageIndex(ref) { assert.equal(ref.num, 6); return 4; } };
  assert.equal(await resolveOutlinePage(pdf, 'chapter.2'), 5);
  assert.equal(await resolveOutlinePage(pdf, [0]), 1);
  assert.equal(await resolveOutlinePage(pdf, [7]), 8);
  for (const invalid of [null, [], [-1], [8], ['javascript:alert(1)'], [{ num: -1, gen: 0 }], [1.5]]) assert.equal(await resolveOutlinePage(pdf, invalid), null);
});

test('reading state is deduplicated and bounded and never trusts foreign page numbers', () => {
  const data = normalizeReadingState({ bookmarks: [{ page: 2 }, { page: 2, createdAt: 9 }, { page: 1 }, { page: 20 }, { page: '3' }], notes: [{ page: 1, text: 'old' }, { page: 1, text: '最新' }, { page: 2, text: ' ' }, { page: 3, text: '<img onerror=1>' }, { page: 4, text: 'x'.repeat(5000) }] }, 4);
  assert.deepEqual(data.bookmarks.map((entry) => entry.page), [1, 2]);
  assert.equal(data.bookmarks[1].createdAt, 9);
  assert.equal(data.notes[0].text, '最新');
  assert.equal(data.notes[1].text, '<img onerror=1>');
  assert.equal(data.notes[2].text.length, 4000);
  assert.deepEqual(normalizeReadingState(null, 2), { version: 1, bookmarks: [], notes: [] });
});

test('Markdown export contains original notes and explicit PDF page references without executable HTML', () => {
  const markdown = buildReadingMarkdown({ name: 'paper <img>.pdf\nnew' }, { bookmarks: [{ page: 3 }, { page: 1 }], notes: [{ page: 3, text: '实际观察：速度 20 m/s。\n<img src=x onerror=alert(1)> [link](https://example.com)' }] }, new Date('2026-10-17T00:00:00Z'));
  assert.match(markdown, /2026-10-17T00:00:00.000Z/);
  assert.ok(markdown.indexOf('## 第 1 页') < markdown.indexOf('## 第 3 页'));
  assert.match(markdown, /实际观察：速度 20 m\/s。/);
  assert.match(markdown, /&lt;img/);
  assert.ok(!markdown.includes('<img'));
  assert.match(markdown, /PDF 文件中的页面顺序/);
});

test('per-page reading edits preserve another window\'s unrelated records and honor explicit deletion', () => {
  const merged = mergeReadingEdits({ bookmarks: [{ page: 1 }, { page: 3 }], notes: [{ page: 1, text: 'another window' }, { page: 2, text: 'remove me' }] }, [
    { kind: 'bookmark', page: 3, value: null }, { kind: 'bookmark', page: 4, value: { createdAt: 5 } },
    { kind: 'note', page: 2, value: null }, { kind: 'note', page: 4, value: { text: 'local edit', updatedAt: 6 } }
  ], 5);
  assert.deepEqual(merged.bookmarks.map((value) => value.page), [1, 4]);
  assert.deepEqual(merged.notes.map((value) => [value.page, value.text]), [[1, 'another window'], [4, 'local edit']]);
});
