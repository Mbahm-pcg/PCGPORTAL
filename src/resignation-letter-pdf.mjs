// src/resignation-letter-pdf.mjs — HR's "Resignation Letter" (PCG letterhead), drawn with jsPDF to
// follow the template: logo at the top, HR address block, "Dear HR Administrator:", the resignation
// paragraph with the filled-in values underlined, then the employee's and the supervisor's signature
// blocks. The PCG seal sits behind the page like the Violation Notice. Pure: no DOM, no fetch.
// RES_SPOTS (jsPDF top-left points) is where a remote employee signature is stamped by
// violation-sign.mjs — keep them in step with the drawing below.
import { usDate } from './resignation-letter.mjs';

export const RES_FONT = { family: 'Caladea', regular: 'Caladea-Regular.ttf', bold: 'Caladea-Bold.ttf' };
export const RES_CHROME = { logo: { src: 'pcg-logo-form.jpg', x: 246, y: 26, w: 120, h: 62 }, watermark: { x: 71, y: 175, size: 470, src: 'pcg-watermark.png' } };

const L = 72, R = 540;            // text margins
const SIG = { x0: 72, x1: 276, dx0: 316, dx1: 430 };
export const RES_Y = { sig: 452, print: 494, supSig: 610, supPrint: 652 };
// Employee signature + date (stamped remotely): image inside x0..x1 sitting on `baseline`, date centred on dateX.
export const RES_SPOTS = { employee: { x0: SIG.x0, x1: SIG.x1, baseline: RES_Y.sig, dateX: (SIG.dx0 + SIG.dx1) / 2, dateY: RES_Y.sig - 3, auditY: 22, label: 'Employee' } };

export function buildResignationPdf(jsPDF, fonts, v = {}, opts = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const F = RES_FONT.family;
  doc.addFileToVFS(RES_FONT.regular, fonts.regular); doc.addFont(RES_FONT.regular, F, 'normal');
  doc.addFileToVFS(RES_FONT.bold, fonts.bold); doc.addFont(RES_FONT.bold, F, 'bold');
  doc.setProperties({ title: 'Resignation Letter', creator: 'PCG Portal' });
  const W = RES_CHROME.watermark;
  if (opts.watermark) doc.addImage(opts.watermark, 'PNG', W.x, W.y, W.size, W.size, 'seal', 'FAST');
  const Lg = RES_CHROME.logo;
  if (opts.logo) doc.addImage(opts.logo, 'JPEG', Lg.x, Lg.y, Lg.w, Lg.h, 'logo', 'FAST');

  doc.setTextColor(0, 0, 0); doc.setFont(F, 'normal'); doc.setFontSize(12);
  ['People Capital Group LLC', 'Human Resources Department', '2200 Michener St STE 4 Philadelphia, PA 19115'].forEach((t, i) => doc.text(t, L, 128 + i * 16));
  doc.text('Dear HR Administrator:', L, 206);

  // The paragraph: plain words and filled-in values (underlined), wrapped to the margins.
  const segs = [
    ['Please accept this letter as a formal notification that I am voluntarily resigning from my position as a Dunkin’ Donuts'],
    [v.position || ' ', 1], ['(position) at PC#'], [v.pc || ' ', 1], [', located at'], [v.storeAddress || ' ', 1],
    ['(store address). I understand that two weeks’ notice is standard. I would appreciate it if you release me from my employment with the Company effective'],
    [usDate(v.lastDay) || ' ', 1], ['(last day of employment).'],
  ];
  const words = [];
  for (const [t, u] of segs) {
    if (u) words.push({ t: String(t).trim() || '        ', u: true });
    else for (const w of String(t).split(/\s+/).filter(Boolean)) words.push({ t: w, u: false });
  }
  let x = L, y = 254; const lh = 21, space = doc.getTextWidth(' ');
  words.forEach((w) => {
    const glue = !w.u && /^[,.]/.test(w.t); // ", located at" sits right after the PC#
    const width = doc.getTextWidth(w.t) + (w.u ? 8 : 0);
    if (x > L && x + (glue ? 0 : space) + width > R) { x = L; y += lh; }
    else if (x > L && !glue) x += space;
    else if (glue) x -= 3; // the underline's right padding
    if (w.u) { doc.text(w.t, x + 4, y); doc.setLineWidth(0.6); doc.line(x, y + 2.5, x + width, y + 2.5); }
    else doc.text(w.t, x, y);
    x += width;
  });

  doc.text('Sincerely,', L, 392);
  const sigBlock = (yy, image, date, sigLabel, dateLabel, title = '') => {
    doc.setLineWidth(0.7);
    doc.line(SIG.x0, yy, SIG.x1, yy); doc.line(SIG.dx0, yy, SIG.dx1, yy);
    doc.setFontSize(12); doc.text(sigLabel, SIG.x0, yy + 14); doc.text(dateLabel, SIG.dx0 + 20, yy + 14);
    let tw = 0;
    if (title) { doc.setFontSize(9); tw = doc.getTextWidth(title) + 6; doc.text(title, SIG.x1 - 2, yy - 3, { align: 'right' }); doc.setFontSize(12); }
    if (image) {
      const p = doc.getImageProperties(image);
      const s = Math.min((SIG.x1 - SIG.x0 - 8 - tw) / p.width, 30 / p.height);
      doc.addImage(image, 'PNG', SIG.x0 + 4, yy - 1 - p.height * s, p.width * s, p.height * s, undefined, 'FAST');
    }
    if (date) doc.text(usDate(date), (SIG.dx0 + SIG.dx1) / 2, yy - 3, { align: 'center' });
  };
  const printBlock = (yy, name, label) => {
    doc.setLineWidth(0.7); doc.line(SIG.x0, yy, SIG.x1 + 60, yy);
    doc.setFontSize(12); doc.text(label, SIG.x0, yy + 14);
    if (name) doc.text(name, SIG.x0 + 4, yy - 4);
  };
  sigBlock(RES_Y.sig, v.employeeSignature, v.employeeSignature ? v.employeeSignedDate : '', '(Signature)', '(Date)');
  printBlock(RES_Y.print, v.employeeName, '(Print Name)');
  doc.text('Acknowledged by:', L, 568);
  sigBlock(RES_Y.supSig, v.supervisorSignature, v.supervisorSignature ? v.supervisorSignedDate : '', '(Supervisor Signature / Title)', '(Date)', v.supervisorTitle ? `/ ${v.supervisorTitle}` : '');
  printBlock(RES_Y.supPrint, v.supervisorName, '(Supervisor - Print Name)');
  return doc;
}
