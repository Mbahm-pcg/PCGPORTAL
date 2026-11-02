// office-clock-day-math.mjs — exact worked minutes for one employee's day of punches.
// Pure and zero-dependency so the browser bundle (app.jsx's officeClockDailyHours) and
// the server (office-clock-lib.mjs's dailyHoursFromPunches → the Paycor send) share the
// SAME math and can never disagree about a day's total.
//
// A day may hold several shifts (v22.42: an office worker who covers two locations
// clocks in and out twice). The punches, in time order, must read as a clean sequence
// of shifts: clock_in → (meal_start → meal_end)* → clock_out, repeated. Each shift's
// span minus its meals is added up. Anything else — a missing clock-out, a duplicate
// punch, a meal outside a shift, a zero/negative span — returns null (incomplete),
// never a guessed number, so the send refuses the week instead of underpaying.
export function dayWorkedMinutes(dayPunches) {
  const sorted = [...(dayPunches || [])].sort((a, b) => new Date(a.capturedAt) - new Date(b.capturedAt));
  if (!sorted.length) return null;
  let state = 'out';
  let inMs = 0, mealMs = 0, totalMs = 0;
  for (const p of sorted) {
    const t = new Date(p.capturedAt).getTime();
    if (!Number.isFinite(t)) return null;
    if (state === 'out' && p.punchType === 'clock_in') { state = 'in'; inMs = t; }
    else if (state === 'in' && p.punchType === 'meal_start') { state = 'meal'; mealMs = t; }
    else if (state === 'meal' && p.punchType === 'meal_end') { state = 'in'; totalMs -= (t - mealMs); }
    else if (state === 'in' && p.punchType === 'clock_out') {
      if (t <= inMs) return null;
      state = 'out'; totalMs += (t - inMs);
    }
    else return null;
  }
  if (state !== 'out' || totalMs <= 0) return null;
  return Math.round(totalMs / 60000);
}

// Number of completed clock_in/clock_out shifts in the day (for a "2 shifts" label).
export function dayShiftCount(dayPunches) {
  return (dayPunches || []).filter(p => p.punchType === 'clock_out').length;
}
