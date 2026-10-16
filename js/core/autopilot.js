// Zone 2 autopilot: the trainer holds a wattage (ERG) and this controller
// nudges it so heart rate settles in a target band and stays there as the
// ride goes on (cardiac drift slowly pulls power down, which is the point).
//
// Heart rate answers a power change with a lag of 30–90 s, so the controller
// is deliberately slow: it looks at smoothed HR and its trend every few
// seconds and moves power a few watts at a time — slower up than down, and
// not up at all for the first few minutes while HR is still rising from rest.
//
// Legs come before heart: grinding below 65 rpm means more effort than heart
// rate shows (a runner's heart on a bike often reads low), so the watts come
// down whatever HR says.

export class HrAutopilot {
  constructor({ targetHr, zoneMin, zoneMax, startWatts, minWatts = 50, maxWatts = 400, intervalS = 5, warmupS = 180, upStep = 1 }) {
    this.targetHr = targetHr;
    this.zoneMin = zoneMin ?? targetHr - 8;
    this.zoneMax = zoneMax ?? targetHr + 8;
    this.watts = startWatts;
    this.minWatts = minWatts;
    this.maxWatts = maxWatts;
    this.intervalS = intervalS;
    this.warmupS = warmupS;
    this.upStep = upStep; // most it adds per interval: 12 W a minute
    this.grindS = 0;
    this.holdUpUntil = 0;
    this.elapsed = 0;
    this.sinceUpdate = 0;
    this.smoothed = null;
    this.history = []; // smoothed HR, one per second, for the trend
    this.lastHrAt = -Infinity;
  }

  get status() {
    if (this.smoothed == null || this.elapsed - this.lastHrAt > 10) return 'no-hr';
    if (this.smoothed > this.zoneMax) return 'above';
    if (this.smoothed < this.zoneMin) return 'below';
    return 'in-zone';
  }

  // At its ceiling and heart rate still under target: the watts, not the
  // heart, are the limit.
  get capped() {
    return this.watts >= this.maxWatts && this.smoothed != null && this.smoothed < this.targetHr - 2;
  }

  // Back off by a share, and don't climb again for two minutes.
  ease(factor = 0.9) {
    this.watts = Math.round(Math.max(this.minWatts, this.watts * factor));
    this.holdUpUntil = this.elapsed + 120;
    return this.watts;
  }

  // Shift the whole band (e.g. Click +/− to aim a little higher or lower).
  nudgeTarget(deltaBpm) {
    this.targetHr = Math.min(this.zoneMax - 2, Math.max(this.zoneMin + 2, this.targetHr + deltaBpm));
  }

  // Call often with the latest HR (or null) and cadence (or null when the
  // trainer doesn't report it). Returns target watts.
  update(dt, hr, { cadence = null } = {}) {
    this.elapsed += dt;
    if (cadence > 0 && cadence < 65) this.grindS += dt;
    else this.grindS = Math.max(0, this.grindS - dt * 2);
    if (hr > 30 && hr < 230) {
      this.lastHrAt = this.elapsed;
      this.smoothed = this.smoothed == null ? hr : this.smoothed + (hr - this.smoothed) * Math.min(1, dt / 8);
      this.history.push(this.smoothed);
      if (this.history.length > 40) this.history.shift();
    }
    this.sinceUpdate += dt;
    if (this.sinceUpdate < this.intervalS) return this.watts;
    this.sinceUpdate = 0;
    if (this.grindS >= 10) {
      this.grindS = 0;
      return this.ease(0.95);
    }
    // No HR for a while: hold steady rather than guess.
    if (this.status === 'no-hr') return this.watts;

    const error = this.smoothed - this.targetHr; // + means too high
    // bpm per minute over the last ~30 s: anticipates where HR is heading.
    const h = this.history;
    const trend = h.length >= 20 ? ((h.at(-1) - h[h.length - 20]) / 19) * 60 : 0;
    const predicted = error + trend * 0.6; // ~35 s look-ahead

    let step = -0.35 * predicted;
    // Early on HR is still climbing from rest: don't chase it either way.
    if (this.elapsed < this.warmupS) step = step > 0 ? 0 : this.smoothed < this.zoneMax ? step * 0.3 : step;
    if (this.elapsed < this.holdUpUntil) step = Math.min(0, step);
    // Small dead-band so a steady rider isn't nagged by constant 1 W changes.
    if (Math.abs(predicted) < 1.5) step = 0;
    const down = this.smoothed > this.zoneMax + 3 ? 10 : 4;
    step = Math.max(-down, Math.min(this.upStep, step));
    this.watts = Math.round(Math.max(this.minWatts, Math.min(this.maxWatts, this.watts + step)));
    return this.watts;
  }
}

// Sensible defaults from FTP and zones: start around the low end of
// endurance power so HR rises into the zone rather than overshooting it,
// and never go past the top of Zone 2 power (75 % of FTP), whatever HR says.
export function autopilotDefaults({ ftp = 200, zoneMin = 122, zoneMax = 151 } = {}) {
  return {
    targetHr: Math.round(zoneMin + (zoneMax - zoneMin) * 0.45),
    zoneMin,
    zoneMax,
    startWatts: Math.round(ftp * 0.55),
    minWatts: Math.round(ftp * 0.3),
    maxWatts: Math.round(ftp * 0.75),
  };
}
