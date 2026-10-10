import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeChar, FakeService, FakeServer } from './fakeGatt.js';
import { SmartTrainer } from '../js/devices/smartTrainer.js';
import * as ZP from '../js/devices/zwiftProtocol.js';
import { UUID } from '../js/devices/bleDevice.js';

const hex = (arr) => arr.map((b) => b.toString(16).padStart(2, '0')).join(' ');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// A KICKR-like trainer: Zwift service + FTMS. Optionally ignores gears.
function fakeKickr({ honourGears = true, zwift = true } = {}) {
  let lastGear = 24000;
  const asyncChar = new FakeChar(ZP.ZP_ASYNC);
  const tx = new FakeChar(ZP.ZP_SYNC_TX);
  const rx = new FakeChar(ZP.ZP_SYNC_RX, {}, (data) => {
    const b = Array.from(data);
    if (b[0] === 0x52) setTimeout(() => tx.emit([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x00]), 1);
    if (b[0] === 0x04 && b[1] === 0x2a && honourGears) {
      const f = ZP.parseFrame(Uint8Array.from([0x3c, 0x08, 0x88, 0x04, 0x12, b.length - 1, 0x0a, b.length - 3, 0x40, ...b.slice(4)]));
      lastGear = f.gearRatioX10000 ?? lastGear;
    }
    if (b[0] === 0x00 && b[2] === 0x88) {
      const value = ZP.varint(lastGear);
      setTimeout(() => tx.emit([0x3c, 0x08, 0x88, 0x04, 0x12, value.length + 3, 0x0a, value.length + 1, 0x40, ...value]), 1);
    }
  });
  const cp = new FakeChar(UUID.FTMS_CONTROL_POINT, {}, (data) => setTimeout(() => cp.emit([0x80, data[0], 0x01]), 1));
  const bikeData = new FakeChar(UUID.INDOOR_BIKE_DATA);
  const services = [new FakeService(UUID.FTMS, [cp, bikeData])];
  if (zwift) services.push(new FakeService(ZP.ZP_SERVICE, [asyncChar, rx, tx]));
  return { server: new FakeServer(services), rx, tx, cp, bikeData, asyncChar };
}

const open = [];
test.afterEach(() => open.splice(0).forEach((t) => clearInterval(t.keepalive)));

async function connected(kickr, opts) {
  const t = new SmartTrainer(opts);
  open.push(t);
  t.state = 'connected';
  t.setTarget({ mode: 'sim', gradePct: 0, gear: 8 });
  t.setMasses(72.6, 8);
  await t.setup(kickr.server);
  t.setState('connected');
  await tick(5);
  return t;
}

test('Zwift path: handshake and init in Zwift’s order', async () => {
  const k = fakeKickr();
  const t = await connected(k);
  assert.equal(t.path, 'zwift');
  const w = k.rx.writes.map(hex);
  assert.equal(w[0], '52 69 64 65 4f 6e 02 01');
  assert.equal(w[1], '41 08 05');
  assert.equal(w[2], hex(Array.from(ZP.bikeSim({ gearRatioX10000: 16800, riderKg: 72.6, bikeKg: 8 }))));
  assert.match(w[3], /^04 22 /); // full road
  assert.equal(w[4], '00 08 88 04');
  clearInterval(t.keepalive);
});

test('shifts coalesce and each is confirmed by a read-back', async () => {
  const k = fakeKickr();
  const t = await connected(k);
  const before = k.rx.writes.length;
  for (const gear of [9, 10, 11, 12]) t.setTarget({ mode: 'sim', gradePct: 0, gear });
  await tick(30);
  const sent = k.rx.writes.slice(before).map(hex);
  // The first shift goes out immediately; the rest collapse to the latest.
  const gears = sent.filter((s) => s.startsWith('04 2a'));
  assert.ok(gears.length <= 2, sent.join(' | '));
  assert.equal(gears.at(-1), hex(Array.from(ZP.setGear(12))));
  assert.ok(sent.filter((s) => s === '00 08 88 04').length >= 1);
  assert.equal(t.echoMismatches, 0);
  clearInterval(t.keepalive);
});

test('grade updates are rate-limited; ERG round-trips through a flat road', async () => {
  const k = fakeKickr();
  const t = await connected(k);
  let mark = k.rx.writes.length;
  t.setTarget({ mode: 'sim', gradePct: 4.5, gear: 8 });
  await tick(300);
  assert.ok(k.rx.writes.slice(mark).map(hex).includes(hex(Array.from(ZP.envSim({ gradePct: 4.5 })))));
  mark = k.rx.writes.length;
  t.setTarget({ mode: 'erg', watts: 180 });
  await tick(10);
  assert.deepEqual(k.rx.writes.slice(mark).map(hex), [hex(Array.from(ZP.ergPower(180)))]);
  mark = k.rx.writes.length;
  t.setTarget({ mode: 'sim', gradePct: 4.5, gear: 8 });
  await tick(700);
  const after = k.rx.writes.slice(mark).map(hex);
  assert.equal(after[0], '04 22 02 10 00'); // flat first
  assert.ok(after.includes(hex(Array.from(ZP.setGear(8)))), after.join(' | ')); // gear restored
  assert.ok(after.includes(hex(Array.from(ZP.envSim({ gradePct: 4.5 })))));
  clearInterval(t.keepalive);
});

test('falls back to FTMS when the trainer ignores gears', async () => {
  const k = fakeKickr({ honourGears: false });
  const t = await connected(k);
  const warnings = [];
  t.addEventListener('warning', (e) => warnings.push(e.detail.message));
  for (const gear of [9, 10, 11]) {
    t.setTarget({ mode: 'sim', gradePct: 0, gear });
    await tick(20);
  }
  await tick(50);
  assert.equal(t.path, 'ftms');
  assert.ok(warnings.some((m) => /virtual gears/.test(m)));
  assert.equal(t.zpStatus, 'gears-ignored');
  assert.ok(k.cp.writes.some((w) => w[0] === 0x11), 'sends FTMS simulation');
  clearInterval(t.keepalive);
});

test('FTMS-only trainer gets geared simulation and ERG', async () => {
  const k = fakeKickr({ zwift: false });
  const t = await connected(k);
  assert.equal(t.path, 'ftms');
  assert.equal(t.zpStatus, 'no-service'); // shown in the trainer sheet
  assert.deepEqual(k.cp.writes[0], [0x00]); // request control
  await tick(10);
  const sim = k.cp.writes.find((w) => w[0] === 0x11);
  assert.ok(sim, 'simulation sent');
  t.setTarget({ mode: 'erg', watts: 200 });
  await tick(10);
  assert.deepEqual(k.cp.writes.at(-1), [0x05, 200, 0]);
  clearInterval(t.keepalive);
});
