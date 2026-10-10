// Zone 2 autopilot: the trainer holds a wattage (ERG) and this controller
// nudges it so heart rate settles in a target band and stays there as the
// ride goes on (cardiac drift slowly pulls power down, which is the point).
//
// Heart rate answers a power change with a lag of 30–90 s, so the controller
// is deliberately slow: it looks at smoothed HR and its trend every few
// seconds and moves power a few watts at a time.

export class HrAutopilot {
  constructor({ targetHr, zoneMin, zoneMax, startWatts, minWatts = 50, maxWatts = 400, intervalS = 5, warmupS = 180 }) {
    this.targetHr = targetHr;
    this.zoneMin = zoneMin ?? targetHr - 8;
    this.zoneMax = zoneMax ?? targetHr + 8;
    this.watts = startWatts;
    this.minWatts = minWatts;
    this.maxWatts = maxWatts;
    this.intervalS = intervalS;
    this.warmupS = warmupS;
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

  // Shift the whole band (e.g. Click +/− to aim a little higher or lower).
  nudgeTarget(deltaBpm) {
    this.targetHr = Math.min(this.zoneMax - 2, Math.max(this.zoneMin + 2, this.targetHr + deltaBpm));
  }

  // Call once per second with the latest HR (or null). Returns target watts.
  update(dt, hr) {
    this.elapsed += dt;
    if (hr > 30 && hr < 230) {
      this.lastHrAt = this.elapsed;
      this.smoothed = this.smoothed == null ? hr : this.smoothed + (hr - this.smoothed) * Math.min(1, dt / 8);
      this.history.push(this.smoothed);
      if (this.history.length > 40) this.history.shift();
    }
    this.sinceUpdate += dt;
    if (this.sinceUpdate < this.intervalS) return this.watts;
    this.sinceUpdate = 0;
    // No HR for a while: hold steady rather than guess.
    if (this.status === 'no-hr') return this.watts;

    const error = this.smoothed - this.targetHr; // + means too high
    // bpm per minute over the last ~30 s: anticipates where HR is heading.
    const h = this.history;
    const trend = h.length >= 20 ? ((h.at(-1) - h[h.length - 20]) / 19) * 60 : 0;
    const predicted = error + trend * 0.6; // ~35 s look-ahead

    let step = -0.35 * predicted;
    // Early on HR is still climbing from rest; don't chase it down hard.
    if (this.elapsed < this.warmupS && step < 0 && this.smoothed < this.zoneMax) step *= 0.3;
    // Small dead-band so a steady rider isn't nagged by constant 1 W changes.
    if (Math.abs(predicted) < 1.5) step = 0;
    const cap = this.smoothed > this.zoneMax + 3 ? 10 : 4;
    step = Math.max(-cap, Math.min(cap, step));
    this.watts = Math.round(Math.max(this.minWatts, Math.min(this.maxWatts, this.watts + step)));
    return this.watts;
  }
}

// Sensible defaults from FTP and zones: start around the low end of
// endurance power so HR rises into the zone rather than overshooting it.
export function autopilotDefaults({ ftp = 200, zoneMin = 122, zoneMax = 151 } = {}) {
  return {
    targetHr: Math.round(zoneMin + (zoneMax - zoneMin) * 0.45),
    zoneMin,
    zoneMax,
    startWatts: Math.round(ftp * 0.55),
    minWatts: Math.round(ftp * 0.3),
    maxWatts: Math.round(ftp * 0.85),
  };
}
