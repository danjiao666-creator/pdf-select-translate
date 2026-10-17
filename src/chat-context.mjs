import { extractPageLayout, finalizeDocumentLayout } from './pdf-layout.mjs';

const tidy = (value) => String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
const abortError = () => new DOMException('已停止分析文章', 'AbortError');
const stopWords = new Set('the a an of to in and or for is are was were be this that these those with from by on as at it we how what why can could would does do please explain article paper study'.split(' '));
const topics = [
  [/总结|概括|摘要|主要|核心|贡献|summary|summari[sz]|overview|contribution/i, 'abstract introduction conclusion discussion contribution purpose findings'],
  [/方法|实验|模型|怎么做|如何做|method|experiment|model/i, 'methods methodology experiment model procedure participants sample design dataset measure'],
  [/局限|缺点|不足|限制|批判|可靠|limitations?|weakness|critic/i, 'limitation limitations discussion future assumption uncertainty constraint validity generalization'],
  [/结果|发现|结论|证据|results?|finding|conclusion|evidence/i, 'results findings conclusion evidence discussion effect significant'],
  [/图表|图\s*\d|figure|table/i, 'figure fig table caption'],
  [/风险|驾驶|车辆|risk|driv|vehicle/i, 'risk driver driving vehicle behaviour behavior car'],
  [/数据|样本|统计|data|sample|statistic/i, 'data sample participant statistical analysis measure confidence significance'],
  [/假设|前提|assumption|hypothes/i, 'assumption hypothesis hypothesize prediction theory']
];

// pdf.js' six-value affine transform, kept local so indexing is testable without a worker.
export function multiplyTransform(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export function contextTerms(text, expand = true) {
  const source = tidy(text).toLowerCase(), tokens = source.match(/[a-z][a-z0-9_-]{1,}|[\p{Script=Han}]{2,}/gu) || [];
  const terms = new Set();
  for (const token of tokens) {
    if (/\p{Script=Han}/u.test(token)) {
      for (let i = 0; i < token.length - 1; i++) terms.add(token.slice(i, i + 2));
    } else if (!stopWords.has(token)) terms.add(token.replace(/(?:ing|ed|s)$/, (ending) => token.length > 5 ? '' : ending));
  }
  if (expand) for (const [pattern, words] of topics) if (pattern.test(source)) for (const word of words.split(' ')) terms.add(word);
  return terms;
}

export function chunkParagraphs(page, blocks, limit = 1600) {
  const chunks = [];
  for (const block of blocks) {
    const text = tidy(block.text);
    if (text.length < 12 || /^(?:https?:\/\/|www\.)\S+$/.test(text)) continue;
    let offset = 0;
    while (offset < text.length) {
      let end = Math.min(text.length, offset + limit);
      if (end < text.length) {
        const minimum = offset + Math.floor(limit * .6);
        const punctuation = Math.max(text.lastIndexOf('. ', end), text.lastIndexOf('。', end), text.lastIndexOf('; ', end));
        if (punctuation >= minimum) end = punctuation + 1;
        else { const space = text.lastIndexOf(' ', end); if (space >= minimum) end = space; }
      }
      const part = text.slice(offset, end).trim();
      if (part) chunks.push({ page, text: part, heading: Boolean(block.heading), bibliography: block.kind === 'bibliography' });
      offset = end;
    }
  }
  return chunks;
}

export async function indexArticle(pdf, { signal, onProgress, maxPages = 1000, maxCharacters = 3500000 } = {}) {
  const pages = [], pageNumbers = [], unavailable = [];
  let characters = 0, scanned = 0;
  const total = pdf.numPages;
  for (let n = 1; n <= Math.min(total, maxPages); n++) {
    if (signal?.aborted) throw abortError();
    try {
      const page = await pdf.getPage(n);
      if (signal?.aborted) throw abortError();
      const layout = extractPageLayout(await page.getTextContent(), page.getViewport({ scale: 1 }), multiplyTransform);
      if (signal?.aborted) throw abortError();
      if (!layout.textItems) scanned++;
      pages.push(layout); pageNumbers.push(n);
      characters += layout.blocks.reduce((sum, block) => sum + block.text.length, 0);
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw abortError();
      unavailable.push(n);
    }
    onProgress?.({ current: n, total });
    if (characters >= maxCharacters) break;
    if (n % 3 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  finalizeDocumentLayout(pages);
  const chunks = pages.flatMap((page, i) => chunkParagraphs(pageNumbers[i], page.blocks));
  const indexedPages = pageNumbers.at(-1) || 0;
  return { chunks, totalPages: total, indexedPages, unavailable, scanned,
    truncated: indexedPages + unavailable.filter((n) => n > indexedPages).length < total, characters };
}

export function retrieveArticleContext(index, question, { currentPage = 1, selection, history = [], maxExcerpts = 12, maxCharacters = 18000 } = {}) {
  const prior = history.filter((message) => message.role === 'user').slice(-2).map((message) => message.content).join(' ');
  const query = `${question} ${selection?.text || ''}`, terms = contextTerms(query), priorTerms = contextTerms(prior);
  const overview = /总结|概括|摘要|主要|核心|贡献|summary|summari[sz]|overview/i.test(question);
  const here = /本页|这页|这里|这段|选中|当前|this page|this passage|selected/i.test(question) || Boolean(selection);
  const chunks = index.chunks, documents = new Map();
  for (const term of new Set([...terms, ...priorTerms])) documents.set(term, chunks.reduce((count, chunk) => count + (chunk.text.toLowerCase().includes(term) ? 1 : 0), 0));
  const candidates = chunks.map((chunk, i) => {
    const text = chunk.text.toLowerCase();
    let score = 0;
    for (const term of terms) if (text.includes(term)) score += 1 + Math.log(1 + chunks.length / (1 + documents.get(term)));
    for (const term of priorTerms) if (!terms.has(term) && text.includes(term)) score += .4;
    if (chunk.page === currentPage) score += here ? 15 : .6;
    if (selection?.page === chunk.page) score += 5;
    if (chunk.page <= 2) score += overview ? 4 : .5;
    if (overview && /abstract|conclusion|discussion|finding|introduction|摘要|结论|讨论/i.test(text)) score += 4;
    if (chunk.bibliography) score -= 12;
    return { ...chunk, index: i, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const result = [], used = new Set();
  let length = 0;
  const add = (chunk) => {
    if (!chunk || result.length >= maxExcerpts || used.has(chunk.index) || length >= maxCharacters) return;
    const text = chunk.text.slice(0, maxCharacters - length).trim();
    if (text.length < 30 && result.length) return;
    result.push({ page: chunk.page, text }); used.add(chunk.index); length += text.length;
  };
  if (selection?.text?.trim() && Number.isInteger(selection.page) && selection.page > 0 && selection.page <= index.totalPages) {
    add({ page: selection.page, text: tidy(selection.text).slice(0, 3000), index: -1 });
  }
  // Overview questions need evidence from several parts, not twelve near-identical abstract fragments.
  if (overview && index.totalPages > 3) {
    const ranges = [[1, 2], [3, Math.ceil(index.totalPages / 2)], [Math.ceil(index.totalPages / 2), index.totalPages]];
    for (const [start, end] of ranges) {
      const inRange = candidates.filter((chunk) => !chunk.bibliography && chunk.page >= start && chunk.page <= end && chunk.text.length > 100);
      inRange.slice(0, 2).forEach(add);
    }
  }
  const perPage = new Map();
  for (const chunk of result) perPage.set(chunk.page, (perPage.get(chunk.page) || 0) + 1);
  for (const chunk of candidates) {
    if ((perPage.get(chunk.page) || 0) >= (here ? 6 : 4)) continue;
    const previous = result.length; add(chunk);
    if (result.length > previous) perPage.set(chunk.page, (perPage.get(chunk.page) || 0) + 1);
  }
  return result;
}

export function boundedChatHistory(messages, { maxMessages = 12, maxCharacters = 16000 } = {}) {
  const result = [];
  let length = 0;
  for (const message of [...messages].reverse()) {
    if (!['user', 'assistant'].includes(message.role) || (message.role === 'assistant' && message.status !== 'done')) continue;
    const limit = message.role === 'user' ? 4000 : 5500;
    const content = tidy(message.content).slice(0, Math.min(limit, maxCharacters - length));
    if (!content) break;
    result.unshift({ role: message.role, content }); length += content.length;
    if (result.length >= maxMessages || length >= maxCharacters) break;
  }
  while (result[0]?.role === 'assistant') result.shift();
  return result;
}

export function chatMarkdown(documentName, messages) {
  const lines = [`# ${String(documentName || '文章').replace(/[\r\n]/g, ' ')} - AI 阅读讨论`, '', '> AI 回答可能有误；页码为 PDF 文件页序，请核对原文。', ''];
  for (const message of messages) {
    if (!message.content?.trim() && !message.error) continue;
    lines.push(`## ${message.role === 'user' ? '我' : 'AI'}${message.status && message.status !== 'done' ? `（${message.status === 'cancelled' ? '已停止' : '未完成'}）` : ''}`, '', message.content || '', '');
    if (message.error) lines.push(`> ${message.error}`, '');
    if (message.role === 'assistant' && message.evidence?.length) {
      lines.push('<details>', '<summary>本轮提供给 AI 的原文片段</summary>', '');
      for (const item of message.evidence) lines.push(`### 第 ${item.page} 页`, '', item.text.replace(/^/gm, '> '), '');
      lines.push('</details>', '');
    }
  }
  return lines.join('\n');
}
