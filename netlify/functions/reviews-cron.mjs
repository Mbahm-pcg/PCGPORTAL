// reviews-cron.mjs — Weekly: fetch Google Places reviews + Claude Haiku sentiment per store
import https from 'node:https';
import { cacheSave, cacheLoad } from './analyst-lib/analyst-cache.js';
import { callClaude, HAIKU } from './analyst-lib/analyst-claude.js';
import { REVIEW_ANALYSIS_SYSTEM } from './analyst-lib/analyst-prompts.js';
import { logAudit } from './analyst-lib/analyst-audit.js';

export const config = { schedule: '0 5 * * 0' };

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

export default async (request) => {
  const isManual = request.method === 'POST';
  console.log('[reviews-cron] Starting', isManual ? '(manual)' : '(scheduled)');

  const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!API_KEY) {
    console.warn('[reviews-cron] GOOGLE_PLACES_API_KEY not set, skipping');
    return new Response(JSON.stringify({ ok: false, error: 'No API key' }), { status: 200 });
  }

  // Load place IDs from config blob (set up separately)
  const placeIds = await cacheLoad('pcg_store_place_ids') || {};
  const storesWithIds = STORES.filter(s => placeIds[s.pc]);

  if (storesWithIds.length === 0) {
    console.warn('[reviews-cron] No stores have Place IDs configured');
    return new Response(JSON.stringify({ ok: false, error: 'No Place IDs configured' }), { status: 200 });
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

  return new Response(
    JSON.stringify({ ok: true, processed, failed, networkAvgRating }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
