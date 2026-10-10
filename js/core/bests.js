// Personal bests: your fastest time over each road (with a split every 50 m,
// so a ghost of that ride can ride beside you) and your best power over the
// classic durations.

import { bestAverage } from './rampTest.js';

export const SPLIT_M = 50;

// Elapsed seconds at distance d along a best attempt (splits[k] = time at k·50 m).
export function timeAt(splits, d) {
  if (!splits?.length) return null;
  const f = Math.max(0, d) / SPLIT_M;
  const i = Math.floor(f);
  if (i >= splits.length - 1) return splits.at(-1);
  return splits[i] + (splits[i + 1] - splits[i]) * (f - i);
}

// Distance reached at elapsed time t on a best attempt (inverse of timeAt).
export function distanceAt(splits, t) {
  if (!splits?.length) return null;
  if (t <= 0) return 0;
  if (t >= splits.at(-1)) return (splits.length - 1) * SPLIT_M;
  let lo = 0;
  let hi = splits.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (splits[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = splits[hi] - splits[lo] || 1;
  return (lo + (t - splits[lo]) / span) * SPLIT_M;
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
          if (cur.splits.length < Math.floor(this.length / SPLIT_M) + 1) cur.splits.push(timeS);
          event = { kind: 'finish', timeS, splits: cur.splits, best: this.best, isBest: !this.best || timeS < this.best.timeS };
          if (event.isBest) this.best = { timeS, splits: cur.splits };
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
    const bestT = timeAt(this.best.splits, rs.d);
    return bestT == null ? null : bestT - (t - cur.start);
  }

  // Where the ghost of your best is now, as a total ridden distance, or null.
  ghostTotal(t) {
    const cur = this.current;
    if (!cur || !this.best) return null;
    const d = distanceAt(this.best.splits, t - cur.start);
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
