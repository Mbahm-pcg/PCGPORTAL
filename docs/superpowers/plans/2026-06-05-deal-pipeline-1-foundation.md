# Deal Pipeline — Plan 1: Server-Side Auth + Data Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the server-enforced backbone of the Deal Pipeline: a signed-token auth layer (verifies password OR Google users server-side), the Neon schema, and the authenticated `deals` CRUD API — so confidential deal data is protected at the endpoint, not just hidden in the browser.

**Architecture:** A pure, unit-tested token module (HMAC-SHA256 via `node:crypto`) + a pure role-rank helper. A `deal-auth.js` function verifies a caller (password against the `pcg_users_v1` blob, or a Google ID token via `google-auth-library`), looks up their role in a new `deal_access` Neon table, and issues a short-lived signed token. `deals.js` requires that token on every request and gates reads vs writes by role. All Deal tables are created via raw SQL in `db-migrate.js`, matching the existing Neon pattern.

**Tech Stack:** Node.js CommonJS Netlify Functions; Neon Postgres (raw SQL via `db.js`); Netlify Blobs (`pcg_users_v1` for password lookup); `google-auth-library` (transitive dep of `googleapis`, already installed) for Google ID-token verification; `node:crypto` for HMAC; tests via `node:test`.

**This is Plan 1 of 4.** Later plans: (2) frontend `AdminDeals` kanban/table/detail + nav/RBAC wiring; (3) documents + versioning; (4) critical dates + .ics + alerts cron + dashboard/filters. This plan ships a testable, server-enforced deals API with no UI yet (verified via curl + unit tests).

---

## Interface Contract (locked — used across all tasks)

```js
// netlify/functions/deal-lib/token.js  (pure, CommonJS)
signToken(payload, secret, opts?) -> "<b64url(body)>.<b64url(hmac)>"
  // body = { ...payload, iat, exp }; opts = { ttlSeconds=43200, nowMs=Date.now() }
verifyToken(token, secret, opts?) -> body object | null   // null = invalid/expired/tampered

// netlify/functions/deal-lib/roles.js  (pure, CommonJS)
ROLE_RANK = { view: 1, edit: 2, admin: 3 }
roleSatisfies(userRole, requiredRole) -> boolean   // edit satisfies view, etc.

// Deal session token payload: { sub: <userId>, username, role: 'view'|'edit'|'admin' }
// deal_access row: { user_key (lowercased username or email), role, added_by, added_at }

// deals.js request: header  Authorization: Bearer <token>
//   body { action, ... }  actions: list | get | create | update | moveStage | handoff | markDead | addNote
//   401 if token missing/invalid; 403 if role insufficient for a write.
```

---

### Task 1: Pure token module (HMAC sign/verify)

**Files:**
- Create: `netlify/functions/deal-lib/token.js`
- Test: `netlify/functions/deal-lib/token.test.js`
- Modify: `package.json` (test glob)

- [ ] **Step 1: Add the deal-lib test glob to package.json**

Change the `test` script to also run `netlify/functions/deal-lib/*.test.js`:
```json
"test": "node --test 'netlify/functions/analyst-lib/*.test.js' 'src/*.test.mjs' 'netlify/functions/deal-lib/*.test.js'",
```

- [ ] **Step 2: Write the failing test**

Create `netlify/functions/deal-lib/token.test.js`:
```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { signToken, verifyToken } = require('./token');

const SECRET = 'test-secret-do-not-use-in-prod';
const NOW = 1_750_000_000_000; // fixed ms for determinism

describe('signToken / verifyToken', () => {
  test('round-trips a payload and returns it on verify', () => {
    const t = signToken({ sub: 1, username: 'mike.bahm', role: 'admin' }, SECRET, { nowMs: NOW, ttlSeconds: 3600 });
    const body = verifyToken(t, SECRET, { nowMs: NOW });
    assert.strictEqual(body.sub, 1);
    assert.strictEqual(body.username, 'mike.bahm');
    assert.strictEqual(body.role, 'admin');
    assert.strictEqual(body.exp, Math.floor(NOW / 1000) + 3600);
  });

  test('rejects a tampered payload', () => {
    const t = signToken({ role: 'view' }, SECRET, { nowMs: NOW });
    const [p, sig] = t.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ role: 'admin', exp: Math.floor(NOW / 1000) + 9999 })).toString('base64url');
    assert.strictEqual(verifyToken(`${forgedBody}.${sig}`, SECRET, { nowMs: NOW }), null);
  });

  test('rejects a wrong secret', () => {
    const t = signToken({ role: 'edit' }, SECRET, { nowMs: NOW });
    assert.strictEqual(verifyToken(t, 'other-secret', { nowMs: NOW }), null);
  });

  test('rejects an expired token', () => {
    const t = signToken({ role: 'view' }, SECRET, { nowMs: NOW, ttlSeconds: 60 });
    assert.strictEqual(verifyToken(t, SECRET, { nowMs: NOW + 61_000 }), null);
  });

  test('rejects malformed input', () => {
    assert.strictEqual(verifyToken('', SECRET, { nowMs: NOW }), null);
    assert.strictEqual(verifyToken('no-dot', SECRET, { nowMs: NOW }), null);
    assert.strictEqual(verifyToken(null, SECRET, { nowMs: NOW }), null);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test netlify/functions/deal-lib/token.test.js`
Expected: FAIL with "Cannot find module './token'".

- [ ] **Step 4: Write the implementation**

Create `netlify/functions/deal-lib/token.js`:
```js
// PCG Deal Pipeline — signed session token (HMAC-SHA256), pure + testable.
// Format: base64url(JSON body) + "." + base64url(HMAC-SHA256(bodyB64, secret)).
const crypto = require('crypto');

const b64urlJson = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const hmac = (data, secret) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

/** @param {object} payload @param {string} secret @param {{ttlSeconds?:number, nowMs?:number}} [opts] */
function signToken(payload, secret, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const ttl = typeof opts.ttlSeconds === 'number' ? opts.ttlSeconds : 43200; // 12h
  const iat = Math.floor(nowMs / 1000);
  const body = { ...payload, iat, exp: iat + ttl };
  const p = b64urlJson(body);
  return `${p}.${hmac(p, secret)}`;
}

/** @returns {object|null} decoded body, or null if invalid/expired/tampered */
function verifyToken(token, secret, opts = {}) {
  if (typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const expected = hmac(p, secret);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let body;
  try { body = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; }
  if (!body || typeof body.exp !== 'number' || Math.floor(nowMs / 1000) >= body.exp) return null;
  return body;
}

module.exports = { signToken, verifyToken };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test netlify/functions/deal-lib/token.test.js`
Expected: PASS (all 5 tests).

- [ ] **Step 6: Commit**

```bash
git add netlify/functions/deal-lib/token.js netlify/functions/deal-lib/token.test.js package.json
git commit -m "feat(deals): signed session-token module (HMAC) with tests"
```
End commit bodies with:
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

---

### Task 2: Pure role-rank helper

**Files:**
- Create: `netlify/functions/deal-lib/roles.js`
- Test: `netlify/functions/deal-lib/roles.test.js`

- [ ] **Step 1: Write the failing test**

Create `netlify/functions/deal-lib/roles.test.js`:
```js
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { roleSatisfies, ROLE_RANK } = require('./roles');

describe('roleSatisfies', () => {
  test('higher roles satisfy lower requirements', () => {
    assert.ok(roleSatisfies('admin', 'view'));
    assert.ok(roleSatisfies('admin', 'edit'));
    assert.ok(roleSatisfies('edit', 'view'));
    assert.ok(roleSatisfies('edit', 'edit'));
    assert.ok(roleSatisfies('view', 'view'));
  });
  test('lower roles do not satisfy higher requirements', () => {
    assert.ok(!roleSatisfies('view', 'edit'));
    assert.ok(!roleSatisfies('view', 'admin'));
    assert.ok(!roleSatisfies('edit', 'admin'));
  });
  test('unknown / missing roles never satisfy', () => {
    assert.ok(!roleSatisfies(undefined, 'view'));
    assert.ok(!roleSatisfies('bogus', 'view'));
    assert.ok(!roleSatisfies('admin', 'bogus'));
  });
  test('ROLE_RANK exposes the ordering', () => {
    assert.ok(ROLE_RANK.admin > ROLE_RANK.edit && ROLE_RANK.edit > ROLE_RANK.view);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test netlify/functions/deal-lib/roles.test.js`
Expected: FAIL with "Cannot find module './roles'".

- [ ] **Step 3: Write the implementation**

Create `netlify/functions/deal-lib/roles.js`:
```js
// PCG Deal Pipeline — role ranking for RBAC. view < edit < admin.
const ROLE_RANK = { view: 1, edit: 2, admin: 3 };

/** Does userRole meet or exceed requiredRole? Unknown roles never satisfy. */
function roleSatisfies(userRole, requiredRole) {
  const have = ROLE_RANK[userRole] || 0;
  const need = ROLE_RANK[requiredRole];
  if (!need) return false; // unknown requirement → deny
  return have >= need;
}

module.exports = { ROLE_RANK, roleSatisfies };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test netlify/functions/deal-lib/roles.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/deal-lib/roles.js netlify/functions/deal-lib/roles.test.js
git commit -m "feat(deals): role-rank RBAC helper with tests"
```

---

### Task 3: Neon schema (deals + related tables)

**Files:**
- Modify: `netlify/functions/db-migrate.js`

- [ ] **Step 1: Read the existing migration to find the insertion point**

Open `netlify/functions/db-migrate.js`. It runs a sequence of `await db\`CREATE TABLE IF NOT EXISTS …\`` statements (see the `kb_articles` / `kb_embeddings` block). You will append the Deal tables to that sequence (before the handler returns its success response).

- [ ] **Step 2: Add the Deal tables**

Insert these statements in the migration sequence (after the last existing `CREATE TABLE`):
```js
await db`
  CREATE TABLE IF NOT EXISTS deal_access (
    user_key   TEXT PRIMARY KEY,           -- lowercased username OR email
    role       TEXT NOT NULL DEFAULT 'view', -- view | edit | admin
    added_by   TEXT,
    added_at   TIMESTAMPTZ DEFAULT now()
  )
`;

await db`
  CREATE TABLE IF NOT EXISTS deals (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    address       TEXT, city TEXT, state TEXT,            -- PA | NJ
    deal_type     TEXT NOT NULL,                          -- lease | purchase
    brand         TEXT,                                   -- dunkin | papajohns | bww_go | dual
    pc_number     TEXT,
    stage         TEXT NOT NULL DEFAULT 'sourcing',
    status        TEXT NOT NULL DEFAULT 'active',         -- active | handed_off | dead
    dead_reason   TEXT,
    deal_lead     TEXT, broker_source TEXT, sqft INTEGER,
    -- lease fields
    landlord_entity TEXT, landlord_contact TEXT, lease_structure TEXT,
    base_rent NUMERIC, rent_psf NUMERIC, escalations TEXT, term_years TEXT,
    renewal_options TEXT, ti_allowance NUMERIC, free_rent TEXT, est_nnn_cam NUMERIC,
    cam_cap TEXT, cam_gross_up TEXT, cam_audit_window_days INTEGER,
    percentage_rent TEXT, pct_rent_breakpoint TEXT, guaranty_type TEXT,
    use_clause TEXT, exclusivity TEXT, radius_restriction TEXT, cotenancy TEXT,
    kickout TEXT, holdover TEXT, rofr_rofo TEXT, signage TEXT, parking TEXT,
    delivery_condition TEXT, security_deposit NUMERIC,
    -- purchase fields
    seller_entity TEXT, seller_contact TEXT, purchase_price NUMERIC,
    earnest_money NUMERIC, emd_hard BOOLEAN DEFAULT false, title_escrow_co TEXT,
    lender TEXT, loan_terms TEXT, appraisal_status TEXT, phase1_status TEXT,
    survey_status TEXT, zoning_status TEXT,
    -- gaps
    spe_entity TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )
`;

await db`
  CREATE TABLE IF NOT EXISTS deal_notes (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    author TEXT, body TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now()
  )
`;

await db`
  CREATE TABLE IF NOT EXISTS deal_dates (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    date_type TEXT NOT NULL,
    due_date DATE NOT NULL,
    recurring TEXT,                       -- null | 'monthly' | 'quarterly' | 'annual'
    warning_tiers JSONB DEFAULT '[]'::jsonb,  -- e.g. [180,120,90,60,30]
    acknowledged_by TEXT, acknowledged_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )
`;

await db`
  CREATE TABLE IF NOT EXISTS deal_documents (
    id SERIAL PRIMARY KEY,
    deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL,               -- loi | lease_psa | amendment | estoppel | snda | title | survey | phase1 | zoning | appraisal | guaranty | closing | other
    title TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )
`;

await db`
  CREATE TABLE IF NOT EXISTS deal_document_versions (
    id SERIAL PRIMARY KEY,
    document_id INTEGER REFERENCES deal_documents(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    blob_key TEXT NOT NULL,               -- chunked-upload base key (see Plan 3)
    filename TEXT, size INTEGER,
    uploaded_by TEXT, uploaded_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(document_id, version_no)
  )
`;

await db`CREATE INDEX IF NOT EXISTS idx_deals_status_stage ON deals(status, stage)`;
await db`CREATE INDEX IF NOT EXISTS idx_deal_dates_due ON deal_dates(due_date)`;
```

- [ ] **Step 3: Seed initial deal_access for the managers (Mike & Ahmed)**

Add after the table creation (idempotent upsert):
```js
await db`
  INSERT INTO deal_access (user_key, role, added_by) VALUES
    ('mike.bahm', 'admin', 'system'),
    ('mike@peoplecapitalgroup.com', 'admin', 'system'),
    ('ahmed', 'admin', 'system'),
    ('ahmed@peoplecapitalgroup.com', 'admin', 'system')
  ON CONFLICT (user_key) DO NOTHING
`;
```

- [ ] **Step 4: Verify the migration file still loads**

Run: `node -e "require('./netlify/functions/db-migrate.js'); console.log('OK')"`
Expected: prints `OK` (syntax valid; the migration runs against Neon only when the function is triggered).

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/db-migrate.js
git commit -m "feat(deals): Neon schema (deals, dates, notes, documents, access) + manager seed"
```

> After deploy, the tables are created by triggering `db-migrate` (manual function). Note that in the execution checkpoint.

---

### Task 4: `deal-auth.js` — verify password OR Google, issue token

**Files:**
- Create: `netlify/functions/deal-auth.js`

- [ ] **Step 1: Write the function**

Create `netlify/functions/deal-auth.js`:
```js
// PCG Deal Pipeline — server-side auth. Verifies a caller (password against the
// pcg_users_v1 blob, OR a Google ID token), confirms they're in deal_access, and
// issues a short-lived signed token used by all deal endpoints.
const { getStore } = require('@netlify/blobs');
const { sql } = require('./db');
const { signToken } = require('./deal-lib/token');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
const lc = (s) => (s == null ? '' : String(s).trim().toLowerCase());

function blobStore() {
  return getStore({ name: 'pcg-portal', consistency: 'strong', siteID: process.env.PCG_SITE_ID, token: process.env.PCG_AUTH_TOKEN });
}

async function loadUsers() {
  try { const w = await blobStore().get('pcg_users_v1', { type: 'json' }); const d = w?.data || w; return Array.isArray(d) ? d : (d?.users || []); }
  catch { return []; }
}

async function verifyGoogle(idToken) {
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(process.env.GOOGLE_GSI_CLIENT_ID);
  const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_GSI_CLIENT_ID });
  const p = ticket.getPayload();
  if (!p?.email_verified) return null;
  return lc(p.email);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'POST only' }) };

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'bad json' }) }; }

  // 1) Resolve the caller's identity keys (username + email), verified server-side.
  let identityKeys = []; let userId = null;
  try {
    if (body.googleIdToken) {
      const email = await verifyGoogle(body.googleIdToken);
      if (!email) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'google verification failed' }) };
      const users = await loadUsers();
      const u = users.find(x => lc(x.email) === email);
      identityKeys = [email, lc(u?.username)].filter(Boolean);
      userId = u?.id ?? null;
    } else if (body.username && body.password) {
      const users = await loadUsers();
      const u = users.find(x => lc(x.username) === lc(body.username));
      if (!u || u.active === false || String(u.password || '') !== String(body.password)) {
        return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'invalid credentials' }) };
      }
      identityKeys = [lc(u.username), lc(u.email)].filter(Boolean);
      userId = u.id ?? null;
    } else {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'username+password or googleIdToken required' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'auth error' }) };
  }

  // 2) Look up deal_access role by any of the caller's identity keys.
  let role = null;
  try {
    const db = sql();
    const rows = await db`SELECT user_key, role FROM deal_access WHERE user_key = ANY(${identityKeys})`;
    const rank = { view: 1, edit: 2, admin: 3 };
    role = rows.reduce((best, r) => (rank[r.role] > (rank[best] || 0) ? r.role : best), null);
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'access lookup failed' }) };
  }
  if (!role) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'no deal access' }) };

  // 3) Issue the signed token.
  const secret = process.env.DEAL_SESSION_SECRET;
  if (!secret) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'server not configured' }) };
  const token = signToken({ sub: userId, username: identityKeys[0], role }, secret);
  return { statusCode: 200, headers: cors, body: JSON.stringify({ token, role, expiresIn: 43200 }) };
};
```

- [ ] **Step 2: Verify it loads**

Run: `node -e "require('./netlify/functions/deal-auth.js'); console.log('OK')"`
Expected: prints `OK` (requires resolve; `google-auth-library` is present via `googleapis`).
If it errors that `google-auth-library` is not found, run `npm ls google-auth-library`; if absent, `npm i google-auth-library` and commit `package.json`/`package-lock.json` with the function.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/deal-auth.js
git commit -m "feat(deals): deal-auth — server-side password+Google verify, issues signed token"
```

> **Env to set before deploy (note for the checkpoint):** `DEAL_SESSION_SECRET` (random 32+ char), `GOOGLE_GSI_CLIENT_ID` (the existing GSI client id from index.html). Set via `netlify env:set`.

---

### Task 5: `deals.js` — authenticated CRUD

**Files:**
- Create: `netlify/functions/deals.js`

- [ ] **Step 1: Write the function**

Create `netlify/functions/deals.js`:
```js
// PCG Deal Pipeline — authenticated deal CRUD. Every request requires a valid
// deal session token; reads need 'view', writes need 'edit'.
const { sql } = require('./db');
const { verifyToken } = require('./deal-lib/token');
const { roleSatisfies } = require('./deal-lib/roles');

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Content-Type': 'application/json' };
const reply = (code, obj) => ({ statusCode: code, headers: cors, body: JSON.stringify(obj) });

function authUser(event) {
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  return verifyToken(token, process.env.DEAL_SESSION_SECRET || '');
}

const STAGES = ['sourcing','loi_out','loi_executed','due_diligence','negotiating','executed','closing','ready_for_construction'];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  const user = authUser(event);
  if (!user) return reply(401, { error: 'unauthorized' });

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'bad json' }); }
  const action = body.action;
  const db = sql();
  const needWrite = ['create','update','moveStage','handoff','markDead','addNote'].includes(action);
  if (needWrite && !roleSatisfies(user.role, 'edit')) return reply(403, { error: 'read-only access' });

  try {
    if (action === 'list') {
      const rows = await db`SELECT * FROM deals WHERE status = ${body.status || 'active'} ORDER BY updated_at DESC`;
      return reply(200, { deals: rows });
    }
    if (action === 'get') {
      const [deal] = await db`SELECT * FROM deals WHERE id = ${body.id}`;
      if (!deal) return reply(404, { error: 'not found' });
      const dates = await db`SELECT * FROM deal_dates WHERE deal_id = ${body.id} ORDER BY due_date`;
      const notes = await db`SELECT * FROM deal_notes WHERE deal_id = ${body.id} ORDER BY created_at DESC`;
      return reply(200, { deal, dates, notes });
    }
    if (action === 'create') {
      const d = body.deal || {};
      const [row] = await db`
        INSERT INTO deals (name, address, city, state, deal_type, brand, deal_lead, broker_source, sqft, stage, created_by)
        VALUES (${d.name}, ${d.address || null}, ${d.city || null}, ${d.state || null}, ${d.deal_type}, ${d.brand || null},
                ${d.deal_lead || null}, ${d.broker_source || null}, ${d.sqft || null}, ${d.stage || 'sourcing'}, ${user.username})
        RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'update') {
      // Whitelist updatable columns to avoid SQL-injection via dynamic keys.
      const allowed = new Set(['name','address','city','state','deal_type','brand','pc_number','deal_lead','broker_source','sqft',
        'landlord_entity','landlord_contact','lease_structure','base_rent','rent_psf','escalations','term_years','renewal_options',
        'ti_allowance','free_rent','est_nnn_cam','cam_cap','cam_gross_up','cam_audit_window_days','percentage_rent','pct_rent_breakpoint',
        'guaranty_type','use_clause','exclusivity','radius_restriction','cotenancy','kickout','holdover','rofr_rofo','signage','parking',
        'delivery_condition','security_deposit','seller_entity','seller_contact','purchase_price','earnest_money','emd_hard',
        'title_escrow_co','lender','loan_terms','appraisal_status','phase1_status','survey_status','zoning_status','spe_entity']);
      const fields = Object.entries(body.deal || {}).filter(([k]) => allowed.has(k));
      for (const [k, v] of fields) {
        await db(`UPDATE deals SET ${k} = $1, updated_at = now() WHERE id = $2`, [v, body.id]);
      }
      const [row] = await db`SELECT * FROM deals WHERE id = ${body.id}`;
      return reply(200, { deal: row });
    }
    if (action === 'moveStage') {
      if (!STAGES.includes(body.stage)) return reply(400, { error: 'invalid stage' });
      const [row] = await db`UPDATE deals SET stage = ${body.stage}, updated_at = now() WHERE id = ${body.id} RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'handoff') {
      const [row] = await db`UPDATE deals SET status = 'handed_off', stage = 'ready_for_construction', updated_at = now() WHERE id = ${body.id} RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'markDead') {
      const [row] = await db`UPDATE deals SET status = 'dead', dead_reason = ${body.reason || null}, updated_at = now() WHERE id = ${body.id} RETURNING *`;
      return reply(200, { deal: row });
    }
    if (action === 'addNote') {
      await db`INSERT INTO deal_notes (deal_id, author, body) VALUES (${body.id}, ${user.username}, ${body.note})`;
      const notes = await db`SELECT * FROM deal_notes WHERE deal_id = ${body.id} ORDER BY created_at DESC`;
      return reply(200, { notes });
    }
    return reply(400, { error: 'unknown action' });
  } catch (e) {
    return reply(500, { error: 'server error' });
  }
};
```
> Note: the dynamic `UPDATE` in `update` uses the `neon` client's positional-parameter call form `db(text, params)` with a **whitelisted** column name (never interpolated from user input) — column keys come from a fixed `allowed` set, values are parameterized. Confirm `db.js`'s `neon()` client supports the `sql(text, params)` call form; if not, build the update with one tagged-template `UPDATE` per field instead (e.g. a small switch, or `db\`UPDATE deals SET base_rent = ${v} ...\`` per allowed key).

- [ ] **Step 2: Verify it loads**

Run: `node -e "require('./netlify/functions/deals.js'); console.log('OK')"`
Expected: prints `OK`.

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/deals.js
git commit -m "feat(deals): authenticated deal CRUD (list/get/create/update/moveStage/handoff/markDead/addNote)"
```

---

### Task 6: Deploy + live foundation verification

**Files:** none (verification)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all tests pass (token + roles + existing pnl/analyst).

- [ ] **Step 2: Set env + deploy fresh functions**

```bash
npx netlify env:set DEAL_SESSION_SECRET "$(openssl rand -hex 32)"
npx netlify env:set GOOGLE_GSI_CLIENT_ID "<the GSI client id from index.html>"
npm run build
npx netlify deploy --prod --skip-functions-cache
```
> `--skip-functions-cache` because new functions were added (avoids the stale-bundle issue seen on the P&L deploy).

- [ ] **Step 3: Run the migration**

Trigger `db-migrate` (the manual function) once to create the Deal tables. Confirm no error in the response/logs.

- [ ] **Step 4: Smoke-test the auth + API with curl**

```bash
# a) get a token as a password manager (Mike)
TOKEN=$(curl -s -X POST "https://pcg-ops.netlify.app/.netlify/functions/deal-auth" -H "Content-Type: application/json" -d '{"username":"mike.bahm","password":"<pw>"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
# b) create a deal
curl -s -X POST "https://pcg-ops.netlify.app/.netlify/functions/deals" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"action":"create","deal":{"name":"Test Site","deal_type":"lease","state":"PA","brand":"dunkin"}}'
# c) list
curl -s -X POST "https://pcg-ops.netlify.app/.netlify/functions/deals" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"action":"list"}'
# d) confirm NO token is rejected (server-side enforcement)
curl -s -X POST "https://pcg-ops.netlify.app/.netlify/functions/deals" -H "Content-Type: application/json" -d '{"action":"list"}'   # expect 401
```
Expected: (a) returns a token + role `admin`; (b) returns the created deal; (c) lists it; (d) returns 401 — proving the data is server-protected, not just hidden.

- [ ] **Step 5: Clean up the test deal** (optional)

Mark it dead via a `markDead` call once the UI exists, or leave it for the Plan 2 UI smoke test.

---

## Self-Review

**Spec coverage (foundation slice):**
- Server-side RBAC (verify password + Google, role-gated reads/writes) → Tasks 1, 2, 4, 5. ✓
- Neon data model (deals + dates + notes + documents/versions + access) → Task 3. ✓
- Deal stages + handoff + dead-reason → Task 5 (`moveStage`/`handoff`/`markDead`). ✓
- Confidential data not client-dependent (401 without token) → Task 6 Step 4d. ✓

**Deferred to later plans (not gaps):** all UI (Plan 2), document upload/versioning bytes (Plan 3 — schema is here), critical-date .ics/alerts + dashboard (Plan 4).

**Open items flagged for the execution checkpoint:** confirm `google-auth-library` resolves (Task 4 Step 2); confirm the `neon()` client supports `db(text, params)` for the whitelisted dynamic update (Task 5 Step 1 note); set `DEAL_SESSION_SECRET` + `GOOGLE_GSI_CLIENT_ID` (Task 6 Step 2).
