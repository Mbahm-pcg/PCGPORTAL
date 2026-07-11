import { integer, pgTable, varchar, text, boolean, timestamp, real, jsonb, serial, bigint, primaryKey, numeric } from "drizzle-orm/pg-core";

// ── Users ─────────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 30 }),
  role: varchar("role", { length: 100 }),
  userType: varchar("user_type", { length: 50 }).notNull(),
  district: integer("district"),
  storePC: varchar("store_pc", { length: 20 }),
  active: boolean("active").notNull().default(true),
  darkMode: boolean("dark_mode").default(false),
  avatarUrl: text("avatar_url"),
  googleId: varchar("google_id", { length: 255 }),
  lastLogin: timestamp("last_login"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  // Auth & 2FA fields
  passwordHash: text("password_hash"),
  mustChange: boolean("must_change").default(false),
  twoFactorRequired: boolean("two_factor_required").default(false),
  twoFactorSecret: text("two_factor_secret"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  // Profile extras
  initials: varchar("initials", { length: 4 }),
  isAdmin: boolean("is_admin").default(false),
  mustSetup: boolean("must_setup").default(false),
  region: varchar("region", { length: 10 }),
  // Login security — failed-attempt lockout (IT-admin unlock only)
  failedAttempts: integer("failed_attempts").notNull().default(0),
  locked: boolean("locked").notNull().default(false),
  // Sign-out-everywhere: tokens issued before this instant are rejected (iat < this).
  sessionsValidFrom: timestamp("sessions_valid_from"),
  // Per-user Audits module grant: null (role default) | 'view' | 'full'. Only
  // executive/it may set it. Self-created via ALTER TABLE IF NOT EXISTS in
  // users.mjs / audits.mjs (not migrated from here) — see audit-lib/access.js
  // (effectiveAudits) and docs/superpowers/specs/2026-07-11-audits-access-grant-design.md.
  auditsAccess: text("audits_access"),
});

// ── Tickets ───────────────────────────────────────────────────────────────────
export const tickets = pgTable("tickets", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 500 }).notNull(),
  description: text("description"),
  status: varchar("status", { length: 30 }).notNull().default("Open"),
  priority: varchar("priority", { length: 20 }).default("Medium"),
  category: varchar("category", { length: 100 }),
  storePC: varchar("store_pc", { length: 20 }),
  district: integer("district"),
  assignedTo: integer("assigned_to"),
  createdBy: integer("created_by").notNull(),
  closedAt: timestamp("closed_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const ticketComments = pgTable("ticket_comments", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id").notNull().references(() => tickets.id),
  userId: integer("user_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Maintenance Tickets (LIVE) ──────────────────────────────────────────────
// These are the tables the portal's maintenance ticket UI actually uses (see
// netlify/functions/tickets.mjs), migrated off the `pcg_tickets_v1` Netlify
// Blob. The `tickets`/`ticket_comments` tables above are an older, unused shape
// kept for reference. `id` is the client-generated Date.now() value (bigint), so
// existing ticket references (selectedId, notifications.ticketId) stay valid.
// tickets.mjs self-creates these via CREATE TABLE IF NOT EXISTS; this block
// documents the schema for drizzle/tooling.
export const maintTickets = pgTable("maint_tickets", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  number: text("number"),
  title: text("title").notNull().default(""),
  description: text("description"),
  notes: text("notes"),
  status: text("status").notNull().default("Open"),
  priority: text("priority").default("Medium"),
  category: text("category"),
  storePC: text("store_pc"),
  storeName: text("store_name"),
  address: text("address"),
  dueDate: text("due_date"),
  ticketOwner: text("ticket_owner"),
  createdBy: text("created_by"),
  selectedIssues: jsonb("selected_issues").notNull().default([]),
  attachments: jsonb("attachments").notNull().default([]),
  expenses: jsonb("expenses").notNull().default([]), // DEPRECATED — expenses now live in maintTicketExpenses; kept empty for back-compat
  startedBy: text("started_by"),
  startedAt: timestamp("started_at"),
  closedBy: text("closed_by"),
  closedAt: timestamp("closed_at"),
  meta: jsonb("meta").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Composite PK (ticketId, id): comment ids are client Date.now() values, unique
// only within a ticket — a global PK would let same-millisecond comments on
// different tickets collide.
export const maintTicketComments = pgTable("maint_ticket_comments", {
  id: bigint("id", { mode: "number" }).notNull(),
  ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
  author: text("author"),
  initials: text("initials"),
  type: text("type").default("comment"),
  text: text("text"),
  createdAt: timestamp("created_at").defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.ticketId, t.id] }) }));

// Expenses logged against a ticket. Expense ids are strings ("exp_<ts>_<rand>"),
// so the PK is text. `amount` is numeric; `receiptKey` points at a separate blob.
export const maintTicketExpenses = pgTable("maint_ticket_expenses", {
  id: text("id").primaryKey(),
  ticketId: bigint("ticket_id", { mode: "number" }).notNull(),
  noExpense: boolean("no_expense").default(false),
  description: text("description"),
  amount: real("amount"),
  category: text("category"),
  addedBy: text("added_by"),
  submittedByUserId: text("submitted_by_user_id"),
  addedAt: timestamp("added_at"),
  receiptKey: text("receipt_key"),
  approvalStatus: text("approval_status"),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at"),
  meta: jsonb("meta").notNull().default({}),
});

// ── Field Operations Audits (LIVE) ────────────────────────────────────────────
// Backs the Audit module UI (see netlify/functions/audits.mjs). audits.mjs
// self-creates these three tables via CREATE TABLE IF NOT EXISTS; this block
// documents the schema for drizzle/tooling only — it is never migrated from here.
export const auditTemplates = pgTable("audit_templates", {
  id: serial("id").primaryKey(),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  type: text("type"),
  sections: jsonb("sections").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// `id` is the client-generated Date.now() value (bigint), same convention as
// maintTickets above. `results` is jsonb: { [itemId]: { result, severity?, note?,
// photoKeys? } }, plus a reserved `_photos` key for audit-level (non-item) photos.
export const audits = pgTable("audits", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  templateId: integer("template_id"),
  storePC: text("store_pc").notNull(),
  auditorUserId: integer("auditor_user_id"),
  auditorName: text("auditor_name"),
  status: text("status").notNull().default("draft"), // draft | submitted
  startedAt: timestamp("started_at"),
  submittedAt: timestamp("submitted_at"),
  submitLat: real("submit_lat"),
  submitLng: real("submit_lng"),
  score: real("score"),
  sectionScores: jsonb("section_scores"),
  cappedByCritical: boolean("capped_by_critical").notNull().default(false),
  results: jsonb("results").notNull().default({}),
  notes: text("notes"),
  unlockedBy: text("unlocked_by"),
  unlockedAt: timestamp("unlocked_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Corrective Action Plan rows: one per checklist item that failed at submit
// time. `id` is `cap_<auditId>_<itemId>` — deterministic, so re-inserting on a
// submit retry is a no-op (ON CONFLICT DO NOTHING in audits.mjs).
export const auditCaps = pgTable("audit_caps", {
  id: text("id").primaryKey(),
  auditId: bigint("audit_id", { mode: "number" }).notNull(),
  templateItemId: text("template_item_id").notNull(),
  itemText: text("item_text"),
  sectionId: text("section_id"),
  severity: text("severity"),
  storePC: text("store_pc"),
  ownerUserId: integer("owner_user_id"),
  ownerName: text("owner_name"),
  deadline: timestamp("deadline"),
  status: text("status").notNull().default("open"), // open | owner_resolved | verified_closed | overdue
  ownerNote: text("owner_note"),
  ownerPhotoKeys: jsonb("owner_photo_keys").notNull().default([]),
  resolvedAt: timestamp("resolved_at"),
  verifiedBy: text("verified_by"),
  verifiedAt: timestamp("verified_at"),
  escalatedAt: timestamp("escalated_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ── Safe Audits (cash / petty-cash reconciliation — LIVE) ─────────────────────
// Backs the Safe Audit UI (see netlify/functions/safe-audits.mjs). This is a distinct
// audit type from the Field Ops checklist above — a denomination cash count reconciled
// against a per-store locked "expected petty cash". safe-audits.mjs self-creates both
// tables via CREATE TABLE IF NOT EXISTS; this block documents the schema for
// drizzle/tooling only — it is never migrated from here.
//
// Per-store locked expected petty cash. `storePC` is the PK. Set on a store's first audit
// submit (via ON CONFLICT DO NOTHING); only executive/it may change it afterward, which
// stamps updatedBy*/updatedAt. See spec §A8.
export const safeSettings = pgTable("safe_settings", {
  storePC: text("store_pc").primaryKey(),
  expectedPettyCash: numeric("expected_petty_cash").notNull(),
  setByUserId: integer("set_by_user_id"),
  setByName: text("set_by_name"),
  setAt: timestamp("set_at"),
  updatedByUserId: integer("updated_by_user_id"),
  updatedByName: text("updated_by_name"),
  updatedAt: timestamp("updated_at"),
});

// One row per safe audit. `id` is the client-generated Date.now() value (bigint), same
// convention as maintTickets/audits. Cash math (billsTotal/coinsTotal/countedTotal/
// accountedTotal/variance/varianceStatus) is recomputed server-side at submit from
// billCounts/coinCounts (jsonb count maps) against the authoritative safeSettings expected —
// client-supplied totals are never trusted. Photos & signatures store blob keys only.
export const safeAudits = pgTable("safe_audits", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  storePC: text("store_pc"),
  storeName: text("store_name"),
  auditorUserId: integer("auditor_user_id"),
  auditorName: text("auditor_name"),
  auditorRole: text("auditor_role"),
  status: text("status").notNull().default("draft"), // draft | submitted
  startedAt: timestamp("started_at"),
  submittedAt: timestamp("submitted_at"),
  reason: text("reason"), // one of safe-cash.js REASONS
  safeCode: text("safe_code"),
  codeLastChanged: text("code_last_changed"),
  storeManagerName: text("store_manager_name"),
  district: integer("district"),
  expectedPettyCash: numeric("expected_petty_cash"),
  hasReceipts: boolean("has_receipts"),
  receiptsTotal: numeric("receipts_total"),
  receiptPhotoKeys: jsonb("receipt_photo_keys").notNull().default([]),
  billCounts: jsonb("bill_counts").notNull().default({}),
  coinCounts: jsonb("coin_counts").notNull().default({}),
  billsTotal: numeric("bills_total"),
  coinsTotal: numeric("coins_total"),
  countedTotal: numeric("counted_total"),
  accountedTotal: numeric("accounted_total"),
  variance: numeric("variance"),
  varianceStatus: text("variance_status"), // balanced | short | over
  hasCounterfeit: boolean("has_counterfeit"),
  counterfeitTotal: numeric("counterfeit_total"),
  counterfeitPhotoKeys: jsonb("counterfeit_photo_keys").notNull().default([]),
  conductorSigKey: text("conductor_sig_key"),
  managerSigKey: text("manager_sig_key"),
  managerAckName: text("manager_ack_name"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ── Business Cases (Orion AI) ─────────────────────────────────────────────────
export const businessCases = pgTable("business_cases", {
  id: serial("id").primaryKey(),
  externalId: varchar("external_id", { length: 100 }).unique(),
  title: varchar("title", { length: 500 }).notNull(),
  summary: text("summary"),
  dollarOpportunity: real("dollar_opportunity").default(0),
  dollarBasis: text("dollar_basis"),
  status: varchar("status", { length: 30 }).notNull().default("New"),
  severity: varchar("severity", { length: 20 }),
  anomalyType: varchar("anomaly_type", { length: 50 }),
  storeName: varchar("store_name", { length: 100 }),
  district: integer("district"),
  affectedLocations: jsonb("affected_locations"),
  actions: jsonb("actions"),
  suggestedOwner: varchar("suggested_owner", { length: 200 }),
  suggestedDueDate: varchar("suggested_due_date", { length: 20 }),
  confidence: varchar("confidence", { length: 10 }),
  citations: jsonb("citations"),
  statusHistory: jsonb("status_history"),
  createdBy: varchar("created_by", { length: 100 }).default("Orion"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ── Chat Messages ─────────────────────────────────────────────────────────────
export const chatMessages = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  channelId: varchar("channel_id", { length: 100 }).notNull(),
  userId: integer("user_id").notNull(),
  userName: varchar("user_name", { length: 255 }),
  content: text("content").notNull(),
  attachments: jsonb("attachments"),
  mentions: jsonb("mentions"),
  deleted: boolean("deleted").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const chatChannels = pgTable("chat_channels", {
  id: varchar("id", { length: 100 }).primaryKey(),
  type: varchar("type", { length: 30 }).notNull(),
  name: varchar("name", { length: 255 }),
  members: jsonb("members"),
  projectId: varchar("project_id", { length: 100 }),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Notifications ─────────────────────────────────────────────────────────────
export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 50 }).notNull(),
  recipientId: integer("recipient_id"),
  channel: varchar("channel", { length: 30 }),
  title: varchar("title", { length: 500 }),
  body: text("body"),
  status: varchar("status", { length: 20 }).default("sent"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Audit Log ─────────────────────────────────────────────────────────────────
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 50 }).notNull(),
  userId: varchar("user_id", { length: 100 }),
  userRole: varchar("user_role", { length: 50 }),
  action: varchar("action", { length: 100 }),
  district: integer("district"),
  statusCode: integer("status_code"),
  model: varchar("model", { length: 100 }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  costUSD: real("cost_usd"),
  latencyMs: integer("latency_ms"),
  rating: varchar("rating", { length: 10 }),
  error: text("error"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Type exports ──────────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type BusinessCase = typeof businessCases.$inferSelect;
export type NewBusinessCase = typeof businessCases.$inferInsert;
export type ChatMessage = typeof chatMessages.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type AuditEntry = typeof auditLog.$inferSelect;
