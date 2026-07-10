// scoring.js — pure audit scoring math. See spec §5.
function bandFor(score) {
  if (score >= 90) return 'excellent';
  if (score >= 80) return 'pass';
  if (score >= 70) return 'needs_improvement';
  return 'fail';
}

function computeScore(template, results) {
  const sectionScores = {};
  let cappedByCritical = false;
  const scored = []; // { id, weight, pct }
  for (const s of template.sections) {
    let earned = 0, possible = 0;
    for (const i of s.items) {
      const r = results[i.id] || 'fail'; // unanswered = fail
      if (r === 'na') continue;
      possible += i.points;
      if (r === 'pass') earned += i.points;
      else if (i.critical) cappedByCritical = true;
    }
    if (possible === 0) { sectionScores[s.id] = null; continue; }
    const pct = (earned / possible) * 100;
    sectionScores[s.id] = Math.round(pct * 10) / 10;
    scored.push({ id: s.id, weight: s.weight, pct });
  }
  const weightSum = scored.reduce((a, x) => a + x.weight, 0) || 1;
  let score = scored.reduce((a, x) => a + x.pct * (x.weight / weightSum), 0);
  score = Math.round(score * 10) / 10;
  if (cappedByCritical) score = Math.min(score, 69);
  return { score, sectionScores, cappedByCritical, band: bandFor(score) };
}
module.exports = { computeScore, bandFor };
