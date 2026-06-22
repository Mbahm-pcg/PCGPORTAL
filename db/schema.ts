import { integer, pgTable, varchar, text, boolean, timestamp, real, jsonb, serial, bigint, primaryKey } from "drizzle-orm/pg-core";

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
