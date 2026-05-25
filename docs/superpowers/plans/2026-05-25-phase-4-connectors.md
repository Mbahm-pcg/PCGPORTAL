# Phase 4: Connectors + Advanced Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add weather-aware forecasting, Google Reviews sentiment analysis, and email integration to the PCG Orion Analyst platform.

**Architecture:** Three independent features, each following the pattern: scheduled Netlify Function → external API → Netlify Blob → frontend display + Orion prompt injection. Build order: Weather → Reviews → Email (increasing external dependency complexity).

**Tech Stack:** Open-Meteo Forecast API (free), Google Places API (New), nodemailer, googleapis, Claude Haiku (sentiment), Netlify Blobs, existing analyst-lib infrastructure (analyst-cache, analyst-data, analyst-prompts, analyst-claude).

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `netlify/functions/weather-forecast-cron.js` | Daily: fetch 7-day forecast per district, compute weather↔sales correlations, store adjusted targets |
| `netlify/functions/reviews-cron.js` | Weekly: fetch Google Places reviews per store, run Claude Haiku sentiment, store per-store + network summaries |
| `netlify/functions/reviews-cron-background.js` | Background wrapper for reviews-cron (15-min timeout) |
| `netlify/functions/email-send.js` | HTTP POST endpoint: compose + send email via SMTP relay |
| `netlify/functions/email-sync-cron.js` | Hourly: poll shared Gmail inbox via Gmail API, store in blob |

### Modified Files
| File | Changes |
|------|---------|
| `netlify/functions/analyst-lib/analyst-data.js` | Add `buildWeatherContext()`, `buildSentimentContext()`, `buildEmailContext()`, `getWeatherForecast()`, `getWeatherCorrelations()`, `getStoreReviews()`, `getNetworkReviews()` |
| `netlify/functions/analyst-lib/analyst-prompts.js` | Add `REVIEW_ANALYSIS_SYSTEM` prompt, update `buildBriefPrompt` and `buildAskPrompt` to accept weather/sentiment context |
| `netlify/functions/analyst-lib/analyst-reports.js` | Add `sendEmailSMTP()` wrapper with Resend fallback, update `sendEmail()` to try SMTP first |
| `netlify/functions/analyst-cron.js` | Inject weather + sentiment context into brief generation |
| `netlify.toml` | Add schedules for weather-forecast-cron, reviews-cron, email-sync-cron |
| `package.json` | Add `nodemailer` dependency |
| `app.jsx` | Weather row in Pulse grid, forecast strip in DistrictDetail, sentiment badges on store cards, reviews section in StoreDetail, Email tab with inbox viewer + compose modal |

---

## Feature 1: Weather-Aware Forecasting (Tasks 1–4)

### Task 1: Weather Forecast Cron Function

**Files:**
- Create: `netlify/functions/weather-forecast-cron.js`
- Modify: `netlify.toml`

- [ ] **Step 1: Create the weather forecast cron function**

Create `netlify/functions/weather-forecast-cron.js`:

```javascript
// weather-forecast-cron.js — Daily: 7-day forecast per district + weekly correlation rebuild
const https = require('https');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');

const DISTRICT_COORDS = {
  1: { lat: 40.205, lon: -75.092 },
  2: { lat: 40.200, lon: -75.070 },
  3: { lat: 39.925, lon: -75.275 },
  4: { lat: 40.000, lon: -75.150 },
  5: { lat: 40.240, lon: -75.340 },
  6: { lat: 40.010, lon: -75.530 },
  7: { lat: 40.070, lon: -75.020 },
  8: { lat: 40.310, lon: -75.230 },
};

const STORES = [
  { pc:"339616", district:1 },{ pc:"340794", district:1 },
  { pc:"351099", district:2 },{ pc:"351259", district:2 },{ pc:"302642", district:2 },
  { pc:"352894", district:2 },{ pc:"341350", district:2 },{ pc:"337839", district:2 },
  { pc:"330338", district:3 },{ pc:"337063", district:3 },{ pc:"343832", district:3 },
  { pc:"304669", district:3 },{ pc:"355146", district:3 },{ pc:"300496", district:3 },
  { pc:"304863", district:3 },{ pc:"354561", district:3 },{ pc:"332393", district:3 },
  { pc:"341167", district:4 },{ pc:"340870", district:4 },{ pc:"335981", district:4 },
  { pc:"353150", district:4 },{ pc:"351050", district:4 },{ pc:"345985", district:4 },
  { pc:"356374", district:5 },{ pc:"353843", district:5 },{ pc:"353047", district:5 },
  { pc:"340538", district:5 },
  { pc:"343079", district:6 },{ pc:"342144", district:6 },{ pc:"364295", district:6 },
  { pc:"365361", district:7 },{ pc:"310382", district:7 },{ pc:"332941", district:7 },
  { pc:"343497", district:7 },{ pc:"302446", district:7 },{ pc:"337079", district:7 },
  { pc:"345986", district:7 },{ pc:"364412", district:7 },{ pc:"345489", district:7 },
  { pc:"336372", district:7 },
  { pc:"358933", district:8 },{ pc:"354865", district:8 },{ pc:"353689", district:8 },
  { pc:"342184", district:8 },{ pc:"356316", district:8 },
];

function wmoToCondition(code) {
  if (code === 0)  return 'clear';
  if (code <= 3)   return 'cloudy';
  if (code <= 48)  return 'fog';
  if (code <= 67)  return 'rain';
  if (code <= 77)  return 'snow';
  if (code <= 82)  return 'rain';
  if (code <= 86)  return 'snow';
  return 'storm';
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchForecasts() {
  const forecasts = {};
  await Promise.all(
    Object.entries(DISTRICT_COORDS).map(async ([district, { lat, lon }]) => {
      const url = `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lat}&longitude=${lon}` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode` +
        `&temperature_unit=fahrenheit` +
        `&timezone=America%2FNew_York&forecast_days=7`;
      try {
        const json = await getJSON(url);
        const d = json.daily || {};
        const days = (d.time || []).map((date, i) => ({
          date,
          condition: wmoToCondition((d.weathercode || [])[i] ?? 0),
          wmoCode: (d.weathercode || [])[i] ?? 0,
          tempHighF: Math.round((d.temperature_2m_max || [])[i] ?? 0),
          tempLowF: Math.round((d.temperature_2m_min || [])[i] ?? 0),
          precipMm: Math.round(((d.precipitation_sum || [])[i] ?? 0) * 10) / 10,
        }));
        forecasts[district] = { days };
      } catch (e) {
        console.warn(`[weather-forecast] Forecast failed for D${district}: ${e.message}`);
        forecasts[district] = { days: [], error: e.message };
      }
    })
  );
  return forecasts;
}

async function buildCorrelations() {
  const conditionSales = {};
  for (let d = 1; d <= 8; d++) conditionSales[d] = {};

  const districtStores = {};
  for (const s of STORES) {
    if (!districtStores[s.district]) districtStores[s.district] = [];
    districtStores[s.district].push(s.pc);
  }

  for (const [district, pcs] of Object.entries(districtStores)) {
    const allDays = [];
    for (const pc of pcs) {
      const history = await cacheLoad(`pcg_hourly_history_${pc}`);
      if (!Array.isArray(history)) continue;
      for (const entry of history) {
        if (!entry.weather?.condition || !entry.hours) continue;
        const daySales = entry.hours.reduce((sum, h) => sum + (h.sales || 0), 0);
        if (daySales <= 0) continue;
        allDays.push({ condition: entry.weather.condition, sales: daySales });
      }
    }

    if (allDays.length === 0) continue;
    const overallAvg = allDays.reduce((s, d) => s + d.sales, 0) / allDays.length;
    if (overallAvg <= 0) continue;

    const byCondition = {};
    for (const day of allDays) {
      if (!byCondition[day.condition]) byCondition[day.condition] = [];
      byCondition[day.condition].push(day.sales);
    }

    for (const [cond, salesArr] of Object.entries(byCondition)) {
      const avg = salesArr.reduce((s, v) => s + v, 0) / salesArr.length;
      conditionSales[district][cond] = Math.round((avg / overallAvg) * 100) / 100;
    }
    conditionSales[district].sampleSize = allDays.length;
  }

  return conditionSales;
}

function getDayOfWeekBaseline(history, dayOfWeek) {
  const matching = history.filter(entry => {
    if (!entry.hours) return false;
    const d = new Date(entry.date + 'T12:00:00');
    return d.getDay() === dayOfWeek;
  });
  if (matching.length === 0) return 0;
  const sales = matching.map(e => e.hours.reduce((s, h) => s + (h.sales || 0), 0));
  return sales.reduce((s, v) => s + v, 0) / sales.length;
}

async function computeAdjustedTargets(forecasts, correlations) {
  const districtStores = {};
  for (const s of STORES) {
    if (!districtStores[s.district]) districtStores[s.district] = [];
    districtStores[s.district].push(s.pc);
  }

  for (const [district, forecast] of Object.entries(forecasts)) {
    if (!forecast.days || forecast.days.length === 0) continue;
    const corr = correlations[district] || {};

    const allHistory = [];
    for (const pc of (districtStores[district] || [])) {
      const history = await cacheLoad(`pcg_hourly_history_${pc}`);
      if (Array.isArray(history)) allHistory.push(...history);
    }

    for (const day of forecast.days) {
      const dow = new Date(day.date + 'T12:00:00').getDay();
      const baseline = getDayOfWeekBaseline(allHistory, dow);
      const impact = corr[day.condition] || 1.0;
      day.adjustedTarget = Math.round(baseline * impact);
      day.impactPct = Math.round((impact - 1) * 100);
    }
  }
}

exports.handler = async (event) => {
  const isManual = event?.httpMethod === 'POST';
  console.log('[weather-forecast] Starting', isManual ? '(manual)' : '(scheduled)');

  const forecasts = await fetchForecasts();
  console.log('[weather-forecast] Fetched forecasts for', Object.keys(forecasts).length, 'districts');

  const now = new Date();
  const isMonday = now.getUTCDay() === 1;
  let correlations = await cacheLoad('pcg_weather_correlations');

  if (!correlations || isMonday || isManual) {
    console.log('[weather-forecast] Building correlations...');
    correlations = await buildCorrelations();
    await cacheSave('pcg_weather_correlations', correlations);
    console.log('[weather-forecast] Correlations saved');
  }

  await computeAdjustedTargets(forecasts, correlations);
  await cacheSave('pcg_weather_forecast', forecasts);

  console.log('[weather-forecast] Complete');
  return isManual
    ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, districts: Object.keys(forecasts).length }) }
    : undefined;
};
```

- [ ] **Step 2: Add schedule to netlify.toml**

Add the following after the existing `pnl-cron` schedule block in `netlify.toml`:

```toml
# Weather forecast — daily at 8 AM ET (12:00 UTC), after labor-cron morning run
[functions.weather-forecast-cron]
  schedule = "0 12 * * *"
```

- [ ] **Step 3: Test locally**

Run: `cd "netlify/functions" && node -e "const w = require('./weather-forecast-cron'); w.handler({ httpMethod: 'POST' }).then(r => console.log(r)).catch(e => console.error(e))"`

This will fail because `cacheLoad`/`cacheSave` need Netlify env vars. Instead, deploy and test via HTTP:

Run: `npx netlify deploy --prod` from project root.

Then trigger manually: `curl -X POST https://pcg-ops.netlify.app/.netlify/functions/weather-forecast-cron`

Expected: `{"ok":true,"districts":8}`

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/weather-forecast-cron.js netlify.toml
git commit -m "feat: weather forecast cron — 7-day forecast + correlations per district"
```

---

### Task 2: Weather Data Accessors + Orion Prompt Integration

**Files:**
- Modify: `netlify/functions/analyst-lib/analyst-data.js`
- Modify: `netlify/functions/analyst-lib/analyst-prompts.js`
- Modify: `netlify/functions/analyst-cron.js`

- [ ] **Step 1: Add weather data accessors to analyst-data.js**

Add these functions before the `module.exports` line in `analyst-data.js`:

```javascript
async function getWeatherForecast() {
  return cacheLoad('pcg_weather_forecast');
}

async function getWeatherCorrelations() {
  return cacheLoad('pcg_weather_correlations');
}

async function buildWeatherContext({ district } = {}) {
  const forecast = await getWeatherForecast();
  const correlations = await getWeatherCorrelations();
  if (!forecast) return '';

  const condIcon = { clear: 'Clear', cloudy: 'Cloudy', fog: 'Foggy', rain: 'Rain', snow: 'Snow', storm: 'Thunderstorm' };
  const districts = district ? [String(district)] : Object.keys(forecast);
  const lines = [];

  for (const d of districts) {
    const f = forecast[d];
    if (!f?.days?.length) continue;
    const corr = correlations?.[d] || {};
    const dayStrs = f.days.slice(0, 7).map(day => {
      const dow = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
      const impact = corr[day.condition];
      const impactStr = impact && Math.abs(impact - 1) > 0.03
        ? ` (${impact > 1 ? '+' : ''}${Math.round((impact - 1) * 100)}% historical sales impact)`
        : '';
      return `${dow} ${condIcon[day.condition] || day.condition} ${day.tempHighF}°F${impactStr}`;
    });
    lines.push(`District ${d} forecast: ${dayStrs.join(', ')}`);
  }

  return lines.length > 0 ? '\n\nWEATHER FORECAST:\n' + lines.join('\n') : '';
}
```

Update the `module.exports` to include the new functions:

```javascript
module.exports = {
  STORES,
  getAllStores,
  getStoresByDistrict,
  getNetworkLabor,
  getStoreLabor,
  buildKPISnapshot,
  buildDataContext,
  buildStoreContext,
  getStoreDailyHistory,
  getWeatherForecast,
  getWeatherCorrelations,
  buildWeatherContext,
};
```

- [ ] **Step 2: Update buildBriefPrompt and buildAskPrompt to accept weather context**

In `analyst-prompts.js`, update `buildBriefPrompt`:

```javascript
function buildBriefPrompt(role, date, dataSnapshot, weatherContext) {
  return BRIEF_TEMPLATE
    .replace('{role}', role)
    .replace('{date}', date)
    .replace('{data}', JSON.stringify(dataSnapshot, null, 2) + (weatherContext || ''));
}
```

Update `buildAskPrompt`:

```javascript
function buildAskPrompt(question, role, scope, date, dataSnapshot, kbContext, ticketsContext, weatherContext) {
  const data = JSON.stringify(dataSnapshot, null, 2) + (kbContext || '') + (ticketsContext || '') + (weatherContext || '');
  return ASK_USER_TEMPLATE
    .replace('{question}', question)
    .replace('{role}', role)
    .replace('{scope}', scope)
    .replace('{date}', date)
    .replace('{data}', data);
}
```

- [ ] **Step 3: Inject weather context into analyst-cron brief generation**

In `analyst-cron.js`, add the import for `buildWeatherContext`:

Update the require line:
```javascript
const { buildDataContext, buildKPISnapshot, buildWeatherContext } = require('./analyst-lib/analyst-data');
```

Then in the exec brief generation (around line 89), add weather context:

```javascript
const execData = await buildDataContext({ includeStoreDetail: true });
const weatherCtx = await buildWeatherContext();
const execPrompt = buildBriefPrompt('VP / Executive', today, execData, weatherCtx);
```

And in the per-district brief generation (around line 119):

```javascript
const distData = await buildDataContext({ district: d });
if (distData.includes('No labor data')) continue;
const distWeatherCtx = await buildWeatherContext({ district: d });
const distPrompt = buildBriefPrompt('District Manager', today, distData, distWeatherCtx);
```

- [ ] **Step 4: Commit**

```bash
git add netlify/functions/analyst-lib/analyst-data.js netlify/functions/analyst-lib/analyst-prompts.js netlify/functions/analyst-cron.js
git commit -m "feat: weather context in Orion briefs — forecast + correlation data injected into prompts"
```

---

### Task 3: Weather UI — Pulse Grid Weather Row + District Forecast Strip

**Files:**
- Modify: `app.jsx`

- [ ] **Step 1: Add weather data loading to AdminPulse**

In `app.jsx`, inside the `AdminPulse` function (around line 7637), after the existing state declarations (around line 7654), add:

```javascript
const [weatherForecast, setWeatherForecast] = useState(null);
const [weatherCorrelations, setWeatherCorrelations] = useState(null);
```

Add a `useEffect` to load weather data on mount (after the existing `useEffect` blocks around line 7792):

```javascript
useEffect(() => {
  (async () => {
    try {
      const [fRes, cRes] = await Promise.all([
        fetch('/.netlify/functions/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', key: 'pcg_weather_forecast' }) }),
        fetch('/.netlify/functions/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', key: 'pcg_weather_correlations' }) }),
      ]);
      if (fRes.ok) { const j = await fRes.json(); setWeatherForecast(j.data || j); }
      if (cRes.ok) { const j = await cRes.json(); setWeatherCorrelations(j.data || j); }
    } catch {}
  })();
}, []);
```

- [ ] **Step 2: Add WeatherRow helper component**

Add this inside `AdminPulse` (before the `return` statement), as a helper:

```javascript
const WEATHER_ICONS = { clear: '☀️', cloudy: '⛅', fog: '🌫️', rain: '🌧️', snow: '❄️', storm: '⛈️' };

const WeatherRow = ({ district }) => {
  if (!weatherForecast || !weatherForecast[district]) return null;
  const days = weatherForecast[district].days || [];
  if (days.length === 0) return null;
  const corr = weatherCorrelations?.[district] || {};
  const todayDate = todayStr;

  return (
    <div style={{ display: 'flex', gap: '0.25rem', padding: '0.35rem 0.5rem', background: `${th.card2}`, borderRadius: '0.375rem', marginBottom: '0.5rem', overflowX: 'auto' }}>
      {days.slice(0, 7).map(day => {
        const isPast = day.date < todayDate;
        const isToday = day.date === todayDate;
        const impact = corr[day.condition];
        const hasNegImpact = impact && impact < 0.90;
        const dow = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        return (
          <div key={day.date} style={{
            flex: '1 1 0', minWidth: 50, textAlign: 'center', padding: '0.3rem 0.15rem',
            borderRadius: '0.25rem', opacity: isPast ? 0.5 : 1,
            background: isToday ? `${G}18` : hasNegImpact ? '#2196f308' : 'transparent',
            border: isToday ? `1px solid ${G}44` : '1px solid transparent',
          }}>
            <div style={{ fontSize: '0.58rem', color: th.muted, fontWeight: 600 }}>{dow}</div>
            <div style={{ fontSize: '1rem' }}>{WEATHER_ICONS[day.condition] || '🌡️'}</div>
            <div style={{ fontSize: '0.6rem', color: th.text, fontWeight: 600 }}>{day.tempHighF}°</div>
            {hasNegImpact && (
              <div style={{ fontSize: '0.52rem', color: '#f44336', fontWeight: 700 }}>
                {Math.round((impact - 1) * 100)}%
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
```

- [ ] **Step 3: Insert WeatherRow into the District Overview Cards**

In the District Overview Cards section (around line 8133), right before the `<div style={{ display:'grid', gridTemplateColumns:...` line, add a network-level weather summary. Then inside each district card, add a `WeatherRow`.

After the `📊 District Performance — {busDt}` header div (around line 8138), add:

```javascript
{weatherForecast && (
  <div style={{ marginBottom: '0.75rem' }}>
    <div style={{ fontSize: '0.7rem', color: th.muted, fontWeight: 600, marginBottom: '0.25rem' }}>7-Day Forecast (District 1 area)</div>
    <WeatherRow district="1" />
  </div>
)}
```

Inside each district card (after the forecast attainment bar, around line 8176), add:

```javascript
{weatherForecast?.[distNum] && (() => {
  const todayForecast = (weatherForecast[distNum]?.days || []).find(d => d.date === busDt);
  if (!todayForecast) return null;
  const impact = weatherCorrelations?.[distNum]?.[todayForecast.condition];
  const hasNegImpact = impact && impact < 0.90;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', marginTop: '0.3rem', fontSize: '0.68rem' }}>
      <span>{WEATHER_ICONS[todayForecast.condition] || '🌡️'}</span>
      <span style={{ color: th.muted }}>{todayForecast.tempHighF}°F</span>
      {hasNegImpact && (
        <span style={{ color: '#f44336', fontWeight: 700, fontSize: '0.62rem' }}>
          {Math.round((impact - 1) * 100)}% impact
        </span>
      )}
    </div>
  );
})()}
```

- [ ] **Step 4: Add forecast strip to DistrictDetail**

In the `DistrictDetail` function (around line 6592), add weather state:

```javascript
const [weatherForecast, setWeatherForecast] = React.useState(null);
const [weatherCorrelations, setWeatherCorrelations] = React.useState(null);

React.useEffect(() => {
  (async () => {
    try {
      const [fRes, cRes] = await Promise.all([
        fetch('/.netlify/functions/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', key: 'pcg_weather_forecast' }) }),
        fetch('/.netlify/functions/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', key: 'pcg_weather_correlations' }) }),
      ]);
      if (fRes.ok) { const j = await fRes.json(); setWeatherForecast(j.data || j); }
      if (cRes.ok) { const j = await cRes.json(); setWeatherCorrelations(j.data || j); }
    } catch {}
  })();
}, []);
```

Then in the DistrictDetail JSX, after the sales-by-day chart section, add a forecast strip:

```javascript
{weatherForecast?.[distNum] && (
  <div style={{ ...card(th), padding: '1rem', marginBottom: '1rem' }}>
    <div style={{ fontSize: '0.8rem', fontWeight: 700, color: th.text, marginBottom: '0.5rem' }}>
      7-Day Weather Forecast — District {distNum}
    </div>
    <div style={{ display: 'flex', gap: '0.5rem', overflowX: 'auto' }}>
      {(weatherForecast[distNum]?.days || []).map(day => {
        const ICONS = { clear: '☀️', cloudy: '⛅', fog: '🌫️', rain: '🌧️', snow: '❄️', storm: '⛈️' };
        const dow = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        const isToday = day.date === localDate;
        const impact = weatherCorrelations?.[distNum]?.[day.condition];
        return (
          <div key={day.date} style={{
            flex: '1 1 0', minWidth: 60, textAlign: 'center', padding: '0.5rem 0.25rem',
            borderRadius: '0.5rem', background: isToday ? `${G}18` : th.card2,
            border: isToday ? `1px solid ${G}55` : `1px solid ${th.cardBorder}`,
          }}>
            <div style={{ fontSize: '0.62rem', color: th.muted, fontWeight: 600 }}>{dow}</div>
            <div style={{ fontSize: '0.6rem', color: th.muted }}>{day.date.slice(5)}</div>
            <div style={{ fontSize: '1.2rem', margin: '0.2rem 0' }}>{ICONS[day.condition] || '🌡️'}</div>
            <div style={{ fontSize: '0.7rem', color: th.text, fontWeight: 700 }}>{day.tempHighF}°</div>
            <div style={{ fontSize: '0.55rem', color: th.muted }}>{day.tempLowF}°</div>
            {day.adjustedTarget > 0 && (
              <div style={{ fontSize: '0.55rem', color: impact && impact < 0.90 ? '#f44336' : G, fontWeight: 600, marginTop: '0.2rem' }}>
                ${Math.round(day.adjustedTarget / 1000)}K target
              </div>
            )}
          </div>
        );
      })}
    </div>
  </div>
)}
```

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add app.jsx app.js
git commit -m "feat: weather UI — forecast row in Pulse grid, 7-day strip in district detail"
```

---

### Task 4: Deploy + Test Weather Feature End-to-End

**Files:** None (deployment + testing)

- [ ] **Step 1: Deploy**

```bash
npx netlify deploy --prod
```

- [ ] **Step 2: Trigger weather cron manually**

```bash
curl -X POST https://pcg-ops.netlify.app/.netlify/functions/weather-forecast-cron
```

Expected: `{"ok":true,"districts":8}`

- [ ] **Step 3: Verify in browser**

Open https://pcg-ops.netlify.app, navigate to Pulse tab. Verify:
- Weather icons appear on district cards (today's weather + temp)
- Click into a district — 7-day forecast strip appears below the sales chart
- Districts with rain/snow show negative impact percentage

- [ ] **Step 4: Trigger analyst cron to verify weather in briefs**

```bash
curl -X POST https://pcg-ops.netlify.app/.netlify/functions/analyst-cron-background
```

Check the generated brief in the Reports tab — should mention weather forecast.

- [ ] **Step 5: Commit version bump**

Update the version string in `app.jsx` (search for `v9.3` and increment to `v9.4`).

```bash
npm run build
git add app.jsx app.js
git commit -m "v9.4 — Weather-aware forecasting: 7-day forecast, historical correlations, Pulse UI overlay"
```

---

## Feature 2: Guest Sentiment Fusion (Tasks 5–8)

### Task 5: Reviews Cron Function + Sentiment Analysis

**Files:**
- Create: `netlify/functions/reviews-cron.js`
- Create: `netlify/functions/reviews-cron-background.js`
- Modify: `netlify/functions/analyst-lib/analyst-prompts.js`
- Modify: `netlify.toml`

- [ ] **Step 1: Add REVIEW_ANALYSIS_SYSTEM prompt**

In `analyst-prompts.js`, add after the `PNL_SYSTEM` constant:

```javascript
const REVIEW_ANALYSIS_SYSTEM = `You are a restaurant review analyst for a Dunkin' franchise network. For each review provided, extract structured sentiment data.

For each review, return:
- sentiment: "positive" | "neutral" | "negative"
- themes: array of 1-3 from ["speed", "accuracy", "cleanliness", "friendliness", "food-quality", "value", "drive-thru", "mobile-order", "atmosphere"]
- actionItem: null if positive/neutral, or one-sentence action if negative (e.g., "Address morning drive-thru wait times")

Return a JSON array matching the input order. Example:
[{"sentiment":"negative","themes":["speed","drive-thru"],"actionItem":"Address drive-thru wait times during morning rush"},{"sentiment":"positive","themes":["friendliness"],"actionItem":null}]

Return ONLY the JSON array, no markdown fences, no explanation.`;
```

Update the `module.exports` to include:
```javascript
REVIEW_ANALYSIS_SYSTEM,
```

- [ ] **Step 2: Create reviews-cron.js**

Create `netlify/functions/reviews-cron.js`:

```javascript
// reviews-cron.js — Weekly: fetch Google Places reviews + Claude Haiku sentiment per store
const https = require('https');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
const { callClaude, HAIKU } = require('./analyst-lib/analyst-claude');
const { REVIEW_ANALYSIS_SYSTEM } = require('./analyst-lib/analyst-prompts');
const { logAudit } = require('./analyst-lib/analyst-audit');

const STORES = [
  { pc:"339616", name:"Wadsworth",       district:1 },
  { pc:"340794", name:"Front",           district:1 },
  { pc:"351099", name:"Sonic",           district:2 },
  { pc:"351259", name:"Rosemore",        district:2 },
  { pc:"302642", name:"County Line",     district:2 },
  { pc:"352894", name:"Street Rd",       district:2 },
  { pc:"341350", name:"Yardley",         district:2 },
  { pc:"337839", name:"Warrington",      district:2 },
  { pc:"330338", name:"Drexel Hill",     district:3 },
  { pc:"337063", name:"Sharon Hill",     district:3 },
  { pc:"343832", name:"Lansdowne",       district:3 },
  { pc:"304669", name:"Collingdale",     district:3 },
  { pc:"355146", name:"Gallery",         district:3 },
  { pc:"300496", name:"Cobbs Creek",     district:3 },
  { pc:"304863", name:"18th St",         district:3 },
  { pc:"354561", name:"Carlisle",        district:3 },
  { pc:"332393", name:"Lindbergh",       district:3 },
  { pc:"341167", name:"5th Street",      district:4 },
  { pc:"340870", name:"Hunting Park",    district:4 },
  { pc:"335981", name:"Lehigh",          district:4 },
  { pc:"353150", name:"Bakers Square",   district:4 },
  { pc:"351050", name:"Allegheny",       district:4 },
  { pc:"345985", name:"Wissahickon",     district:4 },
  { pc:"356374", name:"Montgomeryville", district:5 },
  { pc:"353843", name:"Tollgate",        district:5 },
  { pc:"353047", name:"Silverdale",      district:5 },
  { pc:"340538", name:"Easton",          district:5 },
  { pc:"343079", name:"Downingtown",     district:6 },
  { pc:"342144", name:"Westchester",     district:6 },
  { pc:"364295", name:"Lionville",       district:6 },
  { pc:"365361", name:"Little Welsh",    district:7 },
  { pc:"310382", name:"Grant",           district:7 },
  { pc:"332941", name:"Bustleton",       district:7 },
  { pc:"343497", name:"Red Lion",        district:7 },
  { pc:"302446", name:"Little Red Lion", district:7 },
  { pc:"337079", name:"Holme Circle",    district:7 },
  { pc:"345986", name:"Willits",         district:7 },
  { pc:"364412", name:"8200",            district:7 },
  { pc:"345489", name:"Oxford",          district:7 },
  { pc:"336372", name:"Elkins Park",     district:7 },
  { pc:"358933", name:"Brace Rd",        district:8 },
  { pc:"354865", name:"Quakertown",      district:8 },
  { pc:"353689", name:"Fort Washington", district:8 },
  { pc:"342184", name:"Lansdale",        district:8 },
  { pc:"356316", name:"BJ's",            district:8 },
];

function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search,
      method: 'GET', headers: { ...headers },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { reject(new Error(`Invalid JSON from ${urlObj.hostname}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function reviewId(review) {
  const author = (review.authorAttribution?.displayName || review.authorName || 'anon').slice(0, 20);
  const time = review.publishTime || review.relativePublishTimeDescription || '';
  return `${author}_${time}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

async function fetchStoreReviews(placeId) {
  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const url = `https://places.googleapis.com/v1/places/${placeId}?fields=reviews,rating,userRatingCount&key=${API_KEY}`;
  const { data } = await fetchJSON(url, {
    'X-Goog-Api-Key': API_KEY,
    'X-Goog-FieldMask': 'reviews,rating,userRatingCount',
  });

  return {
    rating: data.rating || 0,
    totalReviews: data.userRatingCount || 0,
    reviews: (data.reviews || []).map(r => ({
      id: reviewId(r),
      authorName: r.authorAttribution?.displayName || 'Anonymous',
      rating: r.rating || 0,
      text: r.text?.text || r.originalText?.text || '',
      publishTime: r.publishTime || '',
    })),
  };
}

async function analyzeSentiment(reviews) {
  if (reviews.length === 0) return [];

  const userPrompt = reviews.map((r, i) => `Review ${i + 1} (${r.rating}★): "${r.text}"`).join('\n\n');

  try {
    const result = await callClaude({
      system: REVIEW_ANALYSIS_SYSTEM,
      userPrompt,
      action: 'sentiment',
      userId: 'system',
      forceDeep: false,
      maxTokens: 1024,
    });

    const parsed = JSON.parse(result.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('[reviews-cron] Sentiment analysis failed:', e.message);
    return reviews.map(() => ({ sentiment: 'neutral', themes: [], actionItem: null }));
  }
}

function computeThemeSummary(reviews) {
  const themes = {};
  for (const r of reviews) {
    for (const t of (r.themes || [])) {
      if (!themes[t]) themes[t] = { mentions: 0, totalRating: 0 };
      themes[t].mentions++;
      themes[t].totalRating += r.rating || 3;
    }
  }
  const summary = {};
  for (const [t, data] of Object.entries(themes)) {
    summary[t] = { mentions: data.mentions, avgSentiment: Math.round((data.totalRating / data.mentions) * 10) / 10 };
  }
  return summary;
}

function computeTrend(reviews) {
  if (reviews.length < 3) return 'stable';
  const recent = reviews.slice(0, Math.ceil(reviews.length / 2));
  const older = reviews.slice(Math.ceil(reviews.length / 2));
  const recentAvg = recent.reduce((s, r) => s + (r.rating || 3), 0) / recent.length;
  const olderAvg = older.reduce((s, r) => s + (r.rating || 3), 0) / older.length;
  if (recentAvg - olderAvg > 0.3) return 'improving';
  if (olderAvg - recentAvg > 0.3) return 'declining';
  return 'stable';
}

exports.handler = async (event) => {
  const isManual = event?.httpMethod === 'POST';
  console.log('[reviews-cron] Starting', isManual ? '(manual)' : '(scheduled)');

  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) {
    console.warn('[reviews-cron] GOOGLE_PLACES_API_KEY not set, skipping');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'No API key' }) };
  }

  // Load place IDs from config blob (set up separately)
  const placeIds = await cacheLoad('pcg_store_place_ids') || {};
  const storesWithIds = STORES.filter(s => placeIds[s.pc]);

  if (storesWithIds.length === 0) {
    console.warn('[reviews-cron] No stores have Place IDs configured');
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'No Place IDs configured' }) };
  }

  let processed = 0, failed = 0;
  const networkRatings = {};
  const allActionItems = [];

  // Process in batches of 5 to respect rate limits
  for (let i = 0; i < storesWithIds.length; i += 5) {
    const batch = storesWithIds.slice(i, i + 5);
    await Promise.all(batch.map(async (store) => {
      try {
        const placeId = placeIds[store.pc];
        const { rating, totalReviews, reviews } = await fetchStoreReviews(placeId);

        // Load existing reviews and deduplicate
        const existing = await cacheLoad(`pcg_reviews_${store.pc}`) || { reviews: [] };
        const existingIds = new Set((existing.reviews || []).map(r => r.id));
        const newReviews = reviews.filter(r => !existingIds.has(r.id));

        // Analyze sentiment for new reviews
        let enriched = [];
        if (newReviews.length > 0) {
          const sentiments = await analyzeSentiment(newReviews);
          enriched = newReviews.map((r, idx) => ({
            ...r,
            sentiment: sentiments[idx]?.sentiment || 'neutral',
            themes: sentiments[idx]?.themes || [],
            actionItem: sentiments[idx]?.actionItem || null,
          }));
        }

        // Merge: new reviews first, then existing, cap at 50
        const allReviews = [...enriched, ...(existing.reviews || [])].slice(0, 50);

        const storeData = {
          placeId,
          googleRating: rating,
          totalReviews,
          reviews: allReviews,
          themeSummary: computeThemeSummary(allReviews),
          trendDirection: computeTrend(allReviews),
          lastFetched: new Date().toISOString(),
        };

        await cacheSave(`pcg_reviews_${store.pc}`, storeData);
        networkRatings[store.pc] = rating;

        // Collect action items
        for (const r of enriched) {
          if (r.actionItem) {
            allActionItems.push({ store: store.name, pc: store.pc, theme: (r.themes || [])[0] || 'general', action: r.actionItem, reviewCount: 1 });
          }
        }

        processed++;
        console.log(`[reviews-cron] ${store.name}: ★${rating} (${newReviews.length} new, ${allReviews.length} total)`);
      } catch (e) {
        failed++;
        console.warn(`[reviews-cron] Failed ${store.name}: ${e.message}`);
      }
    }));

    // Rate limit pause between batches
    if (i + 5 < storesWithIds.length) await new Promise(r => setTimeout(r, 500));
  }

  // Build network summary
  const ratings = Object.values(networkRatings).filter(r => r > 0);
  const networkAvgRating = ratings.length > 0 ? Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10 : 0;
  const sorted = Object.entries(networkRatings).sort((a, b) => b[1] - a[1]);
  const topStores = sorted.slice(0, 5).map(([pc]) => pc);
  const bottomStores = sorted.slice(-5).reverse().map(([pc]) => pc);

  // Aggregate themes across all stores
  const topThemes = {};
  for (const store of storesWithIds) {
    const data = await cacheLoad(`pcg_reviews_${store.pc}`);
    if (!data?.themeSummary) continue;
    for (const [theme, { mentions }] of Object.entries(data.themeSummary)) {
      topThemes[theme] = (topThemes[theme] || 0) + mentions;
    }
  }

  // Consolidate action items by store+theme
  const consolidatedActions = [];
  const actionMap = {};
  for (const item of allActionItems) {
    const key = `${item.pc}_${item.theme}`;
    if (!actionMap[key]) { actionMap[key] = { ...item }; consolidatedActions.push(actionMap[key]); }
    else actionMap[key].reviewCount++;
  }

  const networkSummary = {
    networkAvgRating,
    storeRatings: networkRatings,
    topStores,
    bottomStores,
    recentNegativeCount: allActionItems.length,
    topThemes,
    actionItems: consolidatedActions.slice(0, 10),
  };

  await cacheSave('pcg_reviews_network', networkSummary);

  await logAudit({ type: 'reviews_cron', processed, failed, networkAvgRating, newActionItems: allActionItems.length });
  console.log(`[reviews-cron] Complete: ${processed} processed, ${failed} failed, network ★${networkAvgRating}`);

  return isManual
    ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, processed, failed, networkAvgRating }) }
    : undefined;
};
```

- [ ] **Step 3: Create background wrapper**

Create `netlify/functions/reviews-cron-background.js`:

```javascript
const { handler: reviewsHandler } = require('./reviews-cron');

exports.handler = async (event) => {
  const fakeEvent = { ...event, httpMethod: 'POST' };
  try {
    await reviewsHandler(fakeEvent);
  } catch (err) {
    console.error('[reviews-cron-background] error:', err.message);
  }
};
```

- [ ] **Step 4: Add schedule to netlify.toml**

Add after the weather-forecast-cron schedule:

```toml
# Google Reviews + sentiment — Sunday 1 AM ET (05:00 UTC)
[functions.reviews-cron]
  schedule = "0 5 * * 0"
```

- [ ] **Step 5: Commit**

```bash
git add netlify/functions/reviews-cron.js netlify/functions/reviews-cron-background.js netlify/functions/analyst-lib/analyst-prompts.js netlify.toml
git commit -m "feat: reviews cron — Google Places reviews + Claude Haiku sentiment analysis"
```

---

### Task 6: Sentiment Data Accessors + Orion Integration

**Files:**
- Modify: `netlify/functions/analyst-lib/analyst-data.js`
- Modify: `netlify/functions/analyst-cron.js`

- [ ] **Step 1: Add sentiment data accessors to analyst-data.js**

Add before the `module.exports` line:

```javascript
async function getStoreReviews(pc) {
  return cacheLoad(`pcg_reviews_${pc}`);
}

async function getNetworkReviews() {
  return cacheLoad('pcg_reviews_network');
}

async function buildSentimentContext({ district } = {}) {
  const network = await getNetworkReviews();
  if (!network) return '';

  const lines = [];
  lines.push(`Network avg rating: ★${network.networkAvgRating}`);

  if (network.actionItems?.length > 0) {
    const filtered = district
      ? network.actionItems.filter(a => STORES.find(s => s.pc === a.pc)?.district === district)
      : network.actionItems.slice(0, 5);
    if (filtered.length > 0) {
      lines.push('Action items from recent reviews:');
      for (const item of filtered) {
        lines.push(`  - ${item.store}: ${item.action} (${item.reviewCount} review${item.reviewCount > 1 ? 's' : ''})`);
      }
    }
  }

  if (district && network.storeRatings) {
    const distStores = STORES.filter(s => s.district === district);
    const ratings = distStores.map(s => ({ name: s.name, rating: network.storeRatings[s.pc] })).filter(r => r.rating > 0);
    if (ratings.length > 0) {
      ratings.sort((a, b) => a.rating - b.rating);
      const worst = ratings[0];
      const best = ratings[ratings.length - 1];
      lines.push(`District ${district} ratings: best ${best.name} ★${best.rating}, lowest ${worst.name} ★${worst.rating}`);
    }
  }

  return lines.length > 1 ? '\n\nGUEST SENTIMENT:\n' + lines.join('\n') : '';
}
```

Update `module.exports` to include:
```javascript
getStoreReviews,
getNetworkReviews,
buildSentimentContext,
```

- [ ] **Step 2: Inject sentiment context into analyst-cron briefs**

In `analyst-cron.js`, update the import:

```javascript
const { buildDataContext, buildKPISnapshot, buildWeatherContext, buildSentimentContext } = require('./analyst-lib/analyst-data');
```

In the exec brief generation, after `weatherCtx`:

```javascript
const sentimentCtx = await buildSentimentContext();
const execPrompt = buildBriefPrompt('VP / Executive', today, execData, weatherCtx + sentimentCtx);
```

In the per-district brief generation:

```javascript
const distSentimentCtx = await buildSentimentContext({ district: d });
const distPrompt = buildBriefPrompt('District Manager', today, distData, distWeatherCtx + distSentimentCtx);
```

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/analyst-lib/analyst-data.js netlify/functions/analyst-cron.js
git commit -m "feat: sentiment context in Orion briefs — review data injected into prompts"
```

---

### Task 7: Sentiment UI — Pulse Badges + Store Reviews Section

**Files:**
- Modify: `app.jsx`

- [ ] **Step 1: Add reviews data loading to AdminPulse**

In `AdminPulse`, after the weather state declarations, add:

```javascript
const [networkReviews, setNetworkReviews] = useState(null);
```

In the weather `useEffect`, add a third fetch:

```javascript
const rRes = await fetch('/.netlify/functions/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', key: 'pcg_reviews_network' }) });
if (rRes.ok) { const j = await rRes.json(); setNetworkReviews(j.data || j); }
```

- [ ] **Step 2: Add sentiment badge to district cards**

In each district card (inside the District Overview Cards grid), after the weather badge you added in Task 3, add:

```javascript
{networkReviews?.storeRatings && (() => {
  const distPCs = allRows.filter(s => s.district === distNum).map(s => s.pc);
  const ratings = distPCs.map(pc => networkReviews.storeRatings[pc]).filter(r => r > 0);
  if (ratings.length === 0) return null;
  const avgRating = Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10;
  const color = avgRating >= 4.0 ? '#4caf50' : avgRating >= 3.5 ? '#ff9800' : '#f44336';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.68rem', marginTop: '0.15rem' }}>
      <span style={{ color }}>★ {avgRating}</span>
      <span style={{ color: th.muted, fontSize: '0.6rem' }}>({ratings.length} stores)</span>
    </div>
  );
})()}
```

- [ ] **Step 3: Add reviews section to StoreDetail**

In the `StoreDetail` function (line 5704), add state for reviews:

```javascript
const [storeReviews, setStoreReviews] = React.useState(null);

React.useEffect(() => {
  (async () => {
    try {
      const res = await fetch('/.netlify/functions/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', key: `pcg_reviews_${pc}` }) });
      if (res.ok) { const j = await res.json(); setStoreReviews(j.data || j); }
    } catch {}
  })();
}, [pc]);
```

Then at the end of the `StoreDetail` JSX (before the closing `</div>`), add a reviews section:

```javascript
{storeReviews && (
  <div style={{ ...card(th), padding: '1rem', marginTop: '1rem' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
      <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '0.9rem', color: th.text }}>
        Guest Reviews
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1.1rem', color: storeReviews.googleRating >= 4.0 ? '#4caf50' : storeReviews.googleRating >= 3.5 ? '#ff9800' : '#f44336' }}>
          ★ {storeReviews.googleRating}
        </span>
        <span style={{ fontSize: '0.72rem', color: th.muted }}>({storeReviews.totalReviews} reviews)</span>
        {storeReviews.trendDirection && storeReviews.trendDirection !== 'stable' && (
          <span style={{ fontSize: '0.7rem', fontWeight: 700, color: storeReviews.trendDirection === 'improving' ? '#4caf50' : '#f44336' }}>
            {storeReviews.trendDirection === 'improving' ? '↑' : '↓'}
          </span>
        )}
      </div>
    </div>

    {/* Theme tags */}
    {storeReviews.themeSummary && Object.keys(storeReviews.themeSummary).length > 0 && (
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        {Object.entries(storeReviews.themeSummary)
          .sort((a, b) => b[1].mentions - a[1].mentions)
          .slice(0, 6)
          .map(([theme, data]) => {
            const color = data.avgSentiment >= 4.0 ? '#4caf50' : data.avgSentiment >= 3.0 ? '#ff9800' : '#f44336';
            return (
              <span key={theme} style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
                padding: '0.2rem 0.5rem', borderRadius: '999px',
                background: `${color}15`, border: `1px solid ${color}33`,
                fontSize: '0.65rem', fontWeight: 600, color,
              }}>
                {theme} ({data.mentions})
              </span>
            );
          })}
      </div>
    )}

    {/* Action items */}
    {storeReviews.reviews?.some(r => r.actionItem) && (
      <div style={{ padding: '0.5rem 0.75rem', background: '#FF671F15', borderLeft: '3px solid #FF671F', borderRadius: '0 0.375rem 0.375rem 0', marginBottom: '0.75rem', fontSize: '0.75rem' }}>
        <div style={{ fontWeight: 700, color: '#FF671F', marginBottom: '0.25rem' }}>Action Items</div>
        {storeReviews.reviews.filter(r => r.actionItem).slice(0, 3).map((r, i) => (
          <div key={i} style={{ color: th.text, lineHeight: 1.5 }}>• {r.actionItem}</div>
        ))}
      </div>
    )}

    {/* Recent reviews */}
    {(storeReviews.reviews || []).slice(0, 8).map((review, idx) => (
      <div key={review.id || idx} style={{
        padding: '0.6rem 0', borderBottom: idx < 7 ? `1px solid ${th.cardBorder}` : 'none',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
          <div style={{ fontSize: '0.72rem', fontWeight: 600, color: th.text }}>{review.authorName}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <span style={{ color: review.rating >= 4 ? '#4caf50' : review.rating >= 3 ? '#ff9800' : '#f44336', fontWeight: 700, fontSize: '0.72rem' }}>
              {'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}
            </span>
            {review.sentiment && (
              <span style={{
                fontSize: '0.55rem', fontWeight: 700, padding: '0.1rem 0.3rem', borderRadius: 999,
                background: review.sentiment === 'positive' ? '#4caf5022' : review.sentiment === 'negative' ? '#f4433622' : '#ff980022',
                color: review.sentiment === 'positive' ? '#4caf50' : review.sentiment === 'negative' ? '#f44336' : '#ff9800',
              }}>
                {review.sentiment}
              </span>
            )}
          </div>
        </div>
        {review.text && (
          <div style={{ fontSize: '0.72rem', color: th.muted, lineHeight: 1.5, maxHeight: '3em', overflow: 'hidden' }}>
            {review.text.slice(0, 200)}{review.text.length > 200 ? '…' : ''}
          </div>
        )}
        {review.themes?.length > 0 && (
          <div style={{ display: 'flex', gap: '0.2rem', marginTop: '0.25rem' }}>
            {review.themes.map(t => (
              <span key={t} style={{ fontSize: '0.55rem', padding: '0.05rem 0.3rem', borderRadius: 999, background: th.card2, color: th.muted }}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 4: Add sentiment row to DistrictDetail**

In the `DistrictDetail` function, after the weather forecast strip (added in Task 3), add a sentiment summary:

```javascript
{networkReviews && (() => {
  const distStores = allStores.filter(s => s.district === distNum);
  const ratings = distStores.map(s => ({ name: s.name, rating: networkReviews.storeRatings?.[s.pc] })).filter(r => r.rating > 0);
  if (ratings.length === 0) return null;
  ratings.sort((a, b) => a.rating - b.rating);
  const avg = Math.round((ratings.reduce((s, r) => s + r.rating, 0) / ratings.length) * 10) / 10;
  const best = ratings[ratings.length - 1];
  const worst = ratings[0];
  const color = avg >= 4.0 ? '#4caf50' : avg >= 3.5 ? '#ff9800' : '#f44336';
  return (
    <div style={{ ...card(th), padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <span style={{ fontFamily: "'Raleway'", fontWeight: 800, fontSize: '1rem', color }}>★ {avg}</span>
        <span style={{ fontSize: '0.7rem', color: th.muted }}>District Avg ({ratings.length} stores)</span>
      </div>
      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.7rem' }}>
        <span style={{ color: '#4caf50' }}>Best: {best.name} ★{best.rating}</span>
        <span style={{ color: '#f44336' }}>Lowest: {worst.name} ★{worst.rating}</span>
      </div>
    </div>
  );
})()}
```

This requires loading `networkReviews` in DistrictDetail. Add state + fetch alongside the weather data:

```javascript
const [networkReviews, setNetworkReviews] = React.useState(null);
```

And in the weather useEffect, add:
```javascript
const rRes = await fetch('/.netlify/functions/storage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'load', key: 'pcg_reviews_network' }) });
if (rRes.ok) { const j = await rRes.json(); setNetworkReviews(j.data || j); }
```

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add app.jsx app.js
git commit -m "feat: sentiment UI — review badges on district cards, sentiment row in district detail, reviews section in store detail"
```

---

### Task 8: Deploy + Test Reviews Feature

**Files:** None (deployment + testing)

- [ ] **Step 1: Set up Place IDs**

Before the reviews cron can run, each store needs a Google Place ID. Create a one-time setup script or manually seed the blob. For now, seed a few test stores:

The user needs to set `GOOGLE_PLACES_API_KEY` in Netlify env vars first. Then seed place IDs via a manual blob write. The reviews-cron reads from blob key `pcg_store_place_ids`, which is a map of `{ "pc_code": "place_id" }`.

A helper function can look up Place IDs using Google Places Text Search:
`https://places.googleapis.com/v1/places:searchText` with body `{ "textQuery": "Dunkin' Wadsworth Ave Warminster PA" }`

This should be done manually or via a setup script during deployment.

- [ ] **Step 2: Deploy**

```bash
npx netlify deploy --prod
```

- [ ] **Step 3: Trigger reviews cron for test stores**

```bash
curl -X POST https://pcg-ops.netlify.app/.netlify/functions/reviews-cron-background
```

- [ ] **Step 4: Verify in browser**

Open Pulse tab, check district cards for sentiment badges (★ X.X). Click into a store — verify the reviews section shows at the bottom.

- [ ] **Step 5: Version bump and commit**

Update version to `v9.5` in `app.jsx`.

```bash
npm run build
git add app.jsx app.js
git commit -m "v9.5 — Guest sentiment fusion: Google Reviews + Claude sentiment analysis per store"
```

---

## Feature 3: Email Integration (Tasks 9–12)

### Task 9: SMTP Relay Outbound (Replace Resend)

**Files:**
- Modify: `package.json`
- Modify: `netlify/functions/analyst-lib/analyst-reports.js`

- [ ] **Step 1: Install nodemailer**

```bash
cd "/Users/mike/Library/Mobile Documents/com~apple~CloudDocs/ClaudePro/PCG/pcg-netlify 3" && npm install nodemailer
```

- [ ] **Step 2: Add SMTP sending with Resend fallback in analyst-reports.js**

In `analyst-reports.js`, add at the top after the `https` require:

```javascript
let nodemailer;
try { nodemailer = require('nodemailer'); } catch {}
```

Add a new `sendEmailSMTP` function after the existing `sendEmail`:

```javascript
function sendEmailSMTP({ to, cc, subject, html }) {
  if (!nodemailer || !process.env.GOOGLE_SMTP_USER) return null;

  const transporter = nodemailer.createTransport({
    host: process.env.GOOGLE_SMTP_HOST || 'smtp-relay.gmail.com',
    port: parseInt(process.env.GOOGLE_SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.GOOGLE_SMTP_USER,
      pass: process.env.GOOGLE_SMTP_PASSWORD,
    },
  });

  const FROM = process.env.SMTP_FROM || 'Orion — PCG Analyst <orion@peoplecapitalgroup.com>';
  const mailOptions = {
    from: FROM,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
  };
  if (cc && cc.length > 0) mailOptions.cc = Array.isArray(cc) ? cc.join(', ') : cc;

  return transporter.sendMail(mailOptions);
}
```

Then modify the existing `sendEmail` to try SMTP first, fall back to Resend:

```javascript
async function sendEmail({ to, cc, subject, html }) {
  // Try SMTP first (Google Workspace)
  try {
    const smtpResult = await sendEmailSMTP({ to, cc, subject, html });
    if (smtpResult) {
      console.log('[analyst-reports] email sent via SMTP:', smtpResult.messageId);
      return smtpResult;
    }
  } catch (e) {
    console.warn('[analyst-reports] SMTP failed, falling back to Resend:', e.message);
  }

  // Fallback to Resend
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn('No email provider available, skipping'); return; }
  const FROM = process.env.NOTIFY_FROM || 'Orion — PCG Analyst <noreply@pcgops.com>';

  const payload = { from: FROM, to: Array.isArray(to) ? to : [to], subject, html };
  if (cc && cc.length > 0) payload.cc = Array.isArray(cc) ? cc : [cc];

  const body = JSON.stringify(payload);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { console.log('[analyst-reports] email sent via Resend:', raw); resolve(raw); });
    });
    req.on('error', (e) => { console.error('[analyst-reports] Resend error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json netlify/functions/analyst-lib/analyst-reports.js
git commit -m "feat: SMTP relay outbound with Resend fallback for branded email"
```

---

### Task 10: Email Send Function (Compose from Portal)

**Files:**
- Create: `netlify/functions/email-send.js`

- [ ] **Step 1: Create email-send.js**

```javascript
// email-send.js — HTTP POST endpoint for sending emails from the portal
let nodemailer;
try { nodemailer = require('nodemailer'); } catch {}
const https = require('https');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');
const { logAudit } = require('./analyst-lib/analyst-audit');

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { to, cc, subject, bodyHtml, fromName, userId } = body;
  if (!to || !subject || !bodyHtml) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields: to, subject, bodyHtml' }) };
  }

  // Rate limiting: max 50 sends/day per user
  const today = new Date().toISOString().slice(0, 10);
  const rateKey = `pcg_email_rate_${userId || 'anon'}_${today}`;
  const rateData = await cacheLoad(rateKey) || { count: 0 };
  if (rateData.count >= 50) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Daily email limit reached (50/day)' }) };
  }

  const FROM_DOMAIN = process.env.SMTP_FROM_DOMAIN || 'peoplecapitalgroup.com';
  const FROM_ADDRESS = fromName ? `${fromName} <ops@${FROM_DOMAIN}>` : `PCG Portal <ops@${FROM_DOMAIN}>`;

  let sent = false;
  let method = '';

  // Try SMTP first
  if (nodemailer && process.env.GOOGLE_SMTP_USER) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.GOOGLE_SMTP_HOST || 'smtp-relay.gmail.com',
        port: parseInt(process.env.GOOGLE_SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.GOOGLE_SMTP_USER, pass: process.env.GOOGLE_SMTP_PASSWORD },
      });
      const mailOptions = { from: FROM_ADDRESS, to, subject, html: bodyHtml };
      if (cc) mailOptions.cc = cc;
      await transporter.sendMail(mailOptions);
      sent = true;
      method = 'smtp';
    } catch (e) {
      console.warn('[email-send] SMTP failed:', e.message);
    }
  }

  // Fallback to Resend
  if (!sent && process.env.RESEND_API_KEY) {
    try {
      const payload = { from: process.env.NOTIFY_FROM || `Orion — PCG <noreply@pcgops.com>`, to: Array.isArray(to) ? to : [to], subject, html: bodyHtml };
      if (cc) payload.cc = Array.isArray(cc) ? cc : [cc];
      const resBody = JSON.stringify(payload);
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.resend.com', port: 443, path: '/emails', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Length': Buffer.byteLength(resBody) },
        }, (res) => { let raw = ''; res.on('data', d => raw += d); res.on('end', () => resolve(raw)); });
        req.on('error', reject);
        req.write(resBody);
        req.end();
      });
      sent = true;
      method = 'resend';
    } catch (e) {
      console.warn('[email-send] Resend failed:', e.message);
    }
  }

  if (!sent) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'No email provider available' }) };
  }

  // Update rate limit
  rateData.count++;
  await cacheSave(rateKey, rateData);

  // Audit log
  await logAudit({ type: 'email_sent', to, subject, userId, method }).catch(() => {});

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, method }) };
};
```

- [ ] **Step 2: Commit**

```bash
git add netlify/functions/email-send.js
git commit -m "feat: email-send function — compose + send from portal with SMTP/Resend"
```

---

### Task 11: Email Sync Cron (Gmail API Inbox Polling)

**Files:**
- Create: `netlify/functions/email-sync-cron.js`
- Modify: `netlify.toml`

- [ ] **Step 1: Create email-sync-cron.js**

```javascript
// email-sync-cron.js — Hourly: poll shared Gmail inbox via service account
const { google } = require('googleapis');
const { cacheSave, cacheLoad } = require('./analyst-lib/analyst-cache');

const CATEGORY_KEYWORDS = {
  vendor: ['invoice', 'delivery', 'order', 'shipment', 'supply', 'dcp', 'sysco'],
  corporate: ['dunkin', 'inspire brands', 'corporate', 'compliance', 'audit'],
  complaint: ['complaint', 'issue', 'unhappy', 'refund', 'health department', 'inspection'],
};

function categorize(subject, from) {
  const text = `${subject} ${from}`.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => text.includes(k))) return cat;
  }
  return 'general';
}

function decodeBase64(str) {
  if (!str) return '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function extractBody(payload) {
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return decodeBase64(textPart.body.data);
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) return decodeBase64(htmlPart.body.data);
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }
  return '';
}

function getHeader(headers, name) {
  const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
  return h?.value || '';
}

exports.handler = async (event) => {
  const isManual = event?.httpMethod === 'POST';
  console.log('[email-sync] Starting', isManual ? '(manual)' : '(scheduled)');

  const SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const SHARED_MAILBOX = process.env.GOOGLE_SHARED_MAILBOX;

  if (!SERVICE_ACCOUNT_KEY || !SHARED_MAILBOX) {
    console.warn('[email-sync] Missing GOOGLE_SERVICE_ACCOUNT_KEY or GOOGLE_SHARED_MAILBOX');
    return isManual ? { statusCode: 200, body: JSON.stringify({ ok: false, error: 'Not configured' }) } : undefined;
  }

  let credentials;
  try { credentials = JSON.parse(SERVICE_ACCOUNT_KEY); } catch {
    console.error('[email-sync] Invalid GOOGLE_SERVICE_ACCOUNT_KEY JSON');
    return isManual ? { statusCode: 500, body: JSON.stringify({ error: 'Invalid credentials' }) } : undefined;
  }

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    subject: SHARED_MAILBOX,
  });

  const gmail = google.gmail({ version: 'v1', auth });

  try {
    const listRes = await gmail.users.messages.list({
      userId: SHARED_MAILBOX,
      q: 'newer_than:1d',
      maxResults: 50,
    });

    const messageIds = (listRes.data.messages || []).map(m => m.id);
    console.log(`[email-sync] Found ${messageIds.length} messages from last 24h`);

    const emails = [];
    for (const msgId of messageIds) {
      try {
        const msgRes = await gmail.users.messages.get({
          userId: SHARED_MAILBOX,
          id: msgId,
          format: 'full',
        });

        const msg = msgRes.data;
        const headers = msg.payload?.headers || [];
        const from = getHeader(headers, 'From');
        const fromName = from.replace(/<.*>/, '').trim() || from;
        const to = getHeader(headers, 'To');
        const subject = getHeader(headers, 'Subject');
        const date = getHeader(headers, 'Date');
        const hasAttachment = (msg.payload?.parts || []).some(p => p.filename && p.filename.length > 0);

        emails.push({
          id: msg.id,
          threadId: msg.threadId,
          from: from.match(/<(.+)>/)?.[1] || from,
          fromName,
          to,
          subject,
          snippet: msg.snippet || '',
          date: new Date(date).toISOString(),
          category: categorize(subject, from),
          isRead: !(msg.labelIds || []).includes('UNREAD'),
          hasAttachment,
          bodyPreview: extractBody(msg.payload).slice(0, 500),
        });
      } catch (e) {
        console.warn(`[email-sync] Failed to fetch message ${msgId}: ${e.message}`);
      }
    }

    // Merge with existing (rolling 7-day window)
    const existing = await cacheLoad('pcg_emails_inbox') || { emails: [] };
    const existingIds = new Set(emails.map(e => e.id));
    const older = (existing.emails || []).filter(e => {
      if (existingIds.has(e.id)) return false;
      const age = Date.now() - new Date(e.date).getTime();
      return age < 7 * 24 * 60 * 60 * 1000;
    });

    const allEmails = [...emails, ...older]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 200);

    await cacheSave('pcg_emails_inbox', { emails: allEmails, lastSyncAt: new Date().toISOString() });

    console.log(`[email-sync] Complete: ${emails.length} new, ${allEmails.length} total`);

    return isManual
      ? { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, new: emails.length, total: allEmails.length }) }
      : undefined;

  } catch (e) {
    console.error('[email-sync] Gmail API error:', e.message);
    return isManual
      ? { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) }
      : undefined;
  }
};
```

- [ ] **Step 2: Add schedule to netlify.toml**

```toml
# Email sync — hourly Gmail inbox poll
[functions.email-sync-cron]
  schedule = "0 * * * *"
```

- [ ] **Step 3: Commit**

```bash
git add netlify/functions/email-sync-cron.js netlify.toml
git commit -m "feat: email-sync cron — hourly Gmail API inbox polling via service account"
```

---

### Task 12: Email UI — Inbox Viewer + Compose Modal

**Files:**
- Modify: `app.jsx`

- [ ] **Step 1: Add Email tab to getTabs**

In `app.jsx`, find the `getTabs` function. Add an "Email" tab for admin users. Search for the admin tabs section (where `pulse`, `labor`, etc. are added) and add:

```javascript
{ id: 'email', label: 'Email', icon: '📧' },
```

Add it after the existing admin tabs, with the same visibility check (exec/IT/office_staff).

- [ ] **Step 2: Create EmailTab component**

Add a new `EmailTab` component in `app.jsx` (before the main `PCGPortal` function):

```javascript
function EmailTab({ th, user }) {
  const [emails, setEmails] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [selectedEmail, setSelectedEmail] = useState(null);
  const [composing, setComposing] = useState(false);
  const [composeData, setComposeData] = useState({ to: '', cc: '', subject: '', body: '' });
  const [sending, setSending] = useState(false);
  const [lastSync, setLastSync] = useState(null);

  const loadEmails = async () => {
    setLoading(true);
    try {
      const res = await fetch('/.netlify/functions/storage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'load', key: 'pcg_emails_inbox' }),
      });
      if (res.ok) {
        const j = await res.json();
        const data = j.data || j;
        setEmails(data.emails || []);
        setLastSync(data.lastSyncAt);
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadEmails(); }, []);

  const filtered = filter === 'all' ? emails : emails.filter(e => e.category === filter);
  const unreadCount = emails.filter(e => !e.isRead).length;

  const CATEGORY_COLORS = {
    vendor: '#2196f3', corporate: '#9c27b0', complaint: '#f44336', general: '#607d8b',
  };

  const sendEmail = async () => {
    if (!composeData.to || !composeData.subject || !composeData.body) return;
    setSending(true);
    try {
      const res = await fetch('/.netlify/functions/email-send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: composeData.to,
          cc: composeData.cc || undefined,
          subject: composeData.subject,
          bodyHtml: `<div style="font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px; line-height: 1.6;">${composeData.body.replace(/\n/g, '<br>')}</div>`,
          fromName: user?.name || 'PCG Portal',
          userId: user?.id,
        }),
      });
      if (res.ok) {
        setComposing(false);
        setComposeData({ to: '', cc: '', subject: '', body: '' });
      }
    } catch {}
    setSending(false);
  };

  const accentColor = '#2196f3';

  return (
    <div>
      {/* Header */}
      <div style={{ ...card(th), padding: '1.25rem 1.5rem', marginBottom: '1rem',
        background: 'linear-gradient(135deg, #0d1b2a 0%, #1b2838 100%)',
        border: `1px solid ${accentColor}33` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
          <div>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 900, fontSize: '1.4rem', color: accentColor }}>
              📧 EMAIL
            </div>
            <div style={{ fontSize: '0.7rem', color: `${accentColor}88`, fontWeight: 600, letterSpacing: 2 }}>
              SHARED INBOX{lastSync ? ` · SYNCED ${new Date(lastSync).toLocaleTimeString()}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={() => setComposing(true)} style={{ ...btn(th, { background: accentColor, color: '#fff', fontWeight: 700, padding: '0.4rem 1rem', fontSize: '0.78rem' }) }}>
              ✏️ Compose
            </button>
            <button onClick={loadEmails} disabled={loading} style={{ ...btn(th, { background: `${accentColor}22`, color: accentColor, border: `1px solid ${accentColor}55`, fontWeight: 700, padding: '0.4rem 1rem', fontSize: '0.78rem' }) }}>
              {loading ? '⏳' : '🔄'} Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Category filter */}
      <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {['all', 'vendor', 'corporate', 'complaint', 'general'].map(cat => (
          <button key={cat} onClick={() => setFilter(cat)} style={{
            ...btn(th, {
              background: filter === cat ? `${CATEGORY_COLORS[cat] || accentColor}22` : th.card2,
              color: filter === cat ? (CATEGORY_COLORS[cat] || accentColor) : th.muted,
              border: filter === cat ? `1px solid ${CATEGORY_COLORS[cat] || accentColor}55` : `1px solid ${th.cardBorder}`,
              fontWeight: 600, padding: '0.3rem 0.75rem', fontSize: '0.72rem', textTransform: 'capitalize',
            }),
          }}>
            {cat}{cat === 'all' && unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
        ))}
      </div>

      {/* Email list */}
      <div style={{ ...card(th), padding: 0, overflow: 'hidden' }}>
        {filtered.length === 0 && !loading && (
          <div style={{ padding: '2rem', textAlign: 'center', color: th.muted }}>
            {emails.length === 0 ? 'No emails synced yet. Configure Gmail API to start.' : 'No emails match this filter.'}
          </div>
        )}
        {filtered.map((email, idx) => (
          <div key={email.id} onClick={() => setSelectedEmail(selectedEmail?.id === email.id ? null : email)}
            style={{
              padding: '0.75rem 1rem', cursor: 'pointer',
              borderBottom: idx < filtered.length - 1 ? `1px solid ${th.cardBorder}` : 'none',
              background: selectedEmail?.id === email.id ? `${accentColor}08` : !email.isRead ? `${accentColor}05` : 'transparent',
              transition: 'background .15s',
            }}
            onMouseEnter={e => { if (selectedEmail?.id !== email.id) e.currentTarget.style.background = th.card2; }}
            onMouseLeave={e => { if (selectedEmail?.id !== email.id) e.currentTarget.style.background = !email.isRead ? `${accentColor}05` : 'transparent'; }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', marginBottom: '0.15rem' }}>
                  {!email.isRead && <div style={{ width: 6, height: 6, borderRadius: '50%', background: accentColor, flexShrink: 0 }} />}
                  <span style={{ fontSize: '0.78rem', fontWeight: email.isRead ? 400 : 700, color: th.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {email.fromName}
                  </span>
                  <span style={{
                    fontSize: '0.55rem', fontWeight: 600, padding: '0.05rem 0.35rem', borderRadius: 999,
                    background: `${CATEGORY_COLORS[email.category] || '#607d8b'}18`,
                    color: CATEGORY_COLORS[email.category] || '#607d8b',
                    textTransform: 'capitalize', flexShrink: 0,
                  }}>
                    {email.category}
                  </span>
                  {email.hasAttachment && <span style={{ fontSize: '0.65rem' }}>📎</span>}
                </div>
                <div style={{ fontSize: '0.78rem', fontWeight: email.isRead ? 400 : 600, color: th.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {email.subject}
                </div>
                <div style={{ fontSize: '0.68rem', color: th.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: '0.1rem' }}>
                  {email.snippet}
                </div>
              </div>
              <div style={{ fontSize: '0.62rem', color: th.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
                {new Date(email.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                {' '}
                {new Date(email.date).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </div>
            </div>

            {/* Expanded body */}
            {selectedEmail?.id === email.id && email.bodyPreview && (
              <div style={{ marginTop: '0.75rem', padding: '0.75rem', background: th.card2, borderRadius: '0.375rem', fontSize: '0.75rem', color: th.text, lineHeight: 1.6, maxHeight: '300px', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {email.bodyPreview.replace(/<[^>]+>/g, '')}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Compose Modal */}
      {composing && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}
          onClick={e => { if (e.target === e.currentTarget) setComposing(false); }}>
          <div style={{ ...card(th), width: '100%', maxWidth: 600, padding: '1.5rem' }}>
            <div style={{ fontFamily: "'Raleway'", fontWeight: 700, fontSize: '1rem', color: th.text, marginBottom: '1rem' }}>
              ✏️ Compose Email
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <input placeholder="To (email)" value={composeData.to} onChange={e => setComposeData({ ...composeData, to: e.target.value })}
                style={{ ...inp(th), fontSize: '0.85rem' }} />
              <input placeholder="CC (optional)" value={composeData.cc} onChange={e => setComposeData({ ...composeData, cc: e.target.value })}
                style={{ ...inp(th), fontSize: '0.85rem' }} />
              <input placeholder="Subject" value={composeData.subject} onChange={e => setComposeData({ ...composeData, subject: e.target.value })}
                style={{ ...inp(th), fontSize: '0.85rem' }} />
              <textarea placeholder="Message body..." value={composeData.body} onChange={e => setComposeData({ ...composeData, body: e.target.value })}
                rows={8} style={{ ...inp(th), fontSize: '0.85rem', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button onClick={() => setComposing(false)} style={{ ...btn(th, { padding: '0.4rem 1rem', fontSize: '0.78rem' }) }}>
                  Cancel
                </button>
                <button onClick={sendEmail} disabled={sending || !composeData.to || !composeData.subject}
                  style={{ ...btn(th, { background: accentColor, color: '#fff', fontWeight: 700, padding: '0.4rem 1.25rem', fontSize: '0.78rem', opacity: sending ? 0.6 : 1 }) }}>
                  {sending ? '⏳ Sending…' : '📤 Send'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add EmailTab routing**

In the main `PCGPortal` return statement, where tabs are routed (search for `{tab ===`), add:

```javascript
{tab === "email" && (isFullAdmin(user) || isOfficeStaff) && <EmailTab th={th} user={user} />}
```

- [ ] **Step 4: Add email context to Orion briefs**

In `analyst-data.js`, add:

```javascript
async function buildEmailContext() {
  const inbox = await cacheLoad('pcg_emails_inbox');
  if (!inbox?.emails?.length) return '';

  const unread = inbox.emails.filter(e => !e.isRead);
  if (unread.length === 0) return '';

  const lines = [`${unread.length} unread emails in shared inbox:`];
  const byCategory = {};
  for (const e of unread.slice(0, 10)) {
    const cat = e.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(e);
  }
  for (const [cat, emails] of Object.entries(byCategory)) {
    lines.push(`  ${cat}: ${emails.map(e => e.subject).join('; ')}`);
  }

  return '\n\nEMAIL INBOX:\n' + lines.join('\n');
}
```

Add `buildEmailContext` to the `module.exports`.

In `analyst-cron.js`, update the import and inject into exec briefs only:

```javascript
const { buildDataContext, buildKPISnapshot, buildWeatherContext, buildSentimentContext, buildEmailContext } = require('./analyst-lib/analyst-data');
```

In the exec brief generation:

```javascript
const emailCtx = await buildEmailContext();
const execPrompt = buildBriefPrompt('VP / Executive', today, execData, weatherCtx + sentimentCtx + emailCtx);
```

- [ ] **Step 5: Build and commit**

```bash
npm run build
git add app.jsx app.js netlify/functions/analyst-lib/analyst-data.js netlify/functions/analyst-cron.js
git commit -m "feat: Email tab — inbox viewer, compose modal, email context in Orion briefs"
```

---

### Task 13: Deploy + Test Email Feature + Final Version Bump

**Files:** None (deployment + testing)

- [ ] **Step 1: Deploy**

```bash
npx netlify deploy --prod
```

- [ ] **Step 2: Test compose (works without Gmail API setup)**

Open the portal, navigate to Email tab. Click Compose, send a test email to `mike@raogroupinc.com`. Verify it arrives (via Resend fallback if SMTP not configured yet).

- [ ] **Step 3: Test inbox (requires Gmail API setup)**

If `GOOGLE_SERVICE_ACCOUNT_KEY` and `GOOGLE_SHARED_MAILBOX` are configured:

```bash
curl -X POST https://pcg-ops.netlify.app/.netlify/functions/email-sync-cron
```

Verify emails appear in the Email tab.

- [ ] **Step 4: Version bump and final commit**

Update version to `v9.6` in `app.jsx`.

```bash
npm run build
git add app.jsx app.js
git commit -m "v9.6 — Phase 4: Weather forecasting, guest sentiment fusion, email integration"
```

- [ ] **Step 5: Push to remote**

```bash
git push origin main
```
