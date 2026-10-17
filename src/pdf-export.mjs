// Image-backed PDF avoids remote fonts and keeps browser-rendered CJK glyphs intact.
export function createImagePdf(pages) {
  const encoder = new TextEncoder();
  const parts = [];
  let length = 0;
  const offsets = [0];
  const push = (part) => { const bytes = typeof part === 'string' ? encoder.encode(part) : part; parts.push(bytes); length += bytes.length; };
  const object = (id, contents) => { offsets[id] = length; push(`${id} 0 obj\n`); contents(); push('\nendobj\n'); };
  push('%PDF-1.4\n% image-backed translation\n');
  object(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
  object(2, () => push(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`));
  pages.forEach((page, i) => {
    const id = 3 + i * 3;
    const width = Number(page.width.toFixed(3)), height = Number(page.height.toFixed(3));
    object(id, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Image ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`));
    const commands = `q\n${width} 0 0 ${height} 0 0 cm\n/Image Do\nQ\n`;
    object(id + 1, () => push(`<< /Length ${encoder.encode(commands).length} >>\nstream\n${commands}endstream`));
    object(id + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`);
      push(page.bytes); push('\nendstream');
    });
  });
  const xref = length;
  push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let i = 1; i < offsets.length; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: 'application/pdf' });
}
