const TEMPLATE_V1 = {
  version: 1,
  name: 'PCG Standard Store Audit',
  type: 'standard',
  sections: [
    { id: 'food_safety', name: 'Food Safety & Sanitation', weight: 0.40, items: [
      { id: 'fs_temp_logs',   text: 'Temperature logs current and complete (all units, all dayparts)', points: 4, critical: false, guidance: 'Check cooler/freezer logs for today and prior 7 days.' },
      { id: 'fs_cold_chain',  text: 'Cold-holding units at ≤41°F; no cold-chain break', points: 5, critical: true,  guidance: 'Spot-check 2 units with probe thermometer.' },
      { id: 'fs_hot_hold',    text: 'Hot-holding/hold times followed; expired product discarded', points: 4, critical: true,  guidance: '' },
      { id: 'fs_date_label',  text: 'Date labeling & FIFO rotation correct in all storage areas', points: 4, critical: false, guidance: '' },
      { id: 'fs_allergen',    text: 'Allergen controls: separation, utensils, labeling', points: 4, critical: false, guidance: '' },
      { id: 'fs_handwash',    text: 'Handwashing observed; sinks stocked and accessible', points: 5, critical: true,  guidance: 'Blocked hand sink = critical.' },
      { id: 'fs_hygiene',     text: 'Personal hygiene: gloves, hair restraints, no bare-hand contact', points: 4, critical: false, guidance: '' },
      { id: 'fs_chemicals',   text: 'Chemical storage separated from food; SDS accessible', points: 3, critical: false, guidance: '' },
      { id: 'fs_pest',        text: 'No pest activity; traps/logs current; doors sealed', points: 4, critical: true,  guidance: 'Active infestation = critical + imminent hazard.' },
      { id: 'fs_servsafe',    text: 'Certified food protection manager coverage for shift', points: 3, critical: false, guidance: '' },
    ]},
    { id: 'brand_guest', name: 'Brand Standards & Guest Experience', weight: 0.25, items: [
      { id: 'bg_coffee',      text: 'Coffee freshness timers honored; brew per standard', points: 4, critical: false, guidance: '' },
      { id: 'bg_espresso',    text: 'Espresso calibration current (shot time/yield in range)', points: 3, critical: false, guidance: '' },
      { id: 'bg_build',       text: 'Product build accuracy & portioning to spec (sample 3 products)', points: 4, critical: false, guidance: '' },
      { id: 'bg_sos',         text: 'Speed of service: drive-thru and front counter within target', points: 4, critical: false, guidance: 'Observe 10 minutes at peak if possible.' },
      { id: 'bg_accuracy',    text: 'Order accuracy spot-check', points: 3, critical: false, guidance: '' },
      { id: 'bg_uniform',     text: 'Crew appearance/uniform standards met', points: 3, critical: false, guidance: '' },
      { id: 'bg_merch',       text: 'Merchandising, POP, and menu boards current and accurate', points: 3, critical: false, guidance: '' },
      { id: 'bg_foh_clean',   text: 'Front-of-house cleanliness: lobby, counters, beverage station', points: 4, critical: false, guidance: '' },
    ]},
    { id: 'facility', name: 'Facility Appearance & Maintenance', weight: 0.20, items: [
      { id: 'fa_signage',     text: 'Exterior signage lit, clean, intact', points: 3, critical: false, guidance: '' },
      { id: 'fa_curb',        text: 'Curb appeal: landscaping, parking lot, trash enclosure', points: 3, critical: false, guidance: '' },
      { id: 'fa_drive_thru',  text: 'Drive-thru lane, menu board, and speaker condition', points: 3, critical: false, guidance: '' },
      { id: 'fa_interior',    text: 'Interior condition: walls, floors, ceiling, lighting', points: 3, critical: false, guidance: '' },
      { id: 'fa_equipment',   text: 'Equipment operational; no unreported failures', points: 4, critical: false, guidance: 'Cross-check against open maintenance tickets.' },
      { id: 'fa_restrooms',   text: 'Restrooms clean, stocked, functional', points: 4, critical: false, guidance: '' },
      { id: 'fa_deferred',    text: 'No unrouted deferred-maintenance or capital needs observed', points: 2, critical: false, guidance: 'Route findings to facilities/construction.' },
    ]},
    { id: 'safety', name: 'Safety & Liability', weight: 0.15, items: [
      { id: 'sl_floors',      text: 'Wet-floor protocol followed; floors clean/dry; mats placed', points: 4, critical: false, guidance: 'Slip/trip/fall exposure.' },
      { id: 'sl_ppe',         text: 'PPE available and used (cut gloves, oven mitts)', points: 3, critical: false, guidance: '' },
      { id: 'sl_ladder',      text: 'Ladder/step-stool condition and safe use', points: 2, critical: false, guidance: '' },
      { id: 'sl_fire',        text: 'Fire safety: extinguishers tagged, hood/duct cleaning current', points: 4, critical: true,  guidance: 'Expired extinguisher or overdue hood cleaning = critical.' },
      { id: 'sl_egress',      text: 'Egress paths clear and exit signs lit', points: 4, critical: true,  guidance: 'Blocked egress = critical + imminent hazard.' },
      { id: 'sl_electrical',  text: 'No electrical hazards (exposed wiring, overloaded outlets)', points: 3, critical: true,  guidance: '' },
      { id: 'sl_signage_doc', text: 'Required safety signage posted; training docs & incident kit on site', points: 3, critical: false, guidance: '' },
    ]},
  ],
};

function validateTemplate(tpl) {
  const errors = [];
  if (!tpl || !Array.isArray(tpl.sections) || !tpl.sections.length) return ['no sections'];
  const sum = tpl.sections.reduce((a, s) => a + (s.weight || 0), 0);
  if (Math.abs(sum - 1.0) > 1e-9) errors.push(`section weights sum to ${sum}, expected 1.0`);
  const seen = new Set();
  for (const s of tpl.sections) {
    if (!s.id || !s.name || !Array.isArray(s.items) || !s.items.length) errors.push(`section ${s.id || '?'} malformed`);
    for (const i of (s.items || [])) {
      if (seen.has(i.id)) errors.push(`duplicate item id: ${i.id}`);
      seen.add(i.id);
      if (!(i.points > 0)) errors.push(`item ${i.id} has non-positive points`);
      if (typeof i.critical !== 'boolean') errors.push(`item ${i.id} missing critical flag`);
    }
  }
  return errors;
}
module.exports = { TEMPLATE_V1, validateTemplate };
