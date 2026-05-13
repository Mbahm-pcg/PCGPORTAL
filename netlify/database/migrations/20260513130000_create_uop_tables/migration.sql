-- UOP Portal Tables — Phase 2 Foundation
-- Users, Tickets, Business Cases, Chat, Notifications, Audit Log

-- ── Users ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "users" (
  "id" serial PRIMARY KEY,
  "username" varchar(100) NOT NULL UNIQUE,
  "name" varchar(255) NOT NULL,
  "email" varchar(255),
  "phone" varchar(30),
  "role" varchar(100),
  "user_type" varchar(50) NOT NULL,
  "district" integer,
  "store_pc" varchar(20),
  "active" boolean NOT NULL DEFAULT true,
  "dark_mode" boolean DEFAULT true,
  "avatar_url" text,
  "google_id" varchar(255),
  "last_login" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

-- ── Tickets ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tickets" (
  "id" serial PRIMARY KEY,
  "title" varchar(500) NOT NULL,
  "description" text,
  "status" varchar(30) NOT NULL DEFAULT 'Open',
  "priority" varchar(20) DEFAULT 'Medium',
  "category" varchar(100),
  "store_pc" varchar(20),
  "district" integer,
  "assigned_to" integer,
  "created_by" integer NOT NULL,
  "closed_at" timestamp,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "ticket_comments" (
  "id" serial PRIMARY KEY,
  "ticket_id" integer NOT NULL REFERENCES "tickets"("id"),
  "user_id" integer NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp DEFAULT now()
);

-- ── Business Cases (Orion AI) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS "business_cases" (
  "id" serial PRIMARY KEY,
  "external_id" varchar(100) UNIQUE,
  "title" varchar(500) NOT NULL,
  "summary" text,
  "dollar_opportunity" real DEFAULT 0,
  "dollar_basis" text,
  "status" varchar(30) NOT NULL DEFAULT 'New',
  "severity" varchar(20),
  "anomaly_type" varchar(50),
  "store_name" varchar(100),
  "district" integer,
  "affected_locations" jsonb,
  "actions" jsonb,
  "suggested_owner" varchar(200),
  "suggested_due_date" varchar(20),
  "confidence" varchar(10),
  "citations" jsonb,
  "status_history" jsonb,
  "created_by" varchar(100) DEFAULT 'Orion',
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

-- ── Chat ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "chat_channels" (
  "id" varchar(100) PRIMARY KEY,
  "type" varchar(30) NOT NULL,
  "name" varchar(255),
  "members" jsonb,
  "project_id" varchar(100),
  "created_by" integer,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "chat_messages" (
  "id" serial PRIMARY KEY,
  "channel_id" varchar(100) NOT NULL,
  "user_id" integer NOT NULL,
  "user_name" varchar(255),
  "content" text NOT NULL,
  "attachments" jsonb,
  "mentions" jsonb,
  "deleted" boolean DEFAULT false,
  "created_at" timestamp DEFAULT now()
);

-- ── Notifications ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" serial PRIMARY KEY,
  "type" varchar(50) NOT NULL,
  "recipient_id" integer,
  "channel" varchar(30),
  "title" varchar(500),
  "body" text,
  "status" varchar(20) DEFAULT 'sent',
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now()
);

-- ── Audit Log ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" serial PRIMARY KEY,
  "type" varchar(50) NOT NULL,
  "user_id" varchar(100),
  "action" varchar(100),
  "model" varchar(100),
  "input_tokens" integer,
  "output_tokens" integer,
  "cost_usd" real,
  "latency_ms" integer,
  "rating" varchar(10),
  "error" text,
  "metadata" jsonb,
  "created_at" timestamp DEFAULT now()
);

-- ── Indexes ────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_tickets_status" ON "tickets"("status");
CREATE INDEX IF NOT EXISTS "idx_tickets_district" ON "tickets"("district");
CREATE INDEX IF NOT EXISTS "idx_tickets_created_by" ON "tickets"("created_by");
CREATE INDEX IF NOT EXISTS "idx_ticket_comments_ticket" ON "ticket_comments"("ticket_id");
CREATE INDEX IF NOT EXISTS "idx_business_cases_status" ON "business_cases"("status");
CREATE INDEX IF NOT EXISTS "idx_business_cases_district" ON "business_cases"("district");
CREATE INDEX IF NOT EXISTS "idx_business_cases_created" ON "business_cases"("created_at");
CREATE INDEX IF NOT EXISTS "idx_chat_messages_channel" ON "chat_messages"("channel_id");
CREATE INDEX IF NOT EXISTS "idx_chat_messages_created" ON "chat_messages"("created_at");
CREATE INDEX IF NOT EXISTS "idx_notifications_recipient" ON "notifications"("recipient_id");
CREATE INDEX IF NOT EXISTS "idx_notifications_type" ON "notifications"("type");
CREATE INDEX IF NOT EXISTS "idx_audit_log_type" ON "audit_log"("type");
CREATE INDEX IF NOT EXISTS "idx_audit_log_created" ON "audit_log"("created_at");
CREATE INDEX IF NOT EXISTS "idx_audit_log_user" ON "audit_log"("user_id");
