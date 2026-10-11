// The ride engine: one place that owns a ride.
//
// Two decoupled loops, like Zwift: (1) game physics turns measured power into
// speed and distance along the route; (2) trainer control decides what the
// trainer should do (ride the road in the current gear, or hold ERG watts).
// The UI only reads `snapshot()` and listens for events.

import { RiderPhysics } from '../core/physics.js';
import { START_GEAR, GEAR_COUNT, clampGear, ratioFor, feltGrade, slew } from '../core/gearing.js';
import { HrAutopilot } from '../core/autopilot.js';
import { stepAt, targetFraction, totalDuration } from '../workouts.js';
import { summarize } from '../recorder.js';

// Rides on routes without real coordinates get a GPS track in open ocean
// (like Zwift's virtual worlds) so Strava files them as virtual rides.
const VIRTUAL_ANCHOR = { lat: -20, lon: -140 };

export const DEFAULT_SETTINGS = {
  ftp: 200,
  riderKg: 75,
  bikeKg: 8,
  heightCm: 178,
  difficulty: 0.5, // Zwift's Trainer Difficulty default
  ergStepPct: 0.01, // Zwift: one Click = ±1% FTP in ERG
  fuelEveryMin: 0,
  virtualGears: true, // false: the bike's own gears (FluxRide); +/− only nudge ERG and autopilot
};

export class RideEngine extends EventTarget {
  constructor({ settings = {}, clock = () => Date.now() } = {}) {
    super();
    this.clock = clock;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.physics = new RiderPhysics(this.physicsOptions());
    this.trainer = null;
    this.route = null;
    this.workout = null;
    this.autopilotConfig = null;
    this.autopilot = null;
    this.ergEnabled = true;
    this.reset();
  }

  physicsOptions() {
    const s = this.settings;
    return { riderKg: s.riderKg, bikeKg: s.bikeKg, heightCm: s.heightCm };
  }

  reset() {
    this.state = 'ready';
    this.gear = START_GEAR;
    this.bias = 0;
    this.felt = 0;
    this.physics.speed = 0;
    this.physics.distance = 0;
    this.movingTime = 0;
    this.workoutClock = 0;
    this.climbed = 0;
    this.lastElevation = null;
    this.samples = [];
    this.secondAcc = { t: 0, power: 0, n: 0 };
    this.live = { power: 0, powerAt: -Infinity, cadence: 0, cadenceAt: -Infinity, hr: null, hrAt: -Infinity, trainerHr: null, trainerHrAt: -Infinity };
    this.powerHistory = [];
    this.bailout = { active: false, low: 0, recover: 0 };
    this.lastStepIndex = -1;
    this.lastCountdown = null;
    this.workoutDone = false;
    this.lastLap = 0;
    this.lastDirection = 1;
    this.nextFuelAt = this.settings.fuelEveryMin ? this.settings.fuelEveryMin * 60 : Infinity;
    this.startedAt = null;
    this.mode = 'sim';
    this.ergTarget = null;
    if (this.autopilotConfig) this.autopilot = new HrAutopilot(this.autopilotConfig);
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------------------------------------------------------------- setup

  updateSettings(patch) {
    const fuelBefore = this.settings.fuelEveryMin;
    this.settings = { ...this.settings, ...patch };
    const f = this.settings.fuelEveryMin;
    if (f !== fuelBefore) this.nextFuelAt = f ? (Math.floor(this.movingTime / (f * 60)) + 1) * f * 60 : Infinity;
    this.physics.configure(this.physicsOptions());
    this.trainer?.setMasses?.(this.settings.riderKg, this.settings.bikeKg);
  }

  setTrainer(trainer) {
    this.trainer = trainer;
    trainer.setMasses?.(this.settings.riderKg, this.settings.bikeKg);
    trainer.addEventListener('data', (e) => this.onData(e.detail, 'trainer'));
  }

  setHeartRateMonitor(hrm) {
    hrm.addEventListener('data', (e) => this.onData(e.detail, 'hrm'));
  }

  onData(d, source) {
    const t = this.clock();
    if (d.power != null && source === 'trainer') Object.assign(this.live, { power: d.power, powerAt: t });
    if (d.cadence != null && source === 'trainer') Object.assign(this.live, { cadence: d.cadence, cadenceAt: t });
    if (d.heartRate > 0) {
      if (source === 'hrm') Object.assign(this.live, { hr: d.heartRate, hrAt: t });
      else Object.assign(this.live, { trainerHr: d.heartRate, trainerHrAt: t });
    }
  }

  setRoute(route) {
    this.route = route;
    this.lastElevation = null;
  }

  setWorkout(workout) {
    this.workout = workout;
    this.workoutClock = 0;
    this.lastStepIndex = -1;
    this.workoutDone = false;
    this.bias = 0;
    this.bailout = { active: false, low: 0, recover: 0 };
  }

  // { targetHr, zoneMin, zoneMax, startWatts, minWatts, maxWatts } or null
  setAutopilot(config) {
    this.autopilotConfig = config;
    this.autopilot = config ? new HrAutopilot(config) : null;
  }

  setErgEnabled(on) {
    this.ergEnabled = on;
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.state === 'riding') return;
    if (this.state === 'ready') this.startedAt = this.clock();
    this.state = 'riding';
    this.emit('state', { state: this.state });
  }

  pause() {
    if (this.state !== 'riding') return;
    this.state = 'paused';
    this.emit('state', { state: this.state });
  }

  resume() {
    this.start();
  }

  finish() {
    const ride = {
      startedAt: this.startedAt,
      samples: this.samples,
      route: this.route ? { id: this.route.id, name: this.route.name } : null,
      workout: this.workout ? { id: this.workout.id, name: this.workout.name } : null,
      autopilot: !!this.autopilotConfig,
      climbedM: this.climbed,
      movingTimeS: this.movingTime,
      summary: summarize(this.samples, this.settings.ftp),
    };
    this.state = 'finished';
    this.emit('state', { state: this.state });
    return ride;
  }

  // ---------------------------------------------------------------- input

  // Click / keyboard / screen: +1 harder, −1 easier.
  shift(direction) {
    if (this.mode === 'erg') {
      const before = this.bias;
      this.bias = Math.max(-0.25, Math.min(0.25, Math.round((this.bias + direction * this.settings.ergStepPct) * 1000) / 1000));
      this.emit('bias', { bias: this.bias, direction, limited: before === this.bias });
    } else if (this.mode === 'autopilot' && this.autopilot) {
      this.autopilot.nudgeTarget(direction * 2);
      this.emit('autopilot-target', { targetHr: this.autopilot.targetHr, direction });
    } else if (!this.settings.virtualGears) {
      return;
    } else {
      const next = clampGear(this.gear + direction);
      if (next === this.gear) {
        this.emit('limit', { gear: this.gear, direction });
        return;
      }
      this.gear = next;
      this.emit('shift', { gear: this.gear, direction, ratio: ratioFor(this.gear) });
    }
    this.control(0);
  }

  // ---------------------------------------------------------------- loop

  fresh(at, ms) {
    return this.clock() - at < ms;
  }

  get power() {
    return this.fresh(this.live.powerAt, 3000) ? this.live.power : 0;
  }

  get cadence() {
    return this.fresh(this.live.cadenceAt, 3000) ? this.live.cadence : 0;
  }

  get heartRate() {
    if (this.fresh(this.live.hrAt, 5000)) return this.live.hr;
    if (this.fresh(this.live.trainerHrAt, 5000)) return this.live.trainerHr;
    return null;
  }

  routeState() {
    return this.route ? this.route.stateAt(this.physics.distance) : null;
  }

  tick(dt) {
    const t = this.clock();
    const power = this.power;
    this.powerHistory.push({ t, power });
    while (this.powerHistory.length && t - this.powerHistory[0].t > 3000) this.powerHistory.shift();

    if (this.state === 'riding') {
      const before = this.routeState();
      this.physics.step(dt, power, (before?.grade ?? 0) / 100, before?.elevation ?? 0);
      const after = this.routeState();
      const moving = this.physics.speed > 0.3 || power > 10;
      if (moving) {
        this.movingTime += dt;
        if (this.workout && !this.workoutDone) this.workoutClock += dt;
      }
      if (after) {
        if (this.lastElevation != null && after.elevation > this.lastElevation) this.climbed += after.elevation - this.lastElevation;
        this.lastElevation = after.elevation;
        if (after.lap > this.lastLap) this.emit('lap', { lap: after.lap });
        if (this.lastDirection > 0 && after.direction < 0) this.emit('summit', { elevation: after.elevation });
        this.lastLap = after.lap;
        this.lastDirection = after.direction;
      }
      this.record(dt, power, moving, after);
      this.workoutEvents();
      if (this.settings.fuelEveryMin && this.movingTime >= this.nextFuelAt) {
        this.emit('fuel', { minutes: Math.round(this.movingTime / 60) });
        this.nextFuelAt += this.settings.fuelEveryMin * 60;
      }
    }
    this.control(dt);
  }

  // One FIT-ready sample per riding second while moving.
  record(dt, power, moving, rs) {
    const acc = this.secondAcc;
    acc.t += dt;
    acc.power += power * dt;
    acc.n += dt;
    if (acc.t < 1) return;
    const avgPower = acc.n ? acc.power / acc.n : power;
    this.secondAcc = { t: acc.t - 1, power: 0, n: 0 };
    if (!moving) return;
    const position = this.position(rs);
    this.samples.push({
      time: this.clock(),
      power: Math.round(avgPower),
      cadence: Math.round(this.cadence) || null,
      heartRate: this.heartRate,
      speed: this.physics.speed,
      distance: this.physics.distance,
      altitude: rs?.elevation ?? null,
      grade: rs?.grade ?? null,
      lat: position?.lat ?? null,
      lon: position?.lon ?? null,
    });
  }

  position(rs) {
    if (!rs) return null;
    if (rs.lat != null) return { lat: rs.lat, lon: rs.lon };
    const lat = VIRTUAL_ANCHOR.lat + rs.z / 111320;
    const lon = VIRTUAL_ANCHOR.lon + rs.x / (111320 * Math.cos((VIRTUAL_ANCHOR.lat * Math.PI) / 180));
    return { lat, lon };
  }

  currentStep() {
    if (!this.workout || this.workoutDone) return null;
    return stepAt(this.workout, this.workoutClock);
  }

  workoutEvents() {
    if (!this.workout || this.workoutDone) return;
    const cur = this.currentStep();
    if (!cur) {
      this.workoutDone = true;
      this.emit('workout-complete', { name: this.workout.name });
      return;
    }
    if (cur.index !== this.lastStepIndex) {
      this.lastStepIndex = cur.index;
      this.bailout = { active: false, low: 0, recover: 0 };
      this.lastCountdown = null;
      this.emit('interval', { index: cur.index, step: cur.step, next: this.workout.steps[cur.index + 1] ?? null });
    }
    const left = Math.ceil(cur.stepRemaining);
    if (left <= 3 && left >= 1 && left !== this.lastCountdown && this.workout.steps[cur.index + 1]) {
      this.lastCountdown = left;
      this.emit('countdown', { secondsLeft: left });
    }
  }

  // Decide what the trainer does now and tell it (it coalesces repeats).
  control(dt) {
    const riding = this.state === 'riding';
    const cur = this.currentStep();
    const fraction = cur ? targetFraction(cur.step, cur.stepElapsed) : null;
    let target;
    if (this.autopilot && riding) {
      this.mode = 'autopilot';
      this.ergTarget = this.autopilot.update(dt, this.heartRate);
      target = { mode: 'erg', watts: this.ergTarget };
    } else if (fraction != null && this.ergEnabled) {
      this.ergTarget = Math.max(0, Math.round(this.settings.ftp * (fraction + this.bias)));
      if (riding) this.updateBailout(dt, this.ergTarget);
      this.mode = this.bailout.active ? 'bailout' : 'erg';
      if (this.mode === 'erg') target = { mode: 'erg', watts: this.ergTarget };
    } else {
      this.mode = 'sim';
      this.ergTarget = fraction != null ? Math.round(this.settings.ftp * (fraction + this.bias)) : null;
    }
    if (!target) {
      const rs = this.routeState();
      this.felt = slew(this.felt, feltGrade(rs?.grade ?? 0, this.settings.difficulty), dt || 0.001);
      target = { mode: 'sim', gradePct: Math.round(this.felt * 100) / 100, gear: this.gear };
    }
    this.trainer?.setTarget(target);
  }

  // Zwift-style ERG "bailout": if you stop pedalling or collapse under the
  // target, drop to riding the road (no spiral of death); re-engage once
  // you're back at target for 5 s, or at the next interval.
  updateBailout(dt, target) {
    const b = this.bailout;
    // Cadence counts only from a trainer that reports it.
    const cadence = this.fresh(this.live.cadenceAt, 3000) ? this.live.cadence : null;
    const struggling = this.power < 0.3 * target || (cadence != null && cadence < 40);
    if (!b.active) {
      b.low = struggling ? b.low + dt : 0;
      if (b.low > 3) {
        b.active = true;
        b.recover = 0;
        this.emit('bailout', { active: true });
      }
    } else {
      b.recover = this.power >= 0.9 * target && (cadence == null || cadence >= 50) ? b.recover + dt : 0;
      if (b.recover >= 5) {
        b.active = false;
        b.low = 0;
        this.emit('bailout', { active: false });
      }
    }
  }

  // ---------------------------------------------------------------- UI state

  snapshot() {
    const rs = this.routeState();
    const cur = this.currentStep();
    const avg3 = this.powerHistory.length ? this.powerHistory.reduce((s, p) => s + p.power, 0) / this.powerHistory.length : 0;
    return {
      state: this.state,
      mode: this.mode,
      gear: this.gear,
      gearCount: GEAR_COUNT,
      ratio: ratioFor(this.gear),
      bias: this.bias,
      power: Math.round(avg3),
      powerInstant: this.power,
      cadence: Math.round(this.cadence),
      hasCadence: this.fresh(this.live.cadenceAt, 3000),
      heartRate: this.heartRate,
      speed: this.physics.speed,
      tucked: this.physics.tucked,
      distance: this.physics.distance,
      movingTime: this.movingTime,
      climbed: this.climbed,
      grade: rs?.grade ?? 0,
      feltGrade: this.felt,
      elevation: rs?.elevation ?? null,
      route: rs ? { ...rs, name: this.route.name, length: this.route.length, lapLength: this.route.lapLength } : null,
      ergTarget: this.ergTarget,
      workout: this.workout
        ? {
            name: this.workout.name,
            clock: this.workoutClock,
            total: totalDuration(this.workout),
            done: this.workoutDone,
            index: cur?.index ?? null,
            step: cur?.step ?? null,
            stepRemaining: cur?.stepRemaining ?? 0,
            next: cur ? this.workout.steps[cur.index + 1] ?? null : null,
          }
        : null,
      autopilot: this.autopilot ? { status: this.autopilot.status, targetHr: this.autopilot.targetHr, zoneMin: this.autopilot.zoneMin, zoneMax: this.autopilot.zoneMax, watts: this.autopilot.watts } : null,
    };
  }
}
