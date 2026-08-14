export function buildTextPdf(pages: string[][]): Buffer {
  const offsets = [0];
  const objectCount = 3 + pages.length * 2;
  const fontId = 3;
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`);

  const objects = new Map<number, string>();
  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objects.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
  objects.set(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  pages.forEach((lines, index) => {
    const pageId = 4 + index * 2;
    const contentId = pageId + 1;
    const commands = ['BT', '/F1 12 Tf', '72 720 Td', ...lines.flatMap((line, lineIndex) => {
      const prefix = lineIndex === 0 ? [] : ['0 -18 Td'];
      return [...prefix, `(${escapePdf(line)}) Tj`];
    }), 'ET'];
    const stream = commands.join('\n');
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  });

  let body = Buffer.from('%PDF-1.4\n');
  for (let number = 1; number <= objectCount; number += 1) {
    offsets[number] = body.length;
    body = Buffer.concat([body, Buffer.from(`${number} 0 obj\n${objects.get(number)}\nendobj\n`, 'latin1')]);
  }

  const xrefOffset = body.length;
  const xref = [
    'xref',
    `0 ${objectCount + 1}`,
    '0000000000 65535 f ',
    ...Array.from({ length: objectCount }, (_, index) => `${String(offsets[index + 1]).padStart(10, '0')} 00000 n `)
  ].join('\n');
  const trailer = `\ntrailer << /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.concat([body, Buffer.from(xref, 'latin1'), Buffer.from(trailer, 'latin1')]);
}

export function buildEncryptedPdf() {
  const base = buildTextPdf([['secret text']]);
  const text = base.toString('latin1').replace(
    '/Root 1 0 R',
    '/Root 1 0 R /Encrypt 99 0 R'
  );
  return Buffer.from(text, 'latin1');
}

export function buildEmptyTextPdf() {
  return buildTextPdf([[]]);
}

function escapePdf(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}
