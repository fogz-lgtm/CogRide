import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedTrainer, cadenceForPower, trainerRoadPower } from '../js/devices/simulator.js';

test('rider model: same effort, harder gear → lower cadence', () => {
  const easy = cadenceForPower(180, 2.04, 0, 82);
  const hard = cadenceForPower(180, 3.03, 0, 82);
  assert.ok(hard < easy, `${hard} vs ${easy}`);
  assert.ok(Math.abs(trainerRoadPower(hard, 3.03, 0, 82) - 180) < 2);
});

test('shifting up makes the pedals heavier, then cadence settles', () => {
  const sim = new SimulatedTrainer({ effortWatts: 180, autoStart: false, random: () => 0.5 });
  const samples = [];
  sim.addEventListener('data', (e) => samples.push(e.detail));
  sim.setTarget({ mode: 'sim', gradePct: 0, gear: 12 });
  for (let i = 0; i < 80; i++) sim.step(0.25);
  const settled = samples.at(-1);
  assert.ok(Math.abs(settled.power - 180) < 10, JSON.stringify(settled));
  sim.setTarget({ mode: 'sim', gradePct: 0, gear: 14 });
  sim.step(0.25);
  assert.ok(samples.at(-1).power > settled.power + 20, 'immediate jump in resistance');
  for (let i = 0; i < 80; i++) sim.step(0.25);
  assert.ok(samples.at(-1).cadence < settled.cadence - 5, 'cadence drops in a harder gear');
  assert.ok(Math.abs(samples.at(-1).power - 180) < 10);
});

test('ERG holds the target', () => {
  const sim = new SimulatedTrainer({ autoStart: false, random: () => 0.5 });
  let last;
  sim.addEventListener('data', (e) => (last = e.detail));
  sim.setTarget({ mode: 'erg', watts: 220 });
  for (let i = 0; i < 60; i++) sim.step(0.25);
  assert.ok(Math.abs(last.power - 220) < 3);
  assert.ok(last.cadence > 80);
});
