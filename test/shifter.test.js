import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Shifter } from '../js/core/shifter.js';

function harness() {
  let t = 0;
  const timers = [];
  const shifts = [];
  const shifter = new Shifter((d) => shifts.push(d), {
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => (timer.live = false),
  });
  const advance = (ms) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      t = next.at;
      next.live = false;
      next.fn();
    }
    t = end;
  };
  return { shifter, shifts, advance };
}

test('one press = one shift; hold repeats after 550 ms every 250 ms', () => {
  const { shifter, shifts, advance } = harness();
  shifter.press(1);
  advance(100);
  shifter.release(1);
  assert.deepEqual(shifts, [1]);
  advance(200);
  shifter.press(-1);
  advance(1100); // press, then repeats at 550, 800 and 1050 ms
  shifter.release(-1);
  advance(1000);
  assert.deepEqual(shifts, [1, -1, -1, -1, -1]);
});

test('debounces double-fires and ignores auto-repeat presses', () => {
  const { shifter, shifts, advance } = harness();
  shifter.press(1);
  shifter.release(1);
  advance(30);
  shifter.press(1); // bounce
  shifter.release(1);
  advance(200);
  shifter.press(1);
  shifter.press(1); // keyboard auto-repeat while held
  shifter.releaseAll();
  assert.deepEqual(shifts, [1, 1]);
});
