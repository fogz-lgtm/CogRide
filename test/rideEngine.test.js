import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RideEngine } from '../js/engine/rideEngine.js';
import { SimulatedTrainer } from '../js/devices/simulator.js';
import { buildRoute } from '../js/core/route.js';
import { parseWorkoutText } from '../js/workouts.js';
import { encodeActivity } from '../js/core/fit.js';
import { Decoder, Stream } from '@garmin/fitsdk';

function rig({ settings = {}, effort = 180 } = {}) {
  let now = Date.UTC(2026, 9, 10, 4, 0, 0);
  const engine = new RideEngine({ settings: { ftp: 161, riderKg: 72.6, bikeKg: 8, heightCm: 178, ...settings }, clock: () => now });
  const sim = new SimulatedTrainer({ effortWatts: effort, autoStart: false, random: () => 0.5 });
  engine.setTrainer(sim);
  const events = [];
  for (const type of ['shift', 'limit', 'bias', 'interval', 'countdown', 'workout-complete', 'bailout', 'summit', 'lap', 'fuel', 'autopilot-target']) {
    engine.addEventListener(type, (e) => events.push([type, e.detail]));
  }
  const run = (seconds) => {
    for (let i = 0; i < seconds * 4; i++) {
      now += 250;
      sim.step(0.25);
      engine.tick(0.25);
    }
  };
  return { engine, sim, events, run, advanceClock: (ms) => (now += ms) };
}

const climb = () => buildRoute({ id: 'test-climb', name: 'Test Climb', resolutionM: 500, startElevationM: 100, gradientsPct: [5, 6, 7, 8] });
const flatLoop = () => buildRoute({ id: 'flat', name: 'Flat', loop: true, resolutionM: 250, startElevationM: 10, gradientsPct: [0, 0, 0, 0, 0, 0, 0, 0] });

test('rides a route: physics moves, climb accumulates, trainer gets felt grade + gear', () => {
  const { engine, sim, run } = rig();
  engine.setRoute(climb());
  engine.start();
  run(120);
  const s = engine.snapshot();
  assert.ok(s.distance > 200, `distance ${s.distance}`);
  assert.ok(s.climbed > 10, `climbed ${s.climbed}`);
  assert.equal(sim.target.mode, 'sim');
  assert.equal(sim.target.gear, 8);
  // felt grade = half the road grade (Zwift default difficulty 50%)
  assert.ok(Math.abs(sim.target.gradePct - s.grade / 2) < 0.6, `${sim.target.gradePct} vs ${s.grade}`);
  assert.ok(engine.samples.length >= 100);
  assert.ok(engine.samples.every((x) => x.lat != null && x.lon != null));
});

test('shifting changes gear, clamps at the ends', () => {
  const { engine, sim, events, run } = rig();
  engine.setRoute(flatLoop());
  engine.start();
  run(5);
  engine.shift(1);
  assert.equal(engine.gear, 9);
  assert.equal(sim.target.gear, 9);
  for (let i = 0; i < 30; i++) engine.shift(1);
  assert.equal(engine.gear, 24);
  assert.ok(events.some(([t]) => t === 'limit'));
  for (let i = 0; i < 30; i++) engine.shift(-1);
  assert.equal(engine.gear, 1);
});

test('ERG workout: targets, Click bias ±1% FTP, intervals, countdown, completion', () => {
  const { engine, sim, events, run } = rig();
  engine.setRoute(flatLoop());
  engine.setWorkout({ id: 'w', name: 'Test', steps: parseWorkoutText('30s 50%\n30s 100%\n10s free') });
  engine.start();
  run(5);
  assert.equal(engine.mode, 'erg');
  assert.equal(sim.target.mode, 'erg');
  assert.equal(sim.target.watts, Math.round(161 * 0.5));
  engine.shift(1);
  engine.shift(1);
  assert.ok(Math.abs(engine.bias - 0.02) < 1e-9);
  assert.equal(sim.target.watts, Math.round(161 * 0.52));
  run(30);
  assert.ok(events.some(([t, d]) => t === 'interval' && d.index === 1));
  assert.deepEqual(events.filter(([t]) => t === 'countdown').map(([, d]) => d.secondsLeft).slice(0, 3), [3, 2, 1]);
  run(30);
  assert.equal(engine.mode, 'sim'); // free-ride block → gears
  run(15);
  assert.ok(events.some(([t]) => t === 'workout-complete'));
});

test('ERG bailout when you stop pedalling, re-engages at target', () => {
  const { engine, sim, events, run } = rig();
  engine.setRoute(flatLoop());
  engine.setWorkout({ id: 'w', name: 'Test', steps: parseWorkoutText('10m 80%') });
  engine.start();
  run(20);
  sim.setEffort(0);
  // the pretend trainer would keep "making" ERG power; emulate a stalled rider
  sim.step = function (dt) {
    this.cadence = 0;
    this.power = 0;
    this.dispatchEvent(new CustomEvent('data', { detail: { power: 0, cadence: 0 } }));
  };
  run(6);
  assert.equal(engine.mode, 'bailout');
  assert.equal(sim.target.mode, 'sim');
  assert.ok(events.some(([t, d]) => t === 'bailout' && d.active));
  sim.step = function () {
    this.dispatchEvent(new CustomEvent('data', { detail: { power: 130, cadence: 85 } }));
  };
  run(7);
  assert.equal(engine.mode, 'erg');
});

test('Zone 2 autopilot drives ERG from heart rate', () => {
  const { engine, sim, run } = rig();
  engine.setRoute(flatLoop());
  engine.setAutopilot({ targetHr: 135, zoneMin: 122, zoneMax: 151, startWatts: 90, minWatts: 50, maxWatts: 140 });
  engine.start();
  run(600);
  const s = engine.snapshot();
  assert.equal(s.mode, 'autopilot');
  assert.equal(sim.target.mode, 'erg');
  assert.ok(s.heartRate > 120 && s.heartRate < 151, `hr ${s.heartRate}`);
  engine.shift(1);
  assert.equal(s.autopilot.targetHr + 2, engine.snapshot().autopilot.targetHr);
});

test('summit on an out-and-back climb, and a valid FIT at the end', () => {
  const { engine, events, run } = rig({ effort: 300 });
  engine.setRoute(buildRoute({ id: 'short', name: 'Short', resolutionM: 200, startElevationM: 0, gradientsPct: [3] }));
  engine.start();
  run(90);
  assert.ok(events.some(([t]) => t === 'summit'));
  const ride = engine.finish();
  assert.ok(ride.summary.durationS > 60);
  const fit = encodeActivity(ride.samples, { summary: ride.summary, ftp: 161 });
  const decoder = new Decoder(Stream.fromByteArray(Array.from(fit)));
  assert.ok(decoder.checkIntegrity());
  const { messages, errors } = decoder.read();
  assert.deepEqual(errors, []);
  assert.equal(messages.recordMesgs.length, ride.samples.length);
});

test('pausing stops the clock and recording; fuel reminders fire', () => {
  const { engine, events, run } = rig({ settings: { fuelEveryMin: 1 } });
  engine.setRoute(flatLoop());
  engine.start();
  run(70);
  assert.ok(events.some(([t]) => t === 'fuel'));
  const n = engine.samples.length;
  engine.pause();
  run(30);
  assert.equal(engine.samples.length, n);
  engine.resume();
  run(5);
  assert.ok(engine.samples.length > n);
});
