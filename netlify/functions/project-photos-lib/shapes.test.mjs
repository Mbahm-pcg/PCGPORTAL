import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_GALLERY_ROLES,
  canAccessProjectGallery,
  canMigrate,
  computeSourceRef,
  SHAPE_COLORS,
  isValidShape,
  sanitizeAnnotations,
} from './shapes.mjs';

test('PROJECT_GALLERY_ROLES: exact 3-role list', () => {
  assert.deepEqual(PROJECT_GALLERY_ROLES, ['construction', 'executive', 'it']);
});

test('canAccessProjectGallery: true for construction/executive/it', () => {
  assert.equal(canAccessProjectGallery('construction'), true);
  assert.equal(canAccessProjectGallery('executive'), true);
  assert.equal(canAccessProjectGallery('it'), true);
});

test('canAccessProjectGallery: false for office_staff/dm/manager/vendor/maintenance', () => {
  assert.equal(canAccessProjectGallery('office_staff'), false);
  assert.equal(canAccessProjectGallery('dm'), false);
  assert.equal(canAccessProjectGallery('manager'), false);
  assert.equal(canAccessProjectGallery('vendor'), false);
  assert.equal(canAccessProjectGallery('maintenance'), false);
});

test('canMigrate: true only for executive/it, false for construction', () => {
  assert.equal(canMigrate('executive'), true);
  assert.equal(canMigrate('it'), true);
  assert.equal(canMigrate('construction'), false);
});

test('computeSourceRef: exact stable format', () => {
  assert.equal(computeSourceRef(1725, 0, 2), 'dr_1725_0_2');
  assert.equal(computeSourceRef('abc', 3, 0), 'dr_abc_3_0');
});

test('SHAPE_COLORS: exact fixed 4-color palette', () => {
  assert.deepEqual(SHAPE_COLORS, ['#ef4444', '#f59e0b', '#3b82f6', '#22c55e']);
});

test('isValidShape: a well-formed line is valid', () => {
  assert.equal(isValidShape({ id: 's1', type: 'line', x1: 0.1, y1: 0.2, x2: 0.8, y2: 0.9, color: '#ef4444' }), true);
});

test('isValidShape: a well-formed circle (ellipse) is valid', () => {
  assert.equal(isValidShape({ id: 's2', type: 'circle', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.15, color: '#3b82f6' }), true);
});

test('isValidShape: false for unknown type', () => {
  assert.equal(isValidShape({ id: 's3', type: 'rectangle', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' }), false);
});

test('isValidShape: false for non-finite coordinates (NaN/Infinity)', () => {
  assert.equal(isValidShape({ id: 's4', type: 'line', x1: NaN, y1: 0.2, x2: 0.8, y2: 0.9, color: '#ef4444' }), false);
  assert.equal(isValidShape({ id: 's5', type: 'line', x1: 0.1, y1: 0.2, x2: Infinity, y2: 0.9, color: '#ef4444' }), false);
});

test('isValidShape: false for a circle with non-positive radius', () => {
  assert.equal(isValidShape({ id: 's6', type: 'circle', cx: 0.5, cy: 0.5, rx: 0, ry: 0.1, color: '#ef4444' }), false);
  assert.equal(isValidShape({ id: 's7', type: 'circle', cx: 0.5, cy: 0.5, rx: 0.1, ry: -0.1, color: '#ef4444' }), false);
});

test('isValidShape: false for a color not in SHAPE_COLORS', () => {
  assert.equal(isValidShape({ id: 's8', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#000000' }), false);
});

test('isValidShape: false for missing/non-object input', () => {
  assert.equal(isValidShape(null), false);
  assert.equal(isValidShape(undefined), false);
  assert.equal(isValidShape('not a shape'), false);
});

test('sanitizeAnnotations: drops invalid entries, keeps valid ones', () => {
  const raw = [
    { id: 'a', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' },
    { id: 'b', type: 'bogus', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' },
    { id: 'c', type: 'circle', cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.1, color: '#22c55e' },
  ];
  const cleaned = sanitizeAnnotations(raw);
  assert.equal(cleaned.length, 2);
  assert.deepEqual(cleaned.map(s => s.id), ['a', 'c']);
});

test('sanitizeAnnotations: strips unknown extra fields from a valid shape', () => {
  const raw = [{ id: 'a', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444', evilPayload: '<script>' }];
  const cleaned = sanitizeAnnotations(raw);
  assert.deepEqual(cleaned, [{ id: 'a', type: 'line', x1: 0, y1: 0, x2: 1, y2: 1, color: '#ef4444' }]);
});

test('sanitizeAnnotations: non-array input returns an empty array', () => {
  assert.deepEqual(sanitizeAnnotations(null), []);
  assert.deepEqual(sanitizeAnnotations('not an array'), []);
});
