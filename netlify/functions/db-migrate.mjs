import { sql } from './_shared/db.mjs';

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const db = sql();

  await db`CREATE EXTENSION IF NOT EXISTS vector`;

  await db`
    CREATE TABLE IF NOT EXISTS kb_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT,
      author TEXT,
      status TEXT DEFAULT 'draft',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      locked_by TEXT,
      locked_at TIMESTAMPTZ
    )
  `;

  await db`
    CREATE TABLE IF NOT EXISTS kb_embeddings (
      id SERIAL PRIMARY KEY,
      article_id TEXT REFERENCES kb_articles(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding vector(1536),
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(article_id, chunk_index)
    )
  `;

  await db`
    CREATE INDEX IF NOT EXISTS kb_embeddings_vector_idx
    ON kb_embeddings USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 10)
  `;

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
      author TEXT, body TEXT NOT NULL, kind TEXT DEFAULT 'user', created_at TIMESTAMPTZ DEFAULT now()
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
      alerted_tiers JSONB DEFAULT '[]'::jsonb,  -- fired tier keys for de-dup (e.g. ['overdue','30'])
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

  // Idempotent column adds for deal_dates (in case the table predates these columns).
  await db`ALTER TABLE deal_dates ADD COLUMN IF NOT EXISTS recurring TEXT`;
  await db`ALTER TABLE deal_dates ADD COLUMN IF NOT EXISTS warning_tiers JSONB DEFAULT '[]'::jsonb`;
  // Per-(date,tier) de-dup for deal-alerts-cron: tiers already alerted on for this date.
  // Stored as a JSONB array of fired tier keys (e.g. ['overdue','30','60']).
  await db`ALTER TABLE deal_dates ADD COLUMN IF NOT EXISTS alerted_tiers JSONB DEFAULT '[]'::jsonb`;

  // deal_notes: distinguish system events (stage moves, marked dead, handoff) from user notes.
  await db`ALTER TABLE deal_notes ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'user'`;

  await db`CREATE INDEX IF NOT EXISTS idx_deals_status_stage ON deals(status, stage)`;
  await db`CREATE INDEX IF NOT EXISTS idx_deal_dates_due ON deal_dates(due_date)`;

  await db`CREATE TABLE IF NOT EXISTS deal_leads (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, added_by TEXT, added_at TIMESTAMPTZ DEFAULT now())`;
  await db`INSERT INTO deal_leads (name, added_by) VALUES ('Krunal Rao','system'),('Mike Bahm','system'),('Bill DePrinzio','system'),('Sam Brown','system') ON CONFLICT (name) DO NOTHING`;

  await db`
    INSERT INTO deal_access (user_key, role, added_by) VALUES
      ('mike.bahm', 'admin', 'system'),
      ('mike@peoplecapitalgroup.com', 'admin', 'system'),
      ('ahmed', 'admin', 'system'),
      ('ahmed@peoplecapitalgroup.com', 'admin', 'system')
    ON CONFLICT (user_key) DO NOTHING
  `;

  // ── Users table — canonical user store (replaces pcg_users_v1 blob + portal_users) ──
  await db`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      username    VARCHAR(100) NOT NULL UNIQUE,
      name        VARCHAR(255) NOT NULL,
      email       VARCHAR(255),
      phone       VARCHAR(30),
      role        VARCHAR(100),
      user_type   VARCHAR(50) NOT NULL DEFAULT 'manager',
      district    INTEGER,
      store_pc    VARCHAR(20),
      active      BOOLEAN NOT NULL DEFAULT true,
      dark_mode   BOOLEAN DEFAULT false,
      avatar_url  TEXT,
      google_id   VARCHAR(255),
      last_login  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    )
  `;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change BOOLEAN NOT NULL DEFAULT false`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_required BOOLEAN NOT NULL DEFAULT false`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN NOT NULL DEFAULT false`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS initials VARCHAR(4)`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_setup BOOLEAN NOT NULL DEFAULT false`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS region VARCHAR(10)`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT false`;
  await db`ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_valid_from TIMESTAMPTZ`;
  await db`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)`;
  await db`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`;

  // ── Audit log — analyst LLM calls, feedback, and access/audit events ──
  // Replaces the per-event Netlify Blobs design (analyst/access/*, analyst/audit/*,
  // analyst/feedback/*), whose read path had to list+GET thousands of blobs and
  // timed out. A single indexed query per day is fast and can't time out.
  await db`
    CREATE TABLE IF NOT EXISTS audit_log (
      id            SERIAL PRIMARY KEY,
      type          VARCHAR(50) NOT NULL,        -- access | llm_call | feedback | ...
      user_id       VARCHAR(100),
      action        VARCHAR(100),
      model         VARCHAR(100),
      input_tokens  INTEGER,
      output_tokens INTEGER,
      cost_usd      REAL,
      latency_ms    INTEGER,
      rating        VARCHAR(10),
      error         TEXT,
      metadata      JSONB,
      created_at    TIMESTAMPTZ DEFAULT now()
    )
  `;
  // Access events carry a few extra dimensions; add idempotently.
  await db`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_role VARCHAR(50)`;
  await db`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS district INTEGER`;
  await db`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS status_code INTEGER`;
  // Supports the per-day read: WHERE type=? AND created_at IN [day) ORDER BY created_at DESC.
  await db`CREATE INDEX IF NOT EXISTS idx_audit_type_created ON audit_log(type, created_at DESC)`;
  await db`CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`;

  return new Response(
    JSON.stringify({ ok: true, message: 'Migration complete' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
