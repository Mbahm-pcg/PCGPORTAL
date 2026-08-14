// PCG Portal — Case Watch comment thread (write-through to Case Watch's Supabase)
// Unlike case-watch.mjs (read-only, uses the public anon key), this function
// WRITES into a dedicated `case_comments` table in the same Supabase project
// so exec/IT/office staff can leave notes on worst-tier complaints and have
// them visible in Case Watch's own dashboard too, not just the Portal.
//
// Deliberately a brand-new table, not the `cases.comments` column Case
// Watch's own Google Sheet sync owns — writing into that column would race
// with the next sync and silently lose the note.
//
// Requires CASE_WATCH_SUPABASE_SERVICE_KEY (the project's service_role key,
// NOT the anon key) since RLS on this table only grants SELECT to anon —
// writes must bypass RLS, and the service_role key must never be sent to a
// browser, only used here server-side.
//
// One-time setup in the Case Watch Supabase project's SQL Editor:
//   create table if not exists case_comments (
//     id bigint generated always as identity primary key,
//     case_id text not null,
//     author_name text not null,
//     comment_text text not null,
//     created_at timestamptz not null default now()
//   );
//   create index if not exists case_comments_case_id_idx on case_comments (case_id);
//   alter table case_comments enable row level security;
//   create policy "Allow public read access" on case_comments for select using (true);

export default async (request) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { status: 405, headers });

  const supabaseUrl = process.env.CASE_WATCH_SUPABASE_URL;
  const serviceKey = process.env.CASE_WATCH_SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Comments are not set up yet (missing CASE_WATCH_SUPABASE_SERVICE_KEY) — ask IT to add the Case Watch Supabase service_role key.' }), { status: 500, headers });
  }

  const body = await request.json().catch(() => ({}));
  const { action, caseId, caseIds, authorName, commentText } = body;

  try {
    if (action === 'list') {
      const ids = Array.isArray(caseIds) ? caseIds : (caseId ? [caseId] : []);
      if (ids.length === 0) return new Response(JSON.stringify({ ok: true, comments: [] }), { status: 200, headers });
      const url = `${supabaseUrl}/rest/v1/case_comments?case_id=in.(${ids.map(id => encodeURIComponent(id)).join(',')})&select=*&order=created_at.asc`;
      const res = await fetch(url, { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return new Response(JSON.stringify({ error: `Case Watch returned HTTP ${res.status}`, detail: detail.slice(0, 300) }), { status: 502, headers });
      }
      const comments = await res.json();
      return new Response(JSON.stringify({ ok: true, comments }), { status: 200, headers });
    }

    if (action === 'add') {
      if (!caseId || !authorName?.trim() || !commentText?.trim()) {
        return new Response(JSON.stringify({ error: 'caseId, authorName, and commentText are required' }), { status: 400, headers });
      }
      const url = `${supabaseUrl}/rest/v1/case_comments`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify({ case_id: caseId, author_name: authorName.trim(), comment_text: commentText.trim() }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        return new Response(JSON.stringify({ error: `Case Watch returned HTTP ${res.status}`, detail: detail.slice(0, 300) }), { status: 502, headers });
      }
      const [comment] = await res.json();
      return new Response(JSON.stringify({ ok: true, comment }), { status: 200, headers });
    }

    return new Response(JSON.stringify({ error: 'Unknown action — expected "list" or "add"' }), { status: 400, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};
