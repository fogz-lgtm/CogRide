// Demo rides for trying CogRide without hardware (and for screenshots):
//   ?demo=route:alpe-dhuez&at=4200      a climb, 4.2 km in
//   ?demo=workout:sweet-spot-3x10&clock=1500
//   ?demo=z2&clock=1500
//   ?demo=summary
// Add &tv for TV mode, &pause for the pause sheet, &shift to shift once.

import { allWorkouts, autopilotPlan, workoutPlan, vertPlan } from './plans.js';
import { saveBest, addHistory } from './history.js';
import { SPLIT_M } from '../core/bests.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 15000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await wait(50);
  }
  return true;
}

export async function runDemo(c, params) {
  const spec = params.get('demo') || 'route:alpe-dhuez';
  const [kind, id] = spec.split(':');
  if (!c.trainer) c.useSimulator();
  if (kind === 'summary') return demoSummary(c, params);
  await until(() => c.state.catalog.length);
  // &best=<seconds>: pretend you've ridden this road before, that fast.
  if (params.get('best') && kind === 'route') {
    const def = c.state.catalog.find((d) => d.id === (id || 'alpe-dhuez'));
    const timeS = Number(params.get('best'));
    const n = Math.floor(def.lengthM / SPLIT_M) + 1;
    saveBest(def.id, { timeS, splits: Array.from({ length: n }, (_, k) => Math.round(((k * SPLIT_M) / def.lengthM) * timeS * 10) / 10), at: Date.now() - 9 * 86400000 });
  }
  let plan;
  if (kind === 'vert') plan = vertPlan(Number(params.get('goal') || 914.4), id || 'mount-diablo-south-gate');
  else if (kind === 'workout') plan = workoutPlan(allWorkouts().find((w) => w.id === id) ?? allWorkouts()[2]);
  else if (kind === 'z2') plan = autopilotPlan(60);
  else plan = { kind: 'route', id: id || 'alpe-dhuez', routeId: id || 'alpe-dhuez', title: id };
  c.ride(plan);
  await until(() => c.state.route);
  const e = c.engine;
  e.physics.distance = Number(params.get('at') || 0);
  e.start();
  c.set({ rideState: 'riding' });
  if (params.get('gear')) e.gear = Number(params.get('gear'));
  if (params.get('clock')) e.workoutClock = Number(params.get('clock'));
  if (params.get('clock') || params.get('at')) {
    // Pretend we've been riding a while: fill in some history.
    const mins = Number(params.get('clock') || 0) / 60 || 20;
    e.movingTime = mins * 60;
    e.climbed = Math.max(0, (c.state.route.elevationAt(e.physics.distance) - c.state.route.elevationAt(0)) || 0);
    const t0 = Date.now() - mins * 60000;
    const z = c.state.prefs.hrZones[1];
    for (let i = 0; i < mins * 60; i++) {
      const hr = Math.round(z.min + 8 + 10 * (1 - Math.exp(-i / 400)) + 3 * Math.sin(i / 90));
      e.samples.push({ time: t0 + i * 1000, power: Math.round(150 + 20 * Math.sin(i / 120)), cadence: 86, heartRate: hr, speed: 6, distance: i * 6, altitude: 100, grade: 0, lat: null, lon: null });
    }
    if (e.autopilot) {
      for (let i = 0; i < 60; i++) e.autopilot.update(1, 132 + i * 0.05);
      e.autopilot.elapsed = mins * 60;
    }
  }
  if (params.has('tv')) c.setTv(true);
  if (params.has('pause')) {
    await wait(1500);
    c.pause();
  }
  if (params.has('shift')) {
    await wait(Number(params.get('shiftAt') || 2500));
    c.press(1);
    c.release(1);
  }
}

function demoSummary(c, params) {
  const prefs = c.state.prefs;
  const n = Number(params.get('min') || 52) * 60;
  const t0 = Date.now() - n * 1000;
  const samples = [];
  let d = 0;
  let alt = 720;
  const z2 = params.has('z2');
  for (let i = 0; i < n; i++) {
    const climbing = z2 || i < n * 0.8;
    const p = climbing ? 190 + 25 * Math.sin(i / 200) + (i % 60 < 4 ? 30 : 0) : 30;
    const v = climbing ? 3.4 : 12;
    d += v;
    alt += climbing ? 0.31 : -1.4;
    const hr = z2 ? 128 + 10 * (1 - Math.exp(-i / 500)) + (3 * i) / n + 2 * Math.sin(i / 150) : 118 + 32 * (1 - Math.exp(-i / 600)) + 4 * Math.sin(i / 150);
    samples.push({ time: t0 + i * 1000, power: Math.round(z2 ? 150 + 5 * Math.sin(i / 90) : p), cadence: climbing ? 82 : 0, heartRate: Math.round(hr), speed: v, distance: d, altitude: alt, grade: climbing ? 8 : -6, lat: null, lon: null });
  }
  if (params.has('trend')) {
    [1.08, 1.11, 1.1, 1.14].forEach((ef, i) => addHistory({ id: `demo-${i}`, at: t0 - (28 - i * 7) * 86400000, name: 'Zone 2', kind: 'autopilot', minutes: 60, ef, decoupling: 4 }));
  }
  const result = c.buildResult({
    samples,
    startedAt: t0,
    plan: z2 ? { kind: 'autopilot', id: 'z2-60', title: 'Zone 2 autopilot', minutes: 60 } : { kind: 'route', id: 'alpe-dhuez', title: "Alpe d'Huez" },
    route: { name: "Alpe d'Huez", turns: Array.from({ length: 21 }, () => ({ kind: 'hairpin' })) },
    prefs,
    photo: null,
    climbedM: 1071,
    movingTimeS: n,
    summited: true,
    laps: 0,
    rampFtp: null,
    liftedBefore: params.has('lift'),
    workoutDone: false,
    attempts: params.has('best') ? [{ timeS: 3020, isBest: true, prevTimeS: 3084 }] : [],
  });
  c.set({ screen: 'summary', result });
}
