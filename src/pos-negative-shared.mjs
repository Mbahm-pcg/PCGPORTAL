// PCG Portal — POS "negative-total" defect detection (pure helpers, ESM)
// Single source of truth for the void/re-add register defect: voiding then
// re-adding an item on a recalled check can leave an orphan adjustment line
// (no menuItem attached) behind after every real item nets back to $0 — that
// orphan line drives chkTtl below zero. A genuine refund is a DIFFERENT thing
// (an actual return-flagged menu item line) and must never be classified as
// this defect. Imported by both the frontend (app.jsx) and the backend
// (netlify/functions/pos-negative-*.mjs) so the two never silently drift.

/** True if this check is an actual customer return (returnTtl or a return-flagged line). */
export function isGenuineRefund(check) {
  return Math.abs(check.returnTtl || 0) > 0 || (check.detailLines || []).some(l => l.menuItem?.returnFlag);
}

/** True if this check is the known register defect (not a genuine refund). */
export function isNegativeDefect(check) {
  return (check.chkTtl || 0) < 0 && !isGenuineRefund(check);
}

/**
 * Orphan adjustment lines on a check's detailLines — no menu item, not a void,
 * error-correction audit entry, tender, discount, or suppressed display-only
 * line, yet still counted toward chkTtl. These are what actually drive the
 * defect's negative total.
 *
 * Tender lines can have a linked continuation line (parDtlId pointing back at
 * the tender's dtlId, itself carrying no tenderMedia/menuItem of its own) —
 * that's a normal part of the payment record, not an orphan adjustment, so
 * it's excluded too even though `!l.tenderMedia` alone wouldn't catch it.
 */
export function getOrphanLines(detailLines) {
  const lines = detailLines || [];
  const tenderDtlIds = new Set(lines.filter(l => l.tenderMedia).map(l => l.dtlId));
  return lines.filter(l =>
    !l.menuItem && !l.vdFlag && !l.errCorFlag && !l.tenderMedia && !l.discount &&
    !l.serviceCharge && !l.doNotShowFlag && (l.dspTtl || 0) !== 0 &&
    !(l.parDtlId != null && tenderDtlIds.has(l.parDtlId))
  );
}
