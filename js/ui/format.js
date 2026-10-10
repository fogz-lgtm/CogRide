// Display helpers: times, zones and their colours, units.

import * as U from '../core/units.js';

export { U };

export function clock(totalSeconds, { hours = false } = {}) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h || hours) return `${h}:${String(m).padStart(2, '0')}:${sec}`;
  return `${m}:${sec}`;
}

// Interval countdown: m:ss, or just seconds in the last minute.
export function countdown(seconds) {
  const s = Math.max(0, Math.ceil(seconds || 0));
  return s < 60 ? String(s) : clock(s);
}

export const POWER_ZONES = [
  { n: 1, name: 'Recovery', color: 'var(--pz1)', hex: '#9c958b', max: 0.56 },
  { n: 2, name: 'Endurance', color: 'var(--pz2)', hex: '#74a9c6', max: 0.76 },
  { n: 3, name: 'Tempo', color: 'var(--pz3)', hex: '#90b57f', max: 0.91 },
  { n: 4, name: 'Threshold', color: 'var(--pz4)', hex: '#e7bf57', max: 1.06 },
  { n: 5, name: 'VO₂max', color: 'var(--pz5)', hex: '#ec8c58', max: 1.21 },
  { n: 6, name: 'Anaerobic', color: 'var(--pz6)', hex: '#e05b51', max: Infinity },
];

export const HR_ZONES = [
  { n: 1, name: 'Easy', color: 'var(--pz1)' },
  { n: 2, name: 'Endurance', color: 'var(--pz2)' },
  { n: 3, name: 'Tempo', color: 'var(--pz3)' },
  { n: 4, name: 'Threshold', color: 'var(--pz4)' },
  { n: 5, name: 'Max', color: 'var(--pz6)' },
];

export function powerZone(fraction) {
  return POWER_ZONES.findIndex((z) => fraction < z.max);
}

// Zone of a workout step (or null for free ride).
export function stepFraction(step, at = 0) {
  if (!step) return null;
  if (step.type === 'steady') return step.power;
  if (step.type === 'ramp') return step.from + (step.to - step.from) * Math.min(1, Math.max(0, at));
  return null;
}

export function stepZone(step) {
  const f = step?.type === 'ramp' ? (step.from + step.to) / 2 : stepFraction(step);
  return f == null ? null : POWER_ZONES[powerZone(f)];
}

// Zone label with hysteresis: a change needs a 2 % FTP margin held for 3 s.
export class ZoneLatch {
  constructor({ margin = 0.02, holdMs = 3000, now = () => performance.now() } = {}) {
    this.margin = margin;
    this.holdMs = holdMs;
    this.now = now;
    this.zone = null;
    this.candidate = null;
    this.since = 0;
  }

  update(fraction) {
    if (fraction == null || !Number.isFinite(fraction)) return this.zone;
    const raw = powerZone(fraction);
    if (this.zone == null) {
      this.zone = raw;
      return raw;
    }
    if (raw === this.zone) {
      this.candidate = null;
      return this.zone;
    }
    // Must clear the boundary by the margin.
    const lo = this.zone > 0 ? POWER_ZONES[this.zone - 1].max : -Infinity;
    const hi = POWER_ZONES[this.zone].max;
    if (fraction > lo - this.margin && fraction < hi + this.margin) {
      this.candidate = null;
      return this.zone;
    }
    const t = this.now();
    if (this.candidate !== raw) {
      this.candidate = raw;
      this.since = t;
    } else if (t - this.since >= this.holdMs) {
      this.zone = raw;
      this.candidate = null;
    }
    return this.zone;
  }
}

export function num(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '--';
  return Number(v).toFixed(digits);
}

export function thousands(v) {
  return Math.round(v).toLocaleString('en-US');
}

// "Mont Ventoux (Bédoin)" → "Mont Ventoux" where space is tight.
export const shortName = (name = '') => name.replace(/\s*\(.*\)$/, '');
