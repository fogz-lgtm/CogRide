// Chunk (quadtree leaf) builder: terrain + skirts + road ribbon + props,
// all baked into one non-indexed triangle soup with painterly per-face
// colour. One leaf = one draw call.
//
// Pure JS (no Three.js, no DOM) so it runs in the chunk worker; world.js
// falls back to calling it on the main thread.
//
// Levels (world-aligned quadtree, see world.js):
//   L0 512 m @ 50 (≈ 10 m facets)   terrain, full road with paint + cut banks, all props
//   L1 1024 m @ 40 (≈ 26 m)        simplified road, far props (low-poly versions)
//   L2 2048 m @ 30 (≈ 68 m)        road as a thin strip
//   L3 4096 m @ 24, L4 8192 m @ 20 terrain only (skyline with parallax)

import { RoadIndex, TerrainField, gradNoise } from './terrain.js';
import { SplitBuffer, rgb, hash3, ramp, faceNormal, dirFromAngles, AUX_ROAD } from './paint.js';
import { TEMPLATES, bakeProp, resolveVariants } from './scenery.js';
import { hashString } from '../core/route.js';

export const LEVELS = [
  { size: 512, res: 50 },
  { size: 1024, res: 40 },
  { size: 2048, res: 30 },
  { size: 4096, res: 24 },
  { size: 8192, res: 20 },
];
const ROAD_STRIDE = [1, 2, 5];
// Road row simplification per level: max gap (m), lateral / vertical chord error (m).
const ROAD_SIMPLIFY = [
  { gap: 20, lat: 0.12, vert: 0.08 },
  { gap: 40, lat: 0.4, vert: 0.25 },
  { gap: 100, lat: 1.5, vert: 0.8 },
];

// Low-poly stand-ins for far props (same position, size and colour).
const LOW = { pine: 'pineLow', oak: 'oakLow', juniper: 'oakLow', cypress: 'cypress', redwood: 'redwoodLow' };
TEMPLATES.pineLow = (() => {
  const v = [];
  const s = [];
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * Math.PI * 2;
    const a1 = ((k + 1) / 6) * Math.PI * 2;
    v.push(Math.cos(a0) * 0.3, 0.1, Math.sin(a0) * 0.3, 0, 1, 0, Math.cos(a1) * 0.3, 0.1, Math.sin(a1) * 0.3);
    s.push(0);
  }
  return { v: Float32Array.from(v), s: Uint8Array.from(s), tris: 6 };
})();
TEMPLATES.oakLow = (() => {
  const v = [];
  const s = [];
  const top = [0, 1, 0];
  for (let k = 0; k < 5; k++) {
    const a0 = (k / 5) * Math.PI * 2;
    const a1 = ((k + 1) / 5) * Math.PI * 2;
    const p0 = [Math.cos(a0) * 0.5, 0.55, Math.sin(a0) * 0.5];
    const p1 = [Math.cos(a1) * 0.5, 0.55, Math.sin(a1) * 0.5];
    v.push(...p0, ...top, ...p1);
    v.push(...p1, 0, 0.3, 0, ...p0);
    s.push(0, 0);
  }
  return { v: Float32Array.from(v), s: Uint8Array.from(s), tris: 10 };
})();

function mixRgb(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function smoothstep(a, b, x) {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------- context

// route: { id, x, z, elevation, loop, minElevation, maxElevation } (typed arrays ok)
// `prev`: a previous context for the same route; its road index and terrain
// field are reused when only colours changed (e.g. dusk → night).
export function createContext(route, theme, prev = null) {
  const seed = hashString(String(route.id ?? 'route')) % 100000;
  const T = theme.terrain;
  const R = theme.road;
  const trail = R.kind === 'trail';
  const bedHalf = R.halfWidth + R.shoulderWidth;
  const shapeKey = JSON.stringify([route.id, route.x.length, T, R.kind, R.halfWidth, R.shoulderWidth]);
  const reuse = prev && prev.shapeKey === shapeKey;
  const index = reuse ? prev.index : new RoadIndex(route);
  const field = reuse ? prev.field : new TerrainField(index, {
    seed,
    hillAmp: T.hillAmp,
    hillWave: T.hillWave,
    roadHalfWidth: bedHalf,
    flat: trail ? 1.2 : 2.5,
    feather: trail ? 14 : 24,
    featherUp: trail ? 6 : 9,
    mountains: T.mountains,
    floor: T.floor,
    ocean: T.ocean,
    peaks: T.peaks,
    summitCap: T.summitCap,
    dome: T.summitCap ? { x: T.summitCap.x, z: T.summitCap.z, floor: T.floor } : null,
    rubbleAbove: T.capLine ?? null,
    mesas: T.mesas ? { amp: 150, wave: 1500, near: 400, far: 1600 } : null,
    basins: T.basins ? { amp: 36, wave: 700, near: 50, far: 320 } : null,
  });
  const roadRowsReused = reuse ? prev.roadRows : null;
  const ground = {};
  for (const [k, v] of Object.entries(theme.ground)) ground[k] = [rgb(v[0]), rgb(v[1])];
  const props = {};
  for (const [k, v] of Object.entries(theme.props)) props[k] = resolveVariants(v);
  const L = dirFromAngles(theme.light.bearing, Math.max(8, theme.light.elevation));
  const shade = (hex, k) => {
    const c = rgb(hex);
    return [c[0] * k, c[1] * k, c[2] * k];
  };
  const road = {
    asphalt: [shade(R.asphalt, 1.06), shade(R.asphalt, 0.86)],
    edge: R.edge ? [rgb(R.edge), shade(R.edge, 0.8)] : null,
    centre: R.centre ? [rgb(R.centre), shade(R.centre, 0.8)] : null,
    shoulder: [rgb(R.shoulder), shade(R.shoulder, 0.75)],
    cut: ground.cut ?? ground.rock ?? [rgb('#8A7A70'), rgb('#4A4040')],
    verge: ground.verge ?? [rgb(R.shoulder), shade(R.shoulder, 0.7)],
  };
  if (trail) {
    // Singletrack: grass verges right up to the packed earth.
    const grass = ground.grass ?? ground.meadow ?? ground.floor ?? ground.sage ?? ground.scrub ?? road.verge;
    road.verge = grass;
    road.shoulder = [mixRgb(road.asphalt[0], grass[0], 0.8), mixRgb(road.asphalt[1], grass[1], 0.8)];
    road.cut = [mixRgb(road.asphalt[0], grass[0], 0.4), mixRgb(road.asphalt[1], grass[1], 0.4)];
  }
  const rim = theme.rim ? { color: rgb(theme.rim.color), amount: theme.rim.amount, from: theme.rim.from } : null;
  const ctx = {
    route,
    theme,
    seed,
    shapeKey,
    index,
    field,
    ground,
    props,
    road,
    rim,
    L,
    trail,
    hw: R.halfWidth,
    so: bedHalf,
    vergeD: trail ? 0 : bedHalf + 3.2, // trails: grass right up to the earth
    // Near chunks: the road ribbon carries the true ground out to `cover`
    // metres (cut bank, verges); the coarse terrain beneath is trenched.
    // cover ≥ trench + one cell diagonal (L0 cells ≈ 10 m).
    cover: bedHalf + 31,
    biome: theme.biome,
    T,
    water: theme.water ? theme.water.level : null,
    rampLo: theme.timeOfDay === 'night' ? -0.35 : -0.25,
    rampHi: theme.timeOfDay === 'night' ? 0.9 : 0.8,
    n: route.x.length,
    _q: { distance: 0, y: 0, d: 0, side: 0, i: 0, t: 0 },
  };
  ctx.classify = CLASSIFIERS[theme.biome] ?? CLASSIFIERS.bayhills;
  ctx.roadRows = roadRowsReused && (prev.theme.road.centreStyle === 'dash') === (R.centreStyle === 'dash') ? roadRowsReused : ROAD_STRIDE.map((stride, level) => simplifyRoad(route, stride, ROAD_SIMPLIFY[level], level === 0 && R.centreStyle === 'dash'));
  return ctx;
}

// Greedy, route-global row selection (so neighbouring chunks agree): a row
// is kept when skipping it would bend the chord too far from the road.
// Returns next[i] = index of the next kept row after kept row i (−1 if not kept).
function simplifyRoad(route, stride, lim, keepAll) {
  const xs = route.x;
  const zs = route.z;
  const ys = route.elevation;
  const n = xs.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  let last = 0;
  for (let i = stride; i < n - 1; i += stride) {
    if (keepAll) {
      keep[i] = 1;
      continue;
    }
    const j = Math.min(n - 1, i + stride);
    let bad = (j - last) * 5 > lim.gap;
    if (!bad) {
      const cx = xs[j] - xs[last];
      const cz = zs[j] - zs[last];
      const cl = Math.hypot(cx, cz) || 1;
      for (let k = last + 1; k < j && !bad; k++) {
        const lat = Math.abs((xs[k] - xs[last]) * cz - (zs[k] - zs[last]) * cx) / cl;
        const t = (k - last) / (j - last);
        const vert = Math.abs(ys[k] - (ys[last] + (ys[j] - ys[last]) * t));
        if (lat > lim.lat || vert > lim.vert) bad = true;
      }
    }
    if (bad) {
      keep[i] = 1;
      last = i;
    }
  }
  const next = new Int32Array(n).fill(-1);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    if (prev >= 0) next[prev] = i;
    prev = i;
  }
  return next;
}

// ---------------------------------------------------------------- ground materials

// (ctx, y, slope = tan θ, north = facing-north component, d = road distance, x, z) → ground key
const CLASSIFIERS = {
  alpine(c, y, s, north, d, n1, n2) {
    const T = c.T;
    if (c.water != null && y < c.water + 0.4) return 'scree';
    const snow = T.snowLine + n1 * 120 + n2 * 45 - north * 60;
    if (y > snow) return s > 1.25 ? 'rock' : 'snow';
    if (d < c.vergeD) return 'verge';
    if (s > 1.45) return d < 260 ? 'crag' : 'rock';
    const tl = (T.treeLine ?? 2100) + n1 * 130;
    if (y > tl) return s > 0.75 ? 'scree' : 'pasture';
    if (s > 0.95 && n2 > 0.2) return d < 260 ? 'crag' : 'rock';
    // Meadows along the road, forest on the slopes beyond.
    const f = n1 * 0.9 + n2 * 0.35 + (s - 0.3) * 0.5 + north * 0.2 - 0.32 * (1 - smoothstep(30, 240, d));
    return f > 0.02 ? 'forest' : y < (T.floor ?? 0) + 60 ? 'pasture' : 'meadow';
  },
  provence(c, y, s, north, d, n1, n2) {
    const cap = (c.T.capLine ?? 1500) + n1 * 70 + n2 * 25;
    if (y > cap) return s > 1.1 ? 'rock' : 'cap';
    if (s > 1.15) return 'rock';
    if (d < c.vergeD) return 'verge';
    if (y < 620 + n1 * 50 && s < 0.32 && n2 > -0.3) return 'field';
    return n1 + n2 * 0.4 + (y - 600) * 0.0008 > -0.3 ? 'forest' : 'scrub';
  },
  mallorca(c, y, s, north, d, n1, n2) {
    if (y < 2.5) return 'sand';
    if (s > 0.85) return 'cliff';
    if (d < c.vergeD) return 'verge';
    if (y > 320 + n1 * 90 && n2 > -0.15) return 'rock';
    return n1 > 0.3 ? 'meadow' : 'scrub';
  },
  bayhills(c, y, s, north, d, n1, n2) {
    if (c.water != null && y < 1.5) return 'dry';
    if (s > 1.05) return 'rock';
    if (d < c.vergeD) return 'verge';
    const oak = north * 0.85 + n1 * 0.6 + n2 * 0.25 - (s < 0.12 ? 0.35 : 0);
    if (oak > 0.32) return 'oakwood';
    if (y > 650 && s > 0.45 && n2 > 0.12) return 'chaparral';
    return n2 + n1 * 0.3 > 0.28 ? 'dry' : 'grass';
  },
  tam(c, y, s, north, d, n1, n2) {
    if (c.water != null && y < 1.5) return 'dry';
    if (s > 1.05) return 'rock';
    if (d < c.vergeD) return 'verge';
    if (y < 330 + n1 * 70 && (north > -0.15 || n1 > 0.15)) return 'grove';
    return CLASSIFIERS.bayhills(c, y, s, north, d, n1, n2);
  },
  redwood(c, y, s, north, d, n1, n2) {
    if (s > 1.2) return 'rock';
    if (d < c.vergeD) return 'verge';
    return n2 > 0.3 ? 'moss' : 'floor';
  },
  coast(c, y, s, north, d, n1, n2) {
    if (y < 3 + n2 * 2) return 'sand';
    if (s > 0.85) return 'rock';
    if (d < c.vergeD) return 'verge';
    return n1 + n2 * 0.4 > 0.12 ? 'grass' : 'scrub';
  },
  lakes(c, y, s, north, d, n1, n2) {
    if (c.water != null && y < c.water + 0.3) return 'granite';
    if (y > c.T.snowLine + n1 * 100) return 'snow';
    if (s > 0.7 || n1 > 0.42) return 'granite';
    if (d < c.vergeD) return 'verge';
    return n2 + n1 * 0.5 > 0.05 ? 'forest' : 'meadow';
  },
  mesa(c, y, s, north, d, n1, n2) {
    if (y > c.T.snowLine) return 'snow';
    if (s > 0.7) return 'rim';
    if (s > 0.25) return 'ochre';
    if (d < c.vergeD) return 'verge';
    return n2 > 0.42 ? 'wash' : 'sage';
  },
};

const tmpN = [0, 0, 0];
const tmpC = [0, 0, 0];
const tmpLit = [0, 0, 0];

// Colour for a ground face; returns tmpC.
function paintGround(ctx, ax, ay, az, bx, by, bz, cx, cy, cz, d, noise) {
  faceNormal(tmpN, ax, ay, az, bx, by, bz, cx, cy, cz);
  const ny = tmpN[1] > 0.02 ? tmpN[1] : 0.02;
  const slope = Math.sqrt(Math.max(0, 1 - ny * ny)) / ny;
  const north = -tmpN[2];
  const y = (ay + by + cy) / 3;
  const x = (ax + bx + cx) / 3;
  const z = -(az + bz + cz) / 3;
  const n1 = gradNoise(x / 260, z / 260, ctx.seed + 5);
  const n2 = gradNoise(x / 70, z / 70, ctx.seed + 9);
  const key = ctx.classify(ctx, y, slope, north, d, n1, n2);
  const pal = ctx.ground[key] ?? ctx.ground.verge;
  let lit = pal[0];
  const rim = ctx.rim;
  if (rim && y > rim.from - 200) {
    const a = rim.amount * smoothstep(rim.from - 200 + n1 * 80, rim.from + 260, y);
    tmpLit[0] = lit[0] + (rim.color[0] - lit[0]) * a;
    tmpLit[1] = lit[1] + (rim.color[1] - lit[1]) * a;
    tmpLit[2] = lit[2] + (rim.color[2] - lit[2]) * a;
    lit = tmpLit;
  }
  const L = ctx.L;
  const crisp = key === 'cap' || key === 'snow';
  const t = ramp(tmpN[0] * L[0] + tmpN[1] * L[1] + tmpN[2] * L[2], crisp ? ctx.rampLo + 0.3 : ctx.rampLo, crisp ? ctx.rampHi - 0.1 : ctx.rampHi);
  const sh = pal[1];
  const k = 1 + (noise - 0.5) * 0.08;
  tmpC[0] = (sh[0] + (lit[0] - sh[0]) * t) * k;
  tmpC[1] = (sh[1] + (lit[1] - sh[1]) * t) * k;
  tmpC[2] = (sh[2] + (lit[2] - sh[2]) * t) * k;
  return key;
}

// Painterly colour for any surface with [lit, shade]; returns tmpC.
function paintSurface(ctx, pal, ax, ay, az, bx, by, bz, cx, cy, cz, noise) {
  faceNormal(tmpN, ax, ay, az, bx, by, bz, cx, cy, cz);
  const L = ctx.L;
  const t = ramp(tmpN[0] * L[0] + tmpN[1] * L[1] + tmpN[2] * L[2], ctx.rampLo, ctx.rampHi);
  const lit = pal[0];
  const sh = pal[1];
  const k = 1 + (noise - 0.5) * 0.08;
  tmpC[0] = (sh[0] + (lit[0] - sh[0]) * t) * k;
  tmpC[1] = (sh[1] + (lit[1] - sh[1]) * t) * k;
  tmpC[2] = (sh[2] + (lit[2] - sh[2]) * t) * k;
  return tmpC;
}

// ---------------------------------------------------------------- leaf

export function buildLeaf(ctx, level, ix, iz) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { size, res } = LEVELS[level];
  const step = size / res;
  const x0 = ix * size;
  const z0 = iz * size;
  const n = res + 1;
  const N = n * n;
  const px = new Float64Array(N);
  const pz = new Float64Array(N);
  const h = new Float32Array(N);
  const dd = new Float32Array(N);
  const gi0 = ix * res;
  const gj0 = iz * res;
  const jit = 0.3 * step;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const gi = gi0 + i;
      const gj = gj0 + j;
      const jx = i === 0 || i === res ? 0 : (hash3(gi, gj, 17 + level) - 0.5) * 2 * jit;
      const jz = j === 0 || j === res ? 0 : (hash3(gi, gj, 29 + level) - 0.5) * 2 * jit;
      px[k] = x0 + i * step + jx;
      pz[k] = z0 + j * step + jz;
    }
  }
  const bed = level === 0 ? new Float32Array(N) : null;
  const reach = ctx.so + step * 1.45;
  ctx.field.fill(px, pz, n, n, x0, z0, step, h, dd, bed, reach);
  if (bed) {
    // Trench under the near-road ribbon (below every road leg within reach)
    // so coarse triangles can't bridge a cut, or the gap between stacked
    // hairpins, and poke over the road. The ribbon carries the real shape.
    for (let k = 0; k < N; k++) {
      if (bed[k] === bed[k] && h[k] > bed[k] - 0.25) h[k] = bed[k] - 0.25;
    }
  }
  const tHeights = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;

  const buf = new SplitBuffer(x0, z0, size, level === 0, res * res * 2 + res * 8 + 4096);
  const cellCol = new Float32Array(res * res * 3);

  // Terrain faces (alternating diagonals, so no grid stripes).
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const k00 = j * n + i;
      const k10 = k00 + 1;
      const k01 = k00 + n;
      const k11 = k01 + 1;
      const gi = gi0 + i;
      const gj = gj0 + j;
      const flip = hash3(gi, gj, 41 + level) < 0.5;
      const A = flip ? [k00, k10, k01] : [k00, k10, k11];
      const B = flip ? [k10, k11, k01] : [k00, k11, k01];
      for (let tIdx = 0; tIdx < 2; tIdx++) {
        const f = tIdx === 0 ? A : B;
        const a = f[0];
        const b = f[1];
        const c = f[2];
        const dRoad = (dd[a] + dd[b] + dd[c]) / 3;
        paintGround(ctx, px[a], h[a], -pz[a], px[b], h[b], -pz[b], px[c], h[c], -pz[c], dRoad, hash3(gi, gj, 53 + tIdx));
        buf.at((px[a] + px[b] + px[c]) / 3, -(pz[a] + pz[b] + pz[c]) / 3);
        if (tIdx === 0) {
          const ci = (j * res + i) * 3;
          cellCol[ci] = tmpC[0];
          cellCol[ci + 1] = tmpC[1];
          cellCol[ci + 2] = tmpC[2];
        }
        buf.tri(px[a], h[a], -pz[a], px[b], h[b], -pz[b], px[c], h[c], -pz[c], tmpC);
      }
    }
  }

  // Skirts hide cracks against neighbours at another level.
  const drop = step * 0.7 + 2;
  const skirtCol = [0, 0, 0];
  const skirt = (ka, kb, cell, ox, oz) => {
    skirtCol[0] = cellCol[cell * 3] * 0.85;
    skirtCol[1] = cellCol[cell * 3 + 1] * 0.85;
    skirtCol[2] = cellCol[cell * 3 + 2] * 0.85;
    const ax = px[ka];
    const ay = h[ka];
    const az = -pz[ka];
    const bx = px[kb];
    const by = h[kb];
    const bz = -pz[kb];
    buf.at((ax + bx) / 2, (az + bz) / 2);
    // outward (world): (ox, -oz)
    const ex = bx - ax;
    const ez = bz - az;
    const outward = ez * ox - ex * -oz; // sign of (edge × down)·out
    if (outward < 0) {
      buf.tri(ax, ay, az, bx, by - drop, bz, bx, by, bz, skirtCol);
      buf.tri(ax, ay, az, ax, ay - drop, az, bx, by - drop, bz, skirtCol);
    } else {
      buf.tri(ax, ay, az, bx, by, bz, bx, by - drop, bz, skirtCol);
      buf.tri(ax, ay, az, bx, by - drop, bz, ax, ay - drop, az, skirtCol);
    }
  };
  for (let i = 0; i < res; i++) {
    skirt(i, i + 1, i, 0, -1); // south edge (z0)
    skirt(res * n + i, res * n + i + 1, (res - 1) * res + i, 0, 1); // north edge
    skirt(i * n, (i + 1) * n, i * res, -1, 0); // west edge
    skirt(i * n + res, (i + 1) * n + res, i * res + res - 1, 1, 0); // east edge
  }

  const grid = { x0, z0, step, n, h, dd, px, pz, res };
  let tris = { terrain: buf.triangles };
  if (level <= 2) buildRoad(ctx, buf, grid, level, x0, z0, size);
  tris.road = buf.triangles - tris.terrain;
  const propLevel = ctx.theme.propFar[1] < 600 ? 0 : 1;
  if (level <= propLevel) buildProps(ctx, buf, grid, level, x0, z0, size);
  if (level === 0 && ctx.theme.lavender) buildLavender(ctx, buf, grid, x0, z0, size);
  tris.props = buf.triangles - tris.terrain - tris.road;
  const out = { parts: buf.finish() };
  out.level = level;
  out.ix = ix;
  out.iz = iz;
  out.triangles = buf.triangles;
  out.tris = tris;
  out.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  out.heightMs = tHeights;
  return out;
}

function gridHeight(g, x, z) {
  let fi = (x - g.x0) / g.step;
  let fj = (z - g.z0) / g.step;
  fi = fi < 0 ? 0 : fi > g.res - 1e-6 ? g.res - 1e-6 : fi;
  fj = fj < 0 ? 0 : fj > g.res - 1e-6 ? g.res - 1e-6 : fj;
  const i = Math.floor(fi);
  const j = Math.floor(fj);
  const u = fi - i;
  const v = fj - j;
  const k = j * g.n + i;
  const H = g.h;
  return H[k] * (1 - u) * (1 - v) + H[k + 1] * u * (1 - v) + H[k + g.n] * (1 - u) * v + H[k + g.n + 1] * u * v;
}

// ---------------------------------------------------------------- road ribbon

function roadRows(ctx, x0, z0, size, next) {
  const { index } = ctx;
  const rows = [];
  index.forSegments(x0, z0, x0 + size, z0 + size, (i) => {
    if (next[i] < 0) return;
    const x = index.xs[i];
    const z = index.zs[i];
    if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) return;
    rows.push(i);
  });
  rows.sort((a, b) => a - b);
  return rows;
}

// Cross-section for road sample i: [{ o, y, b }] left → right (b = band to next column).
function section(ctx, i, level, cache) {
  let s = cache.get(i);
  if (s) return s;
  const { index, field } = ctx;
  const nS = ctx.n;
  const xs = index.xs;
  const zs = index.zs;
  const ys = index.ys;
  const i0 = Math.max(0, i - 1);
  const i1 = Math.min(nS - 1, i + 1);
  let dx = xs[i1] - xs[i0];
  let dz = zs[i1] - zs[i0];
  const len = Math.hypot(dx, dz) || 1;
  dx /= len;
  dz /= len;
  const rx = dz; // right normal (route space)
  const rz = -dx;
  const x = xs[i];
  const z = zs[i];
  const y = ys[i] + 0.04;
  const hw = ctx.hw;
  const so = ctx.so;
  const R = ctx.road;
  const cols = [];
  const at = (o) => field.height(x + rx * o, z + rz * o);
  if (level === 0) {
    const trail = ctx.trail;
    const H = (o) => field.height(x + rx * o, z + rz * o);
    // Band extent per side: out to `cover`, or the midpoint to another leg
    // of the road (stacked switchbacks, the inside of a hairpin).
    const q = ctx._q;
    const extent = (side) => {
      // Ours while no road (another leg, or this one curving back) is
      // clearly closer than our own centreline.
      const ours = (o) => {
        const r = index.nearestInto(x + rx * side * o, z + rz * side * o, o + 2, q);
        return !r || r.distance >= o * 0.82 - 1;
      };
      let prev = so + 2.2;
      for (const o of [so + 6, so + 11, so + 17, so + 24, ctx.cover]) {
        if (!ours(o)) {
          let lo = prev;
          let hi = o;
          for (let it = 0; it < 3; it++) {
            const mid = (lo + hi) / 2;
            if (ours(mid)) lo = mid;
            else hi = mid;
          }
          return Math.max(so + 2.2, lo);
        }
        prev = o;
      }
      return ctx.cover;
    };
    const band = (ext) => {
      const out = [];
      for (const o of [so + 5, so + 10, so + 16, so + 23]) if (o < ext - 1.5) out.push(o);
      out.push(ext);
      return out;
    };
    const extL = extent(-1);
    const extR = extent(1);
    const near = so + 4.5;
    const hL = extL > near + 0.2 ? H(-near) : H(-extL);
    const hR = extR > near + 0.2 ? H(near) : H(extR);
    const lim = trail ? 1.1 : 2.6;
    const bl = Math.min(lim, (hL - y) * 0.85);
    const br = Math.min(lim, (hR - y) * 0.85);
    const cutL = bl > (trail ? 0.25 : 0.4);
    const cutR = br > (trail ? 0.25 : 0.4);
    // left: outer band → bank/fill → shoulder
    const bandL = band(extL).reverse();
    for (const o of bandL) if (o > so + 2.2) cols.push({ o: -o, y: H(-o), b: 'ground' });
    if (cutL) {
      cols.push({ o: -(so + (trail ? 1.0 : 1.7)), y: y + bl, b: 'cut' });
      cols.push({ o: -(so + (trail ? 0.3 : 0.45)), y: y + bl * 0.8, b: 'cut' });
      cols.push({ o: -so, y: y - 0.02, b: 'shoulder' });
    } else {
      cols.push({ o: -(so + 0.6), y: Math.min(H(-(so + 0.6)), y - 0.1), b: 'verge' });
      cols.push({ o: -so, y: y - 0.01, b: 'shoulder' });
    }
    if (R.edge) {
      cols.push({ o: -hw, y, b: 'edge' });
      cols.push({ o: -(hw - 0.13), y, b: 'asphalt' });
    } else cols.push({ o: -hw, y, b: 'asphalt' });
    const style = ctx.theme.road.centreStyle;
    if (R.centre && style === 'double') {
      cols.push({ o: -0.17, y, b: 'centre' }, { o: -0.06, y, b: 'asphalt' }, { o: 0.06, y, b: 'centre' }, { o: 0.17, y, b: 'asphalt' });
    } else if (R.centre && style === 'dash') {
      cols.push({ o: -0.07, y, b: 'dash' }, { o: 0.07, y, b: 'asphalt' });
    }
    if (R.edge) {
      cols.push({ o: hw - 0.13, y, b: 'edge' });
      cols.push({ o: hw, y, b: 'shoulder' });
    } else cols.push({ o: hw, y, b: 'shoulder' });
    if (cutR) {
      cols.push({ o: so, y: y - 0.02, b: 'cut' });
      cols.push({ o: so + (trail ? 0.3 : 0.45), y: y + br * 0.8, b: 'cut' });
      cols.push({ o: so + (trail ? 1.0 : 1.7), y: y + br, b: 'ground' });
    } else {
      cols.push({ o: so, y: y - 0.01, b: 'verge' });
      cols.push({ o: so + 0.6, y: Math.min(H(so + 0.6), y - 0.1), b: 'ground' });
    }
    const bandR = band(extR);
    for (let k = 0; k < bandR.length; k++) {
      const o = bandR[k];
      if (o <= so + 2.2) continue;
      cols.push({ o, y: H(o), b: k === bandR.length - 1 ? null : 'ground' });
    }
    cols[cols.length - 1].b = null;
    s = { x, z, y, rx, rz, cols, cut: cutR ? 1 : cutL ? -1 : 0 };
  } else if (level === 1) {
    cols.push({ o: -(so + 2.5), y: y - 0.9, b: 'verge' }, { o: -so, y: y - 0.02, b: 'shoulder' }, { o: -hw, y, b: 'asphalt' });
    if (R.centre && ctx.theme.road.centreStyle === 'double') cols.push({ o: -0.15, y, b: 'centre' }, { o: 0.15, y, b: 'asphalt' });
    cols.push({ o: hw, y, b: 'shoulder' }, { o: so, y: y - 0.02, b: 'verge' }, { o: so + 2.5, y: y - 0.9, b: null });
    s = { x, z, y, rx, rz, cols };
  } else {
    const w = Math.max(so, 3.2);
    cols.push({ o: -w - 3, y: y - 2.5, b: 'shoulder' }, { o: -w, y: y + 0.2, b: 'asphalt' }, { o: w, y: y + 0.2, b: 'shoulder' }, { o: w + 3, y: y - 2.5, b: null });
    s = { x, z, y, rx, rz, cols };
  }
  cache.set(i, s);
  return s;
}

function buildRoad(ctx, buf, grid, level, x0, z0, size) {
  const next = ctx.roadRows[level];
  const rows = roadRows(ctx, x0, z0, size, next);
  if (!rows.length) return;
  const cache = new Map();
  const R = ctx.road;
  for (const i of rows) {
    const j = next[i];
    if (j <= i) continue;
    const A = section(ctx, i, level, cache);
    const B = section(ctx, j, level, cache);
    // Match column counts (banks may differ between rows): rebuild B like A when needed.
    const ca = A.cols;
    const cb = sameLayout(ca, B.cols) ? B.cols : matchCols(ca, B, ctx);
    const dash = Math.floor((i * 5) / 6) % 2 === 0;
    for (let k = 0; k < ca.length - 1; k++) {
      const band = ca[k].b;
      if (!band) continue;
      let pal;
      switch (band) {
        case 'asphalt':
          pal = R.asphalt;
          break;
        case 'edge':
          pal = R.edge ?? R.asphalt;
          break;
        case 'centre':
          pal = R.centre ?? R.asphalt;
          break;
        case 'dash':
          pal = dash && R.centre ? R.centre : R.asphalt;
          break;
        case 'shoulder':
          pal = R.shoulder;
          break;
        case 'cut':
          pal = R.cut;
          break;
        default:
          pal = R.verge;
      }
      const a0 = ca[k];
      const a1 = ca[k + 1];
      const b0 = cb[k];
      const b1 = cb[k + 1];
      // world coords
      const p00x = A.x + A.rx * a0.o;
      const p00z = -(A.z + A.rz * a0.o);
      const p01x = A.x + A.rx * a1.o;
      const p01z = -(A.z + A.rz * a1.o);
      const p10x = B.x + B.rx * b0.o;
      const p10z = -(B.z + B.rz * b0.o);
      const p11x = B.x + B.rx * b1.o;
      const p11z = -(B.z + B.rz * b1.o);
      const noise = hash3(i, k, 71);
      buf.at((p00x + p11x) / 2, (p00z + p11z) / 2);
      // Up-facing winding for both triangles of the quad.
      faceNormal(tmpN, p00x, a0.y, p00z, p01x, a1.y, p01z, p11x, b1.y, p11z);
      const up = tmpN[1] >= 0;
      const T1 = up ? [p00x, a0.y, p00z, p01x, a1.y, p01z, p11x, b1.y, p11z] : [p00x, a0.y, p00z, p11x, b1.y, p11z, p01x, a1.y, p01z];
      const T2 = up ? [p00x, a0.y, p00z, p11x, b1.y, p11z, p10x, b0.y, p10z] : [p00x, a0.y, p00z, p10x, b0.y, p10z, p11x, b1.y, p11z];
      for (const T of [T1, T2]) {
        if (band === 'ground') paintGround(ctx, T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7], T[8], (Math.abs(a0.o) + Math.abs(a1.o)) / 2, noise);
        else paintSurface(ctx, pal, T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7], T[8], noise);
        buf.tri(T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7], T[8], tmpC, AUX_ROAD);
      }
    }
  }
  if (level === 0) buildRoadside(ctx, buf, rows, cache, grid);
}

function sameLayout(a, b) {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (Math.abs(a[k].o - b[k].o) > 0.01 || a[k].b !== b[k].b) return false;
  return true;
}

// When layouts differ between consecutive rows (bank on one, fill on the
// other; a band cut short by another leg), give B the same columns as A:
// band columns take B's true ground, the rest B's own cross-section.
function matchCols(ca, B, ctx) {
  const out = [];
  const byO = B.cols;
  const bandFrom = ctx.so + 2.2;
  for (const c of ca) {
    let y;
    if (Math.abs(c.o) > bandFrom) y = ctx.field.height(B.x + B.rx * c.o, B.z + B.rz * c.o);
    else {
      let lo = byO[0];
      let hi = byO[byO.length - 1];
      for (let k = 0; k < byO.length - 1; k++) {
        if (byO[k].o <= c.o && byO[k + 1].o >= c.o) {
          lo = byO[k];
          hi = byO[k + 1];
          break;
        }
      }
      const t = hi.o > lo.o ? (c.o - lo.o) / (hi.o - lo.o) : 0;
      y = lo.y + (hi.y - lo.y) * Math.max(0, Math.min(1, t));
    }
    out.push({ o: c.o, y, b: c.b });
  }
  return out;
}

// Snow poles, fence posts, guard posts, trail posts (verticals that stay plumb, §6.7).
function buildRoadside(ctx, buf, rows, cache, grid) {
  const F = ctx.theme.furniture ?? {};
  const P = ctx.props;
  const L = ctx.L;
  const so = ctx.so;
  for (const i of rows) {
    const s = cache.get(i);
    if (!s) continue;
    buf.at(s.x, -s.z);
    const dist = i * 5;
    if (F.snowPoles && s.y > F.snowPoles.from && i % Math.round(F.snowPoles.every / 5) === 0) {
      const side = s.cut === 1 ? -1 : 1;
      const o = side * (so + 0.55);
      bakeProp(buf, TEMPLATES.pole, s.x + s.rx * o, s.y - 0.1, -(s.z + s.rz * o), 1.9, 0, 1, [P.pole?.[0] ?? [[1, 1, 1], [0.6, 0.6, 0.6]], null, P.poleTop?.[0] ?? [[0.9, 0.75, 0.3], [0.5, 0.4, 0.2]]], L, false, i);
    }
    if (F.fence && i % Math.round(F.fence.every / 5) === 0) {
      const o = (s.cut === 1 ? -1 : 1) * (so + 2.4);
      bakeProp(buf, TEMPLATES.post, s.x + s.rx * o, s.y - 0.2, -(s.z + s.rz * o), 1.25, hash3(i, 3, 3), 1, [P.post?.[0]], L, false, i);
    }
    if (F.guardPosts && i % 2 === 0 && ctx.T.ocean) {
      const o = ctx.T.ocean;
      // ocean side = the side whose normal points toward the sea
      const side = s.rx * o.nx + s.rz * o.nz > 0 ? 1 : -1;
      const off = side * (so + 0.6);
      bakeProp(buf, TEMPLATES.guard, s.x + s.rx * off, s.y - 0.1, -(s.z + s.rz * off), 0.95, 0, 1, [P.guard?.[0], null, [[0.25, 0.22, 0.2], [0.12, 0.1, 0.1]]], L, false, i);
    }
    if (F.trailPosts && i > 0 && Math.round(dist) % 1609 < 5) {
      const off = so + 0.7;
      bakeProp(buf, TEMPLATES.post, s.x + s.rx * off, s.y - 0.2, -(s.z + s.rz * off), 1.1, 0.4, 1.4, [P.post?.[0] ?? [[0.5, 0.4, 0.3], [0.25, 0.2, 0.15]]], L, false, i);
    }
  }
}

// ---------------------------------------------------------------- props

function buildProps(ctx, buf, grid, level, x0, z0, size) {
  const specs = ctx.theme.scatter ?? [];
  const { index, field, L } = ctx;
  const x1 = x0 + size;
  const z1 = z0 + size;
  const q = ctx._q;
  const water = ctx.water;
  const place = (spec, si, x, z, s, rot, variant, seed) => {
    const tplName = level === 0 ? spec.kind : LOW[spec.kind] ?? spec.kind;
    const tpl = TEMPLATES[tplName];
    if (!tpl) return;
    const y = (level === 0 ? field.height(x, z) : gridHeight(grid, x, z)) - (0.15 + s * 0.02);
    buf.at(x, -z);
    const pal = ctx.props[spec.colors] ?? ctx.props.rock;
    const v = pal[variant % pal.length];
    let slots;
    if (spec.kind === 'redwood') slots = [v, v, v, ctx.props.canopy?.[0] ?? v];
    else slots = [v, ctx.props.trunk?.[0] ?? v, v, v];
    bakeProp(buf, tpl, x, y, -z, s, rot, 0.85 + hash3(seed, 2, si) * 0.3, slots, L, !!spec.far, seed, ctx.rampLo, ctx.rampHi);
  };
  const okAlt = (spec, y) => !spec.alt || (y >= spec.alt[0] && y <= spec.alt[1]);

  // Along the road: per 5 m sample, deterministic per (sample, spec, k).
  const margin = 90;
  const along = specs.filter((s) => s.along && (level === 0 || s.far));
  if (along.length) {
    index.forSegments(x0 - margin, z0 - margin, x1 + margin, z1 + margin, (i) => {
      const xs = index.xs;
      const zs = index.zs;
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(ctx.n - 1, i + 1);
      let dx = xs[i1] - xs[i0];
      let dz = zs[i1] - zs[i0];
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      along.forEach((spec, si) => {
        const rate = spec.along * 0.05;
        const kn = Math.ceil(rate);
        for (let k = 0; k < kn; k++) {
          if (hash3(i, k, 101 + si * 7) >= rate - k) continue;
          const side = hash3(i, k, 211 + si) < 0.5 ? -1 : 1;
          const u = hash3(i, k, 307 + si);
          const lat = spec.band[0] + (spec.band[1] - spec.band[0]) * u * u;
          const al = (hash3(i, k, 401 + si) - 0.5) * 5;
          const x = xs[i] + dx * al + dz * lat * side;
          const z = zs[i] + dz * al - dx * lat * side;
          if (x < x0 || x >= x1 || z < z0 || z >= z1) continue;
          const near = index.nearestInto(x, z, spec.band[0] + 2, q);
          if (near && near.distance < spec.band[0] - 0.5) continue;
          const y = gridHeight(grid, x, z);
          if (!okAlt(spec, y) || (water != null && y < water + 0.5)) continue;
          if (ctx.T.ocean && y < 1) continue;
          const seed = i * 13 + k * 7 + si;
          const s = spec.scale[0] + (spec.scale[1] - spec.scale[0]) * hash3(i, k, 503 + si);
          place(spec, si, x, z, s, hash3(i, k, 601) * 6.283, Math.floor(hash3(i, k, 701) * 8), seed);
        }
      });
    });
  }

  // Area scatter on matching ground: 32 m cells for far props (any level),
  // 16 m cells for near props (L0 only, cheap grid classification).
  specs.forEach((spec, si) => {
    if (!spec.area || !spec.on) return;
    if (level > 0 && !spec.far) return;
    const cell = spec.far ? 32 : 16;
    const p = (spec.area * cell * cell) / 10000;
    const kn = Math.ceil(p);
    const cx0 = Math.floor(x0 / cell);
    const cz0 = Math.floor(z0 / cell);
    const cnt = size / cell;
    for (let cj = 0; cj < cnt; cj++) {
      for (let ci = 0; ci < cnt; ci++) {
        const gx = cx0 + ci;
        const gz = cz0 + cj;
        for (let k = 0; k < kn; k++) {
          if (hash3(gx, gz, 1009 + si * 31 + k) >= p - k) continue;
          const x = (gx + hash3(gx, gz, 1103 + si + k * 3)) * cell;
          const z = (gz + hash3(gx, gz, 1201 + si + k * 3)) * cell;
          let y;
          let slope;
          let north;
          let d;
          if (spec.far) {
            // Level-independent classification (no popping between levels).
            y = field.height(x, z);
            const hx = field.height(x + 3, z);
            const hz = field.height(x, z + 3);
            const gxs = (hx - y) / 3;
            const gzs = (hz - y) / 3;
            slope = Math.hypot(gxs, gzs);
            north = -gzs / Math.sqrt(1 + slope * slope); // facing north = ground falls toward +z
            const near = index.nearestInto(x, z, 40, q);
            d = near ? near.distance : 40;
          } else {
            y = gridHeight(grid, x, z);
            const hx = gridHeight(grid, x + grid.step * 0.5, z);
            const hz = gridHeight(grid, x, z + grid.step * 0.5);
            const gxs = (hx - y) / (grid.step * 0.5);
            const gzs = (hz - y) / (grid.step * 0.5);
            slope = Math.hypot(gxs, gzs);
            north = -gzs / Math.sqrt(1 + slope * slope);
            d = gridDist(grid, x, z);
          }
          if (d < (spec.band?.[0] ?? 6)) continue;
          if (!okAlt(spec, y) || (water != null && y < water + 0.5)) continue;
          if (ctx.T.ocean && y < 1.5) continue;
          if (spec.slopeMax != null && slope > spec.slopeMax) continue;
          const n1 = gradNoise(x / 260, z / 260, ctx.seed + 5);
          const n2 = gradNoise(x / 70, z / 70, ctx.seed + 9);
          const key = ctx.classify(ctx, y, slope, north, d, n1, n2);
          if (!spec.on.includes(key)) continue;
          const seed = gx * 31 + gz * 17 + k + si * 1000;
          const s = spec.scale[0] + (spec.scale[1] - spec.scale[0]) * hash3(gx, gz, 1301 + si + k);
          place(spec, si, x, z, s, hash3(gx, gz, 1401 + k) * 6.283, Math.floor(hash3(gx, gz, 1501 + k) * 8), seed);
        }
      }
    }
  });
}

function gridDist(g, x, z) {
  const i = Math.max(0, Math.min(g.res, Math.round((x - g.x0) / g.step)));
  const j = Math.max(0, Math.min(g.res, Math.round((z - g.z0) / g.step)));
  return g.dd[j * g.n + i];
}

// ---------------------------------------------------------------- lavender (Ventoux, low down)

function buildLavender(ctx, buf, grid, x0, z0, size) {
  const below = ctx.theme.lavender.below ?? 600;
  const pal = ctx.props.lavender?.[0];
  if (!pal) return;
  const field = ctx.field;
  const cell = 64;
  const cnt = size / cell;
  for (let cj = 0; cj < cnt; cj++) {
    for (let ci = 0; ci < cnt; ci++) {
      const gx = Math.floor(x0 / cell) + ci;
      const gz = Math.floor(z0 / cell) + cj;
      if (hash3(gx, gz, 2003) > 0.5) continue;
      const cx = (gx + 0.5) * cell;
      const cz = (gz + 0.5) * cell;
      const dc = gridDist(grid, cx, cz);
      if (dc < 14 || dc > 220) continue;
      const yc = gridHeight(grid, cx, cz);
      if (yc > below) continue;
      // flat-ish ground only
      const sl = Math.abs(gridHeight(grid, cx + 20, cz) - gridHeight(grid, cx - 20, cz)) / 40 + Math.abs(gridHeight(grid, cx, cz + 20) - gridHeight(grid, cx, cz - 20)) / 40;
      if (sl > 0.22) continue;
      buf.at(cx, -cz);
      const ang = hash3(gx, gz, 2011) * Math.PI;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      const vx = -uz;
      const vz = ux;
      const half = 27;
      const rows = 22;
      for (let r = 0; r < rows; r++) {
        const off = (r - (rows - 1) / 2) * 2.4;
        let prev = null;
        for (let s = -half; s <= half + 0.01; s += 6.75) {
          const x = cx + ux * s + vx * off;
          const z = cz + uz * s + vz * off;
          const dRoad = gridDist(grid, x, z);
          if (dRoad < ctx.so + 4) {
            prev = null;
            continue;
          }
          const y = field.height(x, z) - 0.12;
          const cur = { lx: x - vx * 0.55, lz: z - vz * 0.55, rx: x + vx * 0.55, rz: z + vz * 0.55, tx: x, tz: z, y, top: y + 0.62 };
          if (prev) {
            for (const side of [0, 1]) {
              const a = side ? { x: prev.rx, z: prev.rz } : { x: prev.lx, z: prev.lz };
              const b = side ? { x: cur.rx, z: cur.rz } : { x: cur.lx, z: cur.lz };
              const ax = a.x;
              const az = -a.z;
              const bx = b.x;
              const bz = -b.z;
              const tax = prev.tx;
              const taz = -prev.tz;
              const tbx = cur.tx;
              const tbz = -cur.tz;
              paintSurface(ctx, pal, ax, prev.y, az, tbx, cur.top, tbz, tax, prev.top, taz, hash3(gx * 7 + r, s * 3, 9));
              const up = tmpN[1] >= 0;
              if (up) {
                buf.tri(ax, prev.y, az, tbx, cur.top, tbz, tax, prev.top, taz, tmpC, 1, 2, 2);
                buf.tri(ax, prev.y, az, bx, cur.y, bz, tbx, cur.top, tbz, tmpC, 1, 1, 2);
              } else {
                paintSurface(ctx, pal, ax, prev.y, az, tax, prev.top, taz, tbx, cur.top, tbz, hash3(gx * 7 + r, s * 3, 9));
                buf.tri(ax, prev.y, az, tax, prev.top, taz, tbx, cur.top, tbz, tmpC, 1, 2, 2);
                buf.tri(ax, prev.y, az, tbx, cur.top, tbz, bx, cur.y, bz, tmpC, 1, 2, 1);
              }
            }
          }
          prev = cur;
        }
      }
    }
  }
}
