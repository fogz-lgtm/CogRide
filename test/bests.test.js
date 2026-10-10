import test from 'node:test';
import assert from 'node:assert/strict';
import { AttemptTracker, timeAt, distanceAt, powerCurve, mergePowerBests, SPLIT_M } from '../js/core/bests.js';
import { aerobicCheck, decouplingVerdict } from '../js/core/aerobic.js';
import { weekSummary, readiness, weekStart } from '../js/core/load.js';
import { buildRoute } from '../js/core/route.js';

const climb = buildRoute({ id: 'c', name: 'C', resolutionM: 500, startElevationM: 100, gradientsPct: [6, 6] }); // 1 km, out and back
const loop = buildRoute({ id: 'l', name: 'L', loop: true, resolutionM: 250, startElevationM: 10, gradientsPct: [0, 0, 0, 0] });

function ride(route, tracker, speed, seconds, t0 = 0, d0 = 0) {
  const events = [];
  for (let i = 0; i <= seconds; i++) {
    const total = d0 + speed * i;
    const e = tracker.update(route.stateAt(total), t0 + i);
    if (e) events.push({ ...e, at: i });
  }
  return events;
}

test('splits interpolate both ways', () => {
  const splits = [0, 10, 20, 40];
  assert.equal(timeAt(splits, 75), 15);
  assert.equal(distanceAt(splits, 15), 75);
  assert.equal(distanceAt(splits, 30), 125);
  assert.equal(distanceAt(splits, 99), 150);
});

test('a climb attempt finishes at the summit and becomes the best', () => {
  const tr = new AttemptTracker(climb);
  const ev = ride(climb, tr, 4, 300);
  const fin = ev.find((e) => e.kind === 'finish');
  assert.ok(fin, 'finished');
  assert.ok(Math.abs(fin.timeS - 250) <= 2, `time ${fin.timeS}`);
  assert.equal(fin.isBest, true);
  assert.equal(tr.best.splits.length, Math.floor(climb.length / SPLIT_M) + 1);
});

test('racing your best: ahead when faster, ghost where the best was', () => {
  const first = new AttemptTracker(climb);
  ride(climb, first, 4, 300);
  const tr = new AttemptTracker(climb, first.best);
  for (let i = 0; i <= 100; i++) tr.update(climb.stateAt(5 * i), i);
  // 500 m in 100 s vs 125 s before: about 25 s ahead.
  const delta = tr.delta(climb.stateAt(500), 100);
  assert.ok(Math.abs(delta - 25) < 2, `delta ${delta}`);
  // The ghost has done 4 m/s × 100 s = 400 m.
  assert.ok(Math.abs(tr.ghostTotal(100) - 400) < 6, `ghost ${tr.ghostTotal(100)}`);
});

test('no attempt when you join mid-road; loops count each lap', () => {
  const mid = new AttemptTracker(climb);
  assert.equal(ride(climb, mid, 4, 50, 0, 300).length, 0);
  const tr = new AttemptTracker(loop);
  const ev = ride(loop, tr, 10, 250);
  assert.ok(ev.filter((e) => e.kind === 'finish').length >= 2);
});

test('power curve and all-time bests', () => {
  const p = Array.from({ length: 1300 }, (_, i) => (i >= 100 && i < 105 ? 600 : 200));
  const c = powerCurve(p);
  assert.equal(c[5], 600);
  assert.ok(c[60] > 200 && c[60] < 240);
  const { next, improved } = mergePowerBests({ 5: { watts: 500, at: 1 } }, c, 2);
  assert.deepEqual(improved, [5]);
  assert.equal(next[5].watts, 600);
});

test('aerobic decoupling: steady vs drifting', () => {
  const mk = (drift) => Array.from({ length: 3600 }, (_, i) => ({ power: 150, heartRate: 130 + (drift * i) / 3600 }));
  const steady = aerobicCheck(mk(2));
  const drifty = aerobicCheck(mk(25));
  assert.ok(steady.decoupling < 3, `steady ${steady.decoupling}`);
  assert.ok(drifty.decoupling > 5, `drifty ${drifty.decoupling}`);
  assert.equal(decouplingVerdict(2), 'rock steady');
  assert.equal(aerobicCheck(mk(0).slice(0, 900)), null);
});

test('week summary and readiness from Strava activities', () => {
  const now = new Date(2026, 9, 10, 21, 0); // Saturday night
  const day = 86400000;
  const acts = [
    { sportType: 'TrailRun', start: now - 1 * day, movingS: 2 * 3600, distanceM: 21000, elevM: 900 },
    { sportType: 'VirtualRide', start: now - 3 * day, movingS: 3600, distanceM: 30000, elevM: 400 },
    { sportType: 'WeightTraining', start: now - 3 * 3600 * 1000, elapsedS: 3600, movingS: 3600 },
    { sportType: 'Run', start: weekStart(now) - day, movingS: 3600, distanceM: 10000, elevM: 100 }, // last week
  ];
  const w = weekSummary(acts, now);
  assert.equal(w.runDistanceM, 21000);
  assert.equal(w.elevM, 1300);
  assert.equal(w.lifts, 1);
  const r = readiness(acts, { now: now.getTime() });
  assert.equal(r.liftedRecently, true);
  assert.ok(r.bigRun);
  assert.equal(r.lightWeek, false);
  const fresh = readiness([{ sportType: 'Run', start: now - 5 * day, movingS: 1800 }], { now: now.getTime() });
  assert.equal(fresh.lightWeek, true);
});

test('power variability tells steady rides from climbs with descents', async () => {
  const { powerVariability } = await import('../js/core/aerobic.js');
  const steady = Array.from({ length: 3600 }, (_, i) => ({ power: 150 + 10 * Math.sin(i / 20) }));
  const climbDescent = Array.from({ length: 3600 }, (_, i) => ({ power: i < 2700 ? 200 : 20 }));
  assert.ok(powerVariability(steady) < 0.1);
  assert.ok(powerVariability(climbDescent) > 0.3);
});

test('roads that are not a multiple of 50 m: the finish is the last split', () => {
  const odd = buildRoute({ id: 'odd', name: 'Odd', resolutionM: 470, startElevationM: 100, gradientsPct: [6, 6, 6] }); // 1410 m
  const first = new AttemptTracker(odd);
  ride(odd, first, 5, 400);
  const b = first.best;
  assert.equal(b.lengthM, odd.length);
  assert.equal(b.splits.at(-1), b.timeS);
  // Same pace again: level all the way to the top, ghost all the way up.
  const tr = new AttemptTracker(odd, b);
  const t = Math.floor((odd.length - 5) / 5);
  for (let i = 0; i <= t; i++) tr.update(odd.stateAt(5 * i), i);
  assert.ok(Math.abs(tr.delta(odd.stateAt(5 * t), t)) < 1.5, `delta ${tr.delta(odd.stateAt(5 * t), t)}`);
  assert.ok(odd.length - tr.ghostTotal(t) < 8, `ghost ${tr.ghostTotal(t)} of ${odd.length}`);
});
