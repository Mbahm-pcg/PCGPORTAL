const { enrich } = require('./store-map');

// Pure aggregation over raw order rows ({account,total_order,date_ordered,...}).
function summarize(orders) {
  const out = {
    totals: { orders: 0, spend: 0 },
    byWeek: {}, byDistrict: {}, byStore: {},
    unmapped: { orders: 0, spend: 0 },
  };
  for (const raw of orders || []) {
    const o = enrich(raw);
    const amt = Number(o.total_order) || 0;
    out.totals.orders += 1; out.totals.spend += amt;
    if (o.weekKey) {
      const w = (out.byWeek[o.weekKey] ||= { orders: 0, spend: 0 });
      w.orders += 1; w.spend += amt;
    }
    if (o.unmapped) { out.unmapped.orders += 1; out.unmapped.spend += amt; continue; }
    const d = (out.byDistrict[String(o.district)] ||= { dmName: o.dmName, orders: 0, spend: 0, stores: new Set() });
    d.orders += 1; d.spend += amt; d.stores.add(o.pc);
    const st = (out.byStore[o.pc] ||= { name: o.name, district: o.district, orders: 0, spend: 0 });
    st.orders += 1; st.spend += amt;
  }
  // round + serialize sets
  for (const d of Object.values(out.byDistrict)) { d.spend = Math.round(d.spend); d.stores = [...d.stores]; }
  for (const w of Object.values(out.byWeek)) w.spend = Math.round(w.spend);
  for (const s of Object.values(out.byStore)) s.spend = Math.round(s.spend);
  out.totals.spend = Math.round(out.totals.spend);
  out.unmapped.spend = Math.round(out.unmapped.spend);
  return out;
}

module.exports = { summarize };
