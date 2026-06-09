// src/impact.mjs — Impact Radar math engine. Pure: no DOM, no fetch, no globals.

const EARTH_RADIUS_MI = 3958.7613; // mean Earth radius in miles

/**
 * Great-circle distance between two {lat,lng} points, in miles.
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} miles
 */
export function haversineMiles(a, b) {
  if (!a || !b) return NaN;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.min(1, Math.sqrt(h)));
}
