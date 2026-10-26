import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withAlpha, mergeDeep, cleanChartOptions, chartTokens, seriesColor, CHART_PALETTE, areaFill, smoothPath, lineSeries, crosshairPlugin, roundedTopBar } from './chart-style.js';
import { DARK, LIGHT } from './theme.js';

test('withAlpha: hex (3/6 digit) → rgba; other colours pass through', () => {
  assert.equal(withAlpha('#FF671F', 0.2), 'rgba(255,103,31,0.2)');
  assert.equal(withAlpha('#f60', 1), 'rgba(255,102,0,1)');
  assert.equal(withAlpha('rgb(1,2,3)', 0.5), 'rgb(1,2,3)');
});

test('mergeDeep: objects merge, arrays/functions/values replace, undefined keeps base', () => {
  const fn = () => 1;
  const out = mergeDeep({ a: { b: 1, c: 2 }, d: [1, 2], e: 1 }, { a: { c: 3 }, d: [9], e: undefined, f: fn });
  assert.deepEqual(out.a, { b: 1, c: 3 });
  assert.deepEqual(out.d, [9]);
  assert.equal(out.e, 1);
  assert.equal(out.f, fn);
});

test('cleanChartOptions: clean defaults, and each chart keeps its own overrides', () => {
  const fmt = (v) => `$${v}`;
  const o = cleanChartOptions(LIGHT, { scales: { y: { min: 0, max: 100, ticks: { callback: fmt } } }, plugins: { legend: { display: false } } });
  assert.equal(o.scales.x.grid.display, false);            // no vertical grid
  assert.equal(o.scales.y.border.display, false);          // no axis border
  assert.equal(o.scales.y.min, 0);                         // override kept
  assert.equal(o.scales.y.ticks.callback, fmt);            // formatter kept…
  assert.equal(o.scales.y.ticks.color, LIGHT.muted);       // …alongside the clean tick colour
  assert.equal(o.plugins.legend.display, false);
  assert.equal(o.plugins.legend.labels.usePointStyle, true);
  assert.equal(o.elements.point.radius, 0);                // dots only on hover
  assert.equal(o.interaction.mode, 'index');
});

test('chartTokens: light vs dark grid and tooltip follow the theme', () => {
  assert.notEqual(chartTokens(LIGHT).grid, chartTokens(DARK).grid);
  assert.equal(chartTokens(DARK).tooltipBg, DARK.card);
  assert.equal(cleanChartOptions(DARK).plugins.tooltip.backgroundColor, DARK.card);
});

test('seriesColor: brand orange first, wraps around', () => {
  assert.equal(seriesColor(0), '#FF671F');
  assert.equal(seriesColor(CHART_PALETTE.length), '#FF671F');
});

test('areaFill: gradient sized to the plot area; flat colour before layout', () => {
  const stops = [];
  const chart = { chartArea: { top: 10, bottom: 110 }, ctx: { createLinearGradient: (x0, y0, x1, y1) => { stops.push([y0, y1]); return { addColorStop: (o, c) => stops.push([o, c]) }; } } };
  areaFill('#FF671F', 0.3)({ chart });
  assert.deepEqual(stops, [[10, 110], [0, 'rgba(255,103,31,0.3)'], [1, 'rgba(255,103,31,0)']]);
  assert.equal(areaFill('#FF671F', 0.3)({ chart: {} }), 'rgba(255,103,31,0.15)');
});

test('lineSeries: fill uses the gradient, dashed adds a dash', () => {
  const s = lineSeries(LIGHT, { color: '#6366f1', fill: true, dashed: true, label: 'x' });
  assert.equal(s.fill, true);
  assert.equal(typeof s.backgroundColor, 'function');
  assert.deepEqual(s.borderDash, [5, 4]);
  assert.equal(s.label, 'x');
});

test('crosshairPlugin: draws one dashed line at the hovered x only', () => {
  const calls = [];
  const c = { save() {}, restore() {}, beginPath() {}, setLineDash(d) { calls.push(['dash', d]); }, moveTo(x, y) { calls.push(['move', x, y]); }, lineTo(x, y) { calls.push(['line', x, y]); }, stroke() { calls.push(['stroke']); } };
  const p = crosshairPlugin(LIGHT);
  p.afterDatasetsDraw({ ctx: c, chartArea: { top: 0, bottom: 50 }, tooltip: { getActiveElements: () => [] } });
  assert.equal(calls.length, 0);
  p.afterDatasetsDraw({ ctx: c, chartArea: { top: 0, bottom: 50 }, tooltip: { getActiveElements: () => [{ element: { x: 20 } }] } });
  assert.deepEqual(calls.filter(k => k[0] !== 'dash'), [['move', 20, 0], ['line', 20, 50], ['stroke']]);
});

test('smoothPath: passes through every point and never overshoots a flat step', () => {
  assert.equal(smoothPath([]), '');
  assert.equal(smoothPath([{ x: 0, y: 5 }]), 'M0,5');
  const d = smoothPath([{ x: 0, y: 10 }, { x: 10, y: 10 }, { x: 20, y: 0 }]);
  assert.match(d, /^M0,10 C/);
  assert.match(d, / 10,10 C/);
  assert.match(d, / 20,0$/);
  // flat first segment: both control points stay at y=10 (no bulge above/below)
  const firstCurve = d.split(' C')[1].split(' ');
  assert.equal(firstCurve[0].split(',')[1], '10');
});

test('roundedTopBar: rounded top, flat bottom; radius never exceeds half the width or the height', () => {
  assert.equal(roundedTopBar(0, 0, 0, 10), '');
  assert.equal(roundedTopBar(0, 90, 20, 10, 5), 'M0,100 V95 Q0,90 5,90 H15 Q20,90 20,95 V100 Z');
  assert.match(roundedTopBar(0, 98, 20, 2, 5), /^M0,100 V100 Q0,98 2,98/); // radius clamped to the 2px height
});
