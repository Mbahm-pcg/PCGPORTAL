// Pure decision logic for interpreting a punchErrorLog poll response. No network
// or DB I/O here — the background send function (Task 6) is the only caller that
// actually makes the HTTP request.
//
// A real third-party Paycor integration's bug history (alexrelintex/timeclock PR
// #33, cited in the design spec) shows the dangerous mistake here: treating any
// non-404 response as "clean success" silently recorded 401/403/500 errors as
// successful punches. The correct rule, encoded below: only a genuine 2xx resolves
// anything; 404 means "still processing"; everything else is unresolved and must
// never be read as success.

// Returns one of:
//   { state: 'pending' }                                  — 404, keep polling
//   { state: 'unresolved', reason }                        — any other non-2xx
//   { state: 'resolved', succeeded: [...], failed: [...] } — 2xx, per-record outcome
export function resolvePunchLogResponse(status, body) {
  if (status === 404) return { state: 'pending' };
  if (status < 200 || status >= 300) {
    return { state: 'unresolved', reason: `HTTP ${status}` };
  }
  const records = (body && (body.records || body.Records)) || [];
  const succeeded = [];
  const failed = [];
  for (const r of records) {
    const errs = (r && (r.errors || r.Errors)) || [];
    if (Array.isArray(errs) && errs.length > 0) {
      failed.push({ record: r, errors: errs });
    } else {
      succeeded.push(r);
    }
  }
  return { state: 'resolved', succeeded, failed };
}
