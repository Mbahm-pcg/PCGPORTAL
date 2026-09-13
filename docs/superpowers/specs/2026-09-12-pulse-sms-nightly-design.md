# PCG Pulse Nightly SMS — Design Spec

**Date:** 2026-09-12 · Repo: PCGPORTAL (main, live v20.77).

## Goal
Send a nightly SMS to Mike and Krunal with the same sales numbers as the existing nightly "PCG Pulse" email — today's net sales and week-to-date (WTD). On Saturday nights, also include the Top 5 stores by WTD. Plus a config-page button to send a test SMS with the most recent day's data on demand.

## Where it lives
`netlify/functions/pulse-notify.mjs` already runs nightly (~10pm ET via `pulse-cron`, and on manual trigger). It fetches per-store daily totals and computes network `daily.netSales` (today) and `wtd.netSales` (WTD). The SMS piggybacks on that same run — same data, same timing — and is sent **after** the email as best-effort, so an SMS failure never affects the email. Store list comes from the imported `STORES`.

**Per-store WTD (for Saturday Top 5) needs no extra Pulse API calls:** the existing WTD loop already calls `fetchAllStores(date)` for every day in the week; today it aggregates and discards the per-store breakdown. We accumulate a `perStoreWtd[pc] += results[pc].netSales` in that same loop.

## Message format (dollars with cents, comma-grouped)

Nightly (Sun–Fri):
```
PCG Pulse Daily Update (Fri 9/12)
Today's Sales: $124,530.47
WTD Sales: $842,100.19
Have a Good Night
```

Saturday (business date's weekday is Saturday):
```
PCG Pulse Daily Update (Sat 9/13)
Today's Sales: $148,900.12
WTD Sales: $990,400.55
Top 5:
1) County Line $52,300.00
2) 8200 $49,100.00
3) Warrington $47,800.00
4) Lansdowne $45,200.00
5) Elkins $44,900.00
Have a Good Night
```

- Header date: `(<Ddd M/D>)` derived from the business date (e.g. `Fri 9/12`).
- Top 5 = the 5 stores with the highest WTD net sales, labeled with the store's display name (`STORES[].name`), value = that store's WTD with cents. If fewer than 5 operational stores have data, list only what exists.

## Components

### `src/pulse-sms.mjs` (pure, unit-tested — no I/O)
- `fmtUSD(n) -> "$1,234.56"` (comma-grouped, 2 decimals).
- `topStoresByWtd(perStoreWtd, stores, n=5) -> [{ name, wtd }]` — sorted desc, limited to `n`, mapped pc→name.
- `buildPulseSms({ busDt, todaySales, wtdSales, perStoreWtd, stores }) -> string` — decides Saturday vs nightly from `busDt`'s weekday (date-only parse, no TZ drift), formats the message exactly as above.

### `pulse-notify.mjs` (I/O wiring)
- Import `buildPulseSms` from `../../src/pulse-sms.mjs`.
- Accumulate `perStoreWtd` in the existing WTD loop.
- After the email send: build the SMS via `buildPulseSms(...)`, resolve recipients `config.smsRecipients` (default `['+12154903936','+12679340658']`), and send via an inline `sendSms(numbers, message)` helper mirroring `sms.mjs` (Textbelt, `TEXTBELT_API_KEY`, E.164 normalize). Wrap in try/catch — log the result into the run record; never block the email or the run.
- **Test mode:** when the request body has `{ testSms: true, testTo }`, compute the latest `busDt` + `daily` + `wtd` + `perStoreWtd` exactly as a normal run, build the SMS, send **only** to `testTo` (no email, do not write the `pcg_pulse_notify_last_run` guard), and return `{ ok, busDt, message, sms }` so the UI can preview the exact text.

### Config UI (`app.jsx`, Pulse config component, ~lines 17700–17800)
- Add an editable **SMS Recipients** field (comma-separated, mirrors the existing email-recipients field) saved to `config.smsRecipients` (E.164 normalized on save).
- Add a **test-to** input (pre-filled with `+12154903936`) and a **"📱 Send Test Pulse SMS (last day)"** button that POSTs `{ testSms: true, testTo: <field> }` to `pulse-notify`, then shows the returned `message` as a preview plus a sent/failed status (mirroring the existing "⚡ Run Pulse Now" button's status pattern).

## Sender
Textbelt via `TEXTBELT_API_KEY` (the portal's existing SMS provider — confirmed live with 1,437 quota remaining; email stays on Resend, which cannot send SMS). Inline `sendSms` helper (per the codebase's inline-helper convention for crons) rather than an HTTP self-call to `sms.mjs`.

## Recipients & config
- Nightly send: `config.smsRecipients` (array) from `pcg_pulse_notify_config`, defaulting to `['+12154903936','+12679340658']` (Mike + Krunal).
- Test send: only the single `testTo` number from the request (client defaults it to Mike's number).

## Error handling
- Nightly SMS is best-effort: any `sendSms`/build error is caught and logged into the run record; the email and the function's success result are unaffected.
- If the Pulse POS API is down (e.g. SYS102/503), the run already degrades for the email; the SMS simply reflects whatever data the run has (same as email) — no new handling.
- Test mode surfaces errors (Pulse down, bad number) back to the UI.

## Testing
`src/pulse-sms.test.mjs` (picked up by the existing `'src/*.test.mjs'` npm-test glob):
- `fmtUSD`: commas + 2 decimals; zero; large values.
- `topStoresByWtd`: correct desc sort + top-5 limit; pc→name mapping; fewer-than-5 handled; ties stable.
- `buildPulseSms`: nightly format (Sun–Fri) exact; Saturday format includes `Top 5:` + numbered list + closing; header date/weekday derived correctly from `busDt`; dollar values with cents.

Manual verification: click "Send Test Pulse SMS" with your number → confirm the received text and the on-screen preview match; confirm Saturday formatting (unit-tested; live-verified on the next Saturday run).

## Deploy
Reconcile with `origin/main` first (Ahmed pushes daily — currently v20.77, and he has been editing `paycor.mjs`). Build `app.js`, bump `APP_VERSION`, `npm test`, commit, `git push origin main` **without piping its output** (confirm fast-forward), then `npx netlify deploy --prod`, and verify live shows the new version AND Ahmed's latest work intact. See the `pcg-deploy-drift-safety` memory.

## Out of scope
Choosing which stores count; historical/backfill texts; per-recipient message personalization; SMS for anything other than the nightly Pulse; an admin UI for anything beyond the recipients field + test button.
