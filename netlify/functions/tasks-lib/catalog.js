// catalog.js — full task-template catalog for the Ops Task & Checklist system.
// Reverse-engineered from the Workpulse "Book Task" admin (~229 definitions) +
// the Daily Task Report ranges. See docs/TASK_CHECKLIST_SYSTEM_PLAN.md.
//
// `seed` loads every template below so they appear in Admin → Book Task. Only templates
// flagged all45:true are auto-assigned to all 45 stores on seed (the realistic ~40-task
// daily core, matching Workpulse's ~39/store/day). Everything else is present but
// UNASSIGNED — Exec/IT assigns it per store via the admin UI (Baskin combos, specialty
// equipment, alternate shift times, recurring sanitation, etc.).
//
// Ranges are single-value here (one per task); per-item sub-question ranges are Phase 2/3.

// Shift due windows (ET). end = last minute the task is "on time"; after that → overdue.
const SHIFT_WINDOWS = {
  '1 AM':  { startHour: 1,  endHour: 4,  endMin: 59 },
  '5 AM':  { startHour: 5,  endHour: 8,  endMin: 59 },
  '9 AM':  { startHour: 9,  endHour: 12, endMin: 59 },
  '1 PM':  { startHour: 13, endHour: 16, endMin: 59 },
  '2 PM':  { startHour: 14, endHour: 16, endMin: 59 },
  '5 PM':  { startHour: 17, endHour: 20, endMin: 59 },
  '8 PM':  { startHour: 20, endHour: 23, endMin: 59 },
  '9 PM':  { startHour: 21, endHour: 23, endMin: 59 },
  'AM':    { startHour: 0,  endHour: 11, endMin: 59 },
  'Noon':  { startHour: 11, endHour: 16, endMin: 59 },
  'PM':    { startHour: 16, endHour: 23, endMin: 59 },
};

const T6  = ['1 AM', '5 AM', '9 AM', '1 PM', '5 PM', '9 PM'];
const APM = ['AM', 'Noon', 'PM'];

const COLD = { target: 37,  min_val: 35,  max_val: 41,  unit: '°F' };
const FRZ  = { target: -5,  min_val: -10, max_val: 0,   unit: '°F' };
const HOT  = { target: 150, min_val: 135, max_val: 180, unit: '°F' };
const COOK = { target: 165, min_val: 141, max_val: 180, unit: '°F' };

const t = (name, category, label, input_type, o = {}) => ({
  name, task_type: o.task_type || 'shift', category, label, input_type,
  frequency: o.frequency || 'daily', shift_time: o.shift_time || null, recur_days: o.recur_days || null,
  target: o.target ?? null, min_val: o.min_val ?? null, max_val: o.max_val ?? null, unit: o.unit || null,
  allow_signoff: !!o.allow_signoff, is_master: !!o.is_master, active: o.active !== false, all45: !!o.all45,
});
// Expand a base task across shift times → "Base (5 AM)" etc.
const shifts = (base, times, category, label, input_type, o = {}) =>
  times.map((s) => t(`${base} (${s})`, category, label, input_type, { ...o, shift_time: s }));

const CATALOG = [
  // ───────────────────────── DAILY CORE (auto-assigned to all 45) ─────────────────────────
  t('Manager Daily Task Checklist', 'Manager Checklist', 'Planning Checklist', 'checklist', { all45: true }),
  t('Food Safety Checklist (Daily)', 'Food Safety Checklist', 'Food Safety', 'checklist', { all45: true }),
  t('Backroom Checklist (AM)', 'Backroom Checklist', 'Planning Checklist', 'checklist', { shift_time: 'AM', all45: true }),
  ...shifts('Walkin Cooler',  ['5 AM', '9 AM', '1 PM', '5 PM'], 'Cold Holding', 'Food Safety', 'temperature', { ...COLD, all45: true }),
  ...shifts('Walkin Freezer', ['5 AM', '9 AM', '1 PM', '5 PM'], 'Cold Holding', 'Food Safety', 'temperature', { ...FRZ, all45: true }),
  ...shifts('Reachin Cooler', ['5 AM', '1 PM'], 'Cold Holding', 'Food Safety', 'temperature', { ...COLD, all45: true }),
  ...shifts('Sandwich Station', ['5 AM', '9 AM'], 'Cold Holding', 'Food Safety', 'temperature', { ...COLD, all45: true }),
  ...shifts('Pepsi Cooler', ['5 AM', '1 PM'], 'Cold Holding', 'Food Safety', 'temperature', { ...COLD, all45: true }),
  t('TAPS', 'Cold Holding', 'Food Safety', 'temperature', { shift_time: '1 PM', target: 38, min_val: 36, max_val: 40, unit: '°F', all45: true }),
  t('Hot Holding', 'Hot Holding', 'Food Safety', 'temperature', { shift_time: '9 AM', allow_signoff: true, ...HOT, all45: true }),
  ...shifts('Dairy Dispenser Temp', ['5 AM', '9 AM', '1 PM'], 'Dairy Dispenser', 'Fresh', 'temperature', { ...COLD, all45: true }),
  t('Dairy Dispenser Weight (Daily)', 'Dairy Dispenser', 'Fresh', 'weight', { target: 46, min_val: 41, max_val: 51, unit: 'g', all45: true }),
  t('Daily Product Cooking Temp.', 'Cooking Temp', 'Food Safety', 'temperature', { ...COOK, all45: true }),
  t('Thermometer Calibration', 'Thermometer Calibration', 'Food Safety', 'temperature', { target: 32, min_val: 30, max_val: 34, unit: '°F', all45: true }),
  t('Island Oasis Ice Calibration', 'Frozen Beverage', 'Fresh', 'weight', { target: 10, min_val: 9, max_val: 11, unit: 'oz', all45: true }),
  t('Island Oasis Weight Calibration', 'Frozen Beverage', 'Fresh', 'weight', { target: 4, min_val: 3.75, max_val: 4.25, unit: 'oz', all45: true }),
  t('Espresso Cleaning', 'Espresso', 'Fresh', 'checklist', { all45: true }),
  t('Espresso Measurements', 'Espresso', 'Fresh', 'temperature', { target: 154, min_val: 148, max_val: 160, unit: '°F', all45: true }),
  t('Donut Merchandising (10 AM)', 'Merchandising', 'Fresh', 'photo', { all45: true }),
  t('Donut Merchandising (2 PM)', 'Merchandising', 'Fresh', 'photo', { all45: true }),
  t('Building Exterior & Landscaping', 'Exterior Checklist', 'Facility', 'checklist', { shift_time: 'AM', all45: true }),
  t('Receiving Log', 'Receiving Log', 'Food Safety', 'checklist', { all45: true }),
  ...shifts('Sanitizer', ['5 AM', '1 PM'], 'Sanitizer', 'Food Safety', 'count', { target: 200, min_val: 150, max_val: 400, unit: 'ppm', all45: true }),
  t('Hot (High Volume Brewer) Calibraton', 'Hot Beverage', 'Fresh', 'count', { target: 0.9, min_val: 0.8, max_val: 1.0, unit: 'TDS', all45: true }),

  // ───────────────────────── FULL CATALOG (present, unassigned — assign via admin) ─────────────────────────

  // Backroom / planning checklists
  t('Backroom Checklist (Noon)', 'Backroom Checklist', 'Planning Checklist', 'checklist', { shift_time: 'Noon' }),
  t('Backroom Checklist (PM)', 'Backroom Checklist', 'Planning Checklist', 'checklist', { shift_time: 'PM' }),
  ...shifts('Food Prep Areas Checklist', ['AM', 'PM'], 'Food Prep Checklist', 'Planning Checklist', 'checklist'),
  t('Food Prep Areas Checklist (Noon)', 'Food Prep Checklist', 'Planning Checklist', 'checklist', { shift_time: 'Noon', active: false }),
  t('Product Quality Spot Check', 'Food Prep Checklist', 'Planning Checklist', 'checklist'),
  t('Safety & Security Checklist (Weekly)', 'Safety Checklist', 'Planning Checklist', 'checklist', { frequency: 'weekly', shift_time: null }),
  t('Safety Inspection Checklist', 'Safety Checklist', 'Planning Checklist', 'checklist'),

  // Cold Holding — remaining shift variants + equipment
  ...shifts('Walkin Cooler', ['1 AM', '9 PM'], 'Cold Holding', 'Food Safety', 'temperature', COLD),
  ...shifts('Walkin Freezer', ['1 AM', '9 PM'], 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  ...shifts('Walkin Freezer Combo', T6, 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  ...shifts('Reachin Cooler', ['1 AM', '9 AM', '5 PM', '9 PM'], 'Cold Holding', 'Food Safety', 'temperature', COLD),
  ...shifts('Reachin Freezer', T6, 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  ...shifts('Reachin Freezer Combo', T6, 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  ...shifts('Sandwich Station', ['1 AM', '1 PM', '9 PM'], 'Cold Holding', 'Food Safety', 'temperature', COLD),
  ...shifts('Pepsi Cooler', ['1 AM', '9 AM', '5 PM', '9 PM'], 'Cold Holding', 'Food Safety', 'temperature', COLD),
  ...shifts('Flash Freezer', T6, 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  ...shifts('Hash Brown Freezer', T6, 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  t('Milk Cooler', 'Cold Holding', 'Food Safety', 'temperature', COLD),
  ...shifts('Baskin Dessert Case', T6, 'Cold Holding', 'Food Safety', 'temperature', COLD),
  ...shifts('Baskin Dipping Cabinet', T6, 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  ...shifts('Baskin Hardening Cabinet', T6, 'Cold Holding', 'Food Safety', 'temperature', FRZ),
  ...shifts('Baskin Reachin Cooler', T6, 'Cold Holding', 'Food Safety', 'temperature', COLD),

  // Hot Holding
  ...shifts('Steam Table', T6, 'Hot Holding', 'Food Safety', 'temperature', HOT),
  ...shifts('Baskin Hot Topping Warmer', T6, 'Hot Holding', 'Food Safety', 'temperature', HOT),

  // Cooking Temp
  t('Weekly Product Cooking Temps.', 'Cooking Temp', 'Food Safety', 'temperature', { frequency: 'weekly', shift_time: null, ...COOK }),

  // Dairy Dispenser — remaining
  ...shifts('Dairy Dispenser Temp', ['1 AM', '5 PM', '9 PM'], 'Dairy Dispenser', 'Fresh', 'temperature', COLD),
  t('Dairy Dispenser Weight (Weekly)', 'Dairy Dispenser', 'Fresh', 'weight', { frequency: 'weekly', shift_time: null, target: 46, min_val: 41, max_val: 51, unit: 'g' }),

  // Sanitizer — remaining
  ...shifts('Sanitizer', ['1 AM', '9 AM', '5 PM', '9 PM'], 'Sanitizer', 'Food Safety', 'count', { target: 200, min_val: 150, max_val: 400, unit: 'ppm' }),

  // Merchandising
  t('Donut Merchandising (8 PM)', 'Merchandising', 'Fresh', 'photo', {}),
  ...shifts('Baskin Cake Freezer Merchandising', ['1 AM', '2 PM', '8 PM'], 'Merchandising', 'Fresh', 'photo'),
  ...shifts('Baskin Dipping Cabinet Merchandising', ['1 AM', '2 PM', '8 PM'], 'Merchandising', 'Fresh', 'photo'),

  // Espresso
  t('Espresso Shot Time (Coffee Art)', 'Espresso', 'Fresh', 'count', { unit: 'sec', target: 25, min_val: 20, max_val: 30 }),
  t('Espresso Shot Time (WMF)', 'Espresso', 'Fresh', 'count', { unit: 'sec', target: 25, min_val: 20, max_val: 30 }),
  t('Espresso Vol. & Temp. Coffee Art (Large)', 'Espresso', 'Fresh', 'temperature', { ...HOT }),
  t('Espresso Vol. & Temp. Coffee Art (Medium)', 'Espresso', 'Fresh', 'temperature', { ...HOT }),
  t('Espresso Vol. & Temp. Coffee Art (Small)', 'Espresso', 'Fresh', 'temperature', { ...HOT }),
  t('Espresso Vol. & Temp. WMF (Large)', 'Espresso', 'Fresh', 'temperature', { ...HOT }),
  t('Espresso Vol. & Temp. WMF (Medium)', 'Espresso', 'Fresh', 'temperature', { ...HOT }),
  t('Espresso Vol. & Temp. WMF (Small)', 'Espresso', 'Fresh', 'temperature', { ...HOT }),

  // Hot Beverage
  t('High-Volume and Axiom Calibration', 'Hot Beverage', 'Fresh', 'count', { unit: 'TDS', target: 0.9, min_val: 0.8, max_val: 1.0 }),
  t('Hot (HV Single Brewer) Calibraton', 'Hot Beverage', 'Fresh', 'count', { unit: 'TDS', target: 0.9, min_val: 0.8, max_val: 1.0 }),
  t('Hot Winter Beverage Temp (Weekly)', 'Hot Beverage', 'Fresh', 'temperature', { frequency: 'weekly', shift_time: null, ...HOT }),
  t('Single Brewer Vol. & Temp.', 'Hot Beverage', 'Fresh', 'temperature', { ...HOT }),
  t('Single Grind Weight', 'Hot Beverage', 'Fresh', 'weight', { unit: 'g' }),
  t('Soft Heat High Volume Grind', 'Hot Beverage', 'Fresh', 'weight', { unit: 'g' }),
  t('Softheat HV Double Brewer', 'Hot Beverage', 'Fresh', 'count', { unit: 'TDS', target: 0.9, min_val: 0.8, max_val: 1.0 }),
  t('Softheat HV Single Brewer', 'Hot Beverage', 'Fresh', 'count', { unit: 'TDS', target: 0.9, min_val: 0.8, max_val: 1.0 }),
  t('Dual Brewer Vol. & Temp. - Large', 'Hot Beverage', 'Fresh', 'temperature', { ...HOT }),
  t('Dual Brewer Vol. & Temp. - Medium', 'Hot Beverage', 'Fresh', 'temperature', { ...HOT }),
  t('Dual Brewer Vol. & Temp. - Small', 'Hot Beverage', 'Fresh', 'temperature', { ...HOT }),
  t('Dual Grind Weight - Large', 'Hot Beverage', 'Fresh', 'weight', { unit: 'g' }),
  t('Dual Grind Weight - Medium', 'Hot Beverage', 'Fresh', 'weight', { unit: 'g' }),
  t('Dual Grind Weight - Small', 'Hot Beverage', 'Fresh', 'weight', { unit: 'g' }),
  t('Cold Brew TDS', 'Miscellaneous', 'Food Safety', 'count', { unit: 'TDS' }),

  // Ice Coffee
  t('Iced Coffee Brewer Vol. & Temp.', 'Ice Coffee', 'Fresh', 'temperature', { unit: '°F' }),
  t('Iced Digital IC3 Brewer Measurements', 'Ice Coffee', 'Fresh', 'count', { unit: 'TDS' }),
  t('Iced Infused Series Brewer vol. & temp.', 'Ice Coffee', 'Fresh', 'temperature', { unit: '°F' }),

  // Frozen Beverage
  ...shifts('Coolatta Neutral Dual Unit', T6, 'Frozen Beverage', 'Fresh', 'temperature', { unit: '°F' }),
  ...shifts('Coolatta Neutral Single Unit', T6, 'Frozen Beverage', 'Fresh', 'temperature', { unit: '°F' }),
  t('Vitamix Cleaning', 'Frozen Beverage', 'Food Safety', 'checklist', {}),

  // Sugar / Flavor dispensers
  t('Sugar Dispenser', 'Sugar Dispenser', 'Fresh', 'weight', { unit: 'g' }),
  ...shifts('Island Oasis Liquid Sugar Bag', T6, 'Sugar Dispenser', 'Fresh', 'weight', { unit: 'g' }),
  t('Sure Shot Flavor Dispenser', 'Flavor Shot Dispenser', 'Fresh', 'weight', { unit: 'g' }),
  t('Taylor Flavor Dispenser', 'Flavor Shot Dispenser', 'Fresh', 'weight', { unit: 'g' }),

  // Dining Room / Rest Rooms / Queuing / Service / Exterior (facility checklists)
  ...shifts('Dining Room Checklist', APM, 'Dining Room', 'Facility', 'checklist'),
  ...shifts('Mens Rest Rooms Checklist', APM, 'Rest Room Checklist', 'Facility', 'checklist'),
  ...shifts('Womens Rest Rooms Checklist', APM, 'Rest Room Checklist', 'Facility', 'checklist'),
  ...shifts('Unisex Rest Rooms Checklist', APM, 'Rest Room Checklist', 'Facility', 'checklist'),
  ...shifts('Employee Rest Rooms Checklist', APM, 'Rest Room Checklist', 'Facility', 'checklist'),
  ...shifts('Queuing Area Checklist', APM, 'Queuing Area Checklist', 'Facility', 'checklist'),
  t('Exterior Checklist (AM)', 'Exterior Checklist', 'Facility', 'checklist', { shift_time: 'AM' }),
  t('Exterior Checklist (Noon)', 'Exterior Checklist', 'Facility', 'checklist', { shift_time: 'Noon' }),
  t('Exterior Checklist (PM)', 'Exterior Checklist', 'Facility', 'checklist', { shift_time: 'PM' }),
  t('Service Area Checklist (AM)', 'Service Area Checklist', 'Planning Checklist', 'checklist', { shift_time: 'AM' }),
  t('Service Area Checklist (PM)', 'Service Area Checklist', 'Planning Checklist', 'checklist', { shift_time: 'PM' }),
  t('Service Area Checklist (Noon)', 'Service Area Checklist', 'Planning Checklist', 'checklist', { shift_time: 'Noon', active: false }),

  // Health & Wellness
  t('Employee Health & Wellness', 'Health & Wellness', 'Food Safety', 'checklist', {}),
  t('Location Health & Wellness', 'Health & Wellness', 'Food Safety', 'checklist', {}),
  t('Workplace Health & Wellness', 'Health & Wellness', 'Food Safety', 'checklist', {}),

  // Miscellaneous
  t('Dish Washing Machine', 'Miscellaneous', 'Food Safety', 'checklist', {}),
  t('Headset Inventory', 'Miscellaneous', 'Food Safety', 'count', {}),
  t('Hot Water Dispenser Temp.', 'Miscellaneous', 'Food Safety', 'temperature', { unit: '°F' }),

  // Master Sanitation (General — recurring)
  t('Master Sanitation Schedule (Every 72 Hours)', 'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 3, shift_time: null }),
  t('Master Sanitation Schedule (Every 7 Days)',   'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 7, shift_time: null }),
  t('Master Sanitation Schedule (Every 14 Days)',  'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 14, shift_time: null }),
  t('Master Sanitation Schedule (Every 30 Days)',  'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 30, shift_time: null }),
  t('Master Sanitation Schedule (Every 60 Days)',  'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 60, shift_time: null }),
  t('Master Sanitation Schedule (Every 3 Months)', 'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 90, shift_time: null }),
  t('Master Sanitation Schedule (Every 6 Months)', 'Master Sanitation', 'Food Safety', 'checklist', { task_type: 'general', frequency: 'general', recur_days: 180, shift_time: null }),
];

// ── Phase 2: Sub-item definitions for key templates (seed via seed_items action) ──
// matchType 'prefix' matches all shift variants (e.g. 'Sandwich Station (5 AM)', '(9 AM)').
// matchType 'exact' (default) matches only the exact template name.
// equipment[] seeds task_template_equipment unit names for that template group.
const ITEMS_CATALOG = [
  {
    namePattern: 'Manager Daily Task Checklist',
    items: [
      { label: 'Cash Drawers Stocked', input_type: 'bool' },
      { label: 'CML Delivery Received & Shorts noted', input_type: 'bool' },
      { label: 'Throwaways & In-Store Baking documented (prev day)', input_type: 'bool' },
      { label: 'Cash deposits reconciled & EOD performed', input_type: 'bool' },
      { label: 'Time punches verified', input_type: 'bool' },
      { label: 'Product Mix & Sales uploaded in PAROS', input_type: 'bool' },
      { label: 'CML and/or DCP orders placed', input_type: 'bool' },
      { label: 'Bank Deposit made', input_type: 'bool' },
      { label: 'Safe counted & change fund replenished', input_type: 'bool' },
      { label: 'Loss-prevention metrics reviewed', input_type: 'bool' },
    ],
  },
  {
    namePattern: 'Backroom Checklist (AM)',
    items: [
      { label: '3-Bay Sink set-up', input_type: 'bool' },
      { label: '3-Bay Sink sanitizer tested', input_type: 'bool' },
      { label: 'Ovens & Hoods', input_type: 'bool' },
      { label: 'Walk-Ins clean', input_type: 'bool' },
      { label: 'Food labeled & stored properly', input_type: 'bool' },
      { label: 'Stock Area organized', input_type: 'bool' },
      { label: 'Floors clean', input_type: 'bool' },
      { label: 'Walls, Baseboards & Décor', input_type: 'bool' },
      { label: 'Back Door locked', input_type: 'bool' },
      { label: 'Ceilings, Lights & Vents', input_type: 'bool' },
      { label: 'Cleaning Supplies stocked', input_type: 'bool' },
      { label: 'Mop Sink Area clean', input_type: 'bool' },
      { label: 'Brooms, Mops & Bucket clean', input_type: 'bool' },
      { label: 'First-Aid Kit stocked', input_type: 'bool' },
    ],
  },
  {
    namePattern: 'Sandwich Station',
    matchType: 'prefix',
    items: [
      { label: 'Top Temperature', input_type: 'temperature', target: 37, min_val: 35, max_val: 41, unit: '°F' },
      { label: 'Bottom Temperature', input_type: 'temperature', target: 37, min_val: 35, max_val: 41, unit: '°F' },
    ],
  },
  {
    namePattern: 'Hot Holding',
    items: [
      { label: 'Eggs Temperature', input_type: 'temperature', target: 150, min_val: 135, max_val: 180, unit: '°F' },
      { label: 'Sausage Temperature', input_type: 'temperature', target: 150, min_val: 135, max_val: 180, unit: '°F' },
      { label: 'Hash Browns Temperature', input_type: 'temperature', target: 150, min_val: 135, max_val: 180, unit: '°F' },
    ],
  },
  {
    namePattern: 'Dairy Dispenser Temp',
    matchType: 'prefix',
    items: [
      { label: 'Product Temperature', input_type: 'temperature', target: 37, min_val: 35, max_val: 41, unit: '°F' },
    ],
    equipment: ['Dairy Dispenser 1', 'Dairy Dispenser 2'],
  },
  {
    namePattern: 'Dairy Dispenser Weight (Daily)',
    items: [
      { label: 'Cream Weight', input_type: 'weight', target: 46, min_val: 41, max_val: 51, unit: 'g' },
      { label: 'Milk Weight', input_type: 'weight', target: 46, min_val: 41, max_val: 51, unit: 'g' },
      { label: 'Skim Weight', input_type: 'weight', target: 46, min_val: 41, max_val: 51, unit: 'g' },
    ],
    equipment: ['Dairy Dispenser 1', 'Dairy Dispenser 2'],
  },
  {
    namePattern: 'Sugar Dispenser',
    items: [
      { label: 'XS Shot Weight', input_type: 'weight', target: 7.5, min_val: 6, max_val: 9, unit: 'g' },
      { label: 'S Shot Weight', input_type: 'weight', target: 14.5, min_val: 13, max_val: 16, unit: 'g' },
      { label: 'M Shot Weight', input_type: 'weight', target: 21, min_val: 18, max_val: 24, unit: 'g' },
      { label: 'L Shot Weight', input_type: 'weight', target: 28, min_val: 25, max_val: 31, unit: 'g' },
      { label: 'XL Shot Weight', input_type: 'weight', target: 36.5, min_val: 33, max_val: 40, unit: 'g' },
    ],
  },
  {
    namePattern: 'Daily Product Cooking Temp.',
    items: [
      { label: 'Eggs', input_type: 'temperature', target: 160, min_val: 141, max_val: 180, unit: '°F' },
      { label: 'Batch Egg', input_type: 'temperature', target: 160, min_val: 141, max_val: 180, unit: '°F' },
      { label: 'Batch Meat', input_type: 'temperature', target: 160, min_val: 141, max_val: 180, unit: '°F' },
      { label: 'LTO Meat', input_type: 'temperature', target: 160, min_val: 141, max_val: 180, unit: '°F' },
      { label: 'Hash Browns', input_type: 'temperature', target: 169, min_val: 165, max_val: 174, unit: '°F' },
    ],
    equipment: ['Turbochef 1', 'Turbochef 2'],
  },
  {
    namePattern: 'Island Oasis Ice Calibration',
    items: [
      { label: 'Ice Weight', input_type: 'weight', target: 10, min_val: 9, max_val: 11, unit: 'oz' },
    ],
  },
  {
    namePattern: 'Island Oasis Weight Calibration',
    items: [
      { label: 'Water Weight', input_type: 'weight', target: 4, min_val: 3.75, max_val: 4.25, unit: 'oz' },
      { label: 'Liquid Cane Sugar Weight', input_type: 'weight', target: 4, min_val: 3.75, max_val: 4.25, unit: 'oz' },
    ],
  },
  {
    namePattern: 'Receiving Log',
    items: [
      { label: 'Thawed / Refrozen?', input_type: 'bool' },
      { label: 'Receiving Freezer Temp', input_type: 'temperature', target: -10, min_val: -20, max_val: 0, unit: '°F' },
      { label: 'Receiving Cooler Temp 1', input_type: 'temperature', target: 37, min_val: 35, max_val: 41, unit: '°F' },
      { label: 'Receiving Cooler Temp 2', input_type: 'temperature', target: 37, min_val: 35, max_val: 41, unit: '°F' },
      { label: 'Damaged Product?', input_type: 'bool' },
    ],
  },
  {
    namePattern: 'Reachin Cooler',
    matchType: 'prefix',
    items: [
      { label: 'Product Temperature', input_type: 'temperature', target: 37, min_val: 35, max_val: 41, unit: '°F' },
    ],
    equipment: ['Reachin Cooler 1', 'Reachin Cooler 2'],
  },
  {
    namePattern: 'Donut Merchandising',
    matchType: 'prefix',
    items: [
      { label: 'Donut Case Merchandised', input_type: 'bool' },
      { label: 'Display Case Clean', input_type: 'bool' },
      { label: 'Product Labels in place', input_type: 'bool' },
    ],
  },
  {
    namePattern: 'Building Exterior & Landscaping',
    items: [
      { label: 'Landscaping maintained', input_type: 'bool' },
      { label: 'Sidewalks clean', input_type: 'bool' },
      { label: 'Dumpster Area clean', input_type: 'bool' },
    ],
  },
  {
    namePattern: 'Espresso Cleaning',
    items: [
      { label: 'Daily Cleaning completed', input_type: 'bool' },
      { label: 'Weekly Cleaning completed', input_type: 'bool' },
    ],
  },
  {
    namePattern: 'Thermometer Calibration',
    items: [
      { label: 'Ice Water Calibration Reading', input_type: 'temperature', target: 32, min_val: 30, max_val: 34, unit: '°F' },
    ],
  },
];

module.exports = { CATALOG, SHIFT_WINDOWS, ITEMS_CATALOG };
