export const TRANSLATION_FONT = '"Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif';
export const LAYOUT_VERSION = 3;

function normalize(text) {
  return text.normalize('NFKC').replace(/\u00ad/g, '').replace(/([A-Za-z]+)-\s*\n\s*([a-z]+)/g, (_, a, b) =>
    /^(?:human|risk|two|three|four|self|car|cost|task|goal|open|closed|noise|time|real|well|non|multi|single|cross|state|sub)$/i.test(a) ? `${a}-${b}` : a + b)
    .replace(/\[(?:[\d,–−-]+\]\[)+[\d,–−-]+\]/g, (value) => `[${value.replace(/[\[\]]/g, '')}]`)
    .replace(/\s+/g, ' ').trim();
}

export function shouldTranslate(text) {
  const words = text.match(/\p{L}{2,}/gu) || [];
  if (!words.some((word) => word.length >= 4) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}/u.test(text)) return false;
  if (/^(?:https?:\/\/|www\.)\S+$|^\S+@\S+$/i.test(text)) return false;
  if (/[qf][fi]{16,}|[\x00-\x08\x0e-\x1f]/.test(text)) return false;
  const math = (text.match(/[=∑∫√±×÷≤≥{}^¼ðÞ]/g) || []).length;
  return math < Math.max(2, text.length / 18);
}

export function extractPageLayout(content, viewport, transform) {
  const pieces = [];
  let unplaced = 0;
  for (const item of content.items) {
    if (!item.str?.trim()) continue;
    const style = content.styles[item.fontName] || {};
    const tx = transform(viewport.transform, item.transform);
    const fontSize = Math.hypot(tx[2], tx[3]);
    const angle = Math.atan2(tx[1], tx[0]);
    if (!fontSize || style.vertical || Math.abs(angle) > .05) { unplaced++; continue; }
    // Some embedded ligature fonts report ascent=0. Baseline, not glyph top,
    // determines a text row; otherwise every fi/fl becomes its own paragraph.
    const ascent = fontSize * (style.ascent > .3 ? style.ascent : .8);
    const descent = fontSize * (style.descent < 0 ? -style.descent : .2);
    pieces.push({ text: item.str, x: tx[4], y: tx[5] - ascent, baseline: tx[5],
      width: Math.max(item.width * viewport.scale, .1), height: ascent + descent,
      fontSize, fontName: item.fontName, dir: item.dir });
  }
  const weights = new Map();
  for (const p of pieces) {
    const size = Math.round(p.fontSize * 2) / 2;
    weights.set(size, (weights.get(size) || 0) + p.text.length);
  }
  const bodySize = [...weights].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const fontWeights = new Map();
  for (const p of pieces) fontWeights.set(p.fontName, (fontWeights.get(p.fontName) || 0) + p.text.length);
  const mainFont = [...fontWeights].sort((a, b) => b[1] - a[1])[0]?.[0];
  const dropCaps = pieces.filter((p) => p.fontSize > bodySize * 2.4 && /^\p{L}$/u.test(p.text));
  const regular = pieces.filter((p) => !dropCaps.includes(p));
  regular.sort((a, b) => b.fontSize - a.fontSize || a.baseline - b.baseline || a.x - b.x);
  const rows = [];
  const add = (piece) => {
    let row = rows.find((r) => Math.abs(r.baseline - piece.baseline) < Math.min(2, piece.fontSize * .22) &&
      Math.abs(r.fontSize - piece.fontSize) < piece.fontSize * .15);
    if (!row) { row = { baseline: piece.baseline, fontSize: piece.fontSize, items: [] }; rows.push(row); }
    row.items.push(piece);
  };
  // Attach citations and inline variable subscripts before forming columns.
  // Standalone equations/axis labels have no nearby prose row and stay separate.
  for (const piece of regular) {
    const candidates = rows.filter((r) => r.fontSize > piece.fontSize * 1.08 &&
      Math.abs(r.baseline - piece.baseline) <= r.fontSize * .55 && r.items.some((p) =>
        piece.x <= p.x + p.width + r.fontSize * .7 && piece.x + piece.width >= p.x - r.fontSize * .7));
    const row = candidates.sort((a, b) => Math.abs(a.baseline - piece.baseline) - Math.abs(b.baseline - piece.baseline))[0];
    if (row) { piece.script = piece.baseline < row.baseline ? 'super' : 'sub'; row.items.push(piece); }
    else add(piece);
  }
  for (const row of [...rows]) {
    if (row.items.map((p) => p.text).join('').length > 4) continue;
    const target = rows.filter((r) => r !== row && r.fontSize > row.fontSize * .9 && r.fontSize < row.fontSize * 1.1 &&
      Math.abs(r.baseline - row.baseline) < row.fontSize * .5 && r.items.some((p) => p.text.length > 12 &&
        row.items.every((i) => i.x >= p.x - 2 && i.x + i.width <= p.x + p.width + 2)))
      .sort((a, b) => Math.abs(a.baseline - row.baseline) - Math.abs(b.baseline - row.baseline))[0];
    if (target) { target.items.push(...row.items); rows.splice(rows.indexOf(row), 1); }
  }
  rows.sort((a, b) => a.baseline - b.baseline);
  // A narrow gutter can be smaller than a justified word space. Vote across
  // rows for a persistent central gap instead of using a single gap threshold.
  const votes = new Map();
  for (const row of rows) {
    const items = row.items.sort((a, b) => a.x - b.x);
    for (let i = 1; i < items.length; i++) {
      const left = items[i - 1].x + items[i - 1].width, right = items[i].x;
      if (right - left < 6 || left < viewport.width * .28 || right > viewport.width * .72 ||
          left - items[0].x < viewport.width * .15 || items.at(-1).x + items.at(-1).width - right < viewport.width * .15) continue;
      for (let x = Math.ceil(left + 1); x < right - 1; x++) votes.set(x, (votes.get(x) || 0) + 1);
    }
  }
  const peak = Math.max(0, ...votes.values());
  const candidates = [...votes].filter(([, n]) => n === peak).map(([x]) => x);
  const longRows = rows.filter((r) => r.items.some((p) => p.width > viewport.width * .2)).length;
  let gutter = peak >= Math.max(2, longRows * .08) ? candidates.sort((a, b) => Math.abs(a - viewport.width / 2) - Math.abs(b - viewport.width / 2))[0] : null;
  if (!gutter) {
    // Columns with different font sizes/leading may have no shared baselines.
    // Find the same persistent gap from horizontal text coverage in that case.
    const long = pieces.filter((p) => p.width > viewport.width * .12 && p.y > viewport.height * .045 && p.y < viewport.height * .94);
    const coverage = (x) => long.filter((p) => p.x < x && p.x + p.width > x).length;
    let best = 2;
    for (let x = Math.round(viewport.width * .32); x < viewport.width * .68; x++) {
      const score = Math.min(coverage(x - 22), coverage(x + 22)) - coverage(x);
      if (score > best || (score === best && gutter && Math.abs(x - viewport.width / 2) < Math.abs(gutter - viewport.width / 2))) { best = score; gutter = x; }
    }
  }
  const lines = [];
  for (const row of rows) {
    let line;
    for (const piece of row.items) {
      const gap = line ? piece.x - line.right : Infinity;
      const crossesGutter = line && gutter && gap >= 6 && line.right <= gutter && piece.x >= gutter;
      if (!line || crossesGutter || gap > Math.max(9, row.fontSize * 1.2)) {
        line = { x: piece.x, y: piece.y, baseline: row.baseline, right: piece.x, bottom: piece.y,
          fontSize: row.fontSize, fontName: piece.fontName, text: '', dir: piece.dir, pieces: [] };
        lines.push(line);
      }
      if (line.text && gap > row.fontSize * .12 && !piece.script && !/\s$/.test(line.text) && !/^\s/.test(piece.text)) line.text += ' ';
      if (piece.script === 'super' && /^[\d,–−-]+$/.test(piece.text)) {
        const exponent = /^[−-]\d/.test(piece.text) || /\b(?:[A-Za-zα-ωΑ-Ω]|mm|cm|km|kg)$/.test(line.text);
        line.text += exponent ? `^${piece.text}` : `[${piece.text}]`;
      } else if (piece.script === 'sub') line.text += `${line.pieces.at(-1)?.script === 'sub' ? '' : '_'}${piece.text}`;
      else line.text += piece.text;
      line.pieces.push(piece);
      line.y = Math.min(line.y, piece.y);
      line.right = Math.max(line.right, piece.x + piece.width);
      line.bottom = Math.max(line.bottom, piece.y + piece.height);
    }
  }
  for (const cap of dropCaps) {
    const first = lines.filter((l) => l.x >= cap.x + cap.width - 2 && l.x <= cap.x + cap.width + bodySize &&
      l.y >= cap.y - bodySize && l.y < cap.y + cap.height * .7).sort((a, b) => a.y - b.y)[0];
    if (first) { first.text = cap.text + first.text; first.dropCap = cap; first.pieces.unshift(cap); }
    else { unplaced++; }
  }
  for (const line of lines) {
    line.column = gutter ? line.x >= gutter ? 1 : line.right <= gutter ? 0 : -1 : 0;
    line.translatable = shouldTranslate(normalize(line.text)) || /^\((?:Fig|Eq)\.\s*\(?\d/.test(line.text);
    if (line.baseline < viewport.height * .045 || line.y > viewport.height * .95 ||
      /https?:\/\/doi\.org|www\.nature\.com|^NATURE COMMUNICATIONS\s*\|/.test(line.text)) line.translatable = false;
  }
  lines.sort((a, b) => a.baseline - b.baseline || a.x - b.x);
  const rightEdges = new Map();
  for (const line of lines) if (line.translatable) rightEdges.set(line.column, Math.max(rightEdges.get(line.column) || 0, line.right));
  const blocks = [];
  for (const line of lines) {
    let previous;
    for (const block of blocks) {
      const last = block.lines.at(-1);
      const overlap = Math.min(last.right, line.right) - Math.max(last.x, line.x);
      const gap = line.baseline - last.baseline;
      const capWrap = block.dropCap && line.y < block.dropCap.y + block.dropCap.height;
      const indent = line.x - block.x;
      const startsParagraph = !capWrap && indent > line.fontSize * .55;
      const endedParagraph = !capWrap && /[.!?:]\s*$/.test(last.text) && last.right < (rightEdges.get(line.column) || last.right) - line.fontSize * 2;
      if (block.column !== line.column || block.translatable !== line.translatable || startsParagraph || endedParagraph ||
          gap < line.fontSize * .6 || gap > line.fontSize * 1.75 ||
          overlap < Math.min(last.right - last.x, line.right - line.x) * .5 ||
          (!capWrap && Math.abs(line.x - block.x) > line.fontSize * 2) ||
          Math.abs(last.fontSize - line.fontSize) > line.fontSize * .15 ||
          (last.fontName !== line.fontName && last.text.length < 40) ||
          block.text.length + line.text.length > 3400) continue;
      if (!previous || last.bottom > previous.lines.at(-1).bottom) previous = block;
    }
    if (!previous) {
      previous = { id: blocks.length, x: line.dropCap?.x ?? line.x, y: Math.min(line.y, line.dropCap?.y ?? line.y),
        width: 0, height: 0, fontSize: line.fontSize, column: line.column, translatable: line.translatable,
        dropCap: line.dropCap, lines: [], text: '', status: line.translatable ? 'pending' : 'preserved' };
      blocks.push(previous);
    }
    previous.lines.push(line);
    previous.x = Math.min(previous.x, line.x);
    previous.y = Math.min(previous.y, line.y);
    previous.width = Math.max(...previous.lines.map((l) => l.right)) - previous.x;
    previous.height = Math.max(...previous.lines.map((l) => l.bottom), previous.dropCap ? previous.dropCap.y + previous.dropCap.height : 0) - previous.y;
    previous.text = previous.lines.map((l) => l.text).join('\n');
  }
  for (const block of blocks) {
    block.text = normalize(block.text);
    if (!shouldTranslate(block.text)) block.status = 'preserved';
    // Keep tiny chart labels and mathematical subscripts in the original figure.
    if (block.fontSize < bodySize * .86 && block.lines.length === 1 && block.text.length < 45) block.status = 'preserved';
    if (block.fontSize < bodySize * .86 && block.width < viewport.width * .25 && block.text.length < 100 && block.height < block.fontSize * 3.2) block.status = 'preserved';
    if (block.fontSize > bodySize * 1.7 && /^[=∑∫]/.test(block.text)) block.status = 'preserved';
    block.heading = block.fontSize > bodySize * 1.5 || (block.text.length < 80 && block.lines.length === 1 && block.lines[0].fontName !== mainFont);
    for (const line of block.lines) delete line.pieces;
  }
  const title = blocks.find((b) => b.fontSize > 18 && b.text.length > 40 && b.y < viewport.height * .35);
  const abstract = title && blocks.find((b) => b.y > title.y + title.height && b.text.length > 300);
  for (const block of blocks) {
    if (/^(?:ARTICLE|OPEN)$/.test(block.text) || /\bemail:\s*\S+@\S+/i.test(block.text) ||
      (abstract && block.y > title.y + title.height && block.y + block.height < abstract.y)) block.status = 'preserved';
  }
  const spanning = blocks.filter((b) => b.column === -1 && b.width > viewport.width * .6);
  const band = (b) => spanning.filter((s) => s !== b && s.y + s.height <= b.y + 1).length;
  const tier = (b) => b.y < viewport.height * .045 ? -1 : b.y > viewport.height * .95 ? 1 : 0;
  blocks.sort((a, b) => tier(a) - tier(b) || band(a) - band(b) || (a.column === -1 || b.column === -1 ? a.y - b.y : a.column - b.column || a.y - b.y));
  blocks.forEach((b, id) => { b.id = id; });
  return { width: viewport.width, height: viewport.height, blocks, gutter, unplaced, textItems: pieces.length };
}

export function finalizeDocumentLayout(pages) {
  let bibliography = false;
  for (const page of pages) {
    for (const block of page.blocks) {
      if (/^(?:References|Bibliography)$/i.test(block.text)) { bibliography = true; continue; }
      if (/^(?:Acknowledg[e]?ments|Author contributions|Competing interests|Additional information|Supplementary information)$/i.test(block.text)) bibliography = false;
      if (bibliography && block.status !== 'preserved') { block.status = 'preserved'; block.kind = 'bibliography'; }
    }
  }
  return pages;
}

export function wrapText(text, width, measure) {
  const tokens = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}][，。！？；：、）】》〉」』”’％%]*|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|\s+/gu) || [];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/[（【《〈「『“‘]$/.test(tokens[i]) && !/^\s/.test(tokens[i + 1])) tokens.splice(i, 2, tokens[i] + tokens[i + 1]);
  }
  const lines = [];
  let line = '';
  for (const token of tokens) {
    if (!line && /^\s+$/.test(token)) continue;
    if (measure(line + token) <= width) { line += token; continue; }
    if (line.trim()) { lines.push(line.trimEnd()); line = ''; }
    if (/^\s+$/.test(token)) continue;
    if (measure(token) <= width) { line = token; continue; }
    for (const char of token) {
      if (line && measure(line + char) > width) { lines.push(line); line = ''; }
      line += char;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

export function fitTranslation(block, translation, context) {
  let low = Math.max(6, block.fontSize * .72), high = Math.min(block.fontSize, 28), best;
  if (high < low) return null;
  for (let i = 0; i < 14; i++) {
    const fontSize = i === 0 ? low : (low + high) / 2;
    context.font = `${block.heading ? '600 ' : ''}${fontSize}px ${TRANSLATION_FONT}`;
    const lines = wrapText(translation, block.width, (text) => context.measureText(text).width);
    const metrics = context.measureText('译文Ag');
    const ascent = metrics.actualBoundingBoxAscent || fontSize;
    const descent = metrics.actualBoundingBoxDescent || fontSize * .2;
    const lineHeight = Math.max(fontSize * 1.28, ascent + descent + fontSize * .1);
    const fits = (lines.length - 1) * lineHeight + ascent + descent <= block.height + .8;
    if (fits) { best = { fontSize, lineHeight, ascent, lines }; low = fontSize; }
    else high = fontSize;
  }
  return best || null;
}

export function translationPlacement(block, page, context) {
  const collision = page.blocks.some((other) => other !== block &&
    Math.min(block.x + block.width, other.x + other.width) - Math.max(block.x, other.x) > 1 &&
    Math.min(block.y + block.height, other.y + other.height) - Math.max(block.y, other.y) > 1.8);
  return collision ? null : fitTranslation(block, block.translation, context);
}

function backgroundAt(canvas, line, scale) {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const x = Math.max(0, Math.min(canvas.width - 1, Math.floor((line.x - 1.5) * scale)));
  const y = Math.max(0, Math.min(canvas.height - 1, Math.floor((line.y + line.fontSize * .4) * scale)));
  const [r, g, b] = context.getImageData(x, y, 1, 1).data;
  return `rgb(${r},${g},${b})`;
}

export function paintTranslations(canvas, page, source = canvas) {
  const context = canvas.getContext('2d');
  const scale = canvas.width / page.width;
  const placements = [];
  for (const block of page.blocks) {
    if (block.status !== 'done' || !block.translation) continue;
    const layout = translationPlacement(block, page, context);
    placements.push({ block, layout, background: layout ? backgroundAt(source, block.lines[0], scale) : '' });
  }
  // Clear every source region before drawing any target text. Otherwise a later
  // mask can erase the preceding paragraph's descenders at a tight line boundary.
  for (const { block, layout, background } of placements) {
    if (!layout) continue;
    context.save(); context.scale(scale, scale);
    context.fillStyle = background;
    context.fillRect(block.x - 1.1, block.y - .65, block.width + 2.2, block.height + 1.3);
    context.restore();
  }
  for (const { block, layout, background } of placements) {
    if (!layout) continue;
    context.save(); context.scale(scale, scale);
    context.font = `${block.heading ? '600 ' : ''}${layout.fontSize}px ${TRANSLATION_FONT}`;
    const channels = background.match(/\d+/g).map(Number);
    context.fillStyle = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 < 120 ? '#ffffff' : '#17231e';
    context.textBaseline = 'alphabetic';
    const rtl = /[\u0590-\u08ff]/.test(block.translation);
    context.direction = rtl ? 'rtl' : 'ltr'; context.textAlign = rtl ? 'right' : 'left';
    layout.lines.forEach((line, i) => context.fillText(line, rtl ? block.x + block.width : block.x, block.y + layout.ascent + i * layout.lineHeight));
    context.restore();
  }
  return placements;
}
