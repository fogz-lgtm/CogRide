// Turns button presses into shifts, Zwift-style: one press = one gear, and
// (like BikeControl) holding a button repeats after 550 ms every 250 ms.
// Presses closer than 80 ms are ignored: a flaky Click can otherwise
// double-fire and jump several gears.

export class Shifter {
  constructor(onShift, { holdDelayMs = 550, repeatMs = 250, debounceMs = 80, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.onShift = onShift;
    this.holdDelayMs = holdDelayMs;
    this.repeatMs = repeatMs;
    this.debounceMs = debounceMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.held = new Map(); // direction -> timer
    this.lastPress = new Map();
  }

  press(direction) {
    const t = this.now();
    if (this.held.has(direction)) return; // already held (e.g. keyboard auto-repeat)
    if (t - (this.lastPress.get(direction) ?? -Infinity) < this.debounceMs) return;
    this.lastPress.set(direction, t);
    this.onShift(direction);
    const repeat = () => {
      this.onShift(direction);
      this.held.set(direction, this.setTimer(repeat, this.repeatMs));
    };
    this.held.set(direction, this.setTimer(repeat, this.holdDelayMs));
  }

  release(direction) {
    const timer = this.held.get(direction);
    if (timer !== undefined) this.clearTimer(timer);
    this.held.delete(direction);
  }

  releaseAll() {
    for (const d of [...this.held.keys()]) this.release(d);
  }
}
