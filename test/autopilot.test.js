import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HrAutopilot, autopilotDefaults } from '../js/core/autopilot.js';
import { rampTestWorkout, ftpFromRamp, bestAverage, RampFailureDetector } from '../js/core/rampTest.js';
import * as U from '../js/core/units.js';
import { totalDuration } from '../js/workouts.js';

// First-order HR model: steady HR = base + k·W, 45 s time constant, plus slow drift.
// Defaults put zone 2 (~135 bpm) at ~120 W, about 75% of a 161 W FTP.
function simulate(pilot, seconds, { drift = 0, base = 70, k = 0.55 } = {}) {
  let hr = 70;
  const trace = [];
  for (let t = 0; t < seconds; t++) {
    const w = pilot.update(1, hr);
    const steady = base + k * w + drift * t;
    hr += (steady - hr) / 45;
    trace.push({ t, w, hr });
  }
  return trace;
}

test('settles heart rate inside zone 2 and stays there', () => {
  const pilot = new HrAutopilot(autopilotDefaults({ ftp: 161, zoneMin: 122, zoneMax: 151 }));
  const trace = simulate(pilot, 3600);
  const late = trace.slice(900);
  assert.ok(late.every((s) => s.hr >= 122 && s.hr <= 151), 'HR left zone after settling');
  const avg = late.reduce((a, s) => a + s.hr, 0) / late.length;
  assert.ok(Math.abs(avg - pilot.targetHr) < 4, `avg ${avg} vs target ${pilot.targetHr}`);
  // never overshoots badly on the way in
  assert.ok(Math.max(...trace.map((s) => s.hr)) < 151 + 2);
});

test('cardiac drift slowly lowers power', () => {
  const pilot = new HrAutopilot(autopilotDefaults({ ftp: 200 }));
  const trace = simulate(pilot, 5400, { drift: 0.004 });
  const powerAt = (t) => trace[t].w;
  assert.ok(powerAt(5300) < powerAt(1500) - 5, `${powerAt(1500)} -> ${powerAt(5300)}`);
  assert.ok(trace.slice(1200).every((s) => s.hr <= 151));
});

test('holds power when HR drops out and respects limits', () => {
  const pilot = new HrAutopilot({ targetHr: 135, startWatts: 120, minWatts: 80, maxWatts: 150 });
  for (let i = 0; i < 60; i++) pilot.update(1, 135);
  const before = pilot.watts;
  for (let i = 0; i < 60; i++) pilot.update(1, null);
  assert.equal(pilot.status, 'no-hr');
  assert.equal(pilot.watts, before);
  for (let i = 0; i < 600; i++) pilot.update(1, 90); // way below target
  assert.equal(pilot.watts, 150);
  pilot.nudgeTarget(100);
  assert.ok(pilot.targetHr <= pilot.zoneMax - 2);
});

test('ramp test: workout shape and FTP estimate', () => {
  const w = rampTestWorkout(161);
  assert.equal(w.rampStartW, 80);
  assert.equal(w.rampStepW, 10);
  assert.ok(totalDuration(w) > 30 * 60);
  // 5 min warmup, then 15 one-minute steps from 200 W in 20 W increments
  const powers = [...Array(300).fill(120)];
  for (let i = 0; i < 15; i++) powers.push(...Array(60).fill(200 + 20 * i));
  assert.equal(bestAverage(powers, 60), 480);
  assert.equal(ftpFromRamp(powers), 360);
  assert.equal(ftpFromRamp([100, 200]), null);
  const d = new RampFailureDetector({ seconds: 3 });
  assert.equal(d.update(40, false), false);
  assert.equal([d.update(50, true), d.update(50, true), d.update(50, true)].at(-1), true);
});

test('imperial and metric formatting', () => {
  assert.deepEqual(U.speed(8.9408, 'imperial'), { value: '20.0', unit: 'mph' });
  assert.deepEqual(U.speed(10, 'metric'), { value: '36.0', unit: 'km/h' });
  assert.deepEqual(U.distance(16093.44, 'imperial'), { value: '10.0', unit: 'mi' });
  assert.deepEqual(U.elevation(1000, 'imperial'), { value: '3,281', unit: 'ft' });
  assert.deepEqual(U.weight(72.5748, 'imperial'), { value: '160', unit: 'lb' });
  assert.ok(Math.abs(U.parseWeight(160, 'imperial') - 72.5748) < 0.001);
  assert.equal(U.fmt(U.speed(null, 'imperial')), '-- mph');
});
