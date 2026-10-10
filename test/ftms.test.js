import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData, encodeSetTargetPower, parseControlPointResponse } from '../js/devices/ftmsTrainer.js';
import { parseHeartRate } from '../js/devices/heartRate.js';

const dv = (...bytes) => new DataView(Uint8Array.from(bytes).buffer);

test('indoor bike data: speed, cadence, power, HR', () => {
  // flags: cadence (0x04) | power (0x40) | heart rate (0x200); speed present because bit 0 clear
  const flags = 0x0004 | 0x0040 | 0x0200;
  const data = parseIndoorBikeData(dv(flags & 0xff, flags >> 8, 0xc4, 0x09, 0xb4, 0x00, 0xfa, 0x00, 142));
  assert.deepEqual(data, { speedKmh: 25, cadence: 90, power: 250, heartRate: 142 });
});

test('indoor bike data: skips optional fields it does not use', () => {
  // more data (no speed) | avg speed | cadence | distance | resistance | power
  const flags = 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020 | 0x0040;
  const bytes = [flags & 0xff, flags >> 8, 0, 0, 0xb0, 0x00, 0x10, 0x27, 0x00, 5, 0, 0x2c, 0x01];
  assert.deepEqual(parseIndoorBikeData(dv(...bytes)), { cadence: 88, distanceM: 10000, power: 300 });
});

test('indoor bike data: tolerates truncated packets', () => {
  assert.deepEqual(parseIndoorBikeData(dv(0x40, 0x00)), { });
  assert.deepEqual(parseIndoorBikeData(dv(0x40)), {});
});

test('set target power encoding', () => {
  assert.deepEqual([...encodeSetTargetPower(250)], [0x05, 0xfa, 0x00]);
  assert.deepEqual([...encodeSetTargetPower(1000.4)], [0x05, 0xe8, 0x03]);
});

test('control point response', () => {
  assert.deepEqual(parseControlPointResponse(dv(0x80, 0x05, 0x01)), { opcode: 5, result: 1 });
  assert.equal(parseControlPointResponse(dv(0x05, 0x01)), null);
});

test('heart rate 8 and 16 bit', () => {
  assert.equal(parseHeartRate(dv(0x00, 150)), 150);
  assert.equal(parseHeartRate(dv(0x01, 0x2c, 0x01)), 300);
});
