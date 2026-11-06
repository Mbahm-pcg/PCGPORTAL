// src/transfer-notice-pdf.mjs — PCG Employee Transfer letter, drawn to match HR's
// "PCG TRANSFER LETTER TEMPLATE.pdf" (Google Docs, Cambria 12pt, US Letter) exactly.
// Every word sits at the x / baseline the template uses (measured from the template
// itself), in Caladea — the open font with Cambria's exact letter widths — so the
// lines break and justify identically. Filled-in values are written on the blanks;
// the blanks stay underlined, like a typed-in form. Pure: no DOM, no fetch.

// [baseline from top (pt), [[x (pt), text, italic?], ...]] — the template, word by word.
export const TRANSFER_LAYOUT = [
  [83.4, [[72, "Date:"], [101.41, "_______________________"]]],
  [115.76, [[72, "People"], [109.24, "Capital"], [147.68, "Group"], [182.11, "LLC"]]],
  [131.94, [[72, "ATTN:"], [106.97, "Human"], [147.02, "Resources"], [202, "Department"]]],
  [148.12, [[72, "Subject:"], [115.35, "Employee"], [168.53, "Transfer"]]],
  [196.65, [[72, "I,"], [83.99, "________________________________________("], [266.47, "Employee", 1], [320.44, "Name", 1], [349.88, "),"], [361.81, "am"], [382.55, "requesting"], [442.3, "to"], [457.52, "resign"], [494.17, "from"], [523.83, "my"]]],
  [217.76, [[72, "current"], [112.92, "position"], [157.56, "as"], [171.22, "a"], [179.72, "________________________("], [291.04, "position", 1], [333.81, "title", 1], [353.94, "),"], [363.63, "located"], [403.51, "at"], [416.07, "PC#"], [439.71, "____________,"], [498.18, "in"], [510.86, "order"]]],
  [238.86, [[72, "to"], [86.47, "voluntaril"], [136.46, "y"], [146.65, "transfer"], [191.63, "to"], [205.35, "a"], [214.6, "better"], [249.25, "opportunity"], [314.51, "within"], [351.25, "the"], [371.17, "compan"], [411.81, "y"], [421.25, "located"], [461.89, "at"], [475.2, "PC#"], [499.59, "_________"]]],
  [259.96, [[72, "as"], [90.16, "a"], [103.16, "________________________("], [214.48, "position", 1], [261.76, "title", 1], [281.88, ")."], [296.07, "I"], [307.1, "request"], [353.14, "that"], [380.89, "my"], [403.08, "___________"], [458.39, "("], [462.97, "full/part", 1], [512.95, "time", 1], [535.41, ")"]]],
  [281.06, [[72, "employment"], [139.25, "is"], [150.38, "effective"], [195.96, "starting"], [238.66, "___________________("], [327.74, "effective", 1], [371.84, "date", 1], [393.98, ")."]]],
  [323.27, [[72, "I"], [87.53, "acknowledge"], [165.6, "that"], [197.1, "I"], [211.88, "will"], [241.92, "now"], [275.11, "report"], [318.71, "to"], [339.93, "_____________________("], [437.9, "supervisor", 1], [500.99, "name", 1], [528.79, ")/"]]],
  [344.37, [[72, "_____________________("], [169.97, "supervisor", 1], [227.06, "title", 1], [247.19, ")."], [259.13, "I"], [267.91, "also"], [293.44, "acknowledge"], [365.51, "that"], [391.01, "I"], [399.79, "will"], [423.83, "be"], [440.39, "compensat"], [496.23, "ed"], [512.88, "at"], [526.95, "an"]]],
  [365.47, [[72, "hourly"], [108.23, "wage"], [137.58, "of"], [150.23, "___________"], [201.79, "per"], [221.92, "hour"], [249.15, "and"], [271, "paid"], [296.17, "on"], [311.88, "a"], [320.38, "biweekly"], [368.92, "basis."]]],
  [402.75, [[72, "I"], [80.03, "ACCEPT"], [125.72, "THE"], [152.12, "ABOVE"], [192.86, "CONDITIONS"], [264.49, "AND"], [292.21, "AM"], [313.62, "INDICATING"], [381.67, "MY"], [402.45, "ACCEPTANCE"], [476.48, "BY"], [494.59, "SIGNING"]]],
  [418.93, [[72, "THIS"], [99.84, "LETTER"], [144.4, "AND"], [170.63, "RETURNING"], [237.53, "IT"], [251.17, "VIA"], [272.43, "EMAIL"], [309.56, "TO"], [326.99, "THE"], [351.89, "HUMAN"], [395.98, "RESOUR"], [439.12, "CES"], [461.37, "DEPARTMENT."]]],
  [451.29, [[72, "Employee"], [125.17, "Name:"], [160.85, "_____________________________________"]]],
  [483.65, [[72, "Employee"], [125.17, "Signatur"], [168.42, "e:"], [180.08, "____________________________________"]]],
  [516, [[72, "Date:"], [101.41, "________________________"]]],
  [564.54, [[72, "ACCEPTED"], [131.03, "AND"], [157.25, "APPROVED"], [217.95, "BY:"]]],
  [596.9, [[72, "District"], [112.78, "Manager"], [160.37, "Name:"], [196.04, "_____________________________________"]]],
  [629.25, [[72, "District"], [112.78, "Manager"], [160.37, "Signatur"], [203.62, "e:"], [215.28, "_____________________________________"]]],
  [661.61, [[72, "Date:"], [101.41, "________________________"]]],
];

// The template's 17 blanks (underscore runs), in reading order → the field written on
// each. null = left for a pen (signatures and their dates).
export const TRANSFER_BLANK_FIELDS = [
  'date', 'employeeName', 'fromTitle', 'fromPC', 'toPC', 'toTitle', 'employmentType',
  'effectiveDate', 'supervisorName', 'supervisorTitle', 'hourlyWage',
  'employeeName', null, null, 'dmName', null, null,
];

// [{ field, y, x, raw }] for every underscore run in TRANSFER_LAYOUT, in reading order.
export function transferBlanks() {
  const out = [];
  for (const [y, words] of TRANSFER_LAYOUT) for (const [x, raw] of words) {
    if (/_{3,}/.test(raw)) out.push({ field: TRANSFER_BLANK_FIELDS[out.length], y, x, raw });
  }
  return out;
}

export const TRANSFER_FONT = { family: 'Caladea', regular: 'Caladea-Regular.ttf', italic: 'Caladea-Italic.ttf' };

// '15' / 15 / '$15' → '$15.00'; blank stays blank.
export function formatWage(v) {
  const n = Number(String(v ?? '').replace(/[^0-9.]/g, ''));
  return String(v ?? '').trim() === '' || !Number.isFinite(n) ? '' : '$' + n.toFixed(2);
}

// '2026-11-06' → '11/06/2026' (anything else is printed as typed).
export function formatLetterDate(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v || '');
}

// jsPDF: the jsPDF constructor. fonts: { regular, italic } as base64 TTF strings.
// values: { date, employeeName, fromTitle, fromPC, toPC, toTitle, employmentType,
//           effectiveDate, supervisorName, supervisorTitle, hourlyWage, dmName }.
export function buildTransferNoticePdf(jsPDF, fonts, values = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  doc.addFileToVFS(TRANSFER_FONT.regular, fonts.regular);
  doc.addFont(TRANSFER_FONT.regular, TRANSFER_FONT.family, 'normal');
  doc.addFileToVFS(TRANSFER_FONT.italic, fonts.italic);
  doc.addFont(TRANSFER_FONT.italic, TRANSFER_FONT.family, 'italic');
  doc.setProperties({ title: 'Employee Transfer', creator: 'PCG Portal' });
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(12);

  for (const [y, words] of TRANSFER_LAYOUT) {
    for (const [x, text, italic] of words) {
      doc.setFont(TRANSFER_FONT.family, italic ? 'italic' : 'normal');
      doc.text(text, x, y);
    }
  }

  const v = { ...values, date: formatLetterDate(values.date), effectiveDate: formatLetterDate(values.effectiveDate), hourlyWage: formatWage(values.hourlyWage) };
  doc.setFont(TRANSFER_FONT.family, 'normal');
  for (const { field, y, x, raw } of transferBlanks()) {
    const text = field ? String(v[field] ?? '').trim() : '';
    if (!text) continue;
    const lead = raw.indexOf('_');
    const run = raw.match(/_+/)[0];
    doc.setFontSize(12);
    const x0 = x + doc.getTextWidth(raw.slice(0, lead));
    const width = doc.getTextWidth(run);
    // Shrink a long value to fit its blank (never below 7pt), centered on the line.
    let size = 12;
    while (size > 7 && (doc.setFontSize(size), doc.getTextWidth(text)) > width - 2) size -= 0.5;
    doc.setFontSize(size);
    doc.text(text, x0 + width / 2, y - 1.5, { align: 'center' });
  }
  doc.setFontSize(12);
  return doc;
}
