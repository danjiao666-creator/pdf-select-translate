import { indexArticle, retrieveArticleContext, boundedChatHistory, chatMarkdown } from './chat-context.mjs';

const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const identifier = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function appendChatText(container, text, { pages = [], goToPage = () => {} } = {}) {
  const allowed = new Set(pages);
  const inline = (parent, value) => {
    const tokens = /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[(?:p\.?\s*|page\s*)(\d{1,6})\]|\[第\s*(\d{1,6})\s*页\]/gi;
    let offset = 0;
    for (const match of value.matchAll(tokens)) {
      if (match.index > offset) parent.append(document.createTextNode(value.slice(offset, match.index)));
      if (match[1]) parent.append(make('strong', '', match[1]));
      else if (match[2]) parent.append(make('code', '', match[2]));
      else {
        const page = Number(match[3] || match[4]);
        if (allowed.has(page)) {
          const button = make('button', 'chat-citation', `第 ${page} 页`);
          button.type = 'button'; button.title = `跳转到 PDF 第 ${page} 页，核对原文`;
          button.addEventListener('click', () => goToPage(page)); parent.append(button);
        } else {
          const unverified = make('span', 'chat-citation-unverified', match[0]);
          unverified.title = '此页未在本轮提供的原文中，引用未经核对'; parent.append(unverified);
        }
      }
      offset = match.index + match[0].length;
    }
    if (offset < value.length) parent.append(document.createTextNode(value.slice(offset)));
  };
  container.replaceChildren();
  let code = null, list = null, paragraph = null;
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      paragraph = null; list = null;
      if (code) code = null;
      else { const pre = make('pre', 'chat-code'); code = make('code'); pre.append(code); container.append(pre); }
      continue;
    }
    if (code) { code.append(document.createTextNode(line + '\n')); continue; }
    if (!line.trim()) { paragraph = null; list = null; continue; }
    const heading = line.match(/^#{1,5}\s+(.+)/);
    if (heading) { const node = make('h3'); inline(node, heading[1]); container.append(node); paragraph = null; list = null; continue; }
    const item = line.match(/^\s*(?:[-*]|\d+[.)、])\s+(.+)/);
    if (item) {
      if (!list) { list = make(/^\s*\d/.test(line) ? 'ol' : 'ul'); container.append(list); }
      const li = make('li'); inline(li, item[1]); list.append(li); paragraph = null; continue;
    }
    list = null;
    if (!paragraph) { paragraph = make('p'); container.append(paragraph); }
    else paragraph.append(document.createElement('br'));
    inline(paragraph, line);
  }
}

function normalizeSession(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages)) return { messages: [], draft: '', selection: null };
  const messages = value.messages.slice(-120).filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string').map((message) => ({
    id: typeof message.id === 'string' ? message.id.slice(0, 100) : identifier(), role: message.role,
    content: message.content.slice(0, 24000), createdAt: Number(message.createdAt) || Date.now(),
    status: message.role === 'user' ? 'done' : ['done', 'error', 'cancelled'].includes(message.status) ? message.status : 'cancelled',
    error: typeof message.error === 'string' ? message.error.slice(0, 1000) : '',
    evidence: Array.isArray(message.evidence) ? message.evidence.slice(0, 12).filter((item) => item && Number.isInteger(item.page) && item.page > 0 && typeof item.text === 'string').map((item) => ({ page: item.page, text: item.text.slice(0, 3200) })) : []
  }));
  const selection = value.selection && Number.isInteger(value.selection.page) && value.selection.page > 0 && typeof value.selection.text === 'string' ?
    { page: value.selection.page, text: value.selection.text.slice(0, 3000) } : null;
  return { messages, draft: typeof value.draft === 'string' ? value.draft.slice(0, 4000) : '', selection };
}

export function createArticleChat({ state, send, library, goToPage, toast = () => {}, closeCard = () => {} }) {
  const panel = document.getElementById('articleChatPanel'), toggle = document.getElementById('openArticleChat');
  if (!panel || !toggle) throw new Error('文章对话容器未初始化');
  panel.classList.add('article-chat'); panel.hidden = true; panel.setAttribute('aria-label', '文章 AI 讨论');
  panel.innerHTML = `
    <div class="chat-heading"><div><h2>文章讨论</h2><p id="chatDocumentName">请先打开 PDF</p></div><button id="chatClose" class="quiet icon" type="button" aria-label="关闭文章讨论" title="关闭讨论面板">×</button></div>
    <div class="chat-toolbar"><span id="chatModel" class="chat-model"></span><div><button id="chatExport" class="quiet" type="button" title="导出对话及引用原文">导出</button><button id="chatNew" class="quiet" type="button">新对话</button></div></div>
    <div id="chatStorageError" class="chat-error" role="alert" hidden></div>
    <div id="chatMessages" class="chat-messages" role="log" aria-label="文章讨论记录" aria-relevant="additions">
      <section id="chatWelcome" class="chat-welcome"><h3>围绕当前文章提问</h3><p>回答参考文中的相关文字，可通过页码返回原文核对。扫描页和图像中的信息无法直接识别。</p><div class="chat-starters"><button type="button" data-chat-prompt="请概括文章的研究问题、核心方法与主要发现，区分作者结论与推断，并给出原文页码。">概括核心内容 <span>↗</span></button><button type="button" data-chat-prompt="请解释这篇文章的研究方法、关键假设与验证过程，并给出相应原文页码。">梳理研究方法 <span>↗</span></button><button type="button" data-chat-prompt="请分析研究局限与适用边界。明确区分作者在原文中承认的局限和你提出的批判性推断，提供原文页码。">分析研究局限 <span>↗</span></button></div></section>
    </div>
    <button id="chatJumpLatest" class="chat-jump" type="button" hidden>回到最新消息 ↓</button>
    <div id="chatActivity" class="chat-activity" role="status" hidden></div>
    <form id="chatForm" class="chat-composer"><div id="chatSelection" class="chat-selection" hidden><div><strong id="chatSelectionPage"></strong><p id="chatSelectionText"></p></div><button id="chatRemoveSelection" class="quiet" type="button" aria-label="移除选中原文">×</button></div><label class="chat-input-label" for="chatInput">输入问题</label><textarea id="chatInput" rows="3" maxlength="4000" placeholder="提问，或选中原文后点击「问 AI」" aria-describedby="chatInputHint chatPrivacy"></textarea><div class="chat-compose-actions"><span id="chatInputHint">Enter 发送 · Shift+Enter 换行</span><button id="chatStop" type="button" hidden>停止</button><button id="chatSend" class="primary" type="submit">发送</button></div><p id="chatPrivacy" class="chat-privacy">发送问题、最近对话及本轮相关原文文字至已配置 AI，不上传 PDF 文件。可能产生 API 费用；AI 回答请核对原文。</p></form>
    <dialog id="chatResetDialog" class="chat-reset-dialog"><h2>开始新对话？</h2><p>当前文章的讨论记录将清空。需要保留时，请先导出；PDF、译文和书签不受影响。</p><div><button id="chatResetCancel" type="button">保留记录</button><button id="chatResetConfirm" class="primary" type="button">清空并开始</button></div></dialog>`;
  const $ = (id) => panel.querySelector(`#${id}`);
  const list = $('chatMessages'), input = $('chatInput'), welcome = $('chatWelcome');
  let current = null, messages = [], generation = 0, active = null, articleIndex = null, selection = null;
  let saveTimer, saveQueue = Promise.resolve(), lastSaved = '', hydration = false, storageFailed = false, persistenceBlocked = false;
  let persistenceContext = null, blockReason = '';
  const messageElements = new Map();

  function setBusy(value) { state.isChatBusy = value; panel.setAttribute('aria-busy', String(value)); updateControls(); }
  function setActivity(text) { $('chatActivity').textContent = text; $('chatActivity').hidden = !text; }
  function sessionSignature() { return JSON.stringify({ messages, draft: input.value, selection }); }
  function hasUnsaved() {
    if (!current || hydration) return false;
    return persistenceBlocked ? Boolean(messages.length || input.value || selection) : sessionSignature() !== lastSaved;
  }
  function updateControls() {
    const busy = Boolean(active), disabled = !current || !state.pdf || hydration;
    toggle.disabled = disabled; toggle.setAttribute('aria-expanded', String(!panel.hidden));
    $('chatSend').disabled = disabled || busy || !input.value.trim();
    $('chatStop').hidden = !busy; $('chatSend').hidden = busy;
    $('chatNew').disabled = disabled || busy || (!messages.length && !persistenceBlocked);
    $('chatExport').disabled = !messages.some((message) => message.content.trim());
    input.disabled = disabled;
    const custom = state.settings.custom || {};
    $('chatModel').textContent = custom.model ? custom.model : '未配置 AI 模型';
    $('chatModel').title = custom.baseUrl || '请在设置中配置 AI 服务';
    welcome.hidden = messages.length > 0;
    $('chatDocumentName').textContent = current?.name || '请先打开 PDF';
    for (const button of panel.querySelectorAll('[data-chat-prompt]')) button.disabled = disabled || busy;
    for (const refs of messageElements.values()) if (refs.retry) refs.retry.disabled = disabled || busy;
  }

  function persist() {
    clearTimeout(saveTimer);
    if (!current || hydration) return saveQueue;
    if (persistenceBlocked) return saveQueue;
    const documentId = current.id, snapshot = { version: 1, updatedAt: Date.now(), messages: structuredClone(messages), draft: input.value, selection: selection && { ...selection } };
    const signature = JSON.stringify({ messages: snapshot.messages, draft: snapshot.draft, selection: snapshot.selection });
    if (signature === lastSaved) return saveQueue;
    const capturedGeneration = generation, context = persistenceContext;
    saveQueue = saveQueue.catch(() => {}).then(async () => {
      try {
        const write = async () => {
          if (context.blocked && !context.reset) throw new Error(context.blocked);
          const latest = await library.loadState(documentId, 'chat');
          if (!context.reset && JSON.stringify(latest ?? null) !== context.baseline) { context.blocked = 'CONFLICT'; throw new Error('CONFLICT'); }
          const saved = await library.saveState(documentId, 'chat', snapshot);
          if (saved === false) throw new Error('DOCUMENT_REMOVED');
          context.baseline = JSON.stringify(snapshot); context.reset = false; context.blocked = '';
        };
        if (navigator.locks?.request) await navigator.locks.request(`pdf-chat-state:${documentId}`, { mode: 'exclusive' }, write);
        else await write();
        if (capturedGeneration === generation) { lastSaved = signature; storageFailed = false; $('chatStorageError').hidden = true; }
      } catch (error) {
        if (capturedGeneration !== generation) return;
        if (error.message === 'CONFLICT') {
          persistenceBlocked = true; blockReason = 'CONFLICT';
          $('chatStorageError').textContent = '另一窗口已更新这篇文章的讨论。为避免覆盖，本窗口暂停保存；请先导出，或重新打开文章读取最新记录。确认「新对话」会清空共享历史。';
          $('chatStorageError').hidden = false; storageFailed = true; updateControls(); return;
        }
        storageFailed = true; $('chatStorageError').textContent = error.message === 'DOCUMENT_REMOVED' ?
          '当前 PDF 已从文档库删除，讨论无法自动保存。可先导出，再重新导入 PDF。' : '讨论记录未能保存，请检查存储空间，离开前可导出备份。'; $('chatStorageError').hidden = false;
      }
    });
    return saveQueue;
  }
  async function flush() {
    const token = generation, documentId = current?.id;
    await persist();
    if (token !== generation || current?.id !== documentId || !hasUnsaved()) return;
    throw new Error(persistenceBlocked ? (blockReason === 'CONFLICT' ? '另一窗口已更新文章讨论，当前会话存在保存冲突，请先导出本窗口记录或重新打开文章。' :
      '原有讨论记录读取失败，为防止覆盖，当前讨论尚未保存。请先导出，或确认「新对话」后再保存。') : '文章讨论或草稿未能保存，请先导出备份后再离开。');
  }
  function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { void persist(); }, 600); }
  function nearEnd() { return list.scrollHeight - list.scrollTop - list.clientHeight < 90; }
  function scrollLatest(force = false) {
    if (force || nearEnd()) { list.scrollTop = list.scrollHeight; $('chatJumpLatest').hidden = true; }
    else $('chatJumpLatest').hidden = false;
  }

  function evidenceNodes(message) {
    const details = make('details', 'chat-evidence'), pages = [...new Set(message.evidence.map((item) => item.page))].sort((a, b) => a - b);
    details.hidden = !message.evidence.length;
    details.append(make('summary', '', `本轮参考原文 · ${pages.map((page) => `第 ${page} 页`).join('、')} · ${message.evidence.length} 段`));
    details.append(make('p', 'chat-evidence-note', '以下文字是本轮实际提供给 AI 的片段，不代表全文。页码为 PDF 文件页序。图像、图中标注与扫描页未识别。'));
    for (const item of message.evidence) {
      const block = make('div', 'chat-excerpt'), button = make('button', 'chat-citation', `第 ${item.page} 页`);
      button.type = 'button'; button.addEventListener('click', () => goToPage(item.page));
      block.append(button, make('p', '', item.text)); details.append(block);
    }
    return details;
  }
  function refreshMessage(message, initial = false) {
    let refs = messageElements.get(message.id);
    if (!refs) {
      const article = make('article', `chat-message chat-message-${message.role}`); article.dataset.chatMessage = message.id;
      const header = make('div', 'chat-message-heading', message.role === 'user' ? '我' : 'AI');
      const status = make('span', 'chat-message-status'); header.append(status);
      const content = make('div', 'chat-message-content'), error = make('p', 'chat-message-error'); error.setAttribute('role', 'status');
      const actions = make('div', 'chat-message-actions');
      const copy = make('button', 'quiet', '复制'); copy.type = 'button';
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(message.content); toast('已复制回答'); } catch (_) { toast('无法访问剪贴板，可选中文字复制。'); } });
      const retry = make('button', 'quiet', '重试'); retry.type = 'button';
      retry.title = '按当前 AI 设置重新发送这个问题，可能产生新的 API 费用';
      retry.addEventListener('click', () => {
        if (active || hydration) return;
        const position = messages.indexOf(message), previous = messages.slice(0, position).reverse().find((item) => item.role === 'user');
        if (!previous) return;
        const quote = previous.content.match(/\n\n选中原文 \[p\. (\d+)\]：\n([\s\S]*)$/);
        selection = quote ? { page: Number(quote[1]), text: quote[2].slice(0, 3000) } : null;
        input.value = (quote ? previous.content.slice(0, quote.index) : previous.content).slice(0, 4000);
        refreshSelection(); updateControls(); void submit();
      });
      actions.append(retry, copy); article.append(header, content, error);
      let evidence;
      if (message.role === 'assistant') { evidence = evidenceNodes(message); article.append(evidence, actions); }
      list.append(article); refs = { article, content, error, status, copy, retry, evidence }; messageElements.set(message.id, refs);
    }
    const stick = nearEnd();
    if (message.role === 'user') refs.content.textContent = message.content;
    else appendChatText(refs.content, message.content, { pages: message.evidence.map((item) => item.page), goToPage });
    refs.status.textContent = message.status === 'loading' ? '准备中' : message.status === 'streaming' ? '生成中' : message.status === 'cancelled' ? '已停止' : message.status === 'error' ? '未完成' : '';
    refs.error.textContent = message.error || ''; refs.error.hidden = !message.error;
    refs.copy.disabled = !message.content;
    refs.retry.hidden = !['error', 'cancelled'].includes(message.status); refs.retry.disabled = Boolean(active) || hydration;
    refs.article.dataset.status = message.status;
    if (!initial) scrollLatest(stick);
  }
  function renderMessages() {
    for (const node of list.querySelectorAll('.chat-message')) node.remove();
    messageElements.clear(); messages.forEach((message) => refreshMessage(message, true)); updateControls(); scrollLatest(true);
  }
  function refreshSelection() {
    $('chatSelection').hidden = !selection;
    $('chatSelectionPage').textContent = selection ? `选中原文 · 第 ${selection.page} 页` : '';
    $('chatSelectionText').textContent = selection?.text || '';
  }

  function stop({ persistAfter = true } = {}) {
    if (!active) return;
    const previous = active; active = null;
    previous.controller.abort();
    if (previous.requested) void send({ type: 'chatCancel', requestId: previous.requestId }).catch(() => {});
    if (previous.message && previous.generation === generation) {
      previous.message.status = 'cancelled';
      previous.message.error = previous.requested ? '已停止生成。已发送请求仍可能产生用量费用。' : '已停止分析，尚未发送 AI 请求。';
      refreshMessage(previous.message);
    }
    setActivity(''); setBusy(false);
    if (persistAfter) void persist();
  }

  async function submit(question = input.value) {
    question = String(question || '').trim();
    if (active || hydration || !current || !state.pdf || !question) return;
    if (question.length > 4000) { toast('问题不能超过 4000 个字符。'); return; }
    if (messages.length >= 118) { toast('当前讨论记录较长，请导出后开始新对话。'); return; }
    const documentId = current.id, currentGeneration = generation, pdf = state.pdf;
    const history = boundedChatHistory(messages), anchor = selection && { ...selection };
    const userMessage = { id: identifier(), role: 'user', content: question, status: 'done', createdAt: Date.now() };
    if (anchor) userMessage.content += `\n\n选中原文 [p. ${anchor.page}]：\n${anchor.text}`;
    const assistant = { id: identifier(), role: 'assistant', content: '', status: 'loading', createdAt: Date.now(), evidence: [] };
    const request = { requestId: identifier(), documentId, generation: currentGeneration, controller: new AbortController(), message: assistant, requested: false };
    active = request; messages.push(userMessage, assistant); input.value = ''; selection = null; refreshSelection();
    refreshMessage(userMessage); refreshMessage(assistant); scrollLatest(true); setBusy(true); scheduleSave();
    const valid = () => active === request && generation === currentGeneration && current?.id === documentId && !request.controller.signal.aborted;
    try {
      const settings = state.settings.custom || {};
      const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(settings.baseUrl || '');
      if (!settings.model || (!settings.apiKeyConfigured && !local)) throw new Error('文章讨论需要 AI 服务与 API Key。请打开「设置」配置；免费翻译接口不能用于对话。');
      if (!articleIndex) {
        const index = await indexArticle(pdf, { signal: request.controller.signal, onProgress: ({ current: page, total }) => { if (valid()) setActivity(`正在建立文章文字索引 · ${page} / ${total} 页`); } });
        if (!valid()) return;
        articleIndex = index;
      }
      if (!valid()) return;
      if (!articleIndex.chunks.length) throw new Error('这份 PDF 没有可引用的文字层。请先使用 OCR 识别文字；不会向 AI 发送空文章并生成猜测回答。');
      const context = retrieveArticleContext(articleIndex, question, { currentPage: state.currentPage, selection: anchor, history });
      if (!context.length) throw new Error('未能提取可引用的原文，请尝试选中相关段落再提问。');
      assistant.evidence = context;
      const refs = messageElements.get(assistant.id);
      if (refs) { const evidence = evidenceNodes(assistant); refs.evidence?.replaceWith(evidence); refs.evidence = evidence; }
      const notes = [];
      if (articleIndex.truncated) notes.push(`仅索引前 ${articleIndex.indexedPages} / ${articleIndex.totalPages} 页`);
      if (articleIndex.scanned) notes.push(`${articleIndex.scanned} 页无文字层`);
      if (articleIndex.unavailable.length) notes.push(`${articleIndex.unavailable.length} 页读取失败`);
      if (notes.length) { assistant.indexWarning = notes.join('；'); setActivity(`${notes.join('；')}。正在等待 AI…`); }
      else setActivity(`已提供 ${context.length} 段相关原文，等待 AI 回答…`);
      request.requested = true; assistant.status = 'streaming'; refreshMessage(assistant); scheduleSave();
      const result = await send({ type: 'chat', requestId: request.requestId, documentId, name: current.name,
        numPages: pdf.numPages, question, history, context });
      if (!valid()) return;
      if (typeof result?.content === 'string') assistant.content = result.content;
      if (result?.ok) {
        assistant.status = 'done'; assistant.error = assistant.indexWarning ? `${assistant.indexWarning}，回答未覆盖未读取的页面。` : '';
        setActivity('');
      } else {
        assistant.status = result?.cancelled ? 'cancelled' : 'error';
        assistant.error = result?.error || 'AI 服务未响应，请检查设置和网络后手动重试；未自动切换服务。';
      }
      refreshMessage(assistant);
    } catch (error) {
      if (!valid()) return;
      assistant.status = error.name === 'AbortError' ? 'cancelled' : 'error';
      assistant.error = error.message || '无法完成文章讨论，请检查网络和 AI 设置。'; refreshMessage(assistant);
    } finally {
      if (active === request && generation === currentGeneration) {
        active = null; setActivity(''); setBusy(false); await persist(); input.focus({ preventScroll: true });
      }
    }
  }

  const streamListener = (message) => {
    if (message?.type !== 'chat-stream' || !active?.requested || message.requestId !== active.requestId || active.generation !== generation) return;
    if (typeof message.text !== 'string' || message.text.length > 24000) return;
    active.message.content = message.text; active.message.status = 'streaming';
    refreshMessage(active.message); setActivity(message.error ? '本轮请求未完成，正在保存已接收内容…' : 'AI 正在生成；点击页码可核对原文'); scheduleSave();
  };
  chrome.runtime.onMessage.addListener(streamListener);

  function open() {
    if (!current || !state.pdf) { toast('请先打开 PDF。'); return; }
    closeCard(); panel.hidden = false; document.body.dataset.chatOpen = 'true'; toggle.classList.add('active'); updateControls();
    input.focus({ preventScroll: true }); scrollLatest(true);
    window.dispatchEvent(new Event('reader-layout-changed'));
  }
  function close() {
    panel.hidden = true; document.body.dataset.chatOpen = 'false'; toggle.classList.remove('active'); updateControls(); void persist();
    window.dispatchEvent(new Event('reader-layout-changed'));
  }
  async function loaded(record) {
    stop(); await persist();
    const token = ++generation;
    current = record ? { id: record.id, name: record.name, numPages: record.numPages } : null;
    articleIndex = null; messages = []; selection = null; input.value = ''; lastSaved = ''; storageFailed = false; persistenceBlocked = false; blockReason = '';
    persistenceContext = current ? { baseline: 'null', blocked: '', reset: false } : null;
    $('chatStorageError').hidden = true; setActivity(''); refreshSelection(); hydration = Boolean(current); renderMessages();
    if (!current) { close(); return; }
    const documentId = current.id;
    try {
      const saved = await library.loadState(documentId, 'chat');
      if (token !== generation || current?.id !== documentId) return;
      persistenceContext.baseline = JSON.stringify(saved ?? null);
      const session = normalizeSession(saved); messages = session.messages; input.value = session.draft;
      selection = session.selection?.page <= state.pdf?.numPages ? session.selection : null; refreshSelection();
      lastSaved = sessionSignature();
    } catch (_) {
      if (token !== generation) return;
      storageFailed = true; persistenceBlocked = true; blockReason = 'HYDRATION'; persistenceContext.blocked = 'HYDRATION';
      $('chatStorageError').textContent = '原有讨论记录读取失败；为防止覆盖，当前会话暂不自动保存。可先导出，或确认「新对话」后重新保存。'; $('chatStorageError').hidden = false;
    } finally {
      if (token === generation) { hydration = false; renderMessages(); }
    }
  }
  async function beforeClose() { stop(); await persist(); close(); hydration = true; updateControls(); }
  function openFromSelection(text, page = state.currentPage) {
    if (!current || !String(text || '').trim()) return;
    const chosenPage = Number.isInteger(page) && page > 0 && page <= state.pdf.numPages ? page : state.currentPage;
    selection = { text: String(text).trim().slice(0, 3000), page: chosenPage };
    if (String(text).length > 3000) toast('选中内容较长，本次引用前 3000 个字符。');
    refreshSelection(); if (!input.value.trim()) input.value = '请解释这段话的含义、关键术语及其在文章中的作用。'; updateControls(); open(); scheduleSave();
  }

  toggle.addEventListener('click', () => panel.hidden ? open() : close());
  $('chatClose').addEventListener('click', close);
  $('chatForm').addEventListener('submit', (event) => { event.preventDefault(); void submit(); });
  input.addEventListener('input', () => { updateControls(); scheduleSave(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); toggle.focus(); }
  });
  $('chatStop').addEventListener('click', () => stop());
  $('chatRemoveSelection').addEventListener('click', () => { selection = null; refreshSelection(); input.focus(); scheduleSave(); });
  for (const button of panel.querySelectorAll('[data-chat-prompt]')) button.addEventListener('click', () => { input.value = button.dataset.chatPrompt; updateControls(); input.focus(); scheduleSave(); });
  list.addEventListener('scroll', () => { if (nearEnd()) $('chatJumpLatest').hidden = true; });
  $('chatJumpLatest').addEventListener('click', () => scrollLatest(true));
  $('chatNew').addEventListener('click', () => {
    if (active) return;
    $('chatResetDialog').querySelector('p').textContent = blockReason === 'CONFLICT' ?
      '另一窗口已有较新讨论。继续会清空这篇文章的共享讨论历史，包括另一窗口的新内容。请先导出需要保留的记录，再确认清空。PDF、译文和书签不受影响。' : persistenceBlocked ?
      '原有记录未能读取。继续会用新会话覆盖这篇文章的旧讨论。请确认不再需要旧记录，并先导出当前临时会话。PDF、译文和书签不受影响。' :
      '当前文章的讨论记录将清空。需要保留时，请先导出；PDF、译文和书签不受影响。';
    $('chatResetDialog').showModal();
  });
  $('chatResetCancel').addEventListener('click', () => $('chatResetDialog').close());
  $('chatResetConfirm').addEventListener('click', () => {
    if (active) return;
    messages = []; input.value = ''; selection = null; lastSaved = ''; persistenceBlocked = false; storageFailed = false;
    blockReason = ''; if (persistenceContext) { persistenceContext.reset = true; persistenceContext.blocked = ''; }
    $('chatStorageError').hidden = true; refreshSelection(); renderMessages();
    $('chatResetDialog').close(); void persist(); input.focus();
  });
  $('chatExport').addEventListener('click', () => {
    const blob = new Blob([chatMarkdown(current?.name, messages)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = make('a');
    anchor.href = url; anchor.download = `${(current?.name || '文章').replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')}-讨论.md`;
    document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  window.addEventListener('pagehide', () => { stop(); void persist(); });
  window.addEventListener('beforeunload', (event) => {
    if (!active && !hasUnsaved()) return;
    event.preventDefault(); event.returnValue = '';
  });
  if (typeof ResizeObserver !== 'undefined') {
    const toolbar = document.querySelector('.toolbar');
    if (toolbar) new ResizeObserver(() => document.documentElement.style.setProperty('--reader-toolbar-height', `${toolbar.getBoundingClientRect().height}px`)).observe(toolbar);
  }
  updateControls();
  return { loaded, beforeClose, openFromSelection, open, close, flush, hasUnsaved, isBusy: () => Boolean(active),
    settingsChanged() { updateControls(); } };
}
