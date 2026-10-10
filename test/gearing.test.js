import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GEAR_RATIOS, START_GEAR, ratioFor, clampGear, feltGrade, slew, gearedSimulation, estimatePhysicalRatio } from '../js/core/gearing.js';
import { encodeSimulation } from '../js/devices/ftmsTrainer.js';

const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join(' ');

test('Zwift gear table', () => {
  assert.equal(GEAR_RATIOS.length, 24);
  assert.equal(GEAR_RATIOS[0], 0.75);
  assert.equal(GEAR_RATIOS[12], 2.61);
  assert.equal(GEAR_RATIOS[23], 5.49);
  assert.equal(ratioFor(START_GEAR), 1.68);
  assert.equal(clampGear(0), 1);
  assert.equal(clampGear(30), 24);
});

test('felt grade: difficulty, halved descents, KICKR limits', () => {
  assert.equal(feltGrade(10, 0.5), 5);
  assert.equal(feltGrade(-10, 1), -5);
  assert.equal(feltGrade(-10, 0.5), -2.5);
  assert.equal(feltGrade(30, 1), 16);
  assert.equal(slew(0, 5, 1), 1);
  assert.equal(slew(0, -0.2, 1), -0.2);
});

test('geared FTMS simulation reproduces the road at gear speed', () => {
  // k = 1: unchanged road
  const same = gearedSimulation({ gradePct: 5, gearRatio: 2.4, physicalRatio: 2.4 });
  assert.ok(Math.abs(same.gradePct - 5) < 1e-9);
  assert.ok(Math.abs(same.crr - 0.004) < 1e-9);
  assert.ok(Math.abs(same.cw - 0.51) < 1e-9);
  // power equivalence: F'(v)·v == F(k v)·(k v) at any trainer speed
  const m = 85;
  const road = (v, g, crr, cw) => {
    const th = Math.atan(g / 100);
    return m * 9.81 * Math.sin(th) + crr * m * 9.81 * Math.cos(th) + 0.5 * cw * v * v;
  };
  for (const [g, rv, rp] of [[4, 3.03, 2.43], [0, 1.68, 2.43], [-3, 4.24, 3.57], [8, 1.11, 2.43]]) {
    const sim = gearedSimulation({ gradePct: g, gearRatio: rv, physicalRatio: rp, massKg: m });
    const k = rv / rp;
    const vt = 7;
    const trainerPower = road(vt, sim.gradePct, sim.crr, sim.cw) * vt;
    const roadPower = road(k * vt, g, 0.004, 0.51) * k * vt;
    assert.ok(Math.abs(trainerPower - roadPower) / Math.max(50, Math.abs(roadPower)) < 0.01, `${g}% ${rv}/${rp}: ${trainerPower} vs ${roadPower}`);
  }
  // overflow of Cw folds into grade at the given trainer speed
  const big = gearedSimulation({ gradePct: 0, gearRatio: 5.49, physicalRatio: 2.43, trainerSpeedMps: 8, massKg: m });
  assert.equal(big.cw, 2.55);
  assert.ok(big.gradePct > 0);
  const tp = road(8, big.gradePct, big.crr, big.cw) * 8;
  const rp = road(8 * big.k, 0, 0.004, 0.51) * 8 * big.k;
  assert.ok(Math.abs(tp - rp) / rp < 0.02, `${tp} vs ${rp}`);
});

test('physical ratio estimate and FTMS encoding', () => {
  assert.ok(Math.abs(estimatePhysicalRatio(8.48, 80) - 3.03) < 0.01);
  assert.equal(estimatePhysicalRatio(0, 80), null);
  assert.equal(toHex(encodeSimulation({ gradePct: 5, crr: 0.004, cw: 0.51 })), '11 00 00 f4 01 28 33');
  assert.equal(toHex(encodeSimulation({ gradePct: -2.5 })), '11 00 00 06 ff 28 33');
});
