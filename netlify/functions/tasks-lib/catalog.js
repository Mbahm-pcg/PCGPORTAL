// catalog.js — starter task-template catalog for the Ops Task & Checklist system.
// Reverse-engineered from the Workpulse "Book Task" admin (see
// docs/TASK_CHECKLIST_SYSTEM_PLAN.md). This is a representative starter set used by the
// `seed` action so the UI has data immediately; the full ~229-task catalog is loaded
// later from an authoritative export. Exec/IT can add/edit/assign via the admin UI.
//
// Field meanings (mirror task_templates columns):
//   name        display name (includes shift suffix like "(5 AM)" to match Workpulse)
//   task_type   'shift' | 'general'
//   category    grouping chip (Cold Holding, Hot Holding, Merchandising, …)
//   label       'Food Safety' | 'Facility' | 'Fresh' | 'Planning Checklist'
//   input_type  'checklist' | 'temperature' | 'weight' | 'count' | 'photo'
//   frequency   'daily' | 'weekly' | 'general'
//   shift_time  one of SHIFT_LABELS (null for non-shift), drives the due window
//   recur_days  for frequency 'general' (e.g. Master Sanitation)
//   target/min_val/max_val/unit  for measurement tasks
//   allow_signoff, is_master     per-task flags
//
// `all45: true` means seed assigns this task to every store; otherwise no locations
// (Exec/IT assigns later).

// Shift due windows (ET). end = last minute the task is "on time"; after that → overdue.
const SHIFT_WINDOWS = {
  '1 AM':  { startHour: 1,  endHour: 4,  endMin: 59 },
  '5 AM':  { startHour: 5,  endHour: 8,  endMin: 59 },
  '9 AM':  { startHour: 9,  endHour: 12, endMin: 59 },
  '1 PM':  { startHour: 13, endHour: 16, endMin: 59 },
  '5 PM':  { startHour: 17, endHour: 20, endMin: 59 },
  '9 PM':  { startHour: 21, endHour: 23, endMin: 59 },
  'AM':    { startHour: 0,  endHour: 11, endMin: 59 },
  'Noon':  { startHour: 11, endHour: 16, endMin: 59 },
  'PM':    { startHour: 16, endHour: 23, endMin: 59 },
};

const t = (name, category, label, input_type, opts = {}) => ({
  name, task_type: opts.task_type || 'shift', category, label, input_type,
  frequency: opts.frequency || 'daily',
  shift_time: opts.shift_time || null,
  recur_days: opts.recur_days || null,
  target: opts.target ?? null, min_val: opts.min_val ?? null, max_val: opts.max_val ?? null,
  unit: opts.unit || null,
  allow_signoff: !!opts.allow_signoff, is_master: !!opts.is_master,
  active: opts.active !== false,
  all45: opts.all45 !== false,
});

// Helper: expand a measurement task across standard shift times.
const shifts = (base, category, label, times, meas) =>
  times.map((s) => t(`${base} (${s})`, category, label, 'temperature', { shift_time: s, ...meas }));

const COLD = { target: 37, min_val: 35, max_val: 41, unit: '°F' };
const FREEZER = { target: 0, min_val: -10, max_val: 10, unit: '°F' };
const HOT = { target: 140, min_val: 140, max_val: 165, unit: '°F' };

const CATALOG = [
  // ── Manager / planning checklists ──
  t('Manager Daily Task Checklist', 'Manager Checklist', 'Planning Checklist', 'checklist', { frequency: 'daily', shift_time: null }),
  t('Backroom Checklist (AM)',  'Backroom Checklist', 'Planning Checklist', 'checklist', { shift_time: 'AM' }),
  t('Backroom Checklist (PM)',  'Backroom Checklist', 'Planning Checklist', 'checklist', { shift_time: 'PM' }),
  t('Food Safety Checklist (Daily)', 'Food Safety Checklist', 'Food Safety', 'checklist', { frequency: 'daily', shift_time: null }),

  // ── Cold Holding (temperature) ──
  ...shifts('Walkin Cooler',  'Cold Holding', 'Food Safety', ['5 AM', '9 AM', '1 PM', '5 PM'], COLD),
  ...shifts('Walkin Freezer', 'Cold Holding', 'Food Safety', ['5 AM', '9 AM', '1 PM', '5 PM'], FREEZER),
  ...shifts('Reachin Cooler', 'Cold Holding', 'Food Safety', ['5 AM', '1 PM'], COLD),
  ...shifts('Sandwich Station', 'Cold Holding', 'Food Safety', ['5 AM', '9 AM'], COLD),
  ...shifts('Pepsi Cooler',   'Cold Holding', 'Food Safety', ['5 AM', '1 PM'], COLD),
  t('TAPS', 'Cold Holding', 'Food Safety', 'temperature', { shift_time: '1 PM', ...COLD }),

  // ── Hot Holding ──
  t('Hot Holding', 'Hot Holding', 'Food Safety', 'temperature', { shift_time: '1 PM', allow_signoff: true, ...HOT }),
  ...shifts('Steam Table', 'Hot Holding', 'Food Safety', ['9 AM', '1 PM'], HOT),

  // ── Dairy / beverage ──
  ...shifts('Dairy Dispenser Temp', 'Dairy Dispenser', 'Fresh', ['5 AM', '9 AM', '1 PM'], COLD),
  t('Dairy Dispenser Weight (Daily)',  'Dairy Dispenser', 'Fresh', 'weight', { frequency: 'daily',  shift_time: null, unit: 'oz' }),
  t('Dairy Dispenser Weight (Weekly)', 'Dairy Dispenser', 'Fresh', 'weight', { frequency: 'weekly', shift_time: null, unit: 'oz' }),
  t('Espresso Cleaning',     'Espresso', 'Fresh', 'checklist', { shift_time: null, frequency: 'daily' }),
  t('Espresso Measurements', 'Espresso', 'Fresh', 'temperature', { shift_time: null, frequency: 'daily', target: 154, min_val: 148, max_val: 160, unit: '°F' }),
  t('Island Oasis Ice Calibration',    'Frozen Beverage', 'Fresh', 'count', { shift_time: null, frequency: 'daily' }),
  t('Island Oasis Weight Calibration', 'Frozen Beverage', 'Fresh', 'weight', { shift_time: null, frequency: 'daily', unit: 'g' }),

  // ── Cooking temp / calibration ──
  t('Daily Product Cooking Temp.', 'Cooking Temp', 'Food Safety', 'temperature', { shift_time: null, frequency: 'daily', target: 165, min_val: 165, max_val: 200, unit: '°F' }),
  t('Weekly Product Cooking Temps.', 'Cooking Temp', 'Food Safety', 'temperature', { shift_time: null, frequency: 'weekly', target: 165, min_val: 165, max_val: 200, unit: '°F' }),
  t('Thermometer Calibration', 'Thermometer Calibration', 'Food Safety', 'temperature', { shift_time: null, frequency: 'daily', target: 32, min_val: 30, max_val: 34, unit: '°F' }),

  // ── Sanitizer ──
  ...shifts('Sanitizer', 'Sanitizer', 'Food Safety', ['5 AM', '1 PM', '9 PM'], { target: 200, min_val: 150, max_val: 400, unit: 'ppm' }),

  // ── Merchandising ──
  t('Donut Merchandising (10 AM)', 'Merchandising', 'Fresh', 'photo', { shift_time: null, frequency: 'daily' }),
  t('Donut Merchandising (2 PM)',  'Merchandising', 'Fresh', 'photo', { shift_time: null, frequency: 'daily' }),

  // ── Facility checklists ──
  t('Building Exterior & Landscaping', 'Exterior Checklist', 'Facility', 'checklist', { shift_time: null, frequency: 'daily' }),
  t('Mens Rest Rooms Checklist (AM)',  'Rest Room Checklist', 'Facility', 'checklist', { shift_time: 'AM' }),
  t('Womens Rest Rooms Checklist (AM)','Rest Room Checklist', 'Facility', 'checklist', { shift_time: 'AM' }),
  t('Receiving Log', 'Receiving Log', 'Food Safety', 'checklist', { shift_time: null, frequency: 'daily' }),

  // ── General / recurring (Master Sanitation) ──
  t('Master Sanitation Schedule (Every 7 Days)',  'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 7,  shift_time: null }),
  t('Master Sanitation Schedule (Every 30 Days)', 'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 30, shift_time: null }),
];

module.exports = { CATALOG, SHIFT_WINDOWS };
