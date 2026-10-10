import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoute, routeFromGpx, pchip, STEP_M, haversine } from '../js/core/route.js';

const alpe = {
  id: 'test-climb',
  name: 'Test Climb',
  resolutionM: 500,
  startElevationM: 720,
  gradientsPct: [8, 10, 9, 7, 8.5, 11, 6, 9],
  turns: [{ atKm: 1.2, kind: 'hairpin', direction: 'left' }, { atKm: 2.1, kind: 'hairpin', direction: 'right' }],
};

test('PCHIP passes through points without overshoot', () => {
  const f = pchip([0, 1, 2, 3], [0, 1, 1, 2]);
  assert.equal(f(1), 1);
  for (let x = 1; x <= 2; x += 0.05) assert.ok(f(x) >= 1 - 1e-9 && f(x) <= 1 + 1e-9);
});

test('built climb keeps the published segment gradients and total gain', () => {
  const r = buildRoute(alpe);
  assert.equal(r.length, 4000);
  for (let i = 0; i < alpe.gradientsPct.length; i++) {
    const rise = r.elevationAt((i + 1) * 500) - r.elevationAt(i * 500);
    assert.ok(Math.abs(rise / 5 - alpe.gradientsPct[i]) < 0.01, `segment ${i}`);
  }
  const expectedGain = alpe.gradientsPct.reduce((s, g) => s + g * 5, 0);
  assert.ok(Math.abs(r.maxElevation - 720 - expectedGain) < 2);
  // smooth: no gradient jump bigger than 1.5% per 5 m sample
  let prev = r.gradeAt(5);
  for (let d = 10; d < r.length - 5; d += STEP_M) {
    const g = r.gradeAt(d);
    assert.ok(Math.abs(g - prev) < 1.5, `jump at ${d}: ${prev} -> ${g}`);
    prev = g;
  }
});

test('out-and-back: climb up, then descend with negative grade', () => {
  const r = buildRoute(alpe);
  assert.equal(r.lapLength, 8000);
  const up = r.stateAt(1000);
  const down = r.stateAt(7000);
  assert.equal(up.direction, 1);
  assert.equal(down.direction, -1);
  assert.ok(Math.abs(up.d - down.d) < 1e-9);
  assert.ok(Math.abs(up.grade + down.grade) < 1e-9);
  assert.ok(up.grade > 0 && down.grade < 0);
  assert.ok(Math.abs(Math.abs(up.heading - down.heading) - Math.PI) < 1e-6);
  assert.equal(r.stateAt(8500).lap, 1);
});

test('hairpins turn the road around', () => {
  const r = buildRoute({ ...alpe, turns: [{ atKm: 1, kind: 'hairpin', direction: 'left' }] });
  const before = r.stateAt(900).heading;
  const after = r.stateAt(1100).heading;
  let diff = Math.abs(after - before);
  if (diff > Math.PI) diff = 2 * Math.PI - diff;
  assert.ok(diff > 2.6, `turned ${diff}`);
});

test('loop routes close in position and elevation', () => {
  const r = buildRoute({ id: 'loop', name: 'Loop', loop: true, resolutionM: 250, startElevationM: 10, gradientsPct: [1, 2, -1, -2, 3, 0, -1, 1, 0.5, -0.5] });
  const n = r.x.length - 1;
  assert.ok(Math.hypot(r.x[n] - r.x[0], r.z[n] - r.z[0]) < 2 * STEP_M);
  assert.ok(Math.abs(r.elevation[n] - r.elevation[0]) < 1e-9);
  assert.equal(r.lapLength, r.length);
  assert.equal(r.stateAt(r.length + 100).direction, 1);
  // path length matches
  let len = 0;
  for (let i = 1; i <= n; i++) len += Math.hypot(r.x[i] - r.x[i - 1], r.z[i] - r.z[i - 1]);
  assert.ok(Math.abs(len - r.length) / r.length < 0.01);
});

test('profileAhead follows riding order', () => {
  const r = buildRoute(alpe);
  const p = r.profileAhead(3500, 1000, 10);
  assert.equal(p.length, 11);
  assert.ok(p[5].elevation > p[0].elevation); // still climbing to 4000
  assert.ok(p[10].elevation < p[5].elevation); // descending after the summit
});

test('GPX import with noisy elevation', () => {
  const pts = [];
  for (let i = 0; i <= 200; i++) {
    const lat = 37.9 + i * 0.0001; // ~11 m apart
    const ele = 100 + i * 0.55 + (i % 2 ? 1.5 : -1.5); // ~5% with GPS noise
    pts.push(`<trkpt lat="${lat}" lon="-122.6"><ele>${ele}</ele></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx><trk><name>Test Hill</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  const r = routeFromGpx(gpx);
  assert.equal(r.name, 'Test Hill');
  assert.ok(Math.abs(r.length - haversine(37.9, -122.6, 37.92, -122.6)) < 5);
  const g = r.gradeAt(r.length / 2);
  assert.ok(g > 4 && g < 6, `grade ${g}`);
  assert.equal(r.loop, false);
  const s = r.stateAt(100);
  assert.ok(Math.abs(s.lon + 122.6) < 1e-9 && s.lat > 37.9);
  assert.throws(() => routeFromGpx('<gpx></gpx>'));
});
