// store-map.js — pure NDCP↔store helpers. Account number == Pulse pc (verified
// 45/45 on 2026-06-08), so the order→store join is the identity function.
// No I/O — safe to unit-test and import anywhere.

// district → DM display name (from app.jsx DISTRICTS_SEED, current week's DMs)
const DM_BY_DISTRICT = {
  1: 'Taylor Cormier', 2: 'Jay Patel', 3: 'Sonia Khalique', 4: 'Yolicet Grin-Martinez',
  5: 'Shreyes Mehta', 6: 'Mohamed', 7: 'Sharmin Akter', 8: 'Mike',
};

// pc → { name, district } — all 45 stores from app.jsx STORES_SEED (pc/name/district).
const STORES = [
  { pc: '339616', name: 'Wadsworth',       district: 1 },
  { pc: '340794', name: 'Front',           district: 1 },
  { pc: '351099', name: 'Sonic',           district: 2 },
  { pc: '351259', name: 'Rosemore',        district: 2 },
  { pc: '302642', name: 'County Line',     district: 2 },
  { pc: '352894', name: 'Street Rd',       district: 2 },
  { pc: '341350', name: 'Yardley',         district: 2 },
  { pc: '337839', name: 'Warrington',      district: 2 },
  { pc: '330338', name: 'Drexel Hill',     district: 3 },
  { pc: '337063', name: 'Sharon Hill',     district: 3 },
  { pc: '343832', name: 'Lansdowne',       district: 3 },
  { pc: '304669', name: 'Collingdale',     district: 3 },
  { pc: '355146', name: 'Gallery',         district: 3 },
  { pc: '300496', name: 'Cobbs Creek',     district: 3 },
  { pc: '304863', name: '18th St',         district: 3 },
  { pc: '354561', name: 'Carlisle',        district: 3 },
  { pc: '332393', name: 'Lindbergh',       district: 3 },
  { pc: '341167', name: '5th Street',      district: 4 },
  { pc: '340870', name: 'Hunting Park',    district: 4 },
  { pc: '335981', name: 'Lehigh',          district: 4 },
  { pc: '353150', name: 'Bakers Square',   district: 4 },
  { pc: '351050', name: 'Allegheny',       district: 4 },
  { pc: '345985', name: 'Wissahickon',     district: 4 },
  { pc: '356374', name: 'Montgomeryville', district: 5 },
  { pc: '353843', name: 'Tollgate',        district: 5 },
  { pc: '353047', name: 'Silverdale',      district: 5 },
  { pc: '340538', name: 'Easton',          district: 5 },
  { pc: '343079', name: 'Downingtown',     district: 6 },
  { pc: '342144', name: 'Westchester',     district: 6 },
  { pc: '364295', name: 'Lionville',       district: 6 },
  { pc: '365361', name: 'Little Welsh',    district: 7 },
  { pc: '310382', name: 'Grant',           district: 7 },
  { pc: '332941', name: 'Bustleton',       district: 7 },
  { pc: '343497', name: 'Red Lion',        district: 7 },
  { pc: '302446', name: 'Little Red Lion', district: 7 },
  { pc: '337079', name: 'Holme Circle',    district: 7 },
  { pc: '345986', name: 'Willits',         district: 7 },
  { pc: '364412', name: '8200',            district: 7 },
  { pc: '345489', name: 'Oxford',          district: 7 },
  { pc: '336372', name: 'Elkins Park',     district: 7 },
  { pc: '358933', name: 'Brace Rd',        district: 8 },
  { pc: '354865', name: 'Quakertown',      district: 8 },
  { pc: '353689', name: 'Fort Washington', district: 8 },
  { pc: '342184', name: 'Lansdale',        district: 8 },
  { pc: '356316', name: "BJ's",            district: 8 },
];

const STORE_BY_PC = {};
for (const s of STORES) {
  STORE_BY_PC[String(s.pc)] = { ...s, pc: String(s.pc), dmName: DM_BY_DISTRICT[s.district] || `District ${s.district}` };
}

// Sunday-start week key 'YYYY-MM-DD'. Accepts 'MM/DD/YYYY' or ISO 'YYYY-MM-DD'.
function weekOf(dateStr) {
  if (!dateStr) return null;
  let d;
  const s = String(dateStr).trim();
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) d = new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]));
  else { const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (!iso) return null; d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])); }
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - d.getDay()); // back up to Sunday (getDay 0=Sun)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function enrich(order) {
  const acct = String(order.account == null ? '' : order.account).trim();
  const store = STORE_BY_PC[acct];
  return {
    ...order,
    pc: store ? store.pc : null,
    name: store ? store.name : (order.store_name || null),
    district: store ? store.district : null,
    dmName: store ? store.dmName : null,
    weekKey: weekOf(order.date_ordered || order.email_date),
    unmapped: !store,
  };
}

// DCP% = spend / sales * 100, or null when sales missing/zero or spend missing.
function dcpPct(spend, sales) {
  if (spend == null || sales == null) return null;
  const sp = Number(spend), sl = Number(sales);
  if (!isFinite(sp) || !isFinite(sl) || sl <= 0) return null;
  return Math.round((sp / sl) * 1000) / 10; // one decimal
}

module.exports = { STORE_BY_PC, DM_BY_DISTRICT, enrich, weekOf, dcpPct };
