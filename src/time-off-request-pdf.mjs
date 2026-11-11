// src/time-off-request-pdf.mjs — PCG "Time Off Request Form" PDF (v22.80). HR's old version was a
// Google Form, so there is no paper template to copy: this is a branded PCG form in the same family
// as Pay Increase / Violation Notice — the PCG logo, the seal behind the page, Caladea, labelled
// rows on ruled lines, the employee's drawn signature. Pure: no DOM, no fetch.
import { usDate, usTime, leaveLabel } from './time-off-request.mjs';

export const TOR_FONT = { family: 'Caladea', regular: 'Caladea-Regular.ttf', bold: 'Caladea-Bold.ttf' };
export const TOR_CHROME = { logo: { x: 252, y: 30, w: 108, h: 56.25, src: 'pcg-logo-form.jpg' }, watermark: { x: 71, y: 200, size: 470, src: 'pcg-watermark.png' } };
const L = 54, R = 558, LABEL_W = 178;

// values: timeOffValues(...) + { balances: [{ type, current }] } ; fonts: { regular, bold } base64;
// images: { logo (JPEG data URL), watermark (PNG data URL) }.
export function buildTimeOffPdf(jsPDF, fonts, v = {}, images = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const F = TOR_FONT.family;
  doc.addFileToVFS(TOR_FONT.regular, fonts.regular); doc.addFont(TOR_FONT.regular, F, 'normal');
  doc.addFileToVFS(TOR_FONT.bold, fonts.bold); doc.addFont(TOR_FONT.bold, F, 'bold');
  doc.setProperties({ title: 'Time Off Request Form', creator: 'PCG Portal' });
  const C = TOR_CHROME;
  if (images.watermark) doc.addImage(images.watermark, 'PNG', C.watermark.x, C.watermark.y, C.watermark.size, C.watermark.size, 'seal', 'FAST');
  if (images.logo) doc.addImage(images.logo, 'JPEG', C.logo.x, C.logo.y, C.logo.w, C.logo.h);

  doc.setTextColor(0, 0, 0);
  doc.setFont(F, 'bold'); doc.setFontSize(16);
  doc.text('TIME OFF REQUEST FORM', 306, 112, { align: 'center' });
  doc.setFont(F, 'normal'); doc.setFontSize(9.5); doc.setTextColor(70, 70, 70);
  doc.text(`Submitted ${usDate(v.date)}`, 306, 126, { align: 'center' });
  doc.setTextColor(0, 0, 0);

  let y = 152;
  const section = (title) => {
    y += 8;
    doc.setFont(F, 'bold'); doc.setFontSize(11);
    doc.text(title, L, y);
    doc.setDrawColor(0, 0, 0); doc.setLineWidth(1); doc.line(L, y + 3, L + doc.getTextWidth(title), y + 3);
    y += 20;
  };
  const row = (label, value) => {
    doc.setFont(F, 'bold'); doc.setFontSize(10);
    doc.text(label, L, y);
    doc.setFont(F, 'normal');
    const x0 = L + LABEL_W, w = R - x0;
    let text = String(value ?? ''), sz = 10;
    while (sz > 7 && (doc.setFontSize(sz), doc.getTextWidth(text)) > w - 4) sz -= 0.5;
    doc.setFontSize(sz);
    doc.text(text, x0 + 3, y - 1);
    doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.6); doc.line(x0, y + 2.5, R, y + 2.5);
    y += 20;
  };

  section('Employee Information');
  row('Employee Name:', v.employeeName);
  row('Email:', v.email);
  row('Phone Number:', v.phone);
  row('Address:', v.address);
  row('Job Position:', v.position);
  row('Location:', v.location);

  section('Emergency Contact');
  row('Name and Relation:', v.ecName);
  row('Phone Number:', v.ecPhone);
  row('Email Address:', v.ecEmail);
  row('Authorization:', v.ecAuthorized ? 'Yes, I authorize my emergency contact to be contacted via phone, text, or email' : 'No, I do not authorize my emergency contact to be contacted');

  section('Time Off Request');
  row('Start:', `${usDate(v.startDate)}  ${usTime(v.startTime)}`);
  row('Back to Work:', `${usDate(v.returnDate)}  ${usTime(v.returnTime)}`);
  row('Total Hours Requested:', String(v.totalHours ?? ''));
  row('Type of Leave:', leaveLabel(v));
  row('Last Date Worked:', usDate(v.lastWorked));
  if ((v.balances || []).length) row('Paycor Balance (hours):', v.balances.map(b => `${b.type}: ${b.current ?? '—'}`).join('   '));
  if ((v.documents || []).length) row('Supporting Documents:', v.documents.join(', '));

  section('Signature');
  doc.setFont(F, 'bold'); doc.setFontSize(10);
  doc.text('Employee Signature:', L, y + 14);
  const sx = L + LABEL_W;
  doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.8); doc.line(sx, y + 17, sx + 200, y + 17);
  if (v.signature) {
    const p = doc.getImageProperties(v.signature);
    const s = Math.min(196 / p.width, 30 / p.height);
    doc.addImage(v.signature, 'PNG', sx + 3, y + 16 - p.height * s, p.width * s, p.height * s, undefined, 'FAST');
  }
  doc.text('Date:', sx + 220, y + 14);
  doc.setFont(F, 'normal'); doc.text(usDate(v.signedDate), sx + 252, y + 13);
  doc.line(sx + 248, y + 17, R, y + 17);

  doc.setFontSize(8.5); doc.setTextColor(90, 90, 90);
  doc.text('Please allow 24–48 hours for Human Resources to confirm your request.', 306, 752, { align: 'center' });
  doc.setTextColor(0, 0, 0);
  return doc;
}
