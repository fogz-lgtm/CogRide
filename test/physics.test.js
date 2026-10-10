import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RiderPhysics, estimateCdA } from '../js/core/physics.js';

const kmh = (mps) => mps * 3.6;
// Zwift Insider bot: 75 kg, 183 cm, Zwift Carbon frame + 32mm carbon wheels.
const bot = () => new RiderPhysics({ riderKg: 75, heightCm: 183, bikeKg: 7.4 });

test('CdA matches Zwift for the reference rider', () => {
  assert.ok(Math.abs(estimateCdA(183, 75) - 0.3155) < 0.002, estimateCdA(183, 75));
  assert.ok(estimateCdA(183, 90) > estimateCdA(183, 75));
  assert.ok(estimateCdA(153, 75) < estimateCdA(193, 75));
});

test('steady speeds within 2.5% of Zwift Insider bot tests', () => {
  const p = bot();
  const cases = [
    [300, 0, 39.57],
    [150, 0, 30.55],
    [300, 0.0835, 14.81],
    [150, 0.0835, 7.7],
  ];
  for (const [watts, grade, expected] of cases) {
    const got = kmh(p.steadySpeed(watts, grade));
    assert.ok(Math.abs(got - expected) / expected < 0.025, `${watts} W @ ${grade}: ${got.toFixed(2)} vs ${expected}`);
  }
});

test('momentum: accelerates toward steady speed, coasts down slowly', () => {
  const p = bot();
  for (let t = 0; t < 120; t++) p.step(1, 200, 0);
  const steady = p.steadySpeed(200, 0);
  assert.ok(Math.abs(p.speed - steady) < 0.05, `${p.speed} vs ${steady}`);
  const before = p.speed;
  p.step(5, 0, 0); // stop pedalling for 5 s
  assert.ok(p.speed < before && p.speed > before * 0.75, `coasted to ${p.speed}`);
  // Descents build speed without pedalling
  const d = bot();
  for (let t = 0; t < 120; t++) d.step(1, 0, -0.06);
  assert.ok(kmh(d.speed) > 45, `descent ${kmh(d.speed)}`);
  // Steep climb with no power stalls rather than rolling backwards
  const c = bot();
  c.speed = 3;
  for (let t = 0; t < 30; t++) c.step(1, 0, 0.12);
  assert.equal(c.speed, 0);
});

test('distance integrates speed', () => {
  const p = bot();
  p.speed = 10;
  const start = p.distance;
  p.step(1, p.powerFor(10, 0), 0);
  assert.ok(Math.abs(p.distance - start - 10) < 0.05);
});
