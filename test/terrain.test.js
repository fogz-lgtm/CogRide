import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoadIndex, makeHeightField, valueNoise, fbm } from '../js/world/terrain.js';
import { buildRoute } from '../js/core/route.js';

const route = buildRoute({
  id: 'switchbacks',
  name: 'Switchbacks',
  resolutionM: 500,
  startElevationM: 700,
  gradientsPct: [8, 8, 8, 8, 8, 8],
  turns: [{ atKm: 1.5, kind: 'hairpin', direction: 'right', angleDeg: 180 }],
  wander: 0.3,
});

test('noise is deterministic and bounded', () => {
  assert.equal(valueNoise(1.3, 2.7, 5), valueNoise(1.3, 2.7, 5));
  for (let i = 0; i < 200; i++) {
    const v = fbm(i * 0.37, i * 0.11, 3);
    assert.ok(v >= -1 && v <= 1);
  }
});

test('road sits on the terrain and terrain is smooth across switchbacks', () => {
  const index = new RoadIndex(route);
  const h = makeHeightField(index);
  // On the centreline the ground is within ~0.5 m of the road
  for (let d = 0; d < route.length; d += 97) {
    const s = route.stateAt(d);
    const ground = h(s.x, s.z);
    assert.ok(Math.abs(ground - s.elevation) < 0.6, `at ${d}: ground ${ground} road ${s.elevation}`);
  }
  // Walking across the slope between the two legs: no cliffs
  const s = route.stateAt(1300);
  const nx = Math.cos(s.heading);
  const nz = -Math.sin(s.heading);
  let prev = h(s.x, s.z);
  for (let t = 1; t <= 200; t++) {
    const y = h(s.x + nx * t, s.z + nz * t);
    assert.ok(Math.abs(y - prev) < 2, `step ${t}: ${prev} -> ${y}`);
    prev = y;
  }
  assert.ok(index.nearest(s.x, s.z).distance < 15);
});

test('nearest finds the right leg when roads pass close together', () => {
  const zig = buildRoute({
    id: 'zig', name: 'Zig', resolutionM: 500, startElevationM: 700, gradientsPct: [8, 8, 8, 8, 8, 8],
    turns: [1, 1.6, 2.2, 2.8].map((atKm, i) => ({ atKm, kind: 'hairpin', direction: i % 2 ? 'left' : 'right' })),
  });
  const index = new RoadIndex(zig);
  for (let d = 50; d < zig.length; d += 53) {
    const s = zig.stateAt(d);
    const n = index.nearest(s.x, s.z);
    assert.ok(n.distance < 0.5, `at ${d}: ${n.distance}`);
  }
});
