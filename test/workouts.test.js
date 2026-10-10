import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseWorkoutText, parseZwo, totalDuration, stepAt, targetFraction, BUILT_IN_WORKOUTS, formatDuration } from '../js/workouts.js';

test('durations', () => {
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('1h'), 3600);
  assert.equal(parseDuration('1m30s'), 90);
  assert.equal(parseDuration('90sec'), 90);
  assert.equal(parseDuration('2:30'), 150);
  assert.equal(parseDuration('5'), 300);
  assert.throws(() => parseDuration('abc'));
});

test('text workouts with repeats, ramps, free ride and labels', () => {
  const steps = parseWorkoutText(`# warm
10m 45-75% Warm up
2x 3m 110% VO2, 2m 50%
5m free`);
  assert.equal(steps.length, 6);
  assert.deepEqual(steps[0], { type: 'ramp', duration: 600, from: 0.45, to: 0.75, label: 'Warm up' });
  assert.deepEqual(steps[1], { type: 'steady', duration: 180, power: 1.1, label: 'VO2' });
  assert.deepEqual(steps[4], { type: 'steady', duration: 120, power: 0.5, label: undefined });
  assert.equal(steps[5].type, 'free');
});

test('text workout errors name the line', () => {
  assert.throws(() => parseWorkoutText('10m 50%\n5m hard'), /Line 2/);
  assert.throws(() => parseWorkoutText('# nothing'), /no steps/);
});

test('stepAt and ramp targets', () => {
  const workout = { steps: parseWorkoutText('100s 40-60%\n50s 100%') };
  assert.equal(totalDuration(workout), 150);
  const mid = stepAt(workout, 50);
  assert.equal(mid.index, 0);
  assert.ok(Math.abs(targetFraction(mid.step, mid.stepElapsed) - 0.5) < 1e-9);
  const second = stepAt(workout, 100);
  assert.equal(second.index, 1);
  assert.equal(second.stepRemaining, 50);
  assert.equal(stepAt(workout, 150), null);
});

test('zwo import', () => {
  const xml = `<workout_file>
    <name>Test &amp; Go</name>
    <description>Fun</description>
    <workout>
      <Warmup Duration="600" PowerLow="0.25" PowerHigh="0.75"/>
      <SteadyState Duration="300" Power="0.88"><textevent timeoffset="10" message="hi"/></SteadyState>
      <IntervalsT Repeat="3" OnDuration="60" OffDuration="30" OnPower="1.2" OffPower="0.5"/>
      <FreeRide Duration="120" FlatRoad="1"/>
      <Cooldown Duration="300" PowerLow="0.7" PowerHigh="0.4"/>
    </workout>
  </workout_file>`;
  const w = parseZwo(xml);
  assert.equal(w.name, 'Test & Go');
  assert.equal(w.description, 'Fun');
  assert.equal(w.steps.length, 1 + 1 + 6 + 1 + 1);
  assert.deepEqual(w.steps[0], { type: 'ramp', duration: 600, from: 0.25, to: 0.75 });
  assert.deepEqual(w.steps[2], { type: 'steady', duration: 60, power: 1.2 });
  assert.equal(w.steps.at(-1).to, 0.4);
  assert.throws(() => parseZwo('<workout_file></workout_file>'));
});

test('built-ins parse and are sensible lengths', () => {
  assert.ok(BUILT_IN_WORKOUTS.length >= 5);
  for (const w of BUILT_IN_WORKOUTS) {
    const minutes = totalDuration(w) / 60;
    assert.ok(minutes >= 20 && minutes <= 90, `${w.name}: ${minutes} min`);
  }
});

test('formatDuration', () => {
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(3725), '1:02:05');
});
