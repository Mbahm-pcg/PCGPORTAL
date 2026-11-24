// src/pay-rate-paycor.mjs — pure helpers for writing an approved pay rate change into Paycor (v23.9).
// No I/O. Used by netlify/functions/pay-increase.mjs.
//
// Paycor keeps pay rates per employee: GET/POST /v1/employees/{id}/payrates, PUT …/payrates/{rateId}.
// A raise is written as a NEW rate in the same slot (sequence number) as the rate in force today,
// starting on the office's Effective Date — Paycor keeps paying the old rate until then. Field names
// follow what Paycor's GET returns (camelCase). The exact create shape is confirmed with one
// controlled test before the switch is turned on (Admin switch in Tools · Pay Rate Change).
import { pickCurrentPayRate } from './transfer-notice.mjs';

const num = (v) => (v == null || v === '' ? null : Number(v));
const day = (v) => String(v || '').slice(0, 10);

// Only what the screen needs, never anything else Paycor returns.
export function cleanRates(records) {
  return (Array.isArray(records) ? records : []).filter(Boolean).map(r => ({
    id: r.id || r.payRateId || null,
    sequenceNumber: r.sequenceNumber ?? r.sequence ?? null,
    type: r.type || r.payType || null,
    description: r.description || null,
    payRate: num(r.payRate ?? r.rate),
    annualPayRate: num(r.annualPayRate),
    effectiveStartDate: day(r.effectiveStartDate || r.effectiveDate || r.startDate) || null,
    effectiveEndDate: day(r.effectiveEndDate || r.endDate) || null,
  })).sort((a, b) => String(b.effectiveStartDate || '').localeCompare(String(a.effectiveStartDate || '')));
}

export function currentRate(records, todayIso) {
  return pickCurrentPayRate(cleanRates(records), todayIso);
}

// Paycor's current pay for the form's basis ('hour' → payRate, 'year' → annualPayRate).
export const payOf = (rate, basis) => (rate ? (basis === 'year' ? rate.annualPayRate : rate.payRate) : null);

// What state is Paycor in compared with the approved form?
//   'ready'    — Paycor still shows the form's current pay → safe to write the raise
//   'already'  — Paycor already shows the new pay → someone entered it by hand; nothing to send
//   'mismatch' — Paycor shows something else → do NOT write; a person must look
//   'none'     — no rate in Paycor at all
export function compareToForm(rate, form) {
  if (!rate) return 'none';
  const have = Number(payOf(rate, form.payBasis));
  if (Math.abs(have - Number(form.newRate)) <= 0.004) return 'already';
  if (Math.abs(have - Number(form.currentRate)) <= 0.004) return 'ready';
  return 'mismatch';
}

// The new rate to create: same slot / type / description as today's rate, the approved amount,
// starting on the effective date. A salaried employee's per-paycheck payRate is scaled from the
// annual figure the same way Paycor shows today's (payRate / annualPayRate).
export function buildNewRate(rate, form, { formId, approvedBy } = {}) {
  const basis = form.payBasis === 'year' ? 'year' : 'hour';
  const out = {
    sequenceNumber: rate?.sequenceNumber ?? 1,
    type: rate?.type || (basis === 'year' ? 'Salary' : 'Hourly'),
    description: rate?.description || 'Regular',
    effectiveStartDate: `${day(form.effectiveDate)}T00:00:00`,
    reason: 'Pay rate change',
    notes: `PCG Portal pay rate change #${formId ?? ''}${approvedBy ? `, approved by ${approvedBy}` : ''}`.slice(0, 250),
  };
  if (basis === 'hour') out.payRate = Math.round(Number(form.newRate) * 100) / 100;
  else {
    out.annualPayRate = Math.round(Number(form.newRate) * 100) / 100;
    const ratio = rate?.payRate && rate?.annualPayRate ? rate.payRate / rate.annualPayRate : 1 / 26;
    out.payRate = Math.round(out.annualPayRate * ratio * 100) / 100;
  }
  return out;
}

// v23.11: the new rate is sent the moment the office confirms, dated in the future — Paycor holds it.
// Today's rate is still the old one then, so a resend must also look for a rate ALREADY waiting in
// Paycor on the effective date with the new pay, or it would write it twice.
export function alreadyScheduled(records, form) {
  const eff = day(form.effectiveDate);
  return cleanRates(records).some(r => r.effectiveStartDate === eff && Math.abs(Number(payOf(r, form.payBasis)) - Number(form.newRate)) <= 0.004);
}

// An effective date can only be moved while it is still in the future (ET date strings).
export function canMoveEffective(currentEffective, todayIso) {
  return !!currentEffective && day(currentEffective) > day(todayIso);
}

// v23.10 — the Paycor queue (user, 2026-11-23): once the office completes a pay rate change, Roxy
// presses "Update pay in Paycor" and confirms. It waits in a queue until the effective date, when
// pay-rate-queue-cron.mjs sends it. The "Pay Rate Change Paycor update" list hears when it's queued
// and again on the day. Due today or earlier → it goes now instead of waiting.
export function isDueNow(effectiveDate, todayIso) {
  return !!effectiveDate && day(effectiveDate) <= day(todayIso);
}

const usDay = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || ''); };
const money = (n, basis) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${basis === 'year' ? ' a year' : '/hr'}`;

// What the list is told. kind: 'queued' | 'sent' | 'problem' | 'cancelled' | 'moved'.
// row: a pay_increase_forms row. extra: { by, error, from }.
export function paycorNoticeText(kind, row, storeName, extra = {}) {
  const who = `${row.employee_name} (${storeName || 'PC ' + row.pc})`;
  const change = `${money(row.current_rate, row.pay_basis)} to ${money(row.new_rate, row.pay_basis)}`;
  const eff = usDay(row.effective_date);
  switch (kind) {
    case 'queued': return { title: `Pay change queued for Paycor: ${row.employee_name}`,
      line: `${extra.by || 'The office'} queued the pay rate change for ${who}, ${change}. It will be updated in Paycor automatically on ${eff}${row.paycheck_date ? `, first on the paycheck dated ${usDay(row.paycheck_date)}` : ''}.` };
    case 'sent': return extra.future
      ? { title: `Pay rate change entered in Paycor: ${row.employee_name}`,
        line: `${extra.by ? `${extra.by} entered` : 'Entered'} the pay rate change for ${who} in Paycor, ${change}, effective ${eff}. Paycor holds it and keeps paying the old rate until then; you'll be told again that day.` }
      : { title: `Pay updated in Paycor: ${row.employee_name}`,
        line: `The pay for ${who} was updated in Paycor, ${change}, effective ${eff}.` };
    // v23.11: the day it starts — Paycor was read and shows the new pay.
    case 'effective': return { title: `Pay rate change starts today: ${row.employee_name}`,
      line: `The pay rate change for ${who} takes effect today (${eff}): Paycor now shows ${money(row.new_rate, row.pay_basis)} (was ${money(row.current_rate, row.pay_basis)}).` };
    case 'notEffective': return { title: `Check Paycor: ${row.employee_name}`,
      line: `The pay rate change for ${who} (${change}) should take effect today (${eff}), but Paycor shows ${extra.shows != null ? money(extra.shows, row.pay_basis) : 'no current rate'}. Check it in Paycor.` };
    case 'problem': return { title: `Paycor NOT updated: ${row.employee_name}`,
      line: `The pay rate change for ${who} (${change}, effective ${eff}) was not written to Paycor: ${extra.error || 'Paycor did not accept it'}. Check it in Tools > Pay Rate Change > Complete.` };
    case 'cancelled': return { title: `Paycor update cancelled: ${row.employee_name}`,
      line: `${extra.by || 'The office'} cancelled the Paycor update for ${who} (${change}). Paycor will not be changed.` };
    case 'moved': return { title: `Pay rate change date moved: ${row.employee_name}`,
      line: `The pay rate change for ${who} (${change}) now takes effect in Paycor on ${eff} (was ${usDay(extra.from)}). Changed by ${extra.by || 'the office'}.` };
    default: return { title: 'Pay rate change', line: who };
  }
}
