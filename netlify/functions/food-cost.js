// food-cost.js — Theoretical Food Cost calculator
// Pulls menu item sales from Pulse POS, classifies ALL items into categories,
// calculates Food Cost(T) for bakery items with known ingredient costs

const https = require('https');

const APIS = {
  p227: {
    host: 'pos-ra.dunkindonuts.com', path: '/p227',
    xkey: 'sUVxDiWxfv9xIUyBxJlpN3A7znHoIoPx1nfTR6DL',
    apikey: 'MjI3Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
  p228: {
    host: 'pos-ra.dunkindonuts.com', path: '/p228',
    xkey: 'g6ge9xpyBo2I0tNXGXntQ8fm104dt3VD3lQ7HjTP',
    apikey: 'MjI4Onp2RnIrV1dWbnpFeXN0MThhejdyd0tHTFlOZlNGMmlZV0lRZGZXNTZ3L3FvUmFhUGMyQ1ZQalJjaHZtdWVFMWdJSzhremtJSnkxZ3E1YXlzWGN2OVpBPT0=',
  },
};

// Ingredient costs per unit (bakery items with known costs)
const INGREDIENT_COSTS = {
  donut:          0.39,
  munchkin:       0.1150,
  muffin:         0.325,
  bagel:          0.25,
  english_muffin: 0.18,
  croissant:      0.27,
  fancy:          0.5050,
  fritter:        0.5050,
  bagel_twist:    0.60,
};

// Display groups
const CATEGORY_GROUPS = {
  bakery:           { label: 'Bakery', color: '#FF671F', icon: '🍩' },
  hot_beverages:    { label: 'Hot Beverages', color: '#f59e0b', icon: '☕' },
  cold_beverages:   { label: 'Cold Beverages', color: '#3b82f6', icon: '🧊' },
  frozen:           { label: 'Frozen Drinks', color: '#8b5cf6', icon: '🥤' },
  sandwiches:       { label: 'Sandwiches', color: '#10b981', icon: '🥪' },
  wraps:            { label: 'Wraps', color: '#14b8a6', icon: '🌯' },
  snacks_sides:     { label: 'Snacks & Sides', color: '#f97316', icon: '🥓' },
  bottled:          { label: 'Bottled & Packaged', color: '#6366f1', icon: '🧃' },
  other:            { label: 'Other', color: '#94a3b8', icon: '📦' },
};

// Bakery sub-categories that have ingredient costs
const BAKERY_SUBS = ['donut', 'munchkin', 'muffin', 'bagel', 'english_muffin', 'croissant', 'fancy', 'fritter', 'bagel_twist'];

function classifyItem(name) {
  const lower = (name || '').toLowerCase();

  // ── BAKERY ──────────────────────────────────────────
  // Munchkins (before donut)
  if (lower.includes('munchkin')) {
    const ctMatch = lower.match(/(\d+)\s*ct/);
    if (ctMatch) return { group: 'bakery', sub: 'munchkin', qty: parseInt(ctMatch[1]) };
    if (lower.includes('box') || lower.includes('bucket')) {
      if (lower.includes('50')) return { group: 'bakery', sub: 'munchkin', qty: 50 };
      if (lower.includes('25')) return { group: 'bakery', sub: 'munchkin', qty: 25 };
    }
    return { group: 'bakery', sub: 'munchkin', qty: 1 };
  }

  // English Muffin (before muffin)
  if (lower.includes('english muffin')) return { group: 'bakery', sub: 'english_muffin', qty: 1 };

  // Muffin
  if (lower.includes('muffin') && !lower.includes('sandwich') && !lower.includes('wrap')) return { group: 'bakery', sub: 'muffin', qty: 1 };

  // Bagel Twist (before bagel)
  if (lower.includes('bagel twist') || lower.includes('twist bagel')) return { group: 'bakery', sub: 'bagel_twist', qty: 1 };

  // Bagel (but not bagel sandwich)
  if (lower.includes('bagel') && !lower.includes('sandwich') && !lower.includes('wrap')) {
    const dzMatch = lower.match(/(\d+)\s*(?:pk|pack|ct)/);
    if (dzMatch) return { group: 'bakery', sub: 'bagel', qty: parseInt(dzMatch[1]) };
    if (lower.includes('half dozen') || lower.includes('1/2 dozen') || lower.includes('6 pk')) return { group: 'bakery', sub: 'bagel', qty: 6 };
    if (lower.includes('dozen')) return { group: 'bakery', sub: 'bagel', qty: 12 };
    return { group: 'bakery', sub: 'bagel', qty: 1 };
  }

  // Croissant (but not croissant sandwich)
  if (lower.includes('croissant') && !lower.includes('sandwich') && !lower.includes('wrap')) return { group: 'bakery', sub: 'croissant', qty: 1 };

  // Fancies / Fritters
  if (lower.includes('fritter')) return { group: 'bakery', sub: 'fritter', qty: 1 };
  if (lower.includes('danish') || lower.includes('brownie') || lower.includes('coffee cake') ||
      lower.includes('coffee roll') || lower.includes('strudel') || lower.includes('eclair') ||
      lower.includes('turnover') || lower.includes('bismark') || lower.includes('fancy') ||
      lower.includes('crumb cake') || lower.includes('old fashioned cake')) {
    return { group: 'bakery', sub: 'fancy', qty: 1 };
  }

  // Donuts
  if (lower.includes('donut') || lower.includes('doughnut')) {
    const ctMatch = lower.match(/(\d+)\s*(?:ct|pk|pack)/);
    if (ctMatch) return { group: 'bakery', sub: 'donut', qty: parseInt(ctMatch[1]) };
    if (lower.includes('half dozen') || lower.includes('1/2 dozen') || lower.includes('6 pk')) return { group: 'bakery', sub: 'donut', qty: 6 };
    if (lower.includes('dozen')) return { group: 'bakery', sub: 'donut', qty: 12 };
    return { group: 'bakery', sub: 'donut', qty: 1 };
  }

  // ── WRAPS ───────────────────────────────────────────
  if (lower.includes('wrap')) return { group: 'wraps', sub: null, qty: 1 };

  // ── SANDWICHES ──────────────────────────────────────
  if (lower.includes('sandwich') || lower.includes('sourdough') ||
      (lower.includes('croissant') && (lower.includes('egg') || lower.includes('bacon') || lower.includes('sausage'))) ||
      (lower.includes('bagel') && (lower.includes('egg') || lower.includes('bacon') || lower.includes('sausage'))) ||
      (lower.includes('english muffin') && (lower.includes('egg') || lower.includes('bacon') || lower.includes('sausage')))) {
    return { group: 'sandwiches', sub: null, qty: 1 };
  }

  // ── FROZEN DRINKS ───────────────────────────────────
  if (lower.includes('coolatta') || lower.includes('frozen') || lower.includes('frappe') ||
      lower.includes('shake') || lower.includes('float') || lower.includes('smoothie')) {
    return { group: 'frozen', sub: null, qty: 1 };
  }

  // ── HOT BEVERAGES ──────────────────────────────────
  if ((lower.includes('coffee') && !lower.includes('iced') && !lower.includes('cold brew') && !lower.includes('bottled')) ||
      lower.includes('latte') && !lower.includes('iced') ||
      lower.includes('cappuccino') || lower.includes('americano') ||
      lower.includes('macchiato') && !lower.includes('iced') ||
      lower.includes('espresso') || lower.includes('hot chocolate') ||
      lower.includes('hot tea') || lower.includes('chai') && !lower.includes('iced') ||
      (lower.includes('tea') && !lower.includes('iced') && !lower.includes('sweet') && !lower.includes('bottle'))) {
    return { group: 'hot_beverages', sub: null, qty: 1 };
  }

  // ── COLD BEVERAGES ─────────────────────────────────
  if (lower.includes('iced') || lower.includes('cold brew') || lower.includes('refresher') ||
      lower.includes('lemonade') || lower.includes('iced tea') || lower.includes('sweet tea')) {
    return { group: 'cold_beverages', sub: null, qty: 1 };
  }

  // ── BOTTLED & PACKAGED ─────────────────────────────
  if (lower.includes('bottle') || lower.includes('juice') || lower.includes('water') ||
      lower.includes('milk') || lower.includes('simply') || lower.includes('dew') ||
      lower.includes('pepsi') || lower.includes('coke') || lower.includes('soda') ||
      lower.includes('gatorade') || lower.includes('snapple') || lower.includes('can ')) {
    return { group: 'bottled', sub: null, qty: 1 };
  }

  // ── SNACKS & SIDES ─────────────────────────────────
  if (lower.includes('hash brown') || lower.includes('hashbrown') || lower.includes('pretzel') ||
      lower.includes('cookie') || lower.includes('waffle') || lower.includes('oatmeal') ||
      lower.includes('avocado') || lower.includes('cream cheese') || lower.includes('butter') ||
      lower.includes('spread') || lower.includes('bacon') || lower.includes('sausage') ||
      lower.includes('egg') || lower.includes('cheese') || lower.includes('side')) {
    return { group: 'snacks_sides', sub: null, qty: 1 };
  }

  // ── OTHER ───────────────────────────────────────────
  return { group: 'other', sub: null, qty: 1 };
}

function callPulse(cfg, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: cfg.host, port: 443,
      path: `${cfg.path}/${endpoint}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.xkey,
        'Api-Key': cfg.apikey,
        'Content-Length': Buffer.byteLength(data),
      },
    }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function calcFoodCostForStore(pc, date) {
  const api = String(pc) === '345986' ? 'p227' : 'p228';
  const cfg = APIS[api];

  const [dims, daily, ops] = await Promise.all([
    callPulse(cfg, 'getMenuItemDimensions', { locRef: String(pc) }),
    callPulse(cfg, 'getMenuItemDailyTotals', {
      locRef: String(pc), busDt: date,
      searchCriteria: 'where greaterThan(revenueCenters.menuItems.slsCnt, 0)',
      include: 'revenueCenters.menuItems.miNum,revenueCenters.menuItems.slsTtl,revenueCenters.menuItems.slsCnt',
    }),
    callPulse(cfg, 'getOperationsDailyTotals', {
      locRef: String(pc), busDt: date, include: 'revenueCenters',
    }),
  ]);

  if (!dims?.menuItems || !daily?.revenueCenters) {
    return { pc, date, error: 'No data', totalCost: 0, netSales: 0, pct: 0, categories: {} };
  }

  const nameMap = Object.fromEntries(dims.menuItems.map(m => [m.num, m.name]));

  // Aggregate menu items across revenue centers
  const aggregated = {};
  for (const rc of daily.revenueCenters) {
    for (const mi of (rc.menuItems || [])) {
      if (!aggregated[mi.miNum]) aggregated[mi.miNum] = { slsTtl: 0, slsCnt: 0 };
      aggregated[mi.miNum].slsTtl += mi.slsTtl || 0;
      aggregated[mi.miNum].slsCnt += mi.slsCnt || 0;
    }
  }

  let netSales = 0;
  if (ops?.revenueCenters) {
    for (const rc of ops.revenueCenters) netSales += (rc.netSales || 0);
  }

  // Build categorized results
  const categories = {};
  let totalBakeryCost = 0;

  for (const [miNum, data] of Object.entries(aggregated)) {
    const itemName = nameMap[miNum] || `Item ${miNum}`;
    const cls = classifyItem(itemName);
    const groupKey = cls.group;

    if (!categories[groupKey]) {
      const meta = CATEGORY_GROUPS[groupKey] || CATEGORY_GROUPS.other;
      categories[groupKey] = { ...meta, totalRevenue: 0, totalQty: 0, totalCost: 0, items: [] };
    }

    const unitCost = cls.sub && INGREDIENT_COSTS[cls.sub] ? INGREDIENT_COSTS[cls.sub] : 0;
    const totalUnits = data.slsCnt * (cls.qty || 1);
    const cost = totalUnits * unitCost;

    if (cls.group === 'bakery') totalBakeryCost += cost;

    categories[groupKey].totalRevenue += data.slsTtl;
    categories[groupKey].totalQty += data.slsCnt;
    categories[groupKey].totalCost += cost;
    categories[groupKey].items.push({
      name: itemName, miNum, sub: cls.sub,
      qtySold: data.slsCnt, unitsPerSale: cls.qty || 1,
      totalUnits, unitCost: Math.round(unitCost * 10000) / 10000,
      totalCost: Math.round(cost * 100) / 100,
      revenue: Math.round(data.slsTtl * 100) / 100,
    });
  }

  // Sort items within each category by revenue desc
  for (const cat of Object.values(categories)) {
    cat.items.sort((a, b) => b.revenue - a.revenue);
    cat.totalRevenue = Math.round(cat.totalRevenue * 100) / 100;
    cat.totalCost = Math.round(cat.totalCost * 100) / 100;
  }

  return {
    pc, date,
    totalBakeryCost: Math.round(totalBakeryCost * 100) / 100,
    netSales: Math.round(netSales * 100) / 100,
    pct: netSales > 0 ? Math.round((totalBakeryCost / netSales) * 10000) / 100 : 0,
    categories,
    categoryMeta: CATEGORY_GROUPS,
  };
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const { action, pc, date } = JSON.parse(event.body || '{}');

  try {
    if (action === 'store') {
      if (!pc || !date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing pc or date' }) };
      const result = await calcFoodCostForStore(pc, date);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (action === 'classify') {
      if (!pc) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing pc' }) };
      const api = String(pc) === '345986' ? 'p227' : 'p228';
      const dims = await callPulse(APIS[api], 'getMenuItemDimensions', { locRef: String(pc) });
      const items = (dims?.menuItems || []).map(m => ({ num: m.num, name: m.name, classification: classifyItem(m.name) }));
      const grouped = {};
      for (const item of items) {
        const g = item.classification.group;
        if (!grouped[g]) grouped[g] = [];
        grouped[g].push(item);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ total: items.length, groups: grouped }) };
    }

    if (action === 'ingredients') {
      return { statusCode: 200, headers, body: JSON.stringify(INGREDIENT_COSTS) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (err) {
    console.error('[food-cost] Error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
