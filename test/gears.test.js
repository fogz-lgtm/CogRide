import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEAR_RATIOS, gearTargetPower, powerForSpeed, speedForPower, virtualSpeed, clampGear } from '../js/gears.js';

test('24 increasing gears', () => {
  assert.equal(GEAR_RATIOS.length, 24);
  for (let i = 1; i < GEAR_RATIOS.length; i++) assert.ok(GEAR_RATIOS[i] > GEAR_RATIOS[i - 1]);
  assert.equal(clampGear(-3), 0);
  assert.equal(clampGear(99), 23);
});

test('realistic power at 90 rpm in a middle gear on the flat', () => {
  const w = gearTargetPower(90, 11, { massKg: 80, grade: 0 });
  assert.ok(w > 90 && w < 160, `got ${w}`);
});

test('harder gear, higher cadence and climbing all cost more', () => {
  const base = gearTargetPower(85, 10);
  assert.ok(gearTargetPower(85, 11) > base);
  assert.ok(gearTargetPower(95, 10) > base);
  assert.ok(gearTargetPower(85, 10, { grade: 0.06 }) > base);
  assert.equal(gearTargetPower(0, 10), 0);
});

test('descending can need zero power', () => {
  assert.equal(powerForSpeed(5, { grade: -0.08 }), 0);
});

test('speedForPower inverts powerForSpeed', () => {
  const v = speedForPower(220, { massKg: 80 });
  assert.ok(Math.abs(powerForSpeed(v, { massKg: 80 }) - 220) < 0.5);
  assert.equal(speedForPower(0), 0);
  assert.ok(Math.abs(virtualSpeed(60, 1) - 2.105) < 1e-9);
});
