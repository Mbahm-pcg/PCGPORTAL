// src/chart-style.js — one shared, clean chart look for the whole portal (v22.22).
//
// Follows Bklit UI's design rules (bklit-ui-design skill) with what the portal
// already has — Chart.js from the CDN plus a few hand-built SVG/bar charts — instead
// of adding Tailwind/shadcn/visx: faint dashed horizontal grid only, no axis
// borders, smooth monotone lines with no dots until hover, soft vertical gradient
// under single-series lines, rounded bars, a card-style tooltip with a dashed
// crosshair, a calm ease-out draw-in, and one palette that works in light + dark.
// Pure (no DOM/React at import time) so it can be unit-tested.

import { O } from './theme.js';

// Series colours, in order. Brand orange first; the rest are chosen to stay
// distinguishable from each other and readable on both light and dark cards.
export const CHART_PALETTE = ['#FF671F', '#6366f1', '#14b8a6', '#f59e0b', '#d946ef', '#64748b', '#0ea5e9', '#84cc16'];
export const seriesColor = (i) => CHART_PALETTE[((i % CHART_PALETTE.length) + CHART_PALETTE.length) % CHART_PALETTE.length];

// '#FF671F' / '#f60' + alpha → 'rgba(r,g,b,a)'. Non-hex colours pass through.
export function withAlpha(color, alpha) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(color || '').trim());
  if (!m) return color;
  let h = m[1];
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

// Theme-aware chart tokens (th = getTheme(dark)).
export function chartTokens(th) {
  const dark = !!(th && th.dark);
  return {
    text: th?.text || (dark ? '#e8e8e8' : '#1a1710'),
    muted: th?.muted || (dark ? '#a0a0a0' : '#6b6560'),
    grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(26,23,16,0.07)',
    crosshair: dark ? 'rgba(255,255,255,0.28)' : 'rgba(26,23,16,0.22)',
    tooltipBg: th?.card || (dark ? '#1c1c1c' : '#ffffff'),
    tooltipBorder: th?.cardBorder || (dark ? '#2a2a2a' : '#e0ddd8'),
    font: "'Source Sans 3', sans-serif",
    titleFont: "'Raleway', sans-serif",
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v !== 'function';
// Deep merge for Chart.js option objects: plain objects merge, everything else
// (arrays, functions, values) from `over` replaces.
export function mergeDeep(base, over) {
  if (!isObj(over)) return over === undefined ? base : over;
  const out = { ...(isObj(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : (v === undefined ? out[k] : v);
  return out;
}

// Clean Chart.js options. `overrides` wins (deep-merged), so each chart keeps its
// own axis ranges, tick formatters, legend visibility, tooltip callbacks, etc.
export function cleanChartOptions(th, overrides = {}) {
  const t = chartTokens(th);
  const tick = { color: t.muted, font: { family: t.font, size: 11 }, padding: 6 };
  const base = {
    responsive: true,
    animation: { duration: 900, easing: 'easeOutQuart' },
    interaction: { mode: 'index', intersect: false },
    layout: { padding: { top: 6, right: 6 } },
    plugins: {
      legend: {
        position: 'bottom', align: 'start',
        labels: { color: t.muted, usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 14, font: { family: t.font, size: 11.5 } },
      },
      tooltip: {
        backgroundColor: t.tooltipBg, borderColor: t.tooltipBorder, borderWidth: 1,
        titleColor: t.text, bodyColor: t.text, footerColor: t.muted,
        titleFont: { family: t.font, size: 12, weight: '600' }, bodyFont: { family: t.font, size: 12 },
        padding: { x: 12, y: 10 }, cornerRadius: 10, caretSize: 0, caretPadding: 10,
        usePointStyle: true, boxWidth: 7, boxHeight: 7, boxPadding: 5,
      },
    },
    scales: {
      x: { grid: { display: false }, border: { display: false }, ticks: { ...tick, maxRotation: 0, autoSkip: true, autoSkipPadding: 14 } },
      y: { grid: { color: t.grid, drawTicks: false }, border: { display: false, dash: [3, 4] }, ticks: { ...tick, padding: 10, maxTicksLimit: 5 } },
    },
    elements: {
      line: { tension: 0.35, cubicInterpolationMode: 'monotone', borderWidth: 2, borderCapStyle: 'round', borderJoinStyle: 'round' },
      point: { radius: 0, hoverRadius: 4.5, hoverBorderWidth: 2, hitRadius: 14 },
      bar: { borderRadius: 6, borderSkipped: false },
      arc: { borderWidth: 2, borderColor: t.tooltipBg },
    },
  };
  return mergeDeep(base, overrides);
}

// Vertical gradient fill for a line (fades to transparent at the bottom). Use as a
// dataset's backgroundColor with fill: true. Scriptable — sized to the plot area.
export function areaFill(color, strength = 0.22) {
  return (ctx) => {
    const chart = ctx && ctx.chart;
    const area = chart && chart.chartArea;
    if (!area || !chart.ctx || !chart.ctx.createLinearGradient) return withAlpha(color, strength / 2);
    const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
    g.addColorStop(0, withAlpha(color, strength));
    g.addColorStop(1, withAlpha(color, 0));
    return g;
  };
}

// A clean line dataset: colour, hover dot ring in the card colour, optional fill.
export function lineSeries(th, { color, fill = false, dashed = false, width = 2, ...rest } = {}) {
  const t = chartTokens(th);
  return {
    borderColor: color, backgroundColor: fill ? areaFill(color) : color, fill: !!fill,
    borderWidth: width, pointHoverBackgroundColor: color, pointHoverBorderColor: t.tooltipBg,
    ...(dashed ? { borderDash: [5, 4] } : {}),
    ...rest,
  };
}

// Chart.js plugin: dashed vertical guide line at the hovered x (bklit-style crosshair).
export function crosshairPlugin(th) {
  const color = chartTokens(th).crosshair;
  return {
    id: 'pcgCrosshair',
    afterDatasetsDraw(chart) {
      const active = chart.tooltip && chart.tooltip.getActiveElements && chart.tooltip.getActiveElements();
      if (!active || !active.length || !chart.chartArea) return;
      const x = active[0].element.x;
      const { top, bottom } = chart.chartArea;
      const c = chart.ctx;
      c.save();
      c.beginPath(); c.setLineDash([3, 4]); c.lineWidth = 1; c.strokeStyle = color;
      c.moveTo(x, top); c.lineTo(x, bottom); c.stroke();
      c.restore();
    },
  };
}

// Smooth SVG path through points (monotone cubic — never overshoots between
// points, same idea as Chart.js 'monotone' / visx curveMonotoneX) for the
// portal's hand-built SVG charts. points: [{ x, y }] sorted by x.
export function smoothPath(points) {
  const p = (points || []).filter(q => Number.isFinite(q.x) && Number.isFinite(q.y));
  if (p.length === 0) return '';
  if (p.length === 1) return `M${p[0].x},${p[0].y}`;
  const n = p.length;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1].x - p[i].x; dy[i] = p[i + 1].y - p[i].y; m[i] = dx[i] ? dy[i] / dx[i] : 0; }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
  t[n - 1] = m[n - 2];
  const r = (v) => Math.round(v * 100) / 100;
  let d = `M${r(p[0].x)},${r(p[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${r(p[i].x + h)},${r(p[i].y + h * t[i])} ${r(p[i + 1].x - h)},${r(p[i + 1].y - h * t[i + 1])} ${r(p[i + 1].x)},${r(p[i + 1].y)}`;
  }
  return d;
}

// SVG path for a bar with only its TOP corners rounded (flat on the baseline).
export function roundedTopBar(x, y, w, h, r = 5) {
  if (!(w > 0) || !(h > 0)) return '';
  const rr = Math.max(0, Math.min(r, w / 2, h));
  const n = (v) => Math.round(v * 100) / 100;
  return `M${n(x)},${n(y + h)} V${n(y + rr)} Q${n(x)},${n(y)} ${n(x + rr)},${n(y)} H${n(x + w - rr)} Q${n(x + w)},${n(y)} ${n(x + w)},${n(y + rr)} V${n(y + h)} Z`;
}

export const BRAND = O;
