// src/pay-increase-pdf.mjs — PCG "Pay Increase Form", drawn to match HR's "Pay Change
// Form.pdf" (US Letter, Cambria): the logo, title, the six blanks, the "Reason" box, the
// three signature lines and the "For Office Use Only" box sit exactly where the template
// has them (measured from it). Font = Caladea, the open font with Cambria's letter widths.
// The PCG seal watermark sits behind the body (requested 2026-11-09). Pure: no DOM/fetch.

// [baseline from top (pt), size, [[x, text, style]]]  style: 'b' bold, 'bi' bold italic, '' regular
export const PAY_LAYOUT = [
  [111.2, 12, [[72, 'PAY INCREASE FORM', 'b']]],
  [141.2, 11, [[72, 'Date:'], [101.4, '___________________'], [302.5, 'PC #:'], [331.9, '______________________']]],
  [185.7, 11, [[72, 'Employee Name:'], [165.5, '__________________________']]],
  [211.5, 11, [[72, 'Employee Position:'], [166.8, '__________________________']]],
  [237.3, 11, [[72, 'Current Pay Rate:'], [166.0, '__________________________']]],
  [263.1, 11, [[72, 'New Pay Rate:'], [165.5, '__________________________']]],
  [309.4, 9, [[231.9, 'Reason for Pay Change / Evaluation:', 'b']]],
  [431.1, 11, [[72, 'Store Manager Signature:'], [200.2, '_____________________________']]],
  [456.9, 11, [[72, 'District Manager Signature:'], [205.7, '_____________________________']]],
  [482.7, 11, [[72, 'Director of Operations Signature:'], [231.9, '_______________________']]],
  [545.2, 9, [[268.7, 'For Office Use Only', 'bi']]],
  [564.7, 9, [[157.0, 'Effective Date:']]],
  [584.2, 9, [[120.8, 'Effective Pay Rate Paycheck Date:']]],
  [603.7, 9, [[132.6, 'Payroll Manager Signature:']]],
];

// The template's 9 underscore blanks in reading order → the field written on each.
export const PAY_BLANK_FIELDS = ['date', 'pc', 'employeeName', 'position', 'currentRate', 'newRate', 'smSignature', 'dmSignature', 'directorSignature'];
export const PAY_SIGNATURE_FIELDS = new Set(['smSignature', 'dmSignature', 'directorSignature', 'payrollSignature']);

export function payBlanks() {
  const out = [];
  for (const [y, size, words] of PAY_LAYOUT) for (const [x, raw] of words) {
    if (/_{3,}/.test(raw)) out.push({ field: PAY_BLANK_FIELDS[out.length], y, x, raw, size });
  }
  return out;
}

// Ruled boxes, exactly as the template draws them (1pt lines; grey = inner rules).
const BLACK = [0, 0, 0], GREY_R = [204, 204, 204], GREY_O = [183, 183, 183];
export const PAY_BOXES = {
  reason: { left: 72.5, right: 540.5, top: 297.5, bottom: 364.5, rows: [315.5, 331.5, 348.5], headerRow: 315.5 },
  office: { left: 67.5, right: 545.5, top: 533.5, bottom: 609.5, split: 301.5, rows: [551.5, 570.5, 590.5] },
};
export const PAY_LINES = [
  // reason box
  { x1: 72.5, y1: 298, x2: 72.5, y2: 365, c: BLACK }, { x1: 540.5, y1: 298, x2: 540.5, y2: 365, c: BLACK },
  { x1: 72, y1: 297.5, x2: 540, y2: 297.5, c: BLACK },
  { x1: 72, y1: 315.5, x2: 540, y2: 315.5, c: GREY_R }, { x1: 72, y1: 331.5, x2: 540, y2: 331.5, c: GREY_R }, { x1: 72, y1: 348.5, x2: 540, y2: 348.5, c: GREY_R },
  { x1: 72, y1: 364.5, x2: 540, y2: 364.5, c: BLACK },
  // office box
  { x1: 67.5, y1: 533, x2: 67.5, y2: 610, c: BLACK }, { x1: 301.5, y1: 551, x2: 301.5, y2: 610, c: GREY_O }, { x1: 545.5, y1: 533, x2: 545.5, y2: 610, c: BLACK },
  { x1: 67, y1: 533.5, x2: 546, y2: 533.5, c: BLACK }, { x1: 67, y1: 551.5, x2: 546, y2: 551.5, c: BLACK },
  { x1: 67, y1: 570.5, x2: 546, y2: 570.5, c: GREY_O }, { x1: 67, y1: 590.5, x2: 546, y2: 590.5, c: GREY_O },
  { x1: 67, y1: 609.5, x2: 546, y2: 609.5, c: BLACK },
];

export const PAY_CHROME = {
  logo: { x: 229.5, y: 23.1, w: 108, h: 56.25, src: 'pcg-logo-form.jpg' },
  watermark: { x: 71, y: 190, size: 470, src: 'pcg-watermark.png' },
};
export const PAY_FONT = { family: 'Caladea', regular: 'Caladea-Regular.ttf', bold: 'Caladea-Bold.ttf', boldItalic: 'Caladea-BoldItalic.ttf' };

export const formatRate = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.]/g, '')); return String(v ?? '').trim() === '' || !Number.isFinite(n) ? '' : '$' + n.toFixed(2); };
export const formatFormDate = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v || ''); };

// Word-wrap `text` into lines no wider than `width` at the doc's current font/size.
function wrap(doc, text, width) {
  const lines = [];
  for (const para of String(text || '').split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (doc.getTextWidth(t) <= width || !line) line = t; else { lines.push(line); line = word; }
    }
    if (line) lines.push(line);
  }
  return lines;
}

// fonts: { regular, bold, boldItalic } base64 TTF. images: { logo (JPEG data URL), watermark (PNG data URL) }.
// values: { date, pc, employeeName, position, currentRate, newRate, reason, smSignature, dmSignature,
//           directorSignature, effectiveDate, paycheckDate, payrollSignature } — signatures as PNG data URLs.
export function buildPayIncreasePdf(jsPDF, fonts, values = {}, images = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const F = PAY_FONT.family;
  doc.addFileToVFS(PAY_FONT.regular, fonts.regular); doc.addFont(PAY_FONT.regular, F, 'normal');
  doc.addFileToVFS(PAY_FONT.bold, fonts.bold); doc.addFont(PAY_FONT.bold, F, 'bold');
  doc.addFileToVFS(PAY_FONT.boldItalic, fonts.boldItalic); doc.addFont(PAY_FONT.boldItalic, F, 'bolditalic');
  doc.setProperties({ title: 'Pay Increase Form', creator: 'PCG Portal' });
  const C = PAY_CHROME;
  if (images.watermark) doc.addImage(images.watermark, 'PNG', C.watermark.x, C.watermark.y, C.watermark.size, C.watermark.size, 'seal', 'FAST');
  if (images.logo) doc.addImage(images.logo, 'JPEG', C.logo.x, C.logo.y, C.logo.w, C.logo.h);

  doc.setTextColor(0, 0, 0);
  for (const [y, size, words] of PAY_LAYOUT) {
    doc.setFontSize(size);
    for (const [x, text, style] of words) { doc.setFont(F, style === 'b' ? 'bold' : style === 'bi' ? 'bolditalic' : 'normal'); doc.text(text, x, y); }
  }
  doc.setLineWidth(1);
  for (const l of PAY_LINES) { doc.setDrawColor(...l.c); doc.line(l.x1, l.y1, l.x2, l.y2); }

  const v = { ...values, date: formatFormDate(values.date), currentRate: formatRate(values.currentRate), newRate: formatRate(values.newRate) };
  const sign = (img, x, yLine, width, maxH) => {
    const p = doc.getImageProperties(img);
    const s = Math.min((width - 4) / p.width, maxH / p.height);
    doc.addImage(img, 'PNG', x + 4, yLine + 1 - p.height * s, p.width * s, p.height * s, undefined, 'FAST');
  };
  doc.setFont(F, 'normal');
  for (const { field, y, x, raw, size } of payBlanks()) {
    const text = String(v[field] ?? '').trim();
    if (!text) continue;
    doc.setFontSize(size);
    const width = doc.getTextWidth(raw);
    if (PAY_SIGNATURE_FIELDS.has(field)) { sign(text, x, y, width, 21); continue; }
    let s = size;
    while (s > 7 && (doc.setFontSize(s), doc.getTextWidth(text)) > width - 2) s -= 0.5;
    doc.setFontSize(s);
    doc.text(text, x + width / 2, y - 1.5, { align: 'center' });
  }

  // Reason: written on the box's three ruled rows (shrinks to fit, never below 7pt).
  const R = PAY_BOXES.reason;
  const rowsY = [R.rows[0], R.rows[1], R.rows[2], R.bottom];
  if (String(values.reason || '').trim()) {
    let s = 10, lines;
    for (;;) { doc.setFontSize(s); lines = wrap(doc, values.reason, R.right - R.left - 12); if (lines.length <= 3 || s <= 7) break; s -= 0.5; }
    if (lines.length > 3) lines = [...lines.slice(0, 2), lines.slice(2).join(' ')];
    lines.slice(0, 3).forEach((ln, i) => doc.text(ln, R.left + 6, rowsY[i + 1] - 4.5));
  }

  // For Office Use Only — values in the right-hand column.
  const O = PAY_BOXES.office;
  const cellX = O.split + (O.right - O.split) / 2;
  doc.setFontSize(9);
  if (values.effectiveDate) doc.text(formatFormDate(values.effectiveDate), cellX, 564.7, { align: 'center' });
  if (values.paycheckDate) doc.text(formatFormDate(values.paycheckDate), cellX, 584.2, { align: 'center' });
  if (values.payrollSignature) {
    const p = doc.getImageProperties(values.payrollSignature);
    const s = Math.min(160 / p.width, 16 / p.height);
    doc.addImage(values.payrollSignature, 'PNG', cellX - (p.width * s) / 2, 608 - p.height * s, p.width * s, p.height * s, undefined, 'FAST');
  }
  return doc;
}
