// PCG Pulse — iOS home-screen widget (Scriptable, MEDIUM / ~3x1).
// SETUP:
//   1. Install "Scriptable" (free, App Store).
//   2. Scriptable → + (new script) → paste this whole file.
//   3. Set TOKEN below to the WIDGET_SECRET value (from Netlify env).
//   4. Tap ▶ once to preview. Then: home screen → long-press → + → Scriptable →
//      pick the MEDIUM size → "Add Widget" → long-press it → Edit Widget → Script: this one.
// Refreshes automatically (~every 15 min, iOS decides the exact cadence).

const ENDPOINT = "https://uop.peoplecapitalgroup.com/.netlify/functions/widget";
const TOKEN = "PASTE_WIDGET_SECRET_HERE";
// Optional: show one district instead of the whole network → set e.g. "7"; leave "" for network.
const DISTRICT = "";

const O = new Color("#FF671F");
const fmtMoney = (n) => "$" + Number(n || 0).toLocaleString("en-US");
const laborColor = (p) => p == null ? Color.gray() : p >= 26 ? new Color("#ef4444") : p >= 23 ? new Color("#f59e0b") : new Color("#22c55e");

async function getData() {
  let u = `${ENDPOINT}?token=${encodeURIComponent(TOKEN)}`;
  if (DISTRICT) u += `&district=${encodeURIComponent(DISTRICT)}`;
  const req = new Request(u);
  req.timeoutInterval = 10;
  return await req.loadJSON();
}

const w = new ListWidget();
w.backgroundColor = Color.dynamic(new Color("#ffffff"), new Color("#14110f"));
w.setPadding(14, 16, 14, 16);

try {
  const d = await getData();

  const hdr = w.addStack();
  const dot = hdr.addText("● "); dot.textColor = O; dot.font = Font.boldSystemFont(11);
  const title = hdr.addText("PULSE · " + (d.scope || "Network")); title.font = Font.semiboldSystemFont(11); title.textColor = Color.gray();

  w.addSpacer(6);
  const sales = w.addText(fmtMoney(d.netSales)); sales.font = Font.boldSystemFont(30);
  const sub = w.addText("net sales today"); sub.font = Font.systemFont(10); sub.textColor = Color.gray();

  w.addSpacer(6);
  const row = w.addStack(); row.centerAlignContent();
  const lab = row.addText(d.laborPct == null ? "Labor —" : `Labor ${d.laborPct}%`);
  lab.font = Font.semiboldSystemFont(13); lab.textColor = laborColor(d.laborPct);
  row.addSpacer();
  const st = row.addText(`${d.storesReporting}/${d.storeCount} stores`);
  st.font = Font.systemFont(11); st.textColor = Color.gray();

  w.addSpacer(4);
  const ts = d.asOf ? new Date(d.asOf) : null;
  const foot = w.addText(ts ? "Updated " + ts.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "");
  foot.font = Font.systemFont(9); foot.textColor = Color.gray();
} catch (e) {
  const err = w.addText("Pulse unavailable"); err.font = Font.semiboldSystemFont(14); err.textColor = Color.gray();
  const e2 = w.addText("check token / connection"); e2.font = Font.systemFont(10); e2.textColor = Color.gray();
}

w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
if (config.runsInWidget) { Script.setWidget(w); } else { w.presentMedium(); }
Script.complete();
