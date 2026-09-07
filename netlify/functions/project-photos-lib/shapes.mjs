// shapes.mjs — pure helpers for the project-photo-gallery feature. No I/O —
// safe to unit test. Consumed by netlify/functions/project-photos.mjs.

export const PROJECT_GALLERY_ROLES = ['construction', 'executive', 'it'];

export function canAccessProjectGallery(userType) {
  return PROJECT_GALLERY_ROLES.includes(userType);
}

// Migration is exec/IT only — construction can capture/annotate but not
// trigger a bulk import of historical Daily Report photos.
export function canMigrate(userType) {
  return userType === 'executive' || userType === 'it';
}

// Stable, idempotency-key-safe identifier for one Daily Report photo, so
// re-running a migration never creates a duplicate row for the same photo
// (paired with a unique index on source_ref in Postgres).
export function computeSourceRef(reportId, workLogIdx, photoIdx) {
  return `dr_${reportId}_${workLogIdx}_${photoIdx}`;
}

// Fixed annotation palette — red default (measurements/flagged issues want
// high visibility), amber/blue/green as alternates. A color outside this set
// is rejected by isValidShape, not silently allowed through to storage.
export const SHAPE_COLORS = ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e'];

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Coordinates are fractions of the photo's natural width/height (line) or
// width/height separately (circle's cx/rx vs cy/ry) — see the design spec's
// "Coordinate system" section for why a circle is an ellipse under the hood.
export function isValidShape(shape) {
  if (!shape || typeof shape !== 'object') return false;
  if (!SHAPE_COLORS.includes(shape.color)) return false;
  if (shape.type === 'line') {
    return isFiniteNum(shape.x1) && isFiniteNum(shape.y1) && isFiniteNum(shape.x2) && isFiniteNum(shape.y2);
  }
  if (shape.type === 'circle') {
    return isFiniteNum(shape.cx) && isFiniteNum(shape.cy) && isFiniteNum(shape.rx) && isFiniteNum(shape.ry)
      && shape.rx > 0 && shape.ry > 0;
  }
  return false;
}

// Rebuilds each valid shape from ONLY its known fields (drops anything else
// a tampered/buggy client sent) and drops invalid entries entirely — this is
// what the backend's saveAnnotations action runs before persisting.
export function sanitizeAnnotations(rawArray) {
  if (!Array.isArray(rawArray)) return [];
  return rawArray.filter(isValidShape).map((s) => {
    if (s.type === 'line') return { id: s.id, type: 'line', x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, color: s.color };
    return { id: s.id, type: 'circle', cx: s.cx, cy: s.cy, rx: s.rx, ry: s.ry, color: s.color };
  });
}
