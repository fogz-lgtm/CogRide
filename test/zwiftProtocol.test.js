import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ZP from '../js/devices/zwiftProtocol.js';

const hex = (s) => Uint8Array.from(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

test('all 24 gear commands match Zwift captures', () => {
  const expected = [
    '04 2a 03 10 cc 3a', '04 2a 03 10 fc 43', '04 2a 03 10 ac 4d', '04 2a 03 10 dc 56', '04 2a 03 10 8c 60', '04 2a 03 10 e8 6b',
    '04 2a 03 10 c4 77', '04 2a 04 10 a0 83 01', '04 2a 04 10 a8 91 01', '04 2a 04 10 b0 9f 01', '04 2a 04 10 b8 ad 01',
    '04 2a 04 10 c0 bb 01', '04 2a 04 10 f3 cb 01', '04 2a 04 10 a8 dc 01', '04 2a 04 10 dc ec 01', '04 2a 04 10 90 fd 01',
    '04 2a 04 10 d4 90 02', '04 2a 04 10 98 a4 02', '04 2a 04 10 dc b7 02', '04 2a 04 10 9f cb 02', '04 2a 04 10 d8 e2 02',
    '04 2a 04 10 90 fa 02', '04 2a 04 10 c8 91 03', '04 2a 04 10 f3 ac 03',
  ];
  expected.forEach((bytes, i) => assert.equal(toHex(ZP.setGear(i + 1)), bytes, `gear ${i + 1}`));
});

test('init, grade, masses, ERG and release frames', () => {
  assert.equal(toHex(ZP.RIDE_ON_TRAINER), '52 69 64 65 4f 6e 02 01');
  assert.equal(toHex(ZP.logLevelSet(5)), '41 08 05');
  assert.equal(toHex(ZP.getObject(520)), '00 08 88 04');
  assert.equal(toHex(ZP.getObject(0)), '00 08 00');
  assert.equal(toHex(ZP.bikeSim({ gearRatioX10000: 24000, bikeKg: 8.31, riderKg: 85 })), '04 2a 0a 10 c0 bb 01 20 bf 06 28 b4 42');
  assert.equal(toHex(ZP.bikeSim({ gearRatioX10000: 24000, bikeKg: 10, riderKg: 75 })), '04 2a 0a 10 c0 bb 01 20 e8 07 28 cc 3a');
  assert.equal(toHex(ZP.envSim({ windMps: 0, gradePct: 1.73, cw: 0.51, crr: 0.004 })), '04 22 0b 08 00 10 da 02 18 ec 27 20 90 03');
  assert.equal(toHex(ZP.envSim({ gradePct: 5 })), '04 22 03 10 e8 07');
  assert.equal(toHex(ZP.envSim({ gradePct: -3.25 })), '04 22 03 10 89 05');
  assert.equal(toHex(ZP.envSim({ gradePct: -0.85 })), '04 22 03 10 a9 01');
  assert.equal(toHex(ZP.envSim({ gradePct: 0 })), '04 22 02 10 00');
  assert.equal(toHex(ZP.ergPower(200)), '04 18 c8 01');
  assert.equal(toHex(ZP.ergPower(250)), '04 18 fa 01');
  assert.equal(toHex(ZP.releaseVirtualShifting()), '04 2a 02 10 00');
});

test('parses trainer notifications from a real KICKR CORE', () => {
  const n = ZP.parseFrame(hex('03 08 9f 01 10 01 18 8c 04 20 00 28 d5 76 30 cc 81 02'));
  assert.deepEqual(n, { kind: 'trainer', power: 159, cadence: 1, speedCms: 524, realGearRatio: 3.2972 });
  const idle = ZP.parseFrame(hex('03 08 00 10 00 18 00 20 00 28 00 30 cc 81 02'));
  assert.equal(idle.power, 0);
});

test('parses the gear confirmation echo', () => {
  assert.deepEqual(ZP.parseFrame(hex('3c 08 88 04 12 06 0a 04 40 c0 bb 01')), { kind: 'get-response', id: 520, gearRatioX10000: 24000 });
  assert.equal(ZP.parseFrame(hex('3c 08 88 04 12 05 0a 03 40 cc 3a')).gearRatioX10000, 7500);
  assert.equal(ZP.parseFrame(hex('52 69 64 65 4f 6e 02 00')).kind, 'ride-on');
  assert.equal(ZP.parseFrame(hex('2a 08 03 12 0d 22 0b 52 49 44 45 5f 4f 4e 28 32 29 00')).kind, 'info');
  assert.equal(ZP.parseFrame(hex('fe')).kind, 'lost-control');
  assert.equal(ZP.unzigzag(37), -19);
});
