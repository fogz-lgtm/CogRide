// A pretend trainer + rider for trying the app without hardware (and for tests).
//
// It accepts the same targets as SmartTrainer. In SIM mode it behaves like a
// trainer with built-in virtual shifting: at cadence c in gear ratio R the
// rider must make the power to ride the road at v = c/60 · R · 2.1 m. The
// simulated rider aims for a steady effort, so shifting up first makes the
// pedals heavier, then cadence settles lower, like the real thing.
// With realGears (FluxRide) the pretend rider shifts the bike to hold that
// effort, a little slower up steep grades.

import { ratioFor, ZWIFT_CW, ZWIFT_CRR } from '../core/gearing.js';

const WHEEL_M = 2.1;

export function trainerRoadPower(cadence, gearRatio, gradePct, massKg) {
  const v = (cadence / 60) * gearRatio * WHEEL_M;
  const th = Math.atan(gradePct / 100);
  const force = massKg * 9.81 * Math.sin(th) + ZWIFT_CRR * massKg * 9.81 * Math.cos(th) + 0.5 * ZWIFT_CW * v * v;
  return Math.max(0, force * v);
}

// Cadence at which the road costs `watts` (bisection), clamped to a rider's range.
export function cadenceForPower(watts, gearRatio, gradePct, massKg, min = 45, max = 118) {
  let lo = 1;
  let hi = 200;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (trainerRoadPower(mid, gearRatio, gradePct, massKg) < watts) lo = mid;
    else hi = mid;
  }
  return Math.min(max, Math.max(min, (lo + hi) / 2));
}

export class SimulatedTrainer extends EventTarget {
  constructor({ effortWatts = 150, intervalMs = 250, random = Math.random, autoStart = true, realGears = false } = {}) {
    super();
    this.label = 'Trainer';
    this.name = 'Simulator';
    this.displayName = 'Simulator';
    this.state = 'disconnected';
    this.path = 'sim';
    this.realGears = realGears;
    this.nativeShifting = !realGears;
    this.effortWatts = effortWatts;
    this.intervalMs = intervalMs;
    this.random = random;
    this.autoStart = autoStart;
    this.target = { mode: 'sim', gradePct: 0, gear: 8 };
    this.masses = { riderKg: 75, bikeKg: 8 };
    this.cadence = 0;
    this.power = 0;
    this.heartRate = 62;
    this.timer = null;
  }

  get connected() {
    return this.state === 'connected';
  }

  async connect() {
    this.state = 'connected';
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'connected', message: '' } }));
    this.dispatchEvent(new CustomEvent('path', { detail: { path: 'sim' } }));
    if (this.autoStart) {
      this.timer = setInterval(() => this.step(this.intervalMs / 1000), this.intervalMs);
      this.timer?.unref?.();
    }
  }

  disconnect() {
    clearInterval(this.timer);
    this.state = 'disconnected';
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'disconnected', message: '' } }));
  }

  setTarget(target) {
    this.target = { ...target };
  }

  setMasses(riderKg, bikeKg) {
    this.masses = { riderKg, bikeKg };
  }

  // How hard the pretend rider is trying (W).
  setEffort(watts) {
    this.effortWatts = Math.max(0, Math.min(1200, watts));
  }

  step(dt) {
    const noise = (n) => (this.random() - 0.5) * n;
    const mass = this.masses.riderKg + this.masses.bikeKg;
    const t = this.target;
    if (this.effortWatts <= 0) {
      // Stopped pedalling.
      this.cadence += (0 - this.cadence) * Math.min(1, dt * 1.5);
      this.power += (0 - this.power) * Math.min(1, dt * 2);
    } else if (t.mode === 'erg') {
      // The trainer holds the target; the rider keeps a comfortable cadence.
      this.cadence += (88 + noise(4) - this.cadence) * Math.min(1, dt * 1.2);
      this.power += ((t.watts ?? 0) - this.power) * Math.min(1, dt / 1.5);
      this.power += noise(6);
    } else if (this.realGears) {
      const grade = t.gradePct ?? 0;
      this.cadence += (Math.max(62, 88 - Math.max(0, grade) * 2) + noise(3) - this.cadence) * Math.min(1, dt / 1.6);
      this.power += (this.effortWatts - this.power) * Math.min(1, dt / 2) + noise(8);
    } else {
      const ratio = ratioFor(t.gear ?? 8);
      const grade = t.gradePct ?? 0;
      // Cadence drifts toward where the road costs the rider's effort...
      const wanted = cadenceForPower(this.effortWatts, ratio, grade, mass);
      this.cadence += (wanted + noise(3) - this.cadence) * Math.min(1, dt / 1.6);
      // ...while power is whatever this cadence costs in this gear right now.
      this.power = trainerRoadPower(this.cadence, ratio, grade, mass) + noise(8);
    }
    this.power = Math.max(0, this.power);
    this.cadence = Math.max(0, this.cadence);
    // Heart rate follows power with a ~45 s lag.
    const steadyHr = 64 + this.power * 0.42;
    this.heartRate += ((steadyHr - this.heartRate) * dt) / 45;
    this.dispatchEvent(
      new CustomEvent('data', {
        detail: { power: Math.round(this.power), cadence: Math.round(this.cadence), heartRate: Math.round(this.heartRate), source: 'sim' },
      }),
    );
  }
}
