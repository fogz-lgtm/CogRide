import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildRoute, routeFromPoints } from '../js/core/route.js';
import { themeFor, timeOfDayNow, regionFor, TIMES } from '../js/world/themes.js';
import { createContext, buildLeaf, LEVELS } from '../js/world/chunks.js';
import { RoadIndex } from '../js/world/terrain.js';

const catalog = JSON.parse(readFileSync(new URL('../data/routes/catalog.json', import.meta.url), 'utf8')).routes;

function load(id) {
  const def = catalog.find((r) => r.id === id);
  const file = new URL(`../data/routes/geometry/${id}.json`, import.meta.url);
  const geo = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  return buildRoute(def, geo);
}

// CIE L* of an sRGB hex colour.
function lstar(hex) {
  const v = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

test('time of day follows the Evening Edition clock', () => {
  const at = (h, m) => timeOfDayNow(new Date(2026, 9, 10, h, m));
  assert.equal(at(12, 0), 'golden');
  assert.equal(at(19, 29), 'golden');
  assert.equal(at(19, 30), 'dusk');
  assert.equal(at(20, 29), 'dusk');
  assert.equal(at(20, 30), 'night');
  assert.equal(at(23, 15), 'night');
  assert.equal(at(3, 0), 'night');
  assert.equal(timeOfDayNow(new Date(2026, 9, 10, 22, 0), { alwaysGolden: true }), 'golden');
});

test('every route has a complete palette for every time of day, and the sky is never too dark', () => {
  const hex = /^#[0-9A-Fa-f]{6}$/;
  for (const def of catalog) {
    const route = load(def.id);
    for (const tod of TIMES) {
      const t = themeFor(route, tod);
      assert.equal(t.timeOfDay, tod);
      for (const k of ['top', 'mid', 'horizon', 'glow', 'ground']) assert.match(t.sky[k], hex, `${def.id}/${tod} sky.${k}`);
      assert.match(t.fog.color, hex);
      assert.ok(t.fog.far > t.fog.near && t.fog.max > 0 && t.fog.max < 1);
      for (const [k, pair] of Object.entries(t.ground)) {
        assert.match(pair[0], hex, `${def.id}/${tod} ground.${k}`);
        assert.match(pair[1], hex);
      }
      assert.match(t.road.asphalt, hex);
      // Spec §6.2: zenith never below L* 10, horizon never below L* 25.
      assert.ok(lstar(t.sky.top) >= 10, `${def.id}/${tod} zenith L* ${lstar(t.sky.top).toFixed(1)}`);
      assert.ok(lstar(t.sky.horizon) >= 25, `${def.id}/${tod} horizon L* ${lstar(t.sky.horizon).toFixed(1)}`);
      // Plain data (the worker receives it by structured clone).
      assert.doesNotThrow(() => structuredClone(t));
    }
  }
});

test('biomes: the spec routes land in the right palettes', () => {
  const r = (id) => regionFor({ id });
  assert.equal(r('alpe-dhuez'), 'alpine');
  assert.equal(r('stelvio-prato'), 'alpine');
  assert.equal(r('mont-ventoux-bedoin'), 'provence');
  assert.equal(r('mount-diablo-south-gate'), 'bayhills');
  assert.equal(r('cathedral-redwoods'), 'redwood');
  assert.equal(r('fogline-coast'), 'coast');
});

function syntheticRun({ lat = 37.8605, lon = -122.2201, withEle = true } = {}) {
  const points = [];
  let hdg = 0.6;
  for (let i = 0; i < 700; i++) {
    hdg += Math.sin(i / 53) * 0.035;
    lat += Math.cos(hdg) * 0.000054;
    lon += Math.sin(hdg) * 0.000068;
    points.push({ lat, lon, ele: withEle ? 210 + 160 * Math.sin((i / 700) * Math.PI) : null });
  }
  return routeFromPoints({ name: 'Trail run', points, id: 'run-test', kind: 'imported' });
}

test('imported runs render as a narrow singletrack without lane paint', () => {
  const t = themeFor(syntheticRun(), 'night');
  assert.equal(t.road.kind, 'trail');
  assert.ok(t.road.halfWidth * 2 <= 1.25);
  assert.equal(t.road.centre, null);
  assert.equal(t.road.edge, null);
  assert.equal(t.biome, 'bayhills'); // East Bay
  // No elevation data at all still builds.
  const flat = syntheticRun({ withEle: false });
  const ctx = createContext(flat, themeFor(flat, 'golden'));
  const s = flat.stateAt(1000);
  const leaf = buildLeaf(ctx, 0, Math.floor(s.x / LEVELS[0].size), Math.floor(s.z / LEVELS[0].size));
  assert.ok(leaf.triangles > 1000);
});

test('loops without lat/lon build (fictional routes)', () => {
  const route = load('cathedral-redwoods');
  assert.equal(route.lat, null);
  const ctx = createContext(route, themeFor(route, 'night'));
  const s = route.stateAt(3000);
  const leaf = buildLeaf(ctx, 0, Math.floor(s.x / 512), Math.floor(s.z / 512));
  assert.ok(leaf.parts.length >= 1);
});

test('chunk builds are deterministic and within budget', () => {
  const route = load('alpe-dhuez');
  const theme = themeFor(route, 'dusk');
  const a = createContext(route, theme);
  const b = createContext(route, theme);
  const s = route.stateAt(5200);
  for (let level = 0; level < LEVELS.length; level++) {
    const size = LEVELS[level].size;
    const ix = Math.floor(s.x / size);
    const iz = Math.floor(s.z / size);
    const la = buildLeaf(a, level, ix, iz);
    const lb = buildLeaf(b, level, ix, iz);
    assert.equal(la.triangles, lb.triangles);
    assert.deepEqual(la.parts.map((p) => p.vertices), lb.parts.map((p) => p.vertices));
    assert.deepEqual(Array.from(la.parts[0].paint.subarray(0, 400)), Array.from(lb.parts[0].paint.subarray(0, 400)));
    // Generous per-leaf ceilings (the visible total stays ≤ 120k).
    assert.ok(la.triangles < [32000, 16000, 6000, 3000, 2000][level], `L${level}: ${la.triangles}`);
    for (const p of la.parts) {
      assert.equal(p.position.length, p.vertices * 3);
      assert.equal(p.paint.length, p.vertices * 4);
      assert.ok(p.position.every(Number.isFinite));
    }
  }
});

// Height of the leaf's ground (aux 0) surface under (x, zRoute), or null.
function groundUnder(leaf, x, z) {
  const zw = -z;
  let best = null;
  for (const part of leaf.parts) {
    const P = part.position;
    const A = part.paint;
    for (let v = 0; v < part.vertices; v += 3) {
      if (A[v * 4 + 3] !== 0 || A[v * 4 + 7] !== 0 || A[v * 4 + 11] !== 0) continue;
      const ax = P[v * 3];
      const az = P[v * 3 + 2];
      const bx = P[v * 3 + 3];
      const bz = P[v * 3 + 5];
      const cx = P[v * 3 + 6];
      const cz = P[v * 3 + 8];
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-9) continue; // vertical skirt
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (zw - cz)) / det;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (zw - cz)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * P[v * 3 + 1] + l2 * P[v * 3 + 4] + l3 * P[v * 3 + 7];
      best = best == null ? y : Math.max(best, y);
    }
  }
  return best;
}

test('near terrain never pokes through the road (cuts, stacked hairpins)', () => {
  for (const [id, from, to] of [['alpe-dhuez', 1300, 3200], ['stelvio-prato', 7800, 8300]]) {
    const route = load(id);
    const ctx = createContext(route, themeFor(route, 'golden'));
    const leaves = new Map();
    let checked = 0;
    for (let d = from; d <= to; d += 23) {
      const s = route.stateAt(d);
      const key = `${Math.floor(s.x / 512)},${Math.floor(s.z / 512)}`;
      if (!leaves.has(key)) leaves.set(key, buildLeaf(ctx, 0, Math.floor(s.x / 512), Math.floor(s.z / 512)));
      const rx = Math.cos(s.heading);
      const rz = -Math.sin(s.heading);
      for (const o of [-2.5, 0, 2.5]) {
        const g = groundUnder(leaves.get(key), s.x + rx * o, s.z + rz * o);
        if (g == null) continue;
        checked++;
        assert.ok(g <= s.elevation + 0.05, `${id} at ${d} m (offset ${o}): ground ${g.toFixed(2)} above road ${s.elevation.toFixed(2)}`);
      }
    }
    assert.ok(checked > 40, `${id}: only ${checked} checks`);
  }
});

test('bulk fill matches point queries', () => {
  const route = load('mount-diablo-south-gate');
  const ctx = createContext(route, themeFor(route, 'night'));
  const s = route.stateAt(6000);
  const n = 9;
  const step = 10;
  const px = new Float64Array(n * n);
  const pz = new Float64Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    px[j * n + i] = s.x - 40 + i * step + Math.sin(i * 7 + j) * 2;
    pz[j * n + i] = s.z - 40 + j * step + Math.cos(i + j * 3) * 2;
  }
  const h = new Float32Array(n * n);
  const d = new Float32Array(n * n);
  ctx.field.fill(px, pz, n, n, s.x - 40, s.z - 40, step, h, d);
  for (let k = 0; k < n * n; k++) assert.ok(Math.abs(h[k] - ctx.field.height(px[k], pz[k])) < 0.02, `k=${k}`);
});

test('road index nearest() agrees with brute force', () => {
  const route = load('alpe-dhuez');
  const index = new RoadIndex(route);
  const xs = route.x;
  const zs = route.z;
  for (let k = 0; k < 60; k++) {
    const s = route.stateAt((k * 977) % route.length);
    const x = s.x + Math.sin(k) * 70;
    const z = s.z + Math.cos(k * 1.3) * 70;
    let best = Infinity;
    for (let i = 0; i < xs.length - 1; i++) {
      const ex = xs[i + 1] - xs[i];
      const ez = zs[i + 1] - zs[i];
      const l2 = ex * ex + ez * ez || 1;
      const t = Math.max(0, Math.min(1, ((x - xs[i]) * ex + (z - zs[i]) * ez) / l2));
      best = Math.min(best, Math.hypot(xs[i] + ex * t - x, zs[i] + ez * t - z));
    }
    const near = index.nearest(x, z, 400);
    assert.ok(Math.abs(near.distance - best) < 1e-6, `${near.distance} vs ${best}`);
  }
});
