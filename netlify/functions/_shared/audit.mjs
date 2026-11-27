// @ts-check
// _shared/audit.mjs — one line in the audit log for every step of an HR form (v23.38, user
// 2026-11-27: "we need to start logging those from now on"). Written by the server at the moment the
// step happens, so it can't be skipped or faked from a browser. Shown in Admin · Audit Log
// ("Forms only"). Holds WHO / role / WHAT / which form / employee / store / WHEN — never pay amounts,
// SSNs or anything else personal (those stay on the form itself). Never throws: a logging hiccup must
// not stop a form.
import { STORES } from '../tips-report-cron-background.mjs';

export const FORM_LABEL = {
  pay_rate: 'Pay Rate Change', transfer: 'Transfer Notice', time_off: 'Time Off Request', violation: 'Violation Notice',
  missing_hours: 'Missing Hours', resignation: 'Resignation Letter', crew_time_off: 'Crew Time Off',
};
const storeName = (pc) => STORES.find(s => String(s.pc) === String(pc))?.name || (pc ? `PC ${pc}` : '');

/** The line's text, e.g. "Pay Rate Change #23 · Jane Doe · Bustleton" (pure; tested). */
export function auditTarget(form, row) {
  const pc = row?.pc ?? row?.from_pc ?? null;
  return [`${FORM_LABEL[form] || form} #${row?.id ?? '?'}`, row?.employee_name, storeName(pc)].filter(Boolean).join(' · ');
}

/**
 * @param {any} db
 * @param {string} form   pay_rate | transfer | time_off | violation | missing_hours | resignation | crew_time_off
 * @param {string} step   sent | resent | approved | sent_back | office_completed | filed | signed | refused | link_sent | link_withdrawn | submitted | …
 * @param {any} row       the form's row (id, employee_name, pc / from_pc)
 * @param {{ id?: any, role?: string, name?: string } | null} by   who did it (null = the crew member / employee, no login)
 * @param {object} [extra] small, non-personal details (e.g. { via: 'poster' })
 */
export async function auditForm(db, form, step, row, by, extra = {}) {
  if (!row) return;
  try {
    const meta = { form, formId: row.id, targetName: auditTarget(form, row), employee: row.employee_name || null, store: storeName(row.pc ?? row.from_pc), byName: by?.name || (by ? null : row.employee_name || 'the employee'), ...extra };
    await db`INSERT INTO audit_log (type, user_id, user_role, action, metadata)
      VALUES ('form', ${by?.id != null ? String(by.id) : null}, ${by?.role || (by ? null : 'employee')}, ${`${form}.${step}`.slice(0, 100)}, ${JSON.stringify(meta)})`;
  } catch (e) { console.warn('[audit] form', form, step, e.message); }
}
