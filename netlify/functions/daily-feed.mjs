// PCG Portal — Daily Feed
// Fetches: (1) daily inspirational quote from ZenQuotes,
//          (2) mixed news headlines from Fox News, CNN, Google News,
//              and restaurant-industry sources (Nation's Restaurant News,
//              Restaurant Dive) — with article images when available.

import https from 'node:https';

function httpsGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) return reject(new Error('Too many redirects'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PCG-Portal/1.0)' },
      timeout: 9000,
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return httpsGet(res.headers.location, redirectCount + 1).then(resolve, reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// Decode common HTML entities
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripCData(s) {
  if (!s) return '';
  return s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

function extractTag(block, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(block);
  if (!m) return '';
  return decodeEntities(stripCData(m[1]));
}

// Extract first image from an RSS item block — checks multiple common patterns
function extractImage(block) {
  // 1. <media:content url="..." medium="image" /> or type="image/*"
  const mediaContent = /<media:content\b[^>]*\burl=["']([^"']+)["'][^>]*>/i.exec(block);
  if (mediaContent) {
    const url = mediaContent[1];
    // Ensure it looks like an image
    if (/\.(jpe?g|png|gif|webp)(\?|$)/i.test(url) || /medium=["']image["']/i.test(mediaContent[0]) || /type=["']image/i.test(mediaContent[0])) {
      return decodeEntities(url);
    }
  }
  // 2. <media:thumbnail url="..." />
  const mediaThumb = /<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i.exec(block);
  if (mediaThumb) return decodeEntities(mediaThumb[1]);
  // 3. <enclosure url="..." type="image/*" />
  const enclosure = /<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image/i.exec(block);
  if (enclosure) return decodeEntities(enclosure[1]);
  // 4. Look inside description/content:encoded for first <img src="...">
  const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(block);
  if (img) return decodeEntities(img[1]);
  return null;
}

// Parse an RSS XML string into an array of items
function parseRSS(xml, source, limit = 10) {
  const items = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
    const block = match[1];
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const rawDesc = extractTag(block, 'description');
    // Description may have HTML — strip tags, limit length
    const description = rawDesc.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const pubDate = extractTag(block, 'pubDate');
    const image = extractImage(block);
    if (title && link) items.push({ title, link, description, pubDate, image, source });
  }
  return items;
}

// Sort items by pubDate (newest first), fallback to feed order
function sortByDate(items) {
  return items.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });
}

// News sources to pull from
// Google News search queries let us create topic-specific feeds on the fly
const INSPIRE_QUERY = '"Inspire Brands" OR "Dunkin\'" OR "Arby\'s" OR "Baskin-Robbins" OR "Buffalo Wild Wings" OR "Jimmy John\'s" OR "Sonic Drive-In"';
const PAPA_JOHNS_QUERY = '"Papa John\'s" OR "Papa Johns"';
const buildGoogleSearch = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const SOURCES = [
  { name: 'Fox News',                url: 'https://moxie.foxnews.com/google-publisher/latest.xml', limit: 6, category: 'general' },
  { name: 'CNN',                     url: 'http://rss.cnn.com/rss/cnn_topstories.rss',             limit: 6, category: 'general' },
  { name: 'Google News',             url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', limit: 6, category: 'general' },
  { name: 'Nation\'s Restaurant News', url: 'https://www.nrn.com/feeds/rss.xml',                    limit: 5, category: 'restaurant' },
  { name: 'Restaurant Dive',         url: 'https://www.restaurantdive.com/feeds/news/',            limit: 5, category: 'restaurant' },
  { name: 'Inspire Brands',          url: buildGoogleSearch(INSPIRE_QUERY),                         limit: 10, category: 'inspire' },
  { name: 'Papa John\'s',            url: buildGoogleSearch(PAPA_JOHNS_QUERY),                      limit: 10, category: 'papajohns' },
];

export default async (request, context) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=1800, s-maxage=1800', // 30 minutes
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  const result = { quote: null, news: { general: [], restaurant: [], inspire: [], papajohns: [] }, errors: [] };

  // Fetch all RSS sources + the quote in parallel
  const tasks = [
    // Quote
    (async () => {
      try {
        const r = await httpsGet('https://zenquotes.io/api/today');
        if (r.status === 200) {
          const arr = JSON.parse(r.body);
          if (Array.isArray(arr) && arr.length > 0) {
            result.quote = { text: arr[0].q, author: arr[0].a || 'Unknown' };
          }
        } else {
          result.errors.push(`zenquotes HTTP ${r.status}`);
        }
      } catch (e) {
        result.errors.push('zenquotes: ' + e.message);
      }
    })(),
    // News sources
    ...SOURCES.map(src => (async () => {
      try {
        const r = await httpsGet(src.url);
        if (r.status === 200) {
          const items = parseRSS(r.body, src.name, src.limit);
          // For Google News search results, extract the actual publisher from the title
          // (format is "Title - Publisher") and use that as source, plus clean description
          if (src.category === 'inspire' || src.category === 'papajohns') {
            for (const item of items) {
              const m = /^(.*?)\s+-\s+([^-]+)$/.exec(item.title);
              if (m) {
                item.title = m[1].trim();
                item.source = m[2].trim();
              }
              // Google News descriptions are HTML links — clean them up
              item.description = '';
            }
          }
          if (result.news[src.category]) result.news[src.category].push(...items);
        } else {
          result.errors.push(`${src.name} HTTP ${r.status}`);
        }
      } catch (e) {
        result.errors.push(`${src.name}: ${e.message}`);
      }
    })()),
  ];

  await Promise.all(tasks);

  // Sort each category by date (newest first) and interleave general sources
  // For general news, group by source then round-robin for diversity
  const bySource = {};
  for (const n of result.news.general) {
    if (!bySource[n.source]) bySource[n.source] = [];
    bySource[n.source].push(n);
  }
  // Sort each source's articles by date
  Object.keys(bySource).forEach(s => bySource[s] = sortByDate(bySource[s]));
  // Round-robin across sources to create a balanced mix
  const mixed = [];
  const sourceNames = Object.keys(bySource);
  let idx = 0;
  while (mixed.length < 12 && sourceNames.some(s => bySource[s].length > 0)) {
    const src = sourceNames[idx % sourceNames.length];
    if (bySource[src].length > 0) mixed.push(bySource[src].shift());
    idx++;
  }
  result.news.general = mixed;
  result.news.restaurant = sortByDate(result.news.restaurant).slice(0, 8);
  result.news.inspire = sortByDate(result.news.inspire).slice(0, 10);
  result.news.papajohns = sortByDate(result.news.papajohns).slice(0, 10);

  return new Response(JSON.stringify(result), { status: 200, headers });
};
