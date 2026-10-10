// Personal bests: your fastest time over each road (with a split every 50 m,
// so a ghost of that ride can ride beside you) and your best power over the
// classic durations.

import { bestAverage } from './rampTest.js';

export const SPLIT_M = 50;

// splits[k] = elapsed seconds at k·50 m; the last entry is the finish, at
// the road's full length (which is rarely a multiple of 50 m).
const posAt = (i, n, lengthM) => (i === n - 1 && lengthM ? lengthM : i * SPLIT_M);

// Elapsed seconds at distance d along a best attempt.
export function timeAt(splits, d, lengthM = null) {
  if (!splits?.length) return null;
  const n = splits.length;
  const end = posAt(n - 1, n, lengthM);
  const x = Math.max(0, Math.min(d, end));
  const i = Math.min(n - 2, Math.floor(x / SPLIT_M));
  if (i < 0) return splits[0];
  const a = posAt(i, n, lengthM);
  const b = posAt(i + 1, n, lengthM);
  return splits[i] + (splits[i + 1] - splits[i]) * ((x - a) / Math.max(1e-6, b - a));
}

// Distance reached at elapsed time t on a best attempt (inverse of timeAt).
export function distanceAt(splits, t, lengthM = null) {
  if (!splits?.length) return null;
  const n = splits.length;
  if (t <= 0) return 0;
  if (t >= splits.at(-1)) return posAt(n - 1, n, lengthM);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (splits[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = splits[hi] - splits[lo] || 1;
  const a = posAt(lo, n, lengthM);
  const b = posAt(hi, n, lengthM);
  return a + ((t - splits[lo]) / span) * (b - a);
}

// One attempt per pass: up a climb (until the summit) or once round a loop.
// Feed it the route state and moving time; it reports when an attempt starts
// and finishes, and how you're doing against your best on the way.
export class AttemptTracker {
  constructor({ length, lapLength, loop }, best = null) {
    this.length = length;
    this.lapLength = lapLength;
    this.loop = !!loop;
    this.best = best?.splits?.length ? best : null;
    this.current = null;
    this.lastLap = null;
  }

  // rs: { lap, d, direction } from Route.stateAt; t: moving seconds.
  update(rs, t) {
    if (!rs) return null;
    let event = null;
    const cur = this.current;
    if (cur) {
      const forward = rs.direction > 0 && rs.lap === cur.lap;
      if (forward) {
        const k = Math.floor(rs.d / SPLIT_M);
        for (let i = cur.splits.length; i <= k; i++) cur.splits.push(Math.round((t - cur.start) * 10) / 10);
      }
      const done = !forward || rs.d >= this.length - 1;
      if (done) {
        const reached = !forward ? true : rs.d >= this.length - 1;
        if (reached) {
          const timeS = Math.round((t - cur.start) * 10) / 10;
          // The finish is always the last entry, at the full length.
          if ((cur.splits.length - 1) * SPLIT_M < this.length - 0.5) cur.splits.push(timeS);
          else cur.splits[cur.splits.length - 1] = timeS;
          event = { kind: 'finish', timeS, splits: cur.splits, lengthM: this.length, best: this.best, isBest: !this.best || timeS < this.best.timeS };
          if (event.isBest) this.best = { timeS, splits: cur.splits, lengthM: this.length };
        }
        this.current = null;
      }
    }
    // A new attempt starts at the beginning of a lap (not if you join mid-road).
    if (!this.current && rs.direction > 0 && rs.d < SPLIT_M && rs.lap !== this.lastLap) {
      this.current = { lap: rs.lap, start: t, splits: [0] };
      this.lastLap = rs.lap;
      event ??= { kind: 'start' };
    }
    return event;
  }

  // Seconds ahead (+) or behind (−) your best at this point, or null.
  delta(rs, t) {
    const cur = this.current;
    if (!cur || !this.best || rs?.lap !== cur.lap || rs.direction < 0) return null;
    const bestT = timeAt(this.best.splits, rs.d, this.best.lengthM);
    return bestT == null ? null : bestT - (t - cur.start);
  }

  // Where the ghost of your best is now, as a total ridden distance, or null.
  ghostTotal(t) {
    const cur = this.current;
    if (!cur || !this.best) return null;
    const d = distanceAt(this.best.splits, t - cur.start, this.best.lengthM);
    if (d == null) return null;
    return cur.lap * this.lapLength + Math.min(this.length, d);
  }
}

// ---------------------------------------------------------------- power

export const POWER_WINDOWS = [5, 60, 300, 1200];

export function powerCurve(powers, windows = POWER_WINDOWS) {
  const out = {};
  for (const w of windows) {
    const b = bestAverage(powers, w);
    if (b != null) out[w] = Math.round(b);
  }
  return out;
}

// Merge a ride's curve into all-time bests; returns which windows improved.
export function mergePowerBests(stored = {}, curve, at = Date.now()) {
  const next = { ...stored };
  const improved = [];
  for (const [w, watts] of Object.entries(curve)) {
    if (!next[w] || watts > next[w].watts) {
      if (next[w]) improved.push(Number(w));
      next[w] = { watts, at };
    }
  }
  return { next, improved };
}

export function windowLabel(w) {
  return w < 60 ? `${w} s` : `${w / 60} min`;
}
