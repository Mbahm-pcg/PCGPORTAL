# Phase 4: Connectors + Advanced Intelligence — Design Spec

## Overview

Three independent features extending the Orion Analyst with external data connectors and intelligence layers:

1. **Weather-Aware Forecasting** — 7-day weather forecasts overlaid on sales data with historical impact correlation
2. **Guest Sentiment Fusion** — Google Places reviews with Claude-powered sentiment analysis per store
3. **Email Integration** — Branded outbound via Google Workspace SMTP relay + shared inbox viewer

**Architecture:** Each feature follows the existing pattern: scheduled Netlify Function → external API → Netlify Blob → frontend display + Orion prompt injection. All three are independent and can be built/deployed separately.

**Tech Stack:** Open-Meteo Forecast API (free), Google Places API (New), Google Workspace SMTP relay, Gmail API, nodemailer, Claude Haiku (sentiment), Netlify Blobs, existing analyst-lib infrastructure.

---

## Feature 1: Weather-Aware Forecasting

### Goal

Overlay 7-day weather forecasts on Pulse sales views and inject weather-adjusted sales targets using historical weather↔sales correlations. Orion references weather impact in briefs and answers.

### Data Flow

```
Open-Meteo Forecast API → weather-forecast-cron.js → pcg_weather_forecast blob
                                                    → pcg_weather_correlations blob
Historical blobs (hourly snapshots) → correlation engine → impact coefficients
Frontend reads forecast blob → weather row in Pulse grid + forecast badges
Orion prompts receive weather context → briefs mention impact
```

### Backend

#### `netlify/functions/weather-forecast-cron.js`

Scheduled daily (after labor-cron, ~8 AM ET). For each of the 8 districts:

1. Call Open-Meteo Forecast API: `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode&timezone=America/New_York&forecast_days=7`
2. Map WMO weathercode to condition string (reuse mapping from `pulse-hourly-snapshot.js`)
3. Store per-district 7-day forecast in blob `pcg_weather_forecast`

Blob structure:
```json
{
  "savedAt": "2026-05-25T12:00:00Z",
  "data": {
    "1": {
      "days": [
        { "date": "2026-05-25", "condition": "clear", "wmoCode": 0, "tempHighF": 82, "tempLowF": 61, "precipMm": 0 },
        { "date": "2026-05-26", "condition": "rain", "wmoCode": 61, "tempHighF": 68, "tempLowF": 55, "precipMm": 12.4 }
      ]
    },
    "2": { "days": [...] }
  }
}
```

#### Correlation Engine (in `analyst-data.js`)

New function `buildWeatherCorrelations()`:

1. Load last 90 days of hourly snapshot blobs (`pcg_hourly_history_{pc}`) for all stores
2. Group daily sales by district + weather condition
3. Calculate average daily sales per condition vs overall average → impact coefficient
4. Output per-district coefficients:

```json
{
  "1": {
    "clear": 1.03,
    "cloudy": 0.99,
    "rain": 0.88,
    "snow": 0.72,
    "storm": 0.65,
    "fog": 0.95,
    "sampleSize": 90
  }
}
```

Store in blob `pcg_weather_correlations`. Refresh weekly (run inside weather-forecast-cron on Mondays).

#### Weather-Adjusted Targets

In the forecast blob, include `adjustedTarget` per day per district:
- `adjustedTarget = baselineAvgSales * impactCoefficient`
- Baseline = average daily sales for that district over last 4 weeks (same day-of-week)

#### Orion Integration

New function in `analyst-data.js`: `buildWeatherContext({ district })`:
- Loads forecast blob
- Returns string like: "Weather forecast for District 3: Mon clear 78°F, Tue rain 65°F (historically -12% sales impact), Wed cloudy 70°F..."
- Injected into `buildBriefPrompt` and `buildAskPrompt` as additional context section

### Frontend (app.jsx)

#### Pulse Store Grid — Weather Row

Above the daily sales columns in the Pulse grid, add a weather row showing:
- Condition icon (☀️ ⛅ 🌧️ ❄️ ⛈️ 🌫️) per day
- High temp in small text below icon
- For future days: subtle background tint (blue for rain/snow, normal for clear)

#### Pulse District Detail — Forecast Strip

In `DistrictDetail`, add a 7-day forecast strip below the sales-by-day chart:
- Each day: icon + temp + weather-adjusted target vs actual (for past days) or projected (future)
- Color-code: green if actual > adjusted target, red if below

#### Weather Impact Badge

On the Pulse store grid, if today's weather has a significant negative impact (coefficient < 0.90):
- Show a small weather badge on the district header: "🌧️ -12% expected"
- Tooltip: "Rain historically reduces District 3 sales by 12%"

### Scheduling

| Function | Schedule | Purpose |
|----------|----------|---------|
| `weather-forecast-cron` | `0 12 * * *` (8 AM ET) | Daily forecast refresh + weekly correlation rebuild (Mon) |

---

## Feature 2: Guest Sentiment Fusion

### Goal

Fetch Google reviews per store weekly, run Claude Haiku sentiment analysis to extract themes and scores, display sentiment badges and review feeds in Pulse, and inject sentiment context into Orion briefs.

### Data Flow

```
Google Places API → reviews-cron.js → Claude Haiku sentiment → pcg_reviews_{pc} blob
                                                              → pcg_reviews_network blob
Frontend reads review blobs → sentiment badge on store cards + review feed in drill-down
Orion prompts receive sentiment context → briefs mention trends
```

### Prerequisites

- Google Cloud project with Places API (New) enabled
- API key stored as `GOOGLE_PLACES_API_KEY` env var in Netlify
- Google Place IDs for each store (looked up once via Text Search, stored in store config)

### Store Config Update

Add `placeId` to the `ALL_STORES` array in `analyst-data.js`:

```javascript
{ pc:"339616", paycor:"193919", name:"Wadsworth", district:1, placeId:"ChIJ..." }
```

Place IDs will be resolved during implementation via Places Text Search API: `https://places.googleapis.com/v1/places:searchText` with query "Dunkin' {storeName} Philadelphia PA".

### Backend

#### `netlify/functions/reviews-cron.js`

Scheduled weekly (Sunday night). For each store with a `placeId`:

1. Call Places API (New) Place Details: `GET https://places.googleapis.com/v1/places/{placeId}?fields=reviews,rating,userRatingCount&key={API_KEY}`
2. Extract reviews (up to 5 per request): `{ authorName, rating, text, relativePublishTimeDescription, publishTime }`
3. Deduplicate against stored reviews (match by `publishTime` + `authorName`)
4. For new reviews, batch-send to Claude Haiku for sentiment analysis

#### Sentiment Analysis (Claude Haiku)

System prompt for review analysis:
```
You are a restaurant review analyst. For each review, extract:
- sentiment: positive | neutral | negative
- themes: array of 1-3 from [speed, accuracy, cleanliness, friendliness, food-quality, value, drive-thru, mobile-order, atmosphere]
- actionItem: null or one-sentence action if negative (e.g., "Address morning drive-thru wait times")
Return JSON array matching input order.
```

Process reviews in batches of 10-15 per Haiku call to minimize API costs.

#### Blob Storage

**Per-store reviews** (`pcg_reviews_{pc}`):
```json
{
  "savedAt": "2026-05-25T04:00:00Z",
  "data": {
    "placeId": "ChIJ...",
    "googleRating": 4.2,
    "totalReviews": 187,
    "reviews": [
      {
        "id": "hash_of_publishTime_authorName",
        "authorName": "Jane D.",
        "rating": 3,
        "text": "Long wait in drive thru...",
        "publishTime": "2026-05-20T14:30:00Z",
        "sentiment": "negative",
        "themes": ["speed", "drive-thru"],
        "actionItem": "Address drive-thru wait times during morning rush"
      }
    ],
    "themeSummary": {
      "speed": { "mentions": 12, "avgSentiment": 2.8 },
      "friendliness": { "mentions": 8, "avgSentiment": 4.5 }
    },
    "trendDirection": "declining",
    "lastFetched": "2026-05-25T04:00:00Z"
  }
}
```

**Network summary** (`pcg_reviews_network`):
```json
{
  "savedAt": "2026-05-25T04:00:00Z",
  "data": {
    "networkAvgRating": 4.1,
    "storeRatings": { "339616": 4.2, "351099": 3.8 },
    "topStores": ["339616", "345986"],
    "bottomStores": ["351099", "330338"],
    "recentNegativeCount": 7,
    "topThemes": { "speed": 34, "friendliness": 28, "accuracy": 15 },
    "actionItems": [
      { "store": "Sonic", "pc": "351099", "theme": "speed", "action": "Address morning drive-thru wait times", "reviewCount": 3 }
    ]
  }
}
```

Keep last 50 reviews per store (rolling window). Older reviews archived but theme counts preserved.

#### Orion Integration

New function in `analyst-data.js`: `buildSentimentContext({ district })`:
- Loads network summary + relevant store review blobs
- Returns string: "Guest sentiment — District 2 avg ★3.8 (↓0.2 vs last month). Sonic flagged: 3 negative reviews on speed. Network top theme: friendliness (positive)."
- Injected into `buildBriefPrompt` as additional context

### Frontend (app.jsx)

#### Pulse Store Grid — Sentiment Badge

On each store card in the Pulse grid:
- Show Google rating: ★ 4.2 (small, right-aligned)
- Color: green (≥4.0), yellow (3.5–3.9), red (<3.5)
- Trend arrow: ↑ ↓ → based on `trendDirection`

#### Store Drill-Down — Reviews Tab

In `StoreDetail`, add a "Reviews" sub-section:
- Google rating + total count header
- Theme tag bar (speed, friendliness, etc.) with color-coded sentiment
- Recent reviews list (5-10) with rating stars, text excerpt, sentiment badge, theme tags
- Action items highlighted in orange banner if any exist

#### District Detail — Sentiment Summary

In `DistrictDetail`, add a sentiment row:
- Average rating for district, best/worst store
- Top negative theme across district stores

### Scheduling

| Function | Schedule | Purpose |
|----------|----------|---------|
| `reviews-cron` | `0 5 * * 0` (1 AM ET Sunday) | Weekly review fetch + sentiment analysis |

### Cost Estimate

- Places API: ~$17/month (45 stores × 4 weeks × $0.01/request for Place Details)
- Claude Haiku: ~$0.50/month (45 stores × 5 reviews × 4 weeks, minimal tokens)
- Total: ~$18/month

---

## Feature 3: Email Integration

### Goal

Replace Resend with Google Workspace SMTP relay for branded outbound email from the company domain. Add a shared inbox viewer so portal users can see recent ops-related emails. Simple compose capability from within the portal.

### Data Flow

```
Outbound: Portal/Orion → notify.js (nodemailer + SMTP relay) → recipient inbox
Inbound:  Shared mailbox → email-sync-cron.js (Gmail API) → pcg_emails_inbox blob → Portal UI
Compose:  Portal compose form → email-send function → SMTP relay → recipient
```

### Prerequisites

- Google Workspace admin access to configure SMTP relay
- Service account with domain-wide delegation (for Gmail API read access to shared mailbox)
- Env vars: `GOOGLE_SMTP_HOST`, `GOOGLE_SMTP_USER`, `GOOGLE_SMTP_PASSWORD` (or app password), `GOOGLE_SERVICE_ACCOUNT_KEY` (JSON), `GOOGLE_SHARED_MAILBOX` (e.g., `ops@pcgdunkin.com`)
- npm: `nodemailer`, `googleapis` (or `google-auth-library`)

### Backend

#### Outbound: SMTP Relay

Replace Resend HTTP calls in `analyst-reports.js` and `notify.js` with `nodemailer`:

```javascript
const transporter = nodemailer.createTransport({
  host: process.env.GOOGLE_SMTP_HOST || 'smtp-relay.gmail.com',
  port: 587,
  secure: false,
  auth: { user: process.env.GOOGLE_SMTP_USER, pass: process.env.GOOGLE_SMTP_PASSWORD }
});
```

- From address changes from `noreply@pcgops.com` to company domain (e.g., `orion@pcgdunkin.com`)
- `wrapEmail()` template stays the same
- Fallback: if SMTP fails, fall back to Resend (keep as backup)

#### Inbound: `netlify/functions/email-sync-cron.js`

Scheduled hourly. Uses Gmail API via service account with domain-wide delegation to read the shared mailbox:

1. Authenticate with service account credentials
2. List messages from last 24 hours: `gmail.users.messages.list({ userId: sharedMailbox, q: 'newer_than:1d' })`
3. Fetch message details (subject, from, date, snippet, body text)
4. Store in blob `pcg_emails_inbox` (rolling 7-day window, max 200 emails)
5. Tag emails by category using simple keyword matching: vendor, corporate, complaint, general

Blob structure:
```json
{
  "savedAt": "2026-05-25T12:00:00Z",
  "data": {
    "emails": [
      {
        "id": "msg_abc123",
        "threadId": "thread_xyz",
        "from": "vendor@supplier.com",
        "fromName": "Acme Supplies",
        "to": "ops@pcgdunkin.com",
        "subject": "Invoice #4521 — May delivery",
        "snippet": "Please find attached the invoice for...",
        "date": "2026-05-25T09:30:00Z",
        "category": "vendor",
        "isRead": false,
        "hasAttachment": true
      }
    ],
    "lastSyncAt": "2026-05-25T12:00:00Z"
  }
}
```

#### Compose: `netlify/functions/email-send.js`

HTTP POST endpoint for sending emails from the portal:

- Accepts: `{ to, cc, subject, body, fromName }`
- Auth: requires valid portal session (check userId from request)
- Sends via SMTP relay with from = `{fromName} <ops@pcgdunkin.com>`
- Logs send in blob `pcg_emails_sent` for audit trail
- Rate limit: max 50 sends/day per user

#### Orion Integration

New function in `analyst-data.js`: `buildEmailContext()`:
- Loads recent inbox blob
- Flags notable emails (unread, vendor invoices, complaints)
- Returns string: "3 unread emails in ops inbox — 1 vendor invoice from Acme ($2,340), 1 complaint forward, 1 corporate memo"
- Injected into exec daily brief only (not DM briefs)

### Frontend (app.jsx)

#### Email Tab or Sub-Section

New "Email" option, accessible to exec/IT/office_staff:

- **Inbox view:** list of recent emails (subject, from, date, category badge, read/unread)
- **Email detail:** click to expand full body (rendered HTML or plain text)
- **Category filter:** all / vendor / corporate / complaint / general
- **Compose button:** opens compose modal with to, cc, subject, body fields
- **Unread badge:** on the Email tab label, showing count of unread emails

#### Compose Modal

Simple form:
- To (email input with autocomplete from portal's existing Contacts list)
- CC (optional)
- Subject
- Body (plain text textarea, or basic rich text)
- Send button → calls `email-send` function

### Scheduling

| Function | Schedule | Purpose |
|----------|----------|---------|
| `email-sync-cron` | `0 * * * *` (hourly) | Poll shared mailbox for new emails |

### Security Considerations

- Service account key stored as env var (JSON string), never exposed to frontend
- Email bodies may contain sensitive info — only show to exec/IT/office_staff roles
- Compose rate limiting prevents abuse
- No attachment download through portal (link to view in Gmail instead)
- SMTP credentials use app password or OAuth2, never the primary account password

---

## Shared Concerns

### Environment Variables (New)

| Variable | Feature | Purpose |
|----------|---------|---------|
| `GOOGLE_PLACES_API_KEY` | Reviews | Google Places API access |
| `GOOGLE_SMTP_HOST` | Email | SMTP relay host (default: smtp-relay.gmail.com) |
| `GOOGLE_SMTP_USER` | Email | SMTP relay auth user |
| `GOOGLE_SMTP_PASSWORD` | Email | SMTP relay auth password/app password |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Email | Service account JSON for Gmail API |
| `GOOGLE_SHARED_MAILBOX` | Email | Shared mailbox address to poll |

### Build Order

1. **Weather-Aware Forecasting** — zero external prerequisites, builds on existing infrastructure
2. **Guest Sentiment Fusion** — needs Google Cloud API key (quick setup)
3. **Email Integration** — needs Google Workspace admin configuration (most setup overhead)

### netlify.toml Additions

```toml
[functions.weather-forecast-cron]
schedule = "0 12 * * *"

[functions.reviews-cron]
schedule = "0 5 * * 0"

[functions.email-sync-cron]
schedule = "0 * * * *"
```

### Dependencies (package.json)

```json
{
  "nodemailer": "^6.9.0",
  "googleapis": "^130.0.0"
}
```

`nodemailer` for SMTP relay outbound. `googleapis` for Gmail API inbox polling. Both are well-maintained, no security concerns.
