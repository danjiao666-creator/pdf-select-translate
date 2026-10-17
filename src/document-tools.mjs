import { library, digest } from './library.mjs';
import { LAYOUT_VERSION, extractPageLayout, finalizeDocumentLayout, translationPlacement, paintTranslations } from './pdf-layout.mjs';
import { createImagePdf } from './pdf-export.mjs';
import { createLibraryBackup, parseLibraryBackup } from './library-backup.mjs';

const $ = (id) => document.getElementById(id);
const language = (code) => ({ 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español', ru: 'Русский' }[code] || code);
const engineName = (engine) => ({ custom: '自定义 API', auto: '自动免费引擎', google: 'Google', microsoft: 'Microsoft', youdao: '有道', mymemory: 'MyMemory' }[engine] || engine);
const make = (tag, className, text) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };

export function createDocumentTools({ state, pdfjsLib, send, openData, goToPage, applyScale, fitScale, toast, closeCard, onRemoved = () => {} }) {
  let current = null, job = null, contextVersion = 0, hydration = 0;
  let running = false, pauseRequested = false, preparing = false, exporting = false, acquiring = false;
  let checkpointTimer, positionTimer, savedSignature = '', persistenceFailed = false;
  let revision = 0, savedRevision = 0;
  let writeQueue = Promise.resolve();
  let listVersion = 0, backingUp = false;
  const measure = document.createElement('canvas').getContext('2d');

  function settingsSnapshot() {
    const s = state.settings, c = s.custom || {};
    const hasCustom = c.apiKeyConfigured || c.apiKey || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(c.baseUrl || '');
    const engine = s.engine === 'auto' && hasCustom ? 'custom' : s.engine;
    return { layoutVersion: LAYOUT_VERSION, engine, target: s.targetLang, source: s.sourceLang || 'auto',
      custom: engine === 'custom' ? { baseUrl: c.baseUrl, model: c.model, extraBody: c.extraBody, prompt: c.prompt } : undefined };
  }

  function allBlocks(record = job) { return record ? record.pages.flatMap((page, i) => page.blocks.map((block) => ({ page: i + 1, block }))) : []; }
  function recount(record = job) {
    const blocks = allBlocks(record).map((entry) => entry.block).filter((b) => b.status !== 'preserved');
    record.total = blocks.length; record.done = blocks.filter((b) => b.status === 'done').length;
    record.failed = blocks.filter((b) => b.status === 'error').length;
    record.unfitted = blocks.filter((b) => b.status === 'done' && b.unfitted).length;
  }

  function changed() { revision++; }
  async function persist(record = job, { strict = false } = {}) {
    clearTimeout(checkpointTimer);
    if (!record || !current) return;
    if (record === job && savedRevision >= revision && !persistenceFailed) { await writeQueue; return; }
    const capturedRevision = revision;
    const snapshot = structuredClone(record);
    if (snapshot.status === 'running') snapshot.status = 'paused';
    const write = writeQueue.catch(() => {}).then(async () => {
      if (await library.saveTranslation(snapshot) === false) throw new Error('文档已在另一窗口删除，请先导出当前译文。');
    });
    writeQueue = write.catch(() => {});
    try {
      await write;
      if (record === job) { savedRevision = Math.max(savedRevision, capturedRevision); persistenceFailed = false; status(); }
    } catch (error) {
      if (record === job) {
        if (!persistenceFailed) toast('译文尚未保存，请留在当前文档，检查存储空间后重试；也可先导出已完成的译文。');
        persistenceFailed = true; status();
      }
      if (strict) throw new Error(`全文译文未能保存：${error.message || '请检查本地存储空间。'}`);
    }
  }
  function checkpoint() { clearTimeout(checkpointTimer); checkpointTimer = setTimeout(() => { void persist().then(() => { if (document.body.dataset.view === 'library') void list(); }); }, 300); }
  async function savePosition() {
    clearTimeout(positionTimer);
    if (!current) return;
    try { await library.patch(current.id, { page: state.currentPage, mode: state.documentMode, lastOpened: Date.now(), scale: state.scale, fit: state.fit, fitMode: state.fitMode }); }
    catch (_) { /* A read-only session remains usable if browser storage is full. */ }
  }

  function status() {
    state.isDocumentBusy = running || preparing || exporting || acquiring || backingUp;
    $('openFullTranslation').disabled = !state.pdf || preparing || acquiring || !current;
    $('documentTranslationBar').hidden = !job && !preparing;
    $('pauseDocumentTranslation').hidden = !running;
    $('pauseDocumentTranslation').disabled = pauseRequested;
    $('pauseDocumentTranslation').textContent = pauseRequested ? '暂停中…' : '暂停';
    $('resumeDocumentTranslation').hidden = !job || running || preparing || job.done === job.total;
    $('resumeDocumentTranslation').textContent = job?.failed ? '重试未完成段落' : '继续翻译';
    $('exportTranslatedPdf').disabled = exporting || running || preparing || !job?.total || job.done !== job.total;
    $('retryTranslationSave').hidden = !persistenceFailed;
    $('exportTranslationText').disabled = !job?.done;
    let text = preparing ? '正在分析 PDF 文字与段落…' : '';
    if (job) {
      text = `${language(job.target)} · ${engineName(job.engine)} · ${job.done} / ${job.total} 段`;
      if (preparing) text = '正在分析 PDF 文字与段落…';
      else if (pauseRequested && running) text += ' · 等待已发送请求结束';
      else if (running) text += ' · 翻译中';
      else if (!job.total) text = '无可翻译文字；扫描页、公式和旋转文字保留原文';
      else if (job.done === job.total) text += ' · 已完成';
      else text += job.failed ? ` · ${job.failed} 段失败，可重试` : ' · 已暂停';
      if (job.unfitted) text += ` · ${job.unfitted} 段无法安全排入原位，点击虚线段落查看`;
      const preserved = job.pages.reduce((n, p) => n + p.unplaced + p.blocks.filter((b) => b.status === 'preserved').length, 0);
      if (preserved && job.total) text += ` · ${preserved} 处保留原文`;
      const scanned = job.pages.filter((p) => !p.textItems).length;
      if (scanned && job.total) text += ` · ${scanned} 页无文字层，未翻译`;
      if (persistenceFailed) text += ' · 尚未保存';
    }
    $('documentTranslationStatus').textContent = text;
    const lastError = job?.lastError || '';
    $('documentTranslationError').hidden = !lastError && !persistenceFailed;
    $('documentTranslationError').textContent = persistenceFailed ? '本地保存失败，译文暂留在当前窗口。请检查存储空间后重试保存，或先导出已完成的译文；不要直接关闭。' : /401|403/.test(lastError) ? 'API 鉴权失败，请检查设置中的 API Key 与接口地址（HTTP 401/403）。' : lastError ? `最近一次错误：${lastError}` : '';
    $('documentTranslationProgress').max = job?.total || 1;
    $('documentTranslationProgress').value = job?.done || 0;
    for (const button of document.querySelectorAll('[data-mode]')) button.classList.toggle('active', button.dataset.mode === state.documentMode);
  }

  function paragraph(block) {
    $('paragraphSource').textContent = block.text;
    $('paragraphTranslation').textContent = block.translation || (block.error ? `翻译失败：${block.error}` : '该段尚未翻译。');
    $('copyParagraph').disabled = !block.translation;
    if (!$('paragraphDialog').open) $('paragraphDialog').showModal();
  }

  function decorate(entry) {
    entry.container.querySelector('.translation-layer')?.remove();
    entry.row?.querySelector('.original-reference')?.remove();
    if (!entry.rendered || state.documentMode === 'original') return;
    if (state.documentMode === 'compare') {
      const reference = make('div', 'original-reference');
      reference.style.width = entry.container.style.width; reference.style.height = entry.container.style.height;
      const copy = document.createElement('canvas'); copy.width = entry.canvas.width; copy.height = entry.canvas.height;
      copy.getContext('2d').drawImage(entry.canvas, 0, 0); reference.append(copy); entry.row.prepend(reference);
    }
    const page = job?.pages[entry.n - 1];
    if (!page) return;
    const layer = make('div', 'translation-layer');
    const canvas = document.createElement('canvas'); canvas.width = entry.canvas.width; canvas.height = entry.canvas.height;
    canvas.getContext('2d').drawImage(entry.canvas, 0, 0);
    const placements = paintTranslations(canvas, page, entry.canvas);
    layer.append(canvas);
    for (const { block, layout } of placements) {
      const button = make('button', `translation-hit${layout ? '' : ' unfitted'}`, block.translation);
      button.type = 'button'; button.title = layout ? '查看段落对照' : '为避免覆盖公式、图表或缩成小字，此段保留原文；点击查看完整译文';
      button.setAttribute('aria-label', `${button.title}：${block.translation}`);
      Object.assign(button.style, { left: `${block.x / page.width * 100}%`, top: `${block.y / page.height * 100}%`, width: `${block.width / page.width * 100}%`, height: `${block.height / page.height * 100}%` });
      button.addEventListener('click', () => paragraph(block)); layer.append(button);
    }
    entry.container.append(layer);
  }
  function decorateAll() { for (const entry of state.entries.values()) decorate(entry); }
  function setMode(mode) {
    state.documentMode = mode;
    document.body.dataset.documentMode = mode;
    closeCard(); decorateAll();
    if (state.fit && state.pdf) applyScale(fitScale(), true);
    status(); void savePosition();
  }

  async function hydrate() {
    const version = ++hydration;
    if (!current) return;
    const signature = JSON.stringify(settingsSnapshot());
    const key = `${current.id}:${await digest(new TextEncoder().encode(signature))}`;
    const loaded = await library.loadTranslation(key);
    if (version !== hydration || !current) return;
    savedSignature = signature;
    job = loaded || null;
    revision = 0; savedRevision = 0; persistenceFailed = false;
    if (job) {
      for (const { block } of allBlocks()) if (block.status === 'working') block.status = 'pending';
      recount(); if (job.status === 'running') job.status = 'paused';
    }
    status(); decorateAll();
  }

  async function list() {
    const version = ++listVersion;
    try {
      const rows = await library.list();
      if (version !== listVersion) return;
      const search = $('librarySearch').value.trim().toLocaleLowerCase();
      const filtered = rows.filter((row) => row.name.toLocaleLowerCase().includes(search));
      const sort = $('librarySort')?.value || 'recent';
      filtered.sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : sort === 'added' ? (a, b) => b.addedAt - a.addedAt : (a, b) => b.lastOpened - a.lastOpened);
      $('libraryCount').textContent = `${rows.length} 份文档`;
      if ($('backupScope')) {
        const selected = $('backupScope').value;
        $('backupScope').replaceChildren(new Option('全部文档', ''), ...rows.map((record) => new Option(record.name, record.id)));
        if (rows.some((record) => record.id === selected)) $('backupScope').value = selected;
      }
      $('libraryList').replaceChildren();
      $('libraryEmpty').hidden = filtered.length > 0;
      $('libraryEmpty').querySelector('strong').textContent = rows.length ? '没有匹配的文档' : '暂无文档';
      for (const record of filtered) {
        const row = make('div', 'library-row'); row.dataset.documentId = record.id;
        const open = make('button', 'library-document');
        const size = record.size < 1024 * 1024 ? `${Math.max(1, Math.round(record.size / 1024))} KB` : `${(record.size / 1024 / 1024).toFixed(1)} MB`;
        open.append(make('strong', '', record.name), make('small', '', `${record.numPages} 页 · ${size} · 上次读到第 ${record.page} 页 · ${new Date(record.lastOpened).toLocaleDateString()}`));
        open.addEventListener('click', () => { void openSaved(record.id); });
        const translation = record.translation;
        const label = make('span', 'library-translation', translation ? translation.layoutVersion === LAYOUT_VERSION ? `${language(translation.target)} · ${translation.done}/${translation.total} 段` : '旧版译文，打开后需重新翻译' : '未全文翻译');
        const rename = make('button', 'library-rename', '重命名');
        rename.addEventListener('click', () => {
          $('renameInput').value = record.name;
          $('renameDocumentDialog').dataset.documentId = record.id;
          $('renameDocumentDialog').showModal(); $('renameInput').focus(); $('renameInput').select();
        });
        const remove = make('button', 'quiet', '删除');
        remove.title = '仅删除文档库中的副本与译文，原文件不受影响';
        remove.addEventListener('click', async () => {
          if (!window.confirm(`从文档库删除「${record.name}」？\n将删除本地副本、译文、书签、笔记和对话，磁盘原文件不受影响。建议先备份。`)) return;
          const wasCurrent = current?.id === record.id;
          try {
            await library.remove(record.id);
            if (wasCurrent) { await beforeClose({ discard: true }); await onRemoved(record.id); }
            await list();
          }
          catch (error) { toast(`删除失败：${error.message}`); }
        });
        row.append(open, label, rename, remove); $('libraryList').append(row);
      }
      void storageStatus();
    } catch (error) { showLibraryError(`无法读取文档库：${error.message}`); }
  }

  function showLibraryError(text) { $('libraryError').hidden = false; $('libraryError').textContent = text; }
  async function storageStatus() {
    if (!$('libraryStorage')) return;
    try {
      const info = await navigator.storage?.estimate();
      const usage = info?.usage ? `本地已使用 ${(info.usage / 1048576).toFixed(1)} MB` : '文档保存在本机';
      const persistent = await navigator.storage?.persisted?.();
      $('libraryStorage').textContent = `${usage}${persistent ? ' · 已申请持久存储' : ' · 建议定期备份'} · 插件与应用可通过备份文件迁移`;
    } catch (_) { $('libraryStorage').textContent = '建议定期备份；插件与应用可通过备份文件迁移。'; }
  }
  async function showLibrary() {
    await savePosition();
    document.body.dataset.view = 'library'; $('empty').hidden = false;
    $('emptyClose').hidden = !state.pdf; $('docName').textContent = '文档库';
    closeCard(); await list();
    const params = new URLSearchParams(location.search); params.delete('file'); params.delete('url'); params.delete('document'); params.delete('page');
    history.replaceState(null, '', location.pathname + (params.size ? `?${params}` : ''));
  }

  function showReader() {
    document.body.dataset.view = 'reader'; $('empty').hidden = true;
    if (current) {
      $('docName').textContent = current.name;
      const params = new URLSearchParams(location.search); params.set('document', current.id);
      history.replaceState(null, '', `${location.pathname}?${params}`);
    }
  }

  async function openSaved(id) {
    try {
      const record = await library.get(id);
      if (!record?.data) throw new Error('本地副本不存在，请重新导入 PDF。');
      await openData(await record.data.arrayBuffer(), record.name, record);
    } catch (error) { await showLibrary(); showLibraryError(`无法打开文档：${error.message}`); }
  }

  async function beforeClose({ discard = false } = {}) {
    const version = ++contextVersion; hydration++;
    pauseRequested = true; running = false; preparing = false; acquiring = false;
    if (job?.status === 'running') { job.status = 'paused'; changed(); }
    if (discard) { clearTimeout(checkpointTimer); await writeQueue; }
    else await Promise.all([savePosition(), persist(job, { strict: true })]);
    if (version !== contextVersion) return;
    current = null; job = null;
    revision = 0; savedRevision = 0; persistenceFailed = false;
    state.documentMode = 'original'; document.body.dataset.documentMode = 'original'; status();
  }

  async function loaded(pdf, name, url, saved, isCurrent) {
    const version = contextVersion;
    try {
      const record = saved || await library.importPdf(await pdf.getData(), { name, sourceUrl: url, numPages: pdf.numPages });
      if (version !== contextVersion || !isCurrent()) return;
      current = record;
      await library.patch(record.id, { lastOpened: Date.now() });
      await hydrate();
      if (!isCurrent()) return;
      showReader();
      state.fitMode = record.fitMode === 'page' ? 'page' : 'width';
      if (typeof record.fit === 'boolean' && !record.fit && Number(record.scale) > 0) applyScale(record.scale, false);
      else if (state.fit) applyScale(fitScale(), true);
      if (record.page > 1) goToPage(record.page, false);
      if (job && record.mode && record.mode !== 'original') setMode(record.mode);
    } catch (error) {
      if (isCurrent()) toast(`PDF 已打开，但无法保存到文档库：${error.message}`);
    }
    if (isCurrent()) status();
  }

  async function prepare(version, options) {
    preparing = true; status();
    const pdf = state.pdf;
    const pages = [];
    try {
      for (let n = 1; n <= pdf.numPages; n++) {
        if (version !== contextVersion) return false;
        $('documentTranslationStatus').textContent = `正在分析第 ${n} / ${pdf.numPages} 页…`;
        const page = await pdf.getPage(n), viewport = page.getViewport({ scale: 1 });
        pages.push(extractPageLayout(await page.getTextContent(), viewport, pdfjsLib.Util.transform));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (version !== contextVersion) return false;
      finalizeDocumentLayout(pages);
      const id = `${current.id}:${await digest(new TextEncoder().encode(JSON.stringify(options)))}`;
      const firstPage = pages[0]?.blocks.filter((b) => b.status !== 'preserved') || [];
      const title = [...firstPage].sort((a, b) => b.fontSize - a.fontSize)[0]?.text || current.name;
      const abstract = firstPage.find((b) => b.text.length > 300)?.text || '';
      job = { id, documentId: current.id, layoutVersion: LAYOUT_VERSION, target: options.target, source: options.source, engine: options.engine,
        context: { title, abstract }, pages, status: 'paused', createdAt: Date.now() };
      revision = 1; savedRevision = 0; persistenceFailed = false;
      recount(); await persist(job, { strict: true }); return true;
    } finally { if (version === contextVersion) { preparing = false; status(); } }
  }

  async function runUnlocked() {
    if (running || preparing || !current || exporting) return;
    const version = contextVersion;
    const options = settingsSnapshot();
    $('fullTranslationDialog').close();
    try {
      if (!job && !await prepare(version, options)) return;
      if (version !== contextVersion) return;
      if (!job.total) { toast('未找到可翻译文字；扫描页与公式保留原文。'); return; }
      const record = job;
      const ordered = allBlocks().filter(({ block }) => block.status !== 'preserved');
      const queue = allBlocks().filter(({ block }) => block.status === 'pending' || block.status === 'error');
      if (!queue.length) { setMode('translated'); return; }
      pauseRequested = false; running = true; record.status = 'running'; delete record.lastError; status(); setMode('translated');
      let next = 0;
      const worker = async () => {
        while (!pauseRequested && version === contextVersion && next < queue.length) {
          const { block, page } = queue[next++]; block.status = 'working'; delete block.error;
          const index = ordered.findIndex((entry) => entry.block === block);
          const before = ordered.slice(Math.max(0, index - 4), index).map((entry) => entry.block);
          const documentContext = options.engine === 'custom' ? { ...record.context,
            previous: before.at(-1)?.text || '', next: ordered[index + 1]?.block.text || '',
            previousTranslation: before.findLast((b) => b.status === 'done')?.translation || '' } : undefined;
          let result;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { result = await send({ type: 'translate', text: block.text, to: options.target, from: options.source, engine: options.engine, quality: true, finalOnly: true, documentContext }); }
            catch (error) { result = { ok: false, error: error.message }; }
            if (result?.ok || !/411|429|HTTP 5\d\d|超时|Failed to fetch/i.test(result?.error || '') || attempt === 2 || pauseRequested || version !== contextVersion) break;
            await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1500));
            if (pauseRequested || version !== contextVersion) break;
          }
          if (version !== contextVersion || record !== job) return;
          if (result?.ok) {
            block.translation = result.translation; block.status = 'done'; block.engine = result.engine;
            block.unfitted = !translationPlacement(block, record.pages[page - 1], measure);
          } else {
            block.status = 'error'; block.error = result?.error || '翻译服务未响应';
            record.lastError = block.error;
            if (/401|403|411|429|余额|quota/i.test(block.error)) pauseRequested = true;
          }
          changed(); recount(); status(); checkpoint();
          const entry = state.entries.get(page); if (entry?.rendered) decorate(entry);
          if (options.engine !== 'custom') await new Promise((resolve) => setTimeout(resolve, 650));
        }
      };
      await Promise.all(Array.from({ length: options.engine === 'custom' ? 2 : 1 }, worker));
      if (version !== contextVersion || record !== job) return;
      record.status = record.done === record.total ? 'complete' : record.failed ? 'error' : 'paused';
      if (record.status === 'complete') delete record.lastError;
      changed();
      running = false; pauseRequested = false; await persist(); status();
    } catch (error) {
      if (version === contextVersion) {
        preparing = false; running = false; status(); toast(`全文翻译未完成：${error.message}`);
      }
    }
  }

  async function run() {
    if (running || preparing || acquiring || !current || exporting) return;
    acquiring = true; status();
    const version = contextVersion;
    try {
      const key = `${current.id}:${await digest(new TextEncoder().encode(JSON.stringify(settingsSnapshot())))}`;
      await navigator.locks.request(`document-translation:${key}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock) { toast('另一阅读器窗口正在翻译此文档，请在该窗口操作。'); return; }
        if (version !== contextVersion) return;
        await persist(job, { strict: true });
        await hydrate();
        if (version === contextVersion) { acquiring = false; await runUnlocked(); }
      });
    } catch (error) { toast(`无法启动全文翻译：${error.message}`); }
    finally { if (version === contextVersion) acquiring = false; status(); }
  }

  async function settingsChanged() {
    if (!current || JSON.stringify(settingsSnapshot()) === savedSignature) return;
    const version = ++contextVersion; running = false; pauseRequested = true; preparing = false;
    try { await persist(job, { strict: true }); }
    catch (error) { status(); toast(error.message); return; }
    if (version !== contextVersion) return;
    job = null; setMode('original');
    try { await hydrate(); } catch (error) { toast(`无法读取已保存译文：${error.message}`); }
  }

  async function exportPdf() {
    if (!job?.total || job.done !== job.total || exporting || running) return;
    exporting = true; status(); $('confirmExport').disabled = true;
    const pdf = state.pdf, record = job, version = contextVersion, name = current.name;
    try {
      const images = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        if (version !== contextVersion) throw new Error('文档已切换，已取消导出');
        $('exportStatus').textContent = `正在生成第 ${n} / ${pdf.numPages} 页…`;
        const page = await pdf.getPage(n), base = page.getViewport({ scale: 1 });
        const scale = Math.min(2, Math.sqrt(12000000 / (base.width * base.height)), 8192 / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        paintTranslations(canvas, record.pages[n - 1]);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .94));
        if (!blob) throw new Error('页面编码失败，请尝试较小的 PDF');
        images.push({ width: base.width, height: base.height, pixelWidth: canvas.width, pixelHeight: canvas.height, bytes: new Uint8Array(await blob.arrayBuffer()) });
        canvas.width = canvas.height = 0;
      }
      const blob = createImagePdf(images), url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = `${name.replace(/\.pdf$/i, '')}-${record.target}.pdf`;
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('exportStatus').textContent = '已生成 PDF，请查看浏览器下载列表。';
    } catch (error) { $('exportStatus').textContent = `导出失败：${error.message}`; }
    finally { exporting = false; $('confirmExport').disabled = false; status(); }
  }

  $('openLibrary').addEventListener('click', () => { void showLibrary(); });
  $('emptyClose').addEventListener('click', showReader);
  $('librarySearch').addEventListener('input', () => { void list(); });
  $('librarySort')?.addEventListener('change', () => { void list(); });
  $('renameDocumentForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = $('renameDocumentDialog').dataset.documentId, name = $('renameInput').value.trim();
    if (!name) { $('renameInput').focus(); return; }
    try {
      await library.patch(id, { name: name.slice(0, 500) });
      if (current?.id === id) { current.name = name.slice(0, 500); $('docName').textContent = document.body.dataset.view === 'library' ? '文档库' : current.name; }
      $('renameDocumentDialog').close(); await list();
    } catch (error) { toast(`重命名失败：${error.message}`); }
  });
  $('exportLibrary')?.addEventListener('click', async () => {
    if (backingUp) return;
    backingUp = true; status(); $('exportLibrary').disabled = true;
    try {
      await Promise.all([savePosition(), persist(job, { strict: true })]);
      document.dispatchEvent(new Event('library-backup-start'));
      // State owners flush before the read-only snapshot is taken.
      await state.flushReadingData?.();
      const { blob, count } = await createLibraryBackup(library, (text) => { $('libraryTransferStatus').textContent = text; }, $('backupScope').value);
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `文献翻译器-备份-${new Date().toISOString().slice(0, 10)}.zip`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('libraryTransferStatus').textContent = `已生成 ${count} 份文档的备份。含 PDF、译文、书签、笔记和对话，不含 API 设置与密钥。`;
    } catch (error) { showLibraryError(`备份失败：${error.message}`); }
    finally { backingUp = false; $('exportLibrary').disabled = false; status(); }
  });
  $('importLibrary')?.addEventListener('click', () => $('backupInput').click());
  $('backupInput')?.addEventListener('change', async () => {
    const file = $('backupInput').files[0]; $('backupInput').value = '';
    if (!file || backingUp) return;
    backingUp = true; status(); $('importLibrary').disabled = true;
    try {
      const snapshot = await parseLibraryBackup(file, (text) => { $('libraryTransferStatus').textContent = text; });
      if (!window.confirm(`恢复 ${snapshot.documents.length} 份文档及相关译文、书签、笔记和对话？\n同一文档合并；保留较新的本地记录。不修改 API 设置。`)) { $('libraryTransferStatus').textContent = '已取消恢复。'; return; }
      await state.flushReadingData?.();
      if (current) { const id = current.id; await beforeClose(); await onRemoved(id); }
      await library.restore(snapshot);
      $('libraryError').hidden = true; $('libraryTransferStatus').textContent = `已恢复 ${snapshot.documents.length} 份文档。`;
      await list();
    } catch (error) { showLibraryError(`恢复失败，文档库未被覆盖：${error.message}`); }
    finally { backingUp = false; $('importLibrary').disabled = false; status(); }
  });
  $('openFullTranslation').addEventListener('click', () => {
    const options = settingsSnapshot();
    $('fullTranslationSummary').textContent = `${state.numPages} 页 · ${language(options.target)} · ${engineName(options.engine)}${options.custom?.model ? ` / ${options.custom.model}` : ''}`;
    $('startDocumentTranslation').textContent = job?.done === job?.total && job?.total ? '查看已保存译文' : job?.done ? '继续全文翻译' : '开始全文翻译';
    $('fullTranslationError').hidden = true; $('fullTranslationDialog').showModal();
  });
  $('startDocumentTranslation').addEventListener('click', () => { void run(); });
  $('resumeDocumentTranslation').addEventListener('click', () => { void run(); });
  $('pauseDocumentTranslation').addEventListener('click', () => { pauseRequested = true; if (job) { job.status = 'paused'; changed(); } status(); void persist(); });
  $('retryTranslationSave').addEventListener('click', async () => {
    try { await persist(job, { strict: true }); toast('译文已保存到本地文档库。'); }
    catch (error) { toast(error.message); }
  });
  $('exportTranslationText').addEventListener('click', () => {
    if (!job?.done) return;
    const content = [`# ${current?.name || '文档译文'}`, '', `目标语言：${language(job.target)}；已完成 ${job.done}/${job.total} 段。`, ''];
    for (const [index, page] of job.pages.entries()) {
      content.push(`## 第 ${index + 1} 页`, '');
      for (const block of page.blocks) {
        if (block.status === 'preserved') continue;
        content.push('原文：', '', block.text, '', '译文：', '', block.translation || '（尚未完成）', '', '---', '');
      }
    }
    const url = URL.createObjectURL(new Blob([content.join('\n')], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `${(current?.name || '文档').replace(/\.pdf$/i, '')}-${job.target}.md`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => setMode(button.dataset.mode));
  $('exportTranslatedPdf').addEventListener('click', () => { $('exportStatus').textContent = ''; $('exportDialog').showModal(); });
  $('confirmExport').addEventListener('click', () => { void exportPdf(); });
  $('copyParagraph').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('paragraphTranslation').textContent); toast('译文已复制'); }
    catch (_) { toast('复制失败，请手动选择译文。'); }
  });
  $('viewport').addEventListener('scroll', () => { if (document.body.dataset.view !== 'library') { clearTimeout(positionTimer); positionTimer = setTimeout(() => { void savePosition(); }, 400); } }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { void savePosition(); void persist(); } });
  window.addEventListener('pagehide', () => { void savePosition(); void persist(); });
  document.body.dataset.documentMode = 'original';
  return { loaded, beforeClose, decorate, showLibrary, showReader, showLibraryError, openSaved, savePosition, settingsChanged,
    getCurrent: () => current, isBusy: () => running || preparing || exporting || acquiring || backingUp,
    hasUnsaved: () => Boolean(job && revision > savedRevision),
    flush: () => Promise.all([savePosition(), persist(job, { strict: true })]), refreshLibrary: list };
}
