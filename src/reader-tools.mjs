const MAX_RESULTS = 250;
const MAX_NOTE = 4000;
const MAX_RECORDS = 1000;
const MAX_PAGE_TEXT = 400000;
const MAX_CACHE_TEXT = 2000000;
const letter = (value) => /\p{L}/u.test(value || '');

export function normalizeReadingState(value, pageCount) {
  const validPage = (page) => Number.isInteger(page) && page > 0 && page <= pageCount;
  const bookmarks = new Map(), notes = new Map();
  for (const item of Array.isArray(value?.bookmarks) ? value.bookmarks.slice(0, MAX_RECORDS) : []) {
    if (validPage(item?.page)) bookmarks.set(item.page, { page: item.page, createdAt: Number(item.createdAt) || 0 });
  }
  for (const item of Array.isArray(value?.notes) ? value.notes.slice(0, MAX_RECORDS) : []) {
    if (validPage(item?.page) && typeof item.text === 'string' && item.text.trim()) {
      notes.set(item.page, { page: item.page, text: item.text.slice(0, MAX_NOTE), updatedAt: Number(item.updatedAt) || 0 });
    }
  }
  return { version: 1, bookmarks: [...bookmarks.values()].sort((a, b) => a.page - b.page), notes: [...notes.values()].sort((a, b) => a.page - b.page) };
}

export function mergeReadingEdits(value, edits, pageCount) {
  const data = normalizeReadingState(value, pageCount);
  for (const edit of edits || []) {
    if (!Number.isInteger(edit?.page) || edit.page < 1 || edit.page > pageCount) continue;
    if (edit.kind === 'bookmark') {
      data.bookmarks = data.bookmarks.filter((item) => item.page !== edit.page);
      if (edit.value) data.bookmarks.push({ ...edit.value, page: edit.page });
    } else if (edit.kind === 'note') {
      data.notes = data.notes.filter((item) => item.page !== edit.page);
      if (edit.value) data.notes.push({ ...edit.value, page: edit.page });
    }
  }
  return normalizeReadingState(data, pageCount);
}

// Retain source offsets while normalizing ligatures, Unicode case and PDF line hyphenation.
export function normalizeFindText(source, keepLineHyphen = false) {
  const text = String(source || '');
  const output = [], starts = [], ends = [];
  const push = (part, start, end) => {
    for (let n = 0; n < part.length; n++) { output.push(part[n]); starts.push(start); ends.push(end); }
  };
  for (let i = 0; i < text.length;) {
    const start = i;
    let unit = String.fromCodePoint(text.codePointAt(i));
    i += unit.length;
    if (unit === '\u00ad' || unit === '\ufeff' || unit === '\u200b') continue;
    if (/[-\u2010\u2011]/u.test(unit) && letter(text.slice(Math.max(0, start - 2), start).match(/.$/u)?.[0])) {
      const remainder = text.slice(i).match(/^\s*\n\s*(\p{L})/u);
      if (remainder) {
        if (keepLineHyphen) push('-', start, i);
        i += remainder[0].length - remainder[1].length;
        continue;
      }
    }
    if (/\s/u.test(unit)) {
      if (output.at(-1) !== ' ') push(' ', start, i);
      else ends[ends.length - 1] = i;
      continue;
    }
    while (i < text.length) {
      const next = String.fromCodePoint(text.codePointAt(i));
      if (!/\p{M}/u.test(next)) break;
      unit += next; i += next.length;
    }
    const normalized = unit.normalize('NFKC').toLowerCase().replace(/\u03c2/g, '\u03c3').replace(/\u00df/g, 'ss').replace(/[\u2010\u2011]/g, '-');
    push(normalized, start, i);
  }
  return { text: output.join(''), starts: Uint32Array.from(starts), ends: Uint32Array.from(ends) };
}

function itemSeparator(previous, item) {
  if (!previous) return '';
  if (previous.hasEOL) return /\n$/u.test(previous.str) ? '' : '\n';
  if (/\s$/u.test(previous.str) || /^\s/u.test(item.str)) return '';
  const a = previous.transform, b = item.transform;
  if (!Array.isArray(a) || !Array.isArray(b)) return ' ';
  const size = Math.max(1, Math.hypot(a[2], a[3]) || Math.hypot(a[0], a[1]));
  if (Math.abs(a[5] - b[5]) > size * 0.45 || b[4] < a[4] - size) return '\n';
  return b[4] - a[4] - (Number(previous.width) || 0) > size * 0.12 ? ' ' : '';
}

export function buildSearchPage(items) {
  const pieces = [], segments = [];
  let length = 0, span = 0, previous = null, truncated = false;
  for (const item of items || []) {
    if (!item || typeof item.str !== 'string' || !item.str) continue;
    const separator = itemSeparator(previous, item);
    if (length + separator.length + item.str.length > MAX_PAGE_TEXT) { truncated = true; break; }
    pieces.push(separator); length += separator.length;
    const start = length;
    pieces.push(item.str); length += item.str.length;
    const visible = !Array.isArray(item.transform) || Math.hypot(item.transform[2], item.transform[3]) > 0;
    if (visible) segments.push({ start, end: length, span: span++ });
    previous = item;
  }
  const text = pieces.join('');
  return { text, segments, normalized: normalizeFindText(text), truncated };
}

export function findPageMatches(page, input, limit = MAX_RESULTS) {
  const query = normalizeFindText(String(input || '').slice(0, 200), true).text.trim();
  if (!query || !Number.isFinite(limit) || limit <= 0) return [];
  const normalized = query.includes('-') ? (page.hyphenated ||= normalizeFindText(page.text, true)) : page.normalized;
  const matches = [];
  let from = 0;
  while (matches.length < Math.min(MAX_RESULTS, limit)) {
    const at = normalized.text.indexOf(query, from);
    if (at < 0) break;
    const start = normalized.starts[at], end = normalized.ends[at + query.length - 1];
    const ranges = [];
    for (const segment of page.segments) {
      if (segment.end <= start) continue;
      if (segment.start >= end) break;
      ranges.push({ span: segment.span, start: Math.max(start, segment.start) - segment.start, end: Math.min(end, segment.end) - segment.start });
    }
    const snippetStart = Math.max(0, start - 48), snippetEnd = Math.min(page.text.length, end + 75);
    const display = (value) => value.replace(/\s+/gu, ' ');
    if (matches.at(-1)?.start !== start || matches.at(-1)?.end !== end) matches.push({ start, end, ranges, before: `${snippetStart ? '…' : ''}${display(page.text.slice(snippetStart, start))}`, match: display(page.text.slice(start, end)), after: `${display(page.text.slice(end, snippetEnd))}${snippetEnd < page.text.length ? '…' : ''}` });
    from = at + Math.max(1, query.length);
  }
  return matches;
}

export async function resolveOutlinePage(pdf, destination) {
  let dest = destination;
  if (typeof dest === 'string') dest = await pdf.getDestination(dest);
  if (!Array.isArray(dest) || !dest.length) return null;
  const reference = dest[0];
  let index;
  if (Number.isInteger(reference)) index = reference;
  else if (reference && Number.isInteger(reference.num) && reference.num >= 0 && Number.isInteger(reference.gen) && reference.gen >= 0) index = await pdf.getPageIndex(reference);
  return Number.isInteger(index) && index >= 0 && index < pdf.numPages ? index + 1 : null;
}

export function buildReadingMarkdown(record, value, now = new Date()) {
  const escape = (text) => String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]#|])/g, '\\$1');
  const data = normalizeReadingState(value, Number.MAX_SAFE_INTEGER);
  const pages = [...new Set([...data.bookmarks.map((item) => item.page), ...data.notes.map((item) => item.page)])].sort((a, b) => a - b);
  const name = String(record?.name || 'PDF').replace(/[\r\n]/g, ' ');
  const lines = [`# ${escape(name)} 阅读记录`, '', `导出时间：${now.toISOString()}`, '', '页码以 PDF 文件中的页面顺序为准，不一定与论文印刷页码一致。', ''];
  for (const page of pages) {
    lines.push(`## 第 ${page} 页`, '');
    if (data.bookmarks.some((item) => item.page === page)) lines.push('已添加书签。', '');
    const note = data.notes.find((item) => item.page === page);
    if (note) lines.push(escape(note.text), '');
  }
  return `${lines.join('\n')}\n`;
}

function node(tag, attributes = {}, text = '') {
  const result = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') result.className = value;
    else result.setAttribute(name, value);
  }
  if (text) result.textContent = text;
  return result;
}

export function createReaderTools({ state, library, goToPage, toast = () => {}, closeCard = () => {} }) {
  const sidebar = document.getElementById('readerSidebar');
  if (!sidebar) throw new Error('Missing #readerSidebar');
  const buttons = Object.fromEntries(['outline', 'search', 'bookmarks'].map((name) => [name, document.getElementById(`open${name[0].toUpperCase()}${name.slice(1)}`)]));
  const bookmarkButton = document.getElementById('addBookmark');
  let current = null, generation = 0, searchToken = 0, activePanel = 'outline', opener = null;
  let search = emptySearch();
  const header = node('div', { class: 'reader-sidebar-heading' });
  header.append(node('strong', {}, '阅读工具'));
  const closeButton = node('button', { type: 'button', class: 'quiet', 'aria-label': '关闭阅读工具', title: '关闭 (Esc)' }, '×');
  header.append(closeButton);
  const tabs = node('div', { class: 'reader-tabs', role: 'tablist', 'aria-label': '阅读工具' });
  const panels = {}, tabButtons = {};
  for (const [name, title] of [['outline', '目录'], ['search', '搜索'], ['bookmarks', '书签 / 笔记']]) {
    const tab = node('button', { type: 'button', role: 'tab', id: `readerTab-${name}`, 'aria-controls': `readerPanel-${name}`, 'aria-selected': 'false', tabindex: '-1' }, title);
    const panel = node('section', { id: `readerPanel-${name}`, class: 'reader-panel', role: 'tabpanel', 'aria-labelledby': tab.id, tabindex: '0', hidden: '' });
    tab.addEventListener('click', () => open(name, tab));
    tabs.append(tab); panels[name] = panel; tabButtons[name] = tab;
  }
  sidebar.replaceChildren(header, tabs, ...Object.values(panels));
  sidebar.hidden = true;
  const outlineStatus = node('p', { class: 'reader-hint', role: 'status' });
  const outlineList = node('nav', { 'aria-label': 'PDF 目录', class: 'reader-outline' });
  const outlineSearch = node('button', { type: 'button', hidden: '' }, '搜索文档');
  outlineSearch.addEventListener('click', () => open('search'));
  panels.outline.append(outlineStatus, outlineList, outlineSearch);

  const searchForm = node('form', { class: 'reader-search-form', role: 'search' });
  const searchInput = node('input', { id: 'readerSearchInput', type: 'search', maxlength: '200', placeholder: '查找原文内容', 'aria-label': '在整个 PDF 原文中搜索', autocomplete: 'off', spellcheck: 'false' });
  const searchSubmit = node('button', { type: 'submit' }, '搜索');
  searchForm.append(searchInput, searchSubmit);
  const searchHint = node('p', { class: 'reader-hint' }, '搜索原文，不区分大小写。扫描页需要先进行 OCR；译文模式下仅定位页码。');
  const searchControls = node('div', { class: 'reader-search-controls' });
  const previousResult = node('button', { type: 'button', 'aria-label': '上一个结果', title: '上一个结果 (Shift+Enter)', disabled: '' }, '↑');
  const nextResult = node('button', { type: 'button', 'aria-label': '下一个结果', title: '下一个结果 (Enter)', disabled: '' }, '↓');
  const searchPosition = node('span', { class: 'reader-result-position' });
  const cancelSearch = node('button', { type: 'button', hidden: '' }, '停止');
  searchControls.append(previousResult, nextResult, searchPosition, cancelSearch);
  const searchProgress = node('progress', { max: '1', value: '0', 'aria-label': '全文搜索进度', hidden: '' });
  const searchStatus = node('p', { id: 'readerSearchStatus', class: 'reader-hint', role: 'status', 'aria-live': 'polite' }, '输入关键词后搜索。');
  const searchResults = node('ol', { class: 'reader-results', 'aria-label': '搜索结果' });
  panels.search.append(searchForm, searchHint, searchControls, searchProgress, searchStatus, searchResults);

  const bookmarkActions = node('div', { class: 'reader-bookmark-actions' });
  const toggleBookmark = node('button', { type: 'button' }, '添加当前页书签');
  const exportNotes = node('button', { type: 'button', title: '导出本篇文档的书签和笔记为 Markdown' }, '导出记录');
  bookmarkActions.append(toggleBookmark, exportNotes);
  const noteHeading = node('div', { class: 'reader-note-heading' });
  const noteLabel = node('label', { for: 'readerNote' }, '当前页笔记');
  const currentNote = node('button', { type: 'button', class: 'quiet', hidden: '' }, '切换至当前页');
  noteHeading.append(noteLabel, currentNote);
  const noteInput = node('textarea', { id: 'readerNote', rows: '5', maxlength: String(MAX_NOTE), placeholder: '记录这一页的疑问或结论，仅保存在本机。', 'aria-describedby': 'readerNoteStatus readerNoteCount' });
  const noteMeta = node('div', { class: 'reader-note-meta' });
  const saveStatus = node('span', { id: 'readerNoteStatus', role: 'status', 'aria-live': 'polite' });
  const noteCount = node('span', { id: 'readerNoteCount' });
  noteMeta.append(saveStatus, noteCount);
  const retrySave = node('button', { type: 'button', class: 'reader-save-retry', hidden: '' }, '重试保存');
  const bookmarkFilter = node('input', { type: 'search', class: 'reader-bookmark-filter', 'aria-label': '筛选书签和笔记', placeholder: '筛选页码或笔记', maxlength: '200' });
  const bookmarkCount = node('p', { class: 'reader-hint', role: 'status' });
  const bookmarkList = node('ol', { class: 'reader-bookmarks', 'aria-label': '书签和笔记' });
  panels.bookmarks.append(bookmarkActions, noteHeading, noteInput, noteMeta, retrySave, node('p', { class: 'reader-hint reader-storage-hint' }, '自动保存到当前文档。卸载或清理应用数据前，请先导出或备份。'), bookmarkFilter, bookmarkCount, bookmarkList);

  function emptySearch() { return { query: '', results: [], active: -1, running: false, processed: 0, skipped: 0, truncated: 0, hasText: false, limited: false, cancelled: false }; }
  function available() { return Boolean(current && state.pdf === current.pdf && document.body.dataset.view !== 'library'); }
  function same(context) { return current === context && state.pdf === context.pdf && context.generation === generation; }
  function enable(enabled) {
    for (const button of [...Object.values(buttons), bookmarkButton]) if (button) button.disabled = !enabled;
    for (const element of [toggleBookmark, noteInput, currentNote, exportNotes]) element.disabled = !enabled;
  }
  function syncTabs() {
    for (const name of Object.keys(panels)) {
      const selected = name === activePanel;
      tabButtons[name].setAttribute('aria-selected', String(selected));
      tabButtons[name].tabIndex = selected ? 0 : -1;
      panels[name].hidden = !selected;
      buttons[name]?.setAttribute('aria-expanded', String(!sidebar.hidden && selected));
    }
  }
  function open(name = 'outline', trigger = document.activeElement) {
    if (!available() || !panels[name]) return;
    if (sidebar.hidden && trigger && !sidebar.contains(trigger)) opener = trigger;
    closeCard(); activePanel = name; sidebar.hidden = false;
    syncTabs();
    if (name === 'outline') void loadOutline(current);
    if (name === 'bookmarks') { syncNoteEditor(); renderBookmarks(); }
    queueMicrotask(() => { if (!sidebar.hidden && activePanel === name) (name === 'search' ? searchInput : tabButtons[name]).focus({ preventScroll: true }); });
    document.dispatchEvent(new CustomEvent('reader-sidebar-change', { detail: { open: true, panel: name } }));
  }
  function close(restoreFocus = true) {
    if (sidebar.hidden) return;
    sidebar.hidden = true; syncTabs();
    if (restoreFocus && opener?.isConnected && !opener.disabled) opener.focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent('reader-sidebar-change', { detail: { open: false } }));
  }

  async function loadOutline(context) {
    if (!same(context) || context.outlineLoaded) return;
    context.outlineLoaded = true;
    outlineStatus.textContent = '正在读取目录…'; outlineList.replaceChildren(); outlineSearch.hidden = true;
    try {
      const items = await context.pdf.getOutline();
      if (!same(context)) return;
      let count = 0, cut = false;
      const seen = new WeakSet();
      const render = (values, depth = 0) => {
        const list = node('ul');
        for (const item of Array.isArray(values) ? values : []) {
          if (!item || typeof item !== 'object' || seen.has(item)) continue;
          if (count >= 2000 || depth > 16) { cut = true; break; }
          seen.add(item); count++;
          const outlineId = count;
          const row = node('li'), line = node('div', { class: 'reader-outline-row' });
          const children = Array.isArray(item.items) && item.items.length ? render(item.items, depth + 1) : null;
          const expand = node('button', { type: 'button', class: 'reader-outline-expand', 'aria-label': '展开子目录', 'aria-expanded': 'false' }, '›');
          if (!children?.childElementCount) { expand.disabled = true; expand.setAttribute('aria-hidden', 'true'); expand.tabIndex = -1; }
          else {
            children.id = `readerOutline-${context.generation}-${outlineId}`; children.hidden = true;
            expand.setAttribute('aria-controls', children.id);
            expand.addEventListener('click', () => { children.hidden = !children.hidden; expand.setAttribute('aria-expanded', String(!children.hidden)); expand.setAttribute('aria-label', children.hidden ? '展开子目录' : '收起子目录'); });
          }
          const title = String(item.title || '未命名章节').replace(/\s+/g, ' ').slice(0, 500);
          const jump = node('button', { type: 'button', class: 'reader-outline-jump' }, title);
          jump.title = title;
          if (item.dest == null) {
            if (children?.childElementCount) jump.addEventListener('click', () => expand.click());
            else { jump.disabled = true; if (item.url) jump.title = `${title}（外部链接）`; }
          } else jump.addEventListener('click', async () => {
            if (!same(context)) return;
            jump.disabled = true;
            try {
              const page = await resolveOutlinePage(context.pdf, item.dest);
              if (!same(context)) return;
              if (page) goToPage(page);
              else toast('此目录项没有有效的页码。');
            } catch (_) { if (same(context)) toast('无法定位这个目录项，请使用页码或搜索。'); }
            finally { if (jump.isConnected) jump.disabled = false; }
          });
          line.append(expand, jump); row.append(line); if (children?.childElementCount) row.append(children); list.append(row);
        }
        return list;
      };
      const list = render(items);
      outlineList.replaceChildren(list);
      outlineStatus.textContent = count ? (cut ? '目录较大，显示前 2000 项及 16 层目录。' : '点击章节跳转；使用箭头展开子目录。') : '此 PDF 没有内置目录，可使用搜索或添加书签。';
      outlineSearch.hidden = count > 0;
    } catch (_) {
      if (!same(context)) return;
      context.outlineLoaded = false;
      outlineStatus.textContent = '目录读取失败。关闭后重试，或使用搜索定位内容。'; outlineSearch.hidden = false;
    }
  }

  function setSaveStatus(context = current) {
    if (!context || !same(context)) return;
    retrySave.hidden = !context.saveError || !context.canPersist;
    saveStatus.classList.toggle('reader-error', Boolean(context.saveError));
    if (context.saveError) saveStatus.textContent = context.saveError;
    else if (!context.canPersist) saveStatus.textContent = '临时记录，关闭前请导出';
    else if (context.savedRevision < context.revision) saveStatus.textContent = '正在保存…';
    else saveStatus.textContent = '已保存在本机';
  }
  function queueSave(context, force = false) {
    if (!context) return Promise.resolve();
    clearTimeout(context.saveTimer);
    if (!context.canPersist || !context.id || (!force && context.queuedRevision >= context.revision)) { setSaveStatus(context); return context.saveChain; }
    const revision = context.revision;
    const edits = structuredClone([...context.edits.values()]);
    context.queuedRevision = revision;
    context.saveChain = context.saveChain.catch(() => {}).then(async () => {
      try {
        const write = async () => {
          // Merge only this viewer's edits so another open reader's unrelated notes survive.
          const pending = edits.filter((edit) => edit.revision > context.savedRevision);
          const latest = await library.loadState(context.id, 'reading');
          const merged = mergeReadingEdits(latest, pending, context.pdf.numPages);
          const result = await library.saveState(context.id, 'reading', merged);
          if (result === false || result?.saved === false) {
            context.canPersist = false; context.saveError = '文档已移除，记录未写入；请导出备份。';
          } else {
            context.savedRevision = Math.max(context.savedRevision, revision); context.saveError = '';
            const newer = [...context.edits.values()].filter((edit) => edit.revision > revision);
            context.data = mergeReadingEdits(merged, newer, context.pdf.numPages);
            for (const [key, edit] of context.edits) if (edit.revision <= revision) context.edits.delete(key);
            if (same(context)) { updateBookmarkButtons(); syncNoteEditor(); renderBookmarks(); }
          }
        };
        if (globalThis.navigator?.locks?.request) await navigator.locks.request(`pdf-reading-state:${context.id}`, write);
        else await write();
      } catch (_) { context.saveError = '保存失败，请重试或导出备份。'; }
      setSaveStatus(context);
    });
    setSaveStatus(context);
    return context.saveChain;
  }
  function changed(kind, page, immediate = false) {
    const context = current;
    if (!context) return;
    context.revision++; context.saveError = '';
    const value = (kind === 'bookmark' ? context.data.bookmarks : context.data.notes).find((item) => item.page === page) || null;
    context.edits.set(`${kind}:${page}`, { revision: context.revision, kind, page, value: value ? structuredClone(value) : null });
    clearTimeout(context.saveTimer);
    if (immediate) void queueSave(context);
    else context.saveTimer = setTimeout(() => void queueSave(context), 300);
    setSaveStatus(context);
  }
  function updateBookmarkButtons() {
    if (!current) return;
    const exists = current.data.bookmarks.some((item) => item.page === state.currentPage);
    const label = `${exists ? '移除' : '添加'}第 ${state.currentPage} 页书签`;
    toggleBookmark.textContent = label;
    toggleBookmark.setAttribute('aria-pressed', String(exists));
    if (bookmarkButton) {
      bookmarkButton.title = `${label} (Ctrl+D)`;
      bookmarkButton.setAttribute('aria-label', label);
      bookmarkButton.setAttribute('aria-pressed', String(exists));
      bookmarkButton.classList.toggle('active', exists);
    }
  }
  function togglePageBookmark(page = state.currentPage) {
    if (!available() || !Number.isInteger(page) || page < 1 || page > state.numPages) return;
    const existing = current.data.bookmarks.findIndex((item) => item.page === page);
    if (existing >= 0) current.data.bookmarks.splice(existing, 1);
    else {
      if (current.data.bookmarks.length >= MAX_RECORDS) { toast('书签已达到 1000 条，请先导出并清理。'); return; }
      current.data.bookmarks.push({ page, createdAt: Date.now() }); current.data.bookmarks.sort((a, b) => a.page - b.page);
    }
    changed('bookmark', page, true); updateBookmarkButtons(); renderBookmarks();
    toast(existing >= 0 ? `已移除第 ${page} 页书签` : `已添加第 ${page} 页书签`, 1800);
  }
  function syncNoteEditor(page = current?.notePage) {
    if (!current) return;
    current.notePage = Math.min(Math.max(1, Number(page) || state.currentPage), state.numPages);
    const value = current.data.notes.find((item) => item.page === current.notePage)?.text || '';
    if (noteInput.value !== value) noteInput.value = value;
    noteLabel.textContent = `第 ${current.notePage} 页笔记`;
    noteCount.textContent = `${value.length} / ${MAX_NOTE}`;
    currentNote.hidden = current.notePage === state.currentPage;
    currentNote.textContent = `切换至第 ${state.currentPage} 页`;
    setSaveStatus();
  }
  function renderBookmarks() {
    if (!current) return;
    const pages = [...new Set([...current.data.bookmarks.map((item) => item.page), ...current.data.notes.map((item) => item.page)])].sort((a, b) => a - b);
    const filter = bookmarkFilter.value.trim().toLowerCase();
    const filtered = pages.filter((page) => !filter || `第 ${page} 页 ${current.data.notes.find((item) => item.page === page)?.text || ''}`.toLowerCase().includes(filter));
    bookmarkCount.textContent = pages.length ? (filtered.length > 300 ? `共 ${filtered.length} 条，显示前 300 条，请筛选查找。` : `${filter ? '匹配 ' : '共 '}${filtered.length} 页记录`) : '暂无记录。添加书签或在当前页写笔记。';
    exportNotes.disabled = !pages.length;
    const rows = [];
    for (const page of filtered.slice(0, 300)) {
      const row = node('li', { class: 'reader-bookmark-row' });
      const note = current.data.notes.find((item) => item.page === page);
      const bookmark = current.data.bookmarks.some((item) => item.page === page);
      const jump = node('button', { type: 'button', class: 'reader-bookmark-jump', 'aria-label': `前往第 ${page} 页${note ? '并编辑笔记' : ''}` });
      jump.append(node('strong', {}, `第 ${page} 页${bookmark ? ' · 书签' : ''}`));
      if (note) jump.append(node('span', {}, note.text.replace(/\s+/g, ' ').slice(0, 110)));
      jump.addEventListener('click', () => {
        goToPage(page); current.notePinned = true; syncNoteEditor(page);
        if (note) noteInput.focus({ preventScroll: true });
      });
      const actions = node('div', { class: 'reader-bookmark-row-actions' });
      if (bookmark) {
        const remove = node('button', { type: 'button', class: 'quiet', 'aria-label': `移除第 ${page} 页书签` }, '移除书签');
        remove.addEventListener('click', () => togglePageBookmark(page)); actions.append(remove);
      }
      if (note) {
        const remove = node('button', { type: 'button', class: 'quiet', 'aria-label': `删除第 ${page} 页笔记` }, '删除笔记');
        remove.addEventListener('click', () => {
          if (!window.confirm(`删除第 ${page} 页的笔记？此操作无法撤销，可先导出记录。`)) return;
          current.data.notes = current.data.notes.filter((item) => item.page !== page);
          changed('note', page, true); syncNoteEditor(); renderBookmarks();
        }); actions.append(remove);
      }
      row.append(jump, actions); rows.push(row);
    }
    bookmarkList.replaceChildren(...rows);
  }

  function clearHighlights() {
    globalThis.CSS?.highlights?.delete('reader-find'); globalThis.CSS?.highlights?.delete('reader-find-active');
    for (const entry of state.entries.values()) entry.container?.querySelector('.reader-find-layer')?.remove();
  }
  function rangesFor(entry, result) {
    const ranges = [];
    const spans = entry.layer?.children;
    if (!spans || !entry.layer.isConnected) return ranges;
    for (const part of result.ranges) {
      const text = spans[part.span]?.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE || part.start >= part.end || part.end > text.length) continue;
      const range = document.createRange(); range.setStart(text, part.start); range.setEnd(text, part.end); ranges.push(range);
    }
    return ranges;
  }
  function decorate() {
    clearHighlights();
    if (!current || !search.results.length) return;
    const all = [], selected = [];
    for (const entry of state.entries.values()) {
      const matches = search.results.filter((result) => result.page === entry.n);
      if (!matches.length || !entry.layer?.isConnected) continue;
      const fallback = !globalThis.Highlight || !globalThis.CSS?.highlights ? node('div', { class: 'reader-find-layer', 'aria-hidden': 'true' }) : null;
      const bounds = fallback ? entry.container.getBoundingClientRect() : null;
      for (const result of matches) {
        const active = search.results[search.active] === result;
        const ranges = rangesFor(entry, result);
        (active ? selected : all).push(...ranges);
        if (fallback) for (const range of ranges) for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const mark = node('i', { class: `reader-find-box${active ? ' active' : ''}` });
          Object.assign(mark.style, { left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, height: `${rect.height}px` }); fallback.append(mark);
        }
      }
      if (fallback?.childElementCount) entry.container.append(fallback);
    }
    if (globalThis.Highlight && globalThis.CSS?.highlights) {
      CSS.highlights.set('reader-find', new Highlight(...all)); CSS.highlights.set('reader-find-active', new Highlight(...selected));
    }
  }
  function renderSearchStatus() {
    const count = search.results.length;
    cancelSearch.hidden = !search.running; searchProgress.hidden = !search.running;
    searchProgress.max = state.numPages || 1; searchProgress.value = search.processed;
    previousResult.disabled = nextResult.disabled = !count;
    searchPosition.textContent = count ? `${search.active >= 0 ? search.active + 1 : '—'} / ${count}${search.limited ? '+' : ''}` : '';
    if (!search.query) searchStatus.textContent = '输入关键词后搜索。';
    else if (search.running) searchStatus.textContent = `正在搜索 ${search.processed} / ${state.numPages} 页，已找到 ${count} 处。`;
    else {
      const warnings = [search.skipped ? `${search.skipped} 页读取失败` : '', search.truncated ? `${search.truncated} 页文字过长，仅搜索前 40 万字` : ''].filter(Boolean);
      const summary = search.limited ? `显示前 ${MAX_RESULTS} 处结果，请缩小关键词继续查找。` : search.cancelled ? `已停止，搜索了 ${search.processed} / ${state.numPages} 页，找到 ${count} 处。` : count ? `共找到 ${count} 处。` : search.hasText ? '未找到匹配内容。' : '未找到文字。此文档可能是扫描件，需要先进行 OCR。';
      searchStatus.textContent = `${summary}${warnings.length ? ` ${warnings.join('；')}，结果可能不完整。` : ''}`;
    }
  }
  function appendSearchResults(results) {
    for (const result of results) {
      const index = search.results.length;
      search.results.push(result);
      const row = node('li'), jump = node('button', { type: 'button', class: 'reader-result', 'aria-label': `第 ${result.page} 页：${result.match}` });
      jump.append(node('strong', {}, `第 ${result.page} 页`));
      const excerpt = node('span', { class: 'reader-excerpt' });
      excerpt.append(document.createTextNode(result.before), node('mark', {}, result.match), document.createTextNode(result.after)); jump.append(excerpt);
      jump.addEventListener('click', () => void selectResult(index)); row.append(jump); searchResults.append(row);
    }
  }
  async function selectResult(index) {
    if (!available() || !search.results.length) return;
    search.active = (index + search.results.length) % search.results.length;
    const result = search.results[search.active], context = current, token = searchToken;
    for (const [n, button] of [...searchResults.querySelectorAll('button')].entries()) {
      button.classList.toggle('active', n === search.active);
      if (n === search.active) button.setAttribute('aria-current', 'true'); else button.removeAttribute('aria-current');
    }
    renderSearchStatus(); goToPage(result.page); decorate();
    for (let attempt = 0; attempt < 70; attempt++) {
      if (!same(context) || token !== searchToken || search.results[search.active] !== result) return;
      const entry = state.entries.get(result.page);
      if (entry?.layer?.isConnected && entry.rendered) {
        decorate();
        const range = rangesFor(entry, result)[0];
        const viewport = document.getElementById('viewport');
        const rect = range?.getBoundingClientRect(), view = viewport?.getBoundingClientRect();
        if (rect?.height && view) viewport.scrollBy({ top: rect.top - view.top - Math.max(50, view.height * 0.3), behavior: 'smooth' });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  function cancelFind(clear = false) {
    searchToken++; search.running = false; search.cancelled = Boolean(search.query);
    if (clear) { search = emptySearch(); searchResults.replaceChildren(); clearHighlights(); }
    renderSearchStatus();
  }
  async function runSearch(navigate = false) {
    if (!available()) return;
    const query = searchInput.value.trim().slice(0, 200);
    if (!query) { cancelFind(true); return; }
    if (query === search.query && !search.cancelled) { if (navigate && search.results.length) await selectResult(search.active + 1); return; }
    const context = current, token = ++searchToken;
    search = { ...emptySearch(), query, running: true }; searchResults.replaceChildren(); clearHighlights(); renderSearchStatus();
    for (let n = 1; n <= context.pdf.numPages; n++) {
      if (!same(context) || token !== searchToken) return;
      try {
        let index = context.cache.get(n);
        if (index) { context.cache.delete(n); context.cache.set(n, index); }
        else {
          const page = await context.pdf.getPage(n);
          if (!same(context) || token !== searchToken) return;
          const content = await page.getTextContent();
          if (!same(context) || token !== searchToken) return;
          index = buildSearchPage(content.items);
          context.cache.set(n, index); context.cacheText += index.text.length;
          while (context.cache.size > 40 || context.cacheText > MAX_CACHE_TEXT) {
            const key = context.cache.keys().next().value;
            const removed = context.cache.get(key); context.cache.delete(key); context.cacheText -= removed.text.length;
          }
        }
        search.hasText ||= Boolean(index.text.trim());
        if (index.truncated) search.truncated++;
        const matches = findPageMatches(index, query, MAX_RESULTS - search.results.length).map((result) => ({ ...result, page: n }));
        appendSearchResults(matches);
      } catch (_) { if (!same(context) || token !== searchToken) return; search.skipped++; }
      search.processed = n; renderSearchStatus(); decorate();
      if (search.results.length >= MAX_RESULTS) { search.limited = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!same(context) || token !== searchToken) return;
    search.running = false; renderSearchStatus();
    if (navigate && search.results.length) await selectResult(0);
  }

  let inputTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(inputTimer); cancelFind(true);
    if (searchInput.value.trim()) inputTimer = setTimeout(() => void runSearch(), 220);
  });
  searchForm.addEventListener('submit', (event) => { event.preventDefault(); clearTimeout(inputTimer); void runSearch(true); });
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && searchInput.value.trim() === search.query && search.results.length) {
      event.preventDefault(); clearTimeout(inputTimer); void selectResult(search.active + (event.shiftKey ? -1 : 1));
    }
  });
  previousResult.addEventListener('click', () => void selectResult(search.active < 0 ? search.results.length - 1 : search.active - 1));
  nextResult.addEventListener('click', () => void selectResult(search.active + 1));
  cancelSearch.addEventListener('click', () => { clearTimeout(inputTimer); cancelFind(); });
  closeButton.addEventListener('click', () => close());
  for (const [name, button] of Object.entries(buttons)) {
    button?.setAttribute('aria-controls', sidebar.id);
    button?.setAttribute('aria-expanded', 'false');
    button?.addEventListener('click', () => !sidebar.hidden && activePanel === name ? close() : open(name, button));
  }
  bookmarkButton?.addEventListener('click', () => togglePageBookmark());
  toggleBookmark.addEventListener('click', () => togglePageBookmark());
  currentNote.addEventListener('click', () => { if (current) { current.notePinned = true; syncNoteEditor(state.currentPage); noteInput.focus({ preventScroll: true }); } });
  bookmarkFilter.addEventListener('input', renderBookmarks);
  noteInput.addEventListener('focus', () => { if (current) current.notePinned = true; });
  noteInput.addEventListener('input', () => {
    if (!available()) return;
    const page = current.notePage, value = noteInput.value.slice(0, MAX_NOTE);
    const existing = current.data.notes.findIndex((item) => item.page === page);
    if (value.trim()) {
      if (existing < 0 && current.data.notes.length >= MAX_RECORDS) { toast('笔记已达到 1000 页，请先导出并清理。'); syncNoteEditor(); return; }
      const record = { page, text: value, updatedAt: Date.now() };
      if (existing >= 0) current.data.notes[existing] = record; else current.data.notes.push(record);
      current.data.notes.sort((a, b) => a.page - b.page);
    } else if (existing >= 0) current.data.notes.splice(existing, 1);
    noteCount.textContent = `${value.length} / ${MAX_NOTE}`;
    changed('note', page); renderBookmarks();
  });
  noteInput.addEventListener('blur', () => void queueSave(current));
  retrySave.addEventListener('click', () => void queueSave(current, true));
  exportNotes.addEventListener('click', () => {
    if (!current) return;
    const blob = new Blob([buildReadingMarkdown(current, current.data)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = node('a', { href: url, download: `${String(current.name || 'PDF').replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100)}-阅读记录.md` });
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('阅读记录已导出，不包含 PDF 文件本身。');
  });
  document.addEventListener('keydown', (event) => {
    if (!available() || document.querySelector('dialog[open]') || event.altKey) return;
    const typing = event.target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.isComposing) {
      if (event.key.toLowerCase() === 'f' && (!typing || event.target === searchInput)) { event.preventDefault(); event.stopPropagation(); open('search'); }
      else if (event.key.toLowerCase() === 'd' && !typing) { event.preventDefault(); event.stopPropagation(); togglePageBookmark(); }
    } else if (event.key === 'Escape' && !sidebar.hidden && document.getElementById('card')?.hidden !== false) {
      event.preventDefault(); event.stopPropagation(); close();
    } else if (tabs.contains(event.target) && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const names = Object.keys(tabButtons), at = names.indexOf(activePanel);
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? names.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + names.length) % names.length;
      open(names[target], event.target);
    }
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) void queueSave(current); });
  window.addEventListener('pagehide', () => void queueSave(current));
  enable(false); syncTabs();

  return {
    open, close, decorate,
    async loaded(record) {
      if (!state.pdf) { enable(false); return; }
      const context = {
        generation: ++generation, pdf: state.pdf, id: record?.id || '', name: record?.name || document.getElementById('docName')?.textContent || 'PDF',
        data: normalizeReadingState(null, state.numPages), revision: 0, queuedRevision: 0, savedRevision: 0,
        saveChain: Promise.resolve(), edits: new Map(), canPersist: Boolean(record?.id && library?.loadState && library?.saveState), saveError: '', notePage: state.currentPage,
        notePinned: false, cache: new Map(), cacheText: 0, outlineLoaded: false
      };
      current = context; enable(false); bookmarkFilter.value = ''; noteInput.value = ''; outlineList.replaceChildren();
      clearTimeout(inputTimer); searchInput.value = ''; cancelFind(true);
      if (context.canPersist) {
        try {
          const stored = await library.loadState(context.id, 'reading');
          if (!same(context)) return;
          context.data = normalizeReadingState(stored, state.numPages);
        } catch (_) { context.canPersist = false; context.saveError = '读取记录失败，本次仅作临时记录；请导出备份。'; }
      }
      if (!same(context)) return;
      enable(true); updateBookmarkButtons(); syncNoteEditor(); renderBookmarks();
      if (!sidebar.hidden && activePanel === 'outline') void loadOutline(context);
    },
    async beforeClose() {
      clearTimeout(inputTimer); cancelFind(true);
      const previous = current;
      if (previous) clearTimeout(previous.saveTimer);
      current = null; generation++; enable(false); close(false); clearHighlights();
      await queueSave(previous, Boolean(previous?.saveError));
    },
    async flush() {
      const context = current;
      await queueSave(context, Boolean(context?.saveError));
      if (context?.saveError || (context && context.revision > context.savedRevision)) throw new Error('书签或笔记尚未保存，请重试或单独导出记录。');
    },
    hasUnsaved() { return Boolean(current && current.revision > current.savedRevision); },
    pageChanged() {
      if (!available()) return;
      updateBookmarkButtons();
      if (!current.notePinned && document.activeElement !== noteInput) syncNoteEditor(state.currentPage);
      else syncNoteEditor(current.notePage);
    }
  };
}
