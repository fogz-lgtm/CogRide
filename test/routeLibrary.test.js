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

test('punchy routes: real loops on real roads, with named climbs and cobbles', async () => {
  const catalog = await loadCatalog(fetchFile);
  const want = {
    'flanders-finale': ['Koppenberg', 'Oude Kwaremont', 'Paterberg'],
    'amstel-limburg': ['Keutenberg', 'Eyserbosweg', 'Fromberg', 'Cauberg'],
    'three-bears': ['Castro Ranch Rd', 'Mama Bear', 'Papa Bear', 'Baby Bear'],
  };
  for (const [id, names] of Object.entries(want)) {
    const def = catalog.find((d) => d.id === id);
    assert.ok(def?.loop && def.geometry, id);
    assert.deepEqual(def.climbs.map((k) => k.name), names);
    const r = await loadRoute(id, fetchFile);
    assert.ok(r.lat && r.lon, `${id} follows the real road`);
    for (const k of def.climbs) {
      assert.ok(k.startM < k.endM && k.endM <= def.lengthM, `${id} ${k.name}`);
      const rise = r.elevationAt(k.endM) - r.elevationAt(k.startM);
      assert.ok(Math.abs(rise - k.gainM) < 4, `${id} ${k.name} rises ${rise.toFixed(1)} vs ${k.gainM}`);
      assert.ok(k.max100mPct >= k.avgPct);
    }
  }
  const flanders = await loadRoute('flanders-finale', fetchFile);
  for (const k of flanders.climbs) assert.equal(flanders.surfaceAt((k.startM + k.endM) / 2), 'cobbles', k.name);
  const kopp = flanders.climbs[0];
  assert.ok(kopp.avgPct > 9 && kopp.max100mPct > 15, 'the Koppenberg is a wall');
  // Real places: Kluisbergen, Valkenburg, Orinda, Albany.
  assert.ok(Math.abs(flanders.lat[0] - 50.78) < 0.03 && Math.abs(flanders.lon[0] - 3.53) < 0.06);
  const marin = catalog.find((d) => d.id === 'marin-ave');
  assert.equal(marin.loop, false);
  assert.ok(marin.climbs[0].avgPct > 14, 'Marin averages ~15 % from the circle');
  assert.ok(marin.maxGradientPct > 20);
});
