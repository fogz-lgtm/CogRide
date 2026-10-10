import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedPower, summarize, toTcx } from '../js/recorder.js';

const samples = Array.from({ length: 3600 }, (_, i) => ({
  time: Date.UTC(2026, 0, 1, 7) + i * 1000,
  power: 200,
  cadence: 90,
  heartRate: 140,
  speed: 9,
  distance: (i + 1) * 9,
}));

test('steady hour at FTP is 100 TSS', () => {
  const s = summarize(samples, 200);
  assert.equal(s.durationS, 3600);
  assert.equal(s.avgPower, 200);
  assert.equal(s.normalizedPower, 200);
  assert.equal(s.tss, 100);
  assert.equal(s.intensityFactor, 1);
  assert.equal(s.kilojoules, 720);
  assert.equal(s.avgHeartRate, 140);
});

test('NP exceeds average for variable efforts', () => {
  const powers = Array.from({ length: 600 }, (_, i) => (Math.floor(i / 60) % 2 ? 300 : 100));
  assert.ok(normalizedPower(powers) > 200);
});

test('TCX contains trackpoints with power', () => {
  const xml = toTcx(samples.slice(0, 3), 200);
  assert.match(xml, /<Activity Sport="Biking">/);
  assert.equal(xml.match(/<Trackpoint>/g).length, 3);
  assert.match(xml, /<Time>2026-01-01T07:00:00Z<\/Time>/);
  assert.match(xml, /<ns3:Watts>200<\/ns3:Watts>/);
  assert.match(xml, /<Cadence>90<\/Cadence>/);
  assert.throws(() => toTcx([], 200));
});
