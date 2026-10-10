import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCatalog, loadRoute, sparkline } from '../js/core/routeLibrary.js';
import { STEP_M } from '../js/core/route.js';

// Serve the data folder through a fetch shim.
const fetchFile = async (url) => {
  try {
    const body = await readFile(new URL(url));
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

test('every catalog route builds and keeps its published stats', async () => {
  const catalog = await loadCatalog(fetchFile);
  assert.ok(catalog.length >= 15);
  for (const def of catalog) {
    const r = await loadRoute(def.id, fetchFile);
    assert.ok(Math.abs(r.length - def.lengthM) <= STEP_M, `${def.id} length`);
    if (def.loop) {
      const n = r.x.length - 1;
      assert.ok(Math.hypot(r.x[n] - r.x[0], r.z[n] - r.z[0]) < 1, `${def.id} closes`);
      assert.ok(Math.abs(r.elevation[n] - r.elevation[0]) < 0.01, `${def.id} elevation closes`);
    } else {
      assert.ok(r.lat && r.lon, `${def.id} has real coordinates`);
      const top = r.elevationAt(r.length);
      assert.ok(Math.abs(top - def.endElevationM) < 3, `${def.id} top ${top} vs ${def.endElevationM}`);
      // real road: path length ≈ profile length (geometry stretched to fit)
      let len = 0;
      for (let i = 1; i < r.x.length; i++) len += Math.hypot(r.x[i] - r.x[i - 1], r.z[i] - r.z[i - 1]);
      assert.ok(Math.abs(len - r.length) / r.length < 0.05, `${def.id} path ${len} vs ${r.length}`);
    }
  }
});

test('Alpe d’Huez: 21 hairpins in the real road', async () => {
  const r = await loadRoute('alpe-dhuez', fetchFile);
  const virage1 = r.turns.find((t) => t.label === 'Virage 1');
  assert.ok(virage1);
  const s = r.stateAt(5000);
  assert.ok(s.lat > 45 && s.lat < 45.2 && s.lon > 6 && s.lon < 6.1);
  assert.ok(s.grade > 5 && s.grade < 13, `grade ${s.grade}`);
  const line = sparkline((await loadCatalog(fetchFile)).find((d) => d.id === 'alpe-dhuez'), 10);
  assert.equal(line.length, 10);
  assert.ok(line.at(-1) > line[0] + 1000);
});
