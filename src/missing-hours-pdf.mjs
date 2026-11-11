// src/missing-hours-pdf.mjs — HR's "Employee Missing Hours" form, drawn with jsPDF to follow the
// template (title, Employee Name / PC # / Pay Period lines, the 14-row Date · Clock In · Clock Out ·
// Total Hours table with its TOTAL HOURS row, and the signature + date line), with the PCG seal
// behind the page. Pure: no DOM, no fetch. Positions are jsPDF top-left points on US Letter.
import { usDate, fmtTime, fmtHours, MH_MAX_ROWS } from './missing-hours.mjs';

export const MH_CHROME = { watermark: { x: 71, y: 175, size: 470, src: 'pcg-watermark.png' } };
const COLS = [72, 189.4, 306.6, 423.8, 541];
const HEAD = { top: 258, bottom: 284 };
const ROW_H = 23.4;
export const MH_SIG = { lineY: 694, x0: 144, x1: 312, dateX0: 426, dateX1: 540 };

export function buildMissingHoursPdf(jsPDF, v = {}, opts = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  doc.setProperties({ title: 'Employee Missing Hours', creator: 'PCG Portal' });
  const W = MH_CHROME.watermark;
  if (opts.watermark) doc.addImage(opts.watermark, 'PNG', W.x, W.y, W.size, W.size, 'seal', 'FAST');
  doc.setTextColor(0, 0, 0);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.text('EMPLOYEE MISSING HOURS', 306, 90, { align: 'center' });

  const field = (y, label, value) => {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    doc.text(label, 72, y);
    const x0 = 72 + doc.getTextWidth(label) + 3;
    doc.setLineWidth(0.6); doc.line(x0, y + 2, 368, y + 2);
    if (value) { doc.setFont('helvetica', 'bold'); doc.text(String(value), x0 + 4, y - 1); }
  };
  field(150, 'Employee Name:', v.employeeName);
  field(183, 'PC #:', v.pc);
  field(216, 'Pay Period/Pay Date:', v.periodStart ? `${usDate(v.periodStart)} - ${usDate(v.periodEnd)}` : '');

  // Table
  const rows = (v.rows || []).slice(0, MH_MAX_ROWS);
  const bottom = HEAD.bottom + MH_MAX_ROWS * ROW_H;
  const totalBottom = bottom + 25;
  doc.setLineWidth(0.8);
  doc.rect(COLS[0], HEAD.top, COLS[4] - COLS[0], totalBottom - HEAD.top);
  doc.line(COLS[0], HEAD.bottom, COLS[4], HEAD.bottom);
  for (let i = 1; i <= MH_MAX_ROWS; i++) doc.line(COLS[0], HEAD.bottom + i * ROW_H, COLS[4], HEAD.bottom + i * ROW_H);
  for (const x of COLS.slice(1, 3)) doc.line(x, HEAD.top, x, bottom);
  doc.line(COLS[3], HEAD.top, COLS[3], totalBottom);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
  ['DATE', 'CLOCK IN', 'CLOCK OUT', 'TOTAL HOURS'].forEach((t, i) => doc.text(t, (COLS[i] + COLS[i + 1]) / 2, HEAD.top + 17, { align: 'center' }));
  doc.setFont('helvetica', 'normal');
  rows.forEach((r, i) => {
    const y = HEAD.bottom + i * ROW_H + 15.5;
    [usDate(r.date), fmtTime(r.clockIn), fmtTime(r.clockOut), fmtHours(r.hours)].forEach((t, c) => doc.text(t, (COLS[c] + COLS[c + 1]) / 2, y, { align: 'center' }));
  });
  doc.setFont('helvetica', 'bold');
  doc.text('TOTAL HOURS:', (COLS[0] + COLS[3]) / 2, bottom + 16.5, { align: 'center' });
  if (rows.length) doc.text(fmtHours(v.total || 0), (COLS[3] + COLS[4]) / 2, bottom + 16.5, { align: 'center' });

  if (v.reason) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    const lines = doc.splitTextToSize(`Notes: ${v.reason}`, COLS[4] - COLS[0]).slice(0, 3);
    doc.text(lines, 72, totalBottom + 20);
  }

  // Signature + date
  const S = MH_SIG;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  // v22.90: titled by who signs it (Store Manager / District Manager / Director of Operations / ...); the
  // line starts right after the title, like the Pay Increase form.
  const label = opts.signLabel || 'District Manager Signature:';
  doc.text(label, 72, S.lineY);
  const sx0 = Math.max(S.x0, 72 + doc.getTextWidth(label) + 4), sx1 = Math.min(388, Math.max(S.x1, sx0 + 140));
  doc.text('Date:', S.dateX0 - 30, S.lineY);
  doc.setLineWidth(0.6); doc.line(sx0, S.lineY + 2, sx1, S.lineY + 2); doc.line(S.dateX0, S.lineY + 2, S.dateX1, S.lineY + 2);
  if (v.signature) {
    const p = doc.getImageProperties(v.signature);
    const s = Math.min((sx1 - sx0 - 8) / p.width, 30 / p.height);
    doc.addImage(v.signature, 'PNG', sx0 + 4, S.lineY - p.height * s, p.width * s, p.height * s, undefined, 'FAST');
  }
  if (v.signedDate) doc.text(usDate(v.signedDate), (S.dateX0 + S.dateX1) / 2, S.lineY - 2, { align: 'center' });
  if (v.signerName) { doc.setFontSize(9); doc.setTextColor(80, 80, 80); doc.text(v.signerName, sx0 + 4, S.lineY + 13); doc.setTextColor(0, 0, 0); }
  return doc;
}
