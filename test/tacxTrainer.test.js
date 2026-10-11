import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeChar, FakeService, FakeServer } from './fakeGatt.js';
import { UUID } from '../js/devices/bleDevice.js';
import {
  TacxTrainer,
  FEC_SERVICE,
  FEC_NOTIFY,
  FEC_WRITE,
  antMessage,
  fecTrackResistance,
  fecTargetPower,
  fecUserConfig,
  fecWindResistance,
  parseFecNotification,
  parseFecPage,
  parseCyclingPower,
  cadenceBetween,
  CYCLING_POWER_MEASUREMENT,
} from '../js/devices/tacxTrainer.js';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const xor = (bytes) => bytes.reduce((a, b) => a ^ b, 0);

// A broadcast FE-C message as the trainer notifies it.
function broadcast(page) {
  const msg = [0xa4, 0x09, 0x4e, 0x05, ...page];
  return [...msg, xor(msg)];
}
const trainerPage = ({ cadence = 85, power = 250, flags = 0, limit = 0 } = {}) => [0x19, 1, cadence, 0, 0, power & 0xff, ((power >> 8) & 0x0f) | (flags << 4), limit | 0x30];

function fakeFlux({ fec = true, ftms = true, power = false } = {}) {
  const notify = new FakeChar(FEC_NOTIFY);
  const write = new FakeChar(FEC_WRITE);
  const cp = new FakeChar(UUID.FTMS_CONTROL_POINT, {}, (data) => setTimeout(() => cp.emit([0x80, data[0], 0x01]), 1));
  const bikeData = new FakeChar(UUID.INDOOR_BIKE_DATA);
  const services = [];
  if (fec) services.push(new FakeService(FEC_SERVICE, [notify, write]));
  if (ftms) services.push(new FakeService(UUID.FTMS, [cp, bikeData]));
  const cpm = new FakeChar(CYCLING_POWER_MEASUREMENT);
  if (power) services.push(new FakeService(UUID.CYCLING_POWER, [cpm]));
  return { server: new FakeServer(services), notify, write, cp, bikeData, cpm };
}

const open = [];
test.afterEach(() => open.splice(0).forEach((t) => clearInterval(t.keepalive)));

async function connected(flux) {
  const t = new TacxTrainer();
  open.push(t);
  t.state = 'connected';
  t.setMasses(72.6, 8);
  await t.setup(flux.server);
  t.setState('connected');
  await tick(5);
  return t;
}

test('FE-C messages: framing, checksum and page encodings', () => {
  const m = antMessage([0x33, 0xff, 0xff, 0xff, 0xff, 0x14, 0x50, 0x50]);
  assert.deepEqual(Array.from(m.slice(0, 4)), [0xa4, 0x09, 0x4f, 0x05]);
  assert.equal(m.length, 13);
  assert.equal(m[12], xor(Array.from(m.slice(0, 12))));
  // 5 % → (5 + 200) × 100 = 20500 = 0x5014; Crr 0.004 → 80.
  assert.deepEqual(Array.from(fecTrackResistance(5).slice(4, 12)), [0x33, 0xff, 0xff, 0xff, 0xff, 0x14, 0x50, 80]);
  // −3.5 % → 19650 = 0x4cc2
  assert.deepEqual(Array.from(fecTrackResistance(-3.5).slice(9, 11)), [0xc2, 0x4c]);
  // 200 W → 800 quarter-watts = 0x0320
  assert.deepEqual(Array.from(fecTargetPower(200).slice(4, 12)), [0x31, 0xff, 0xff, 0xff, 0xff, 0xff, 0x20, 0x03]);
  // 72.6 kg → 7260 = 0x1c5c; 8 kg bike → 160 = 0x0a0 (12 bits); 0.70 m wheel.
  assert.deepEqual(Array.from(fecUserConfig(72.6, 8).slice(4, 12)), [0x37, 0x5c, 0x1c, 0xff, 0x0f, 0x0a, 70, 0x00]);
  // 0.51 kg/m, no wind (127), riding alone (100 %).
  assert.deepEqual(Array.from(fecWindResistance().slice(4, 12)), [0x32, 0xff, 0xff, 0xff, 0xff, 51, 127, 100]);
});

test('parses trainer pages from notifications, and skips corrupt ones', () => {
  const good = broadcast(trainerPage({ cadence: 88, power: 0x1fa }));
  const bad = broadcast(trainerPage());
  bad[bad.length - 1] ^= 0xff;
  const pages = parseFecNotification(Uint8Array.from([...good, ...bad]));
  assert.equal(pages.length, 1);
  const d = parseFecPage(pages[0]);
  assert.equal(d.kind, 'trainer');
  assert.equal(d.cadence, 88);
  assert.equal(d.power, 0x1fa);
  assert.equal(d.powerLimit, 0);
  // Invalid cadence (0xff) reads as unknown, not zero.
  assert.equal(parseFecPage(Uint8Array.from(trainerPage({ cadence: 0xff }))).cadence, null);
  // General page: speed in mm/s, heart rate.
  const g = parseFecPage(Uint8Array.from([0x10, 0x19, 0, 0, 0x10, 0x27, 142, 0x34]));
  assert.equal(g.speedMps, 10);
  assert.equal(g.heartRate, 142);
});

test('FE-C path: rider weight, still air, then the road; grade capped at 10 %', async () => {
  const flux = await fakeFlux();
  const t = await connected(flux);
  assert.equal(t.path, 'fec');
  const pages = flux.write.writes.map((w) => w[4]);
  assert.deepEqual(pages.slice(0, 3), [0x37, 0x32, 0x33]);
  assert.equal(flux.cp.writes.length, 0); // FTMS control left alone

  t.setTarget({ mode: 'sim', gradePct: 14, gear: 3 });
  await tick(300);
  t.kick();
  await tick(5);
  const last = flux.write.writes.at(-1);
  assert.equal(last[4], 0x33);
  assert.equal(last[9] | (last[10] << 8), 21000); // (10 + 200) × 100

  t.setTarget({ mode: 'erg', watts: 180 });
  await tick(5);
  const erg = flux.write.writes.at(-1);
  assert.equal(erg[4], 0x31);
  assert.equal(erg[10] | (erg[11] << 8), 720);
});

test('FE-C data drives power and cadence; FTMS only fills in when FE-C is quiet', async () => {
  const flux = await fakeFlux();
  const t = await connected(flux);
  const seen = [];
  t.addEventListener('data', (e) => seen.push(e.detail));
  flux.notify.emit(broadcast(trainerPage({ cadence: 91, power: 230 })));
  // FTMS Indoor Bike Data (cadence + power) right after: ignored.
  flux.bikeData.emit([0x44, 0x00, 0x00, 0x00, 0xb4, 0x00, 0xc8, 0x00]);
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].power, seen[0].cadence, seen[0].source], [230, 91, 'fec']);
});

test('in ERG, says which way to shift when the brake is out of range', async () => {
  const flux = await fakeFlux();
  const t = await connected(flux);
  const hints = [];
  t.addEventListener('gear-hint', (e) => hints.push(e.detail.direction));
  t.setTarget({ mode: 'erg', watts: 300 });
  await tick(5);
  flux.notify.emit(broadcast(trainerPage({ power: 180, limit: 1 })));
  t.limitSince -= 5000; // as if 5 s had passed
  flux.notify.emit(broadcast(trainerPage({ power: 180, limit: 1 })));
  flux.notify.emit(broadcast(trainerPage({ power: 180, limit: 1 })));
  assert.deepEqual(hints, [1]); // too slow: shift to a harder gear, once
});

test('FTMS fallback when the trainer has no FE-C service', async () => {
  const flux = await fakeFlux({ fec: false });
  const t = await connected(flux);
  assert.equal(t.path, 'ftms');
  const ops = flux.cp.writes.map((w) => w[0]);
  assert.deepEqual(ops.slice(0, 3), [0x00, 0x07, 0x11]);
  t.setTarget({ mode: 'sim', gradePct: 12 });
  await tick(300);
  t.kick();
  await tick(10);
  const sim = flux.cp.writes.at(-1);
  assert.equal(sim[0], 0x11);
  assert.equal(sim[3] | (sim[4] << 8), 1000); // capped at 10 %, in 0.01 %
});

test('refuses a device with neither FE-C nor FTMS', async () => {
  const t = new TacxTrainer();
  await assert.rejects(t.setup(new FakeServer([])), /Tacx/);
});

test('Cycling Power: power, and cadence from crank revolutions', () => {
  // flags 0x0020 (crank data), 250 W, 100 revs at 1024 ticks.
  const dv = (revs, time) => new DataView(Uint8Array.from([0x20, 0x00, 0xfa, 0x00, revs & 0xff, revs >> 8, time & 0xff, time >> 8]).buffer);
  const a = parseCyclingPower(dv(100, 1024));
  const b = parseCyclingPower(dv(101, 1024 + 683)); // one stroke in 0.667 s
  assert.equal(a.power, 250);
  assert.equal(cadenceBetween(a.crank, b.crank), 90);
  // Counters roll over at 65536.
  assert.equal(cadenceBetween({ revs: 65535, time: 65000 }, { revs: 0, time: 65000 + 683 - 65536 }), 90);
});

test('Cycling Power fills in only when FE-C and FTMS are quiet', async () => {
  const flux = await fakeFlux({ power: true });
  const t = await connected(flux);
  const seen = [];
  t.addEventListener('data', (e) => seen.push(e.detail.source));
  flux.cpm.emit([0x00, 0x00, 0xc8, 0x00]);
  assert.deepEqual(seen, ['power']);
  flux.notify.emit(broadcast(trainerPage()));
  flux.cpm.emit([0x00, 0x00, 0xc8, 0x00]);
  assert.deepEqual(seen, ['power', 'fec']);
});
