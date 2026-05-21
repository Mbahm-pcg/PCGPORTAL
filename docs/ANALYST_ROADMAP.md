# UOP Analyst (Orion) — Roadmap

## Phase 1 (v5.0) — MVP ✅
- [x] Cmd-K "Ask Analyst" omnibar (global, every page)
- [x] Today's Brief from Orion (3-5 bullets, cached, refresh on demand)
- [x] Business Cases feed card (auto-generated from anomalies, status workflow)
- [x] analyst.js HTTP handler (ask, brief, case-list, case-update, feedback)
- [x] analyst-cron.js scheduled function (anomaly detection, brief generation, case creation)
- [x] analyst-lib/ modules (data, claude, prompts, anomaly, cases, cache, audit)
- [x] 👍/👎 feedback on every answer, logged to blobs
- [x] Haiku/Sonnet model routing (cost control)
- [x] Audit logging (every LLM call with token count + cost)
- [x] District-scoped data for DMs
- [x] docs/ANALYST_ROADMAP.md

## Phase 2 — Analyst Chat Channel + Deep Features
- [ ] Analyst channel type inside existing Chat (#analyst-me, #analyst-exec, #analyst-ops)
- [ ] Threaded conversations with context memory
- [ ] @mention routing (Analyst auto-mentions relevant DM/GM)
- [ ] "Drill in" links — click citation to open exact Pulse/Labor view
- [x] Make every KPI tile on dashboard clickable → opens Analyst thread pre-seeded with "Explain this tile"
- [x] Knowledge Base section (metric definitions, SOPs, brand standards)
- [ ] Page-locking with approval workflow (draft → review → lock)
- [ ] Supabase/Postgres migration for structured storage + pgvector for KB embeddings
- [ ] GM access (store-scoped data only)

## Phase 3 — Data Stories + Scheduled Reports
- [ ] Auto-generated interactive dashboards (save/share)
- [ ] Slide deck generation (reveal.js or PPTX, board-ready)
- [x] Scheduled reports: daily 7am DMO, weekly exec (Sun + Tue) — monthly P&L pending
- [x] Delivery: email (Resend) — in-app inbox + Chat delivery pending
- [x] One-click "Send to Announcements" and "Send to a Location Manager"
- [x] PDF export for business cases and reports

## Phase 4 — Connectors + Advanced Intelligence
- [ ] Pluggable connectors: BigQuery, Snowflake, Postgres, QBO, GA, Meta
- [ ] Email integration (Google Workspace SMTP/IMAP)
- [ ] Slack/Teams outbound
- [ ] Weather-aware forecasting (condition forecasts on 7-day weather) — coords defined, pending UI
- [ ] Guest sentiment fusion (Google/Yelp reviews per location, sentiment scoring) — Places API (New) selected
- [ ] Vendor/COGS watchdog (track invoice unit costs, flag creeping prices) — WorkPulse as source, pending API access
- [ ] Forecast-to-schedule loop (Next Week Forecast → shift recommendations → push to Paycor)
- [ ] Cash variance autopilot (deposit variance → auto business case with likely cause)

## Phase 5 — Embedded / White-Label / Enterprise
- [x] SSO (Google), session timeout, 2FA on admin
- [x] SOC 2-style audit trail, PII redaction on logs
- [ ] Row-level security per location
- [x] Embeddable mode (narrow mobile view for GMs)
- [x] Theme tokens for multi-brand white-labeling
- [ ] Franchisee portal mode (single-location operators, locked-down data)
- [x] MCP server: expose UOP as MCP endpoint for Claude Desktop / Claude Code
- [x] Notion, Google Drive, SharePoint, GitHub sync for KB

## Level-Up Ideas (Beyond Orion)
- [ ] Voice-first "Walk-the-floor" mode for GMs (speak → 30-second action list)
- [x] Location leaderboards + gamification (weekly rankings with auto shout-outs)
- [x] "Decision log" — Accept/Reject on cases becomes reinforcement learning data
- [x] "Ask the archive" — index all past Announcements, Notes, Chat into KB
- [ ] Compliance/audit: auto-generate monthly board-ready deck + food-safety readiness report
- [ ] Mobile/PWA-first Analyst experience
