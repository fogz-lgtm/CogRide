import test from 'node:test';
import assert from 'node:assert/strict';
import { numberWords, rideHeadline, ergHeadline, z2Headline, workPosition, tonightsPick, greeting, PRESET_WORKOUTS } from '../js/app/plans.js';
import { packSamples, unpackSamples } from '../js/app/history.js';
import { HR_ZONES_DEFAULT, hrZoneIndex, zone2, DEFAULT_PREFS, engineSettings } from '../js/app/prefs.js';
import { clock, countdown, powerZone, ZoneLatch, shortName } from '../js/ui/format.js';
import { parseWorkoutText } from '../js/workouts.js';

test('number words read like an editor wrote them', () => {
  assert.equal(numberWords(0), 'zero');
  assert.equal(numberWords(21), 'twenty-one');
  assert.equal(numberWords(60), 'sixty');
  assert.equal(numberWords(145), '145');
});

test('summary headlines: climbs, context, autopilot, ramp — never an exclamation mark', () => {
  const alpe = { name: "Alpe d'Huez", turns: Array.from({ length: 21 }, () => ({ kind: 'hairpin' })) };
  assert.deepEqual(rideHeadline({ plan: { kind: 'route' }, route: alpe, summited: true, liftedBefore: true, minutes: 70 }), ['Twenty-one hairpins,', 'after leg day.']);
  assert.deepEqual(rideHeadline({ plan: { kind: 'autopilot' }, minutes: 60, zoneShare: 0.93 }), ['Sixty minutes', 'in the pocket.']);
  assert.deepEqual(rideHeadline({ plan: { kind: 'ramp' }, rampFtp: 214 }), ['New FTP:', '214 W.']);
  const all = [
    rideHeadline({ plan: { kind: 'route' }, route: { name: 'Fogline', turns: [] }, laps: 3, minutes: 50 }),
    rideHeadline({ plan: { kind: 'workout', title: 'Sweet Spot 3×10' }, workoutDone: true, minutes: 60 }),
  ].flat();
  assert.ok(all.every((t) => !t.includes('!')));
});

test('work intervals are counted in blocks (over-unders count once)', () => {
  const w = { steps: parseWorkoutText('10m 50%\n3x 2m 95%, 1m 108%, 5m 50%') };
  // steps: warm, (95,108,50) x3
  assert.deepEqual(workPosition(w, 1), { workIndex: 1, workCount: 3 });
  assert.deepEqual(workPosition(w, 2), { workIndex: 1, workCount: 3 });
  assert.deepEqual(workPosition(w, 7), { workIndex: 3, workCount: 3 });
  assert.equal(workPosition(w, 3).workIndex, null);
  assert.deepEqual(ergHeadline({ step: w.steps[7], workIndex: 3, workCount: 3 }), ['Last one.', 'Make it tidy.']);
  assert.deepEqual(ergHeadline({ step: w.steps[4], workIndex: 2, workCount: 3 }), ['Two of three.', 'Settle in.']);
  assert.deepEqual(z2Headline('in-zone', 900), ['In the', 'pocket.']);
});

test("tonight's pick: a flush after lifting, recovery after a big day, else Zone 2", () => {
  const night = new Date(2026, 9, 10, 21, 0);
  assert.equal(tonightsPick({ liftedRecently: true, date: night }).plan.id, PRESET_WORKOUTS[0].id);
  assert.match(tonightsPick({ date: night }).kicker, /^Tonight's pick/);
  assert.equal(tonightsPick({ date: night }).plan.kind, 'autopilot');
  const big = { at: Date.now() - 20 * 3600 * 1000, tss: 120 };
  assert.equal(tonightsPick({ lastRide: big, date: night }).plan.id, 'recovery-30');
  assert.equal(greeting(night, 'Sam'), 'Evening, Sam.');
  assert.equal(greeting(new Date(2026, 9, 10, 9), ''), 'Good morning.');
});

test('checkpoint samples pack and unpack losslessly enough', () => {
  const s = [{ time: 1700000000000, power: 201, cadence: 88, heartRate: 140, speed: 6.123456, distance: 1234.567, altitude: 101.26, grade: 7.94, lat: 45.0912345, lon: 6.0712345 }];
  const back = unpackSamples(JSON.parse(JSON.stringify(packSamples(s))));
  assert.equal(back[0].power, 201);
  assert.equal(back[0].speed, 6.12);
  assert.equal(back[0].distance, 1234.6);
  assert.ok(Math.abs(back[0].lat - 45.0912345) < 1e-6);
});

test('preferences: zones and engine settings', () => {
  assert.deepEqual(zone2(DEFAULT_PREFS), { min: 122, max: 151 });
  assert.equal(hrZoneIndex(130, HR_ZONES_DEFAULT), 1);
  assert.equal(hrZoneIndex(175, HR_ZONES_DEFAULT), 4);
  assert.equal(hrZoneIndex(null), null);
  assert.equal(engineSettings(DEFAULT_PREFS).difficulty, 0.5);
});

test('formatting: clocks, zones with hysteresis, short names', () => {
  assert.equal(clock(65), '1:05');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(countdown(42.2), '43');
  assert.equal(countdown(402), '6:42');
  assert.equal(powerZone(0.9), 2);
  assert.equal(powerZone(0.95), 3);
  let t = 0;
  const latch = new ZoneLatch({ now: () => t });
  assert.equal(latch.update(0.7), 1);
  // Just over the line, briefly: stays in Z2.
  assert.equal(latch.update(0.77), 1);
  // Clearly over and held for 3 s: moves to Z3.
  assert.equal(latch.update(0.82), 1);
  t = 3100;
  assert.equal(latch.update(0.82), 2);
  assert.equal(shortName('Mont Ventoux (Bédoin)'), 'Mont Ventoux');
});

test('CogRide is the default app and keeps its storage keys', async () => {
  const v = await import('../js/variant.js');
  assert.equal(v.VARIANT, 'cog');
  assert.equal(v.APP.name, 'CogRide');
  assert.equal(v.APP.virtualGears, true);
  assert.equal(v.storeKey('prefs'), 'cogride.prefs'); // unchanged, so nothing saved is lost
});

test('TV mode parks the show where iOS puts its largest Picture in Picture window', async () => {
  const { pipBox } = await import('../js/ui/pip.js');
  // Measured on an iPhone (430 × 932 pt) in Bluefy: a 404 × 227 window,
  // across the top in portrait; top right in landscape, overhanging the page.
  const portrait = pipBox({ screenW: 430, screenH: 932, innerW: 430, innerH: 840 });
  assert.deepEqual(portrait, { landscape: false, w: 404, h: 227, x: 13 });
  const landscape = pipBox({ screenW: 430, screenH: 932, innerW: 829, innerH: 408 });
  assert.equal(landscape.landscape, true);
  assert.equal(landscape.w, 404);
  assert.ok(Math.abs(landscape.x - 453) <= 1, `x ${landscape.x}`);
  // A computer: numbers keep a fair share of the width.
  const desktop = pipBox({ screenW: 1920, screenH: 1080, innerW: 1280, innerH: 720 });
  assert.ok(desktop.x >= 1280 * 0.42 && desktop.x + 200 < 1280);
});
