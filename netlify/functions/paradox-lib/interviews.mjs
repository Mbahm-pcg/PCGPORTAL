// paradox-lib/interviews.mjs — keep interview_invites current from the Paradox API (v22.45),
// so interview reminders no longer depend on the store Gmail calendar invites.
//
// For every open store: GET /candidates?job_loc_code=<PC#>&candidate_journey_status=<booked
// stage>&interviews=1 (job_loc_code = the Dunkin' PC#, confirmed 2026-11-03). Each booked,
// not-yet-held interview becomes an interview_invites row with uid "px:<candidate OID>".
//   - new → inserted (inheriting any reminder already sent for the same interview from its
//     Gmail invite, so switching sources never re-sends a reminder);
//   - time changed → updated and its sent flags cleared (a reschedule gets fresh reminders);
//   - no longer booked → 'cancelled' (only for stores whose fetch succeeded this run).
// The reminder sending itself is unchanged (interview-reminders-lib/run.mjs).
//
// Times: Paradox's own zone marker is trusted; a bare time is read as US Eastern (all stores
// are in PA/NJ). Override with env PARADOX_TIME_ZONE (e.g. 'UTC') if a check shows otherwise.
import { pxCandidates, pool } from './client.mjs';
import { SCHEDULED_STATUSES, PX_UID_PREFIX, readInterviewRow } from '../../../src/paradox-interviews.mjs';

export const naiveZone = () => (process.env.PARADOX_TIME_ZONE || 'America/New_York').trim();

// Booked interviews per store. { rows, okStores:Set, failed:{pc:error}, sampleRaw }
export async function fetchParadoxInterviews(stores) {
  const rows = [], okStores = new Set(), failed = {};
  let sampleRaw = null;
  const zone = naiveZone();
  await pool(stores.map(s => String(s.pc)), 6, async (pc) => {
    try {
      for (const status of SCHEDULED_STATUSES) {
        const list = await pxCandidates(`job_loc_code=${encodeURIComponent(pc)}&interviews=1&candidate_journey_status=${encodeURIComponent(status)}`);
        for (const r of list) {
          if (!sampleRaw && r?.interview?.scheduled_at) sampleRaw = String(r.interview.scheduled_at);
          const iv = readInterviewRow(r, pc, { naiveZone: zone, label: status.startsWith('2nd') ? '2nd interview' : 'Interview' });
          if (iv) rows.push(iv);
        }
      }
      okStores.add(pc);
    } catch (e) {
      // 404 = Paradox has no location with this PC# (e.g. Willits) → nothing booked there.
      if (e.status === 404) okStores.add(pc); else failed[pc] = e.message;
    }
  });
  // A candidate listed under two stores/stages: keep one (the soonest).
  const byUid = new Map();
  for (const r of rows) { const ex = byUid.get(r.uid); if (!ex || r.start < ex.start) byUid.set(r.uid, r); }
  return { rows: [...byUid.values()], okStores, failed, sampleRaw };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

export async function syncParadoxInterviews(db, stores) {
  const { rows, okStores, failed, sampleRaw } = await fetchParadoxInterviews(stores);
  let added = 0, moved = 0, cancelled = 0;
  for (const iv of rows) {
    const ex = (await db`SELECT start_at, status FROM interview_invites WHERE uid = ${iv.uid} AND store_pc = ${iv.pc}`)[0];
    if (!ex) {
      // Same interview already reminded from its Gmail invite? Carry those flags over.
      const twin = (await db`SELECT candidate, sent_day_at, sent_hour_at FROM interview_invites
        WHERE store_pc = ${iv.pc} AND uid NOT LIKE ${PX_UID_PREFIX + '%'} AND status = 'active'
          AND start_at BETWEEN ${iv.start}::timestamptz - interval '10 minutes' AND ${iv.start}::timestamptz + interval '10 minutes'`)
        .find(t => norm(t.candidate) && norm(t.candidate) === norm(iv.candidate));
      await db`INSERT INTO interview_invites (uid, store_pc, candidate, summary, start_at, status, sequence, source_msg, sent_day_at, sent_hour_at)
        VALUES (${iv.uid}, ${iv.pc}, ${iv.candidate}, ${iv.summary}, ${iv.start}, 'active', 0, 'paradox', ${twin?.sent_day_at || null}, ${twin?.sent_hour_at || null})
        ON CONFLICT (uid, store_pc) DO NOTHING`;
      added++;
      continue;
    }
    const changed = new Date(ex.start_at).toISOString() !== iv.start;
    if (changed || ex.status !== 'active') {
      await db`UPDATE interview_invites SET candidate = ${iv.candidate}, summary = ${iv.summary}, start_at = ${iv.start}, status = 'active', updated_at = now(),
          sent_day_at = CASE WHEN ${changed} THEN NULL ELSE sent_day_at END, sent_hour_at = CASE WHEN ${changed} THEN NULL ELSE sent_hour_at END
        WHERE uid = ${iv.uid} AND store_pc = ${iv.pc}`;
      moved++;
    }
  }
  // Booked before, not any more (canceled / moved stage) — only where this run read the store.
  const live = new Set(rows.map(r => `${r.uid}|${r.pc}`));
  const open = await db`SELECT uid, store_pc FROM interview_invites WHERE uid LIKE ${PX_UID_PREFIX + '%'} AND status = 'active' AND start_at > now()`;
  for (const o of open) {
    if (!okStores.has(String(o.store_pc)) || live.has(`${o.uid}|${o.store_pc}`)) continue;
    await db`UPDATE interview_invites SET status = 'cancelled', updated_at = now() WHERE uid = ${o.uid} AND store_pc = ${o.store_pc}`;
    cancelled++;
  }
  return { ok: true, booked: rows.length, added, moved, cancelled, storesRead: okStores.size, failed, zone: naiveZone(), sampleShape: sampleRaw ? sampleRaw.replace(/\d/g, '9') : null };
}

// Read-only comparison for the trial check: Paradox's time vs the Gmail invite's time for the
// same interview (same store + same candidate). Counts and minute offsets only.
export async function compareWithGmail(db, stores) {
  const { rows, okStores, failed, sampleRaw } = await fetchParadoxInterviews(stores);
  const gmail = await db`SELECT store_pc, candidate, start_at FROM interview_invites WHERE uid NOT LIKE ${PX_UID_PREFIX + '%'} AND status = 'active' AND start_at > now() - interval '1 day'`;
  const offsets = {};
  let matched = 0, exact = 0;
  for (const iv of rows) {
    const g = gmail.find(x => String(x.store_pc) === iv.pc && norm(x.candidate) && norm(x.candidate) === norm(iv.candidate));
    if (!g) continue;
    matched++;
    const diff = Math.round((Date.parse(iv.start) - new Date(g.start_at).getTime()) / 60000);
    if (diff === 0) exact++;
    offsets[diff] = (offsets[diff] || 0) + 1;
  }
  return { zone: naiveZone(), sampleShape: sampleRaw ? sampleRaw.replace(/\d/g, '9') : null, paradoxBooked: rows.length, gmailUpcoming: gmail.length, matched, exactTimeMatch: exact, minuteOffsets: offsets, storesRead: okStores.size, failed };
}
