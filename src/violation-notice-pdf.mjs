// src/violation-notice-pdf.mjs — PCG "Violation Notice" (2026), drawn to match HR's
// "2026 New Violation Notice.pdf" exactly: every word at the x / baseline / size / weight the
// template uses (measured from it), the heading underlines and grey writing lines it draws, in
// Caladea (Cambria's exact letter widths). Filled values sit on their blanks; checked boxes get an
// "X" on their ____; the PCG seal is behind the page (user, 2026-11-10). Pure: no DOM, no fetch.

// [baseline from top (pt), size, [[x, text, bold?], ...]] — measured from the template.
export const VIO_LAYOUT = [
  [52.15, 15, [[250.89, "Violation", 1], [317.29, "Notice", 1]]],
  [68.42, 10, [[36, "Employee", 1], [83.03, "Information:", 1]]],
  [93.09, 9, [[36, "Employee", 1], [78.35, "Name:", 1], [106.56, "__________________________________________________"], [277.3, "Job", 1], [292.79, "Title:", 1], [314.73, "_______________________________________________"], [473.48, "PC#:", 1], [494.16, "_____________________"]]],
  [117.36, 9, [[36, "Supervisor:", 1], [85.81, "_________________________________________________________"], [277.91, "Date:", 1], [301.51, "___________________________________"]]],
  [142.57, 10, [[36, "Type", 1], [60.93, "of", 1], [72.08, "Violation", 1], [116.33, "Notice:", 1]]],
  [167.24, 9, [[36, "_____"], [54.66, "First"], [74.61, "Violation"], [111.48, "Notice"], [150.16, "_____"], [168.82, "Second"], [198.42, "Violation"], [235.29, "Notice"], [271.99, "_____"], [290.65, "Third"], [314.02, "Violation"], [350.89, "Notice"], [391.55, "_____"], [410.21, "Ongoing"], [444.29, "Violation"], [481.17, "Notice"]]],
  [193.41, 10, [[36, "Type", 1], [60.93, "of", 1], [72.08, "Violation:", 1]]],
  [218.47, 9, [[36, "_____"], [54.66, "Tardiness/Lea"], [109.77, "ving"], [128.25, "Early"], [156.23, "_____"], [174.89, "Absenteeism"], [228.2, "or"], [238.68, "No"], [251.57, "Call"], [267.9, "No"], [280.78, "Show"], [315.79, "_____"], [334.45, "Insubor"], [364.52, "dination"], [406.68, "_____"], [425.34, "Cash"], [445.61, "Handling"], [482.6, "Procedure"]]],
  [230.61, 9, [[36, "_____"], [54.66, "Employee"], [94.54, "Conduct"], [138.27, "_____"], [156.93, "Workplace"], [199.99, "Policy"], [225.14, "(safety,"], [254.5, "uniform,"], [289.42, "sanitation,"], [331.82, "etc.)"]]],
  [256.77, 10, [[36, "Description", 1], [92.07, "of", 1], [103.22, "Violation:", 1], [256.59, "Date", 1], [280, "of", 1], [291.15, "Violation:", 1], [338.42, "________________________________"]]],
  [377.93, 10, [[36, "Disciplinary", 1], [94.3, "Action", 1], [126.09, "Taken:", 1]]],
  [404.89, 9, [[36, "_____"], [54.88, "Verbal"], [81.51, "Warning"], [122.44, "_____"], [141.1, "Written"], [172.81, "Warning"], [211.76, "_____"], [230.42, "Termination"], [279.87, "_____"], [298.53, "Suspension"], [344.4, "(Start"], [368.49, "Date:____________"], [432.56, "Return"], [461.12, "to"], [470.84, "Work"], [493.76, "Date"], [513.45, "____________"], [555.46, ")"]]],
  [428.37, 10, [[36, "Plans", 1], [63.39, "for", 1], [79.15, "Improvement", 1], [143.87, "(If", 1], [156.91, "Applicable):", 1]]],
  [495.78, 10, [[36, "Consequences", 1], [103.21, "of", 1], [114.37, "Further", 1], [152.05, "Policy", 1], [182.04, "Violation:", 1]]],
  [549.71, 10, [[36, "Acknowledgment:", 1]]],
  [574.38, 9, [[36, "By"], [47.93, "signing"], [77.72, "this"], [94.08, "form,"], [116.51, "you"], [132.6, "confirm"], [164.79, "that"], [182.22, "you"], [198.31, "understand"], [244.71, "the"], [259.09, "information"], [306.94, "on"], [318.72, "this"], [335.08, "violation."], [372.91, "You"], [388.98, "also"], [406.44, "confirm"], [438.63, "that"], [456.06, "you"], [472.15, "and"], [488.54, "your"], [508.35, "manager"], [544.19, "have"]]],
  [586.51, 9, [[36, "discussed"], [75.4, "the"], [89.78, "violation"], [125.76, "and"], [142.15, "plan"], [161, "for"], [174.09, "improvement."], [229.98, "Signing"], [260.37, "this"], [276.73, "form"], [297.31, "does"], [317.32, "not"], [332.15, "necessaril"], [370.53, "y"], [377.05, "indicate"], [409.77, "that"], [427.2, "you"], [443.29, "agree"], [466.48, "with"], [485.95, "this"], [502.31, "violation."], [540.13, "If"], [547.76, "you"]]],
  [598.65, 9, [[36, "are"], [50.36, "provided"], [86.99, "this"], [103.35, "notice"], [129.04, "by"], [140.35, "email,"], [165.39, "it"], [172.92, "is"], [181.27, "not"], [196.1, "necessary"], [236.24, "for"], [249.33, "the"], [263.72, "employee"], [302.81, "to"], [312.53, "sign"], [330.35, "the"], [344.74, "acknowledgement"], [417.05, "as"], [427.29, "the"], [441.68, "email"], [464.88, "serves"], [491.45, "as"], [501.7, "a"], [508.07, "formal"]]],
  [610.78, 9, [[36, "acknowledgment"], [102.07, "."]]],
  [649.88, 9, [[36, "Employee", 1], [78.35, "-", 1], [85.34, "Name:", 1], [113.56, "______________________________________________"], [272.94, "Signatur", 1], [308, "e:", 1], [317.27, "_______________________________________________"], [478, "Date:", 1], [501.6, "______________________"]]],
  [681.53, 9, [[36, "Supervisor", 1], [83.29, "-", 1], [90.29, "Name:", 1], [118.51, "_____________________________________________"], [272.57, "Signatur", 1], [307.63, "e:", 1], [316.9, "_______________________________________________"], [477.63, "Date:", 1], [501.23, "______________________"]]],
  [713.19, 9, [[36, "Witness", 1], [71.22, "-", 1], [78.22, "Name:", 1], [106.44, "______________________________________________"], [265.81, "Signatur", 1], [300.87, "e:", 1], [310.15, "_______________________________________________"], [470.88, "Date:", 1], [494.48, "______________________"]]],
];

// Heading underlines (black) and the grey writing lines, as the template draws them (1pt).
const BLACK = [0, 0, 0], GREY = [136, 136, 136];
export const VIO_LINES = [
  [251, 53.5, 361], [36, 69.5, 142], [36, 143.5, 148], [36, 194.5, 117], [36, 257.5, 148], [257, 257.5, 336],
  [36, 379.5, 157], [36, 429.5, 213], [36, 496.5, 227], [36, 550.5, 119], [36, 650.5, 76], [36, 682.5, 81], [36, 714.5, 69],
].map(([x1, y, x2]) => ({ x1, y, x2, c: BLACK }))
  .concat([280.5, 304.5, 327.5, 351.5, 453.5, 480.5, 521.5].map(y => ({ x1: 39, y, x2: 573, c: GREY })));

// The writing lines each free-text answer is written on.
export const VIO_TEXT_LINES = { description: [280.5, 304.5, 327.5, 351.5], improvement: [453.5, 480.5], consequences: [521.5] };

// Underscore blanks in reading order → the field written on each. A "check" field gets an X.
export const VIO_BLANK_FIELDS = [
  'employeeName', 'jobTitle', 'pc',
  'supervisor', 'date',
  'notice:first', 'notice:second', 'notice:third', 'notice:ongoing',
  'type:tardiness', 'type:absenteeism', 'type:insubordination', 'type:cash',
  'type:conduct', 'type:policy',
  'violationDate',
  'action:verbal', 'action:written', 'action:termination', 'action:suspension', 'suspensionStart', 'suspensionReturn',
  'employeeName2', 'employeeSignature', 'employeeSignedDate',
  'supervisorName', 'supervisorSignature', 'supervisorSignedDate',
  'witnessName', 'witnessSignature', 'witnessSignedDate',
];
export const VIO_SIGNATURE_FIELDS = new Set(['employeeSignature', 'supervisorSignature', 'witnessSignature']);

// [{ field, y, x, run, size }] — x/run are the underscore run itself (for "Date:____", the part after the label).
export function vioBlanks() {
  const out = [];
  for (const [y, size, words] of VIO_LAYOUT) for (const [x, raw] of words) {
    const m = /_{3,}/.exec(raw);
    if (!m) continue;
    out.push({ field: VIO_BLANK_FIELDS[out.length], y, x, prefix: raw.slice(0, m.index), run: m[0], size });
  }
  return out;
}

export const VIO_CHROME = { watermark: { x: 71, y: 175, size: 470, src: 'pcg-watermark.png' } };
export const VIO_FONT = { family: 'Caladea', regular: 'Caladea-Regular.ttf', bold: 'Caladea-Bold.ttf' };
export const formatVioDate = (v) => { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v || ''); };

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

// values: { employeeName, jobTitle, pc, supervisor, date, notice: 'first'|'second'|'third'|'ongoing',
//   types: ['tardiness', ...], action: 'verbal'|'written'|'termination'|'suspension', suspensionStart,
//   suspensionReturn, violationDate, description, improvement, consequences, supervisorName,
//   witnessName, employeeSignature, employeeSignedDate, employeeRefused, supervisorSignature,
//   supervisorSignedDate, witnessSignature, witnessSignedDate } — signatures as PNG data URLs.
// fonts: { regular, bold } base64 TTF. opts.watermark: PNG data URL.
export function buildViolationPdf(jsPDF, fonts, values = {}, opts = {}) {
  const doc = new jsPDF({ unit: 'pt', format: 'letter', orientation: 'portrait' });
  const F = VIO_FONT.family;
  doc.addFileToVFS(VIO_FONT.regular, fonts.regular); doc.addFont(VIO_FONT.regular, F, 'normal');
  doc.addFileToVFS(VIO_FONT.bold, fonts.bold); doc.addFont(VIO_FONT.bold, F, 'bold');
  doc.setProperties({ title: 'Violation Notice', creator: 'PCG Portal' });
  const W = VIO_CHROME.watermark;
  if (opts.watermark) doc.addImage(opts.watermark, 'PNG', W.x, W.y, W.size, W.size, 'seal', 'FAST');

  doc.setTextColor(0, 0, 0);
  for (const [y, size, words] of VIO_LAYOUT) {
    doc.setFontSize(size);
    for (const [x, text, bold] of words) { doc.setFont(F, bold ? 'bold' : 'normal'); doc.text(text, x, y); }
  }
  doc.setLineWidth(1);
  for (const l of VIO_LINES) { doc.setDrawColor(...l.c); doc.line(l.x1, l.y, l.x2, l.y); }

  const v = values;
  const checked = (f) => {
    const [group, key] = f.split(':');
    if (group === 'notice') return v.notice === key;
    if (group === 'type') return (v.types || []).includes(key);
    if (group === 'action') return v.action === key;
    return false;
  };
  const text = {
    employeeName: v.employeeName, jobTitle: v.jobTitle, pc: v.pc, supervisor: v.supervisor, date: formatVioDate(v.date),
    violationDate: formatVioDate(v.violationDate), suspensionStart: v.action === 'suspension' ? formatVioDate(v.suspensionStart) : '',
    suspensionReturn: v.action === 'suspension' ? formatVioDate(v.suspensionReturn) : '',
    employeeName2: v.employeeName, employeeSignedDate: formatVioDate(v.employeeSignedDate),
    supervisorName: v.supervisorName, supervisorSignedDate: formatVioDate(v.supervisorSignedDate),
    witnessName: v.witnessName, witnessSignedDate: formatVioDate(v.witnessSignedDate),
  };
  doc.setFont(F, 'normal');
  for (const { field, y, x, prefix, run, size } of vioBlanks()) {
    doc.setFontSize(size);
    const x0 = x + doc.getTextWidth(prefix);
    const width = doc.getTextWidth(run);
    if (field.includes(':')) {
      if (!checked(field)) continue;
      doc.setFont(F, 'bold'); doc.text('X', x0 + width / 2, y - 1, { align: 'center' }); doc.setFont(F, 'normal');
      continue;
    }
    if (VIO_SIGNATURE_FIELDS.has(field)) {
      const img = v[field];
      if (field === 'employeeSignature' && !img && v.employeeRefused) {
        doc.setFont(F, 'normal'); doc.text('Refused to sign', x0 + width / 2, y - 1.5, { align: 'center' });
        continue;
      }
      if (!img) continue;
      const p = doc.getImageProperties(img);
      const s = Math.min((width - 4) / p.width, 22 / p.height);
      doc.addImage(img, 'PNG', x0 + 4, y + 1 - p.height * s, p.width * s, p.height * s, undefined, 'FAST');
      continue;
    }
    const t = String(text[field] ?? '').trim();
    if (!t) continue;
    let sz = size;
    while (sz > 6 && (doc.setFontSize(sz), doc.getTextWidth(t)) > width - 2) sz -= 0.5;
    doc.setFontSize(sz);
    doc.text(t, x0 + width / 2, y - 1.5, { align: 'center' });
  }

  // Free text, written on the grey lines (shrinks to fit the lines, never below 7pt).
  for (const [key, ys] of Object.entries(VIO_TEXT_LINES)) {
    const t = String(v[key] || '').trim();
    if (!t) continue;
    let sz = 10, lines;
    for (;;) { doc.setFontSize(sz); lines = wrap(doc, t, 573 - 41 - 4); if (lines.length <= ys.length || sz <= 7) break; sz -= 0.5; }
    if (lines.length > ys.length) lines = [...lines.slice(0, ys.length - 1), lines.slice(ys.length - 1).join(' ')];
    lines.forEach((ln, i) => doc.text(ln, 41, ys[i] - 3));
  }
  doc.setFontSize(10);
  return doc;
}
