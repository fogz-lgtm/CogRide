// Terrain around a route, generated from the road itself (no map data).
//
// height(x, z) =  κ(d)·ŷ  +  (1 − κ(d))·natural
//   d        exact distance to the road centreline (segment projection)
//   ŷ        IDW of nearby road-segment elevations (exact on the road, smooth
//            across stacked switchback legs, compact support e1)
//   κ(d)     1 inside the road bed, feathered to 0 at e1
//   natural  Shepard surface of the road with per-anchor slope (so a
//            mountainside of hairpins keeps rising above the top leg)
//            + rolling hills (grow with distance from the road)
//            + ridged mountains (far from the road; per-biome amplitude)
//            + hand-placed peaks, valley-floor clamp, coastline, summit cap.
//
// Speed matters (it is the main cost of a chunk): segments live in a dense
// CSR grid with numeric cells; the Shepard part is cached on 64 m nodes in
// 1 km tiles; a whole chunk grid is filled in one pass by splatting road
// segments onto the vertices they touch instead of searching per vertex.
//
// Pure JS (no DOM, no Three.js): runs in the chunk worker and in tests.
// Coordinates here are route space (x east, z north), metres.

import { mulberry32 } from '../core/route.js';

// ---------------------------------------------------------------- noise

function hash2(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

export function valueNoise(x, z, seed = 1) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz) * 2 - 1;
}

export function fbm(x, z, seed = 1, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq, z * freq, seed + i * 17);
    freq *= 2.03;
    amp *= 0.5;
  }
  return sum;
}

// Gradient (Perlin-style) noise, roughly −1..1. Smoother than value noise,
// which matters for ridgelines.
const GX = [1, -1, 0, 0, 0.7071, -0.7071, 0.7071, -0.7071];
const GZ = [0, 0, 1, -1, 0.7071, 0.7071, -0.7071, -0.7071];
function ghash(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) & 7;
}

export function gradNoise(x, z, seed = 1) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const g00 = ghash(ix, iz, seed);
  const g10 = ghash(ix + 1, iz, seed);
  const g01 = ghash(ix, iz + 1, seed);
  const g11 = ghash(ix + 1, iz + 1, seed);
  const n00 = GX[g00] * fx + GZ[g00] * fz;
  const n10 = GX[g10] * (fx - 1) + GZ[g10] * fz;
  const n01 = GX[g01] * fx + GZ[g01] * (fz - 1);
  const n11 = GX[g11] * (fx - 1) + GZ[g11] * (fz - 1);
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.4;
}

export function gradFbm(x, z, seed = 1, octaves = 3) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * gradNoise(x * f, z * f, seed + i * 53);
    f *= 2.07;
    amp *= 0.5;
  }
  return sum;
}

// Ridged multifractal, ≈ 0..1: sharp crests, soft valleys (alpine skylines).
export function ridged(x, z, seed = 1, octaves = 4) {
  let sum = 0;
  let amp = 0.6;
  let f = 1;
  let w = 1;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(gradNoise(x * f, z * f, seed + i * 101));
    n *= n * w;
    w = n * 1.5 > 1 ? 1 : n * 1.5;
    sum += n * amp;
    f *= 2.13;
    amp *= 0.45;
  }
  return sum;
}

function smoothstep(a, b, x) {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

function smax(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
}

// ---------------------------------------------------------------- road index

// Road centreline segments (sample i → i+1, every 5 m) in a dense CSR grid.
export class RoadIndex {
  constructor(route, { cell = 64, margin = 400 } = {}) {
    this.route = route;
    const xs = route.x;
    const zs = route.z;
    const n = xs.length;
    this.n = n;
    this.xs = xs;
    this.zs = zs;
    this.ys = route.elevation;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (xs[i] < minX) minX = xs[i];
      if (xs[i] > maxX) maxX = xs[i];
      if (zs[i] < minZ) minZ = zs[i];
      if (zs[i] > maxZ) maxZ = zs[i];
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    let c = cell;
    while (((maxX - minX + 2 * margin) / c) * ((maxZ - minZ + 2 * margin) / c) > 1.2e6) c *= 2;
    this.cell = c;
    this.ox = minX - margin;
    this.oz = minZ - margin;
    const gw = Math.ceil((maxX - minX + 2 * margin) / c) + 1;
    const gh = Math.ceil((maxZ - minZ + 2 * margin) / c) + 1;
    this.gw = gw;
    this.gh = gh;
    const start = new Int32Array(gw * gh + 1);
    const each = (fn) => {
      for (let i = 0; i < n - 1; i++) {
        const ax = Math.floor((Math.min(xs[i], xs[i + 1]) - this.ox) / c);
        const bx = Math.floor((Math.max(xs[i], xs[i + 1]) - this.ox) / c);
        const az = Math.floor((Math.min(zs[i], zs[i + 1]) - this.oz) / c);
        const bz = Math.floor((Math.max(zs[i], zs[i + 1]) - this.oz) / c);
        for (let gz = az; gz <= bz; gz++) for (let gx = ax; gx <= bx; gx++) fn(gz * gw + gx, i);
      }
    };
    each((k) => start[k + 1]++);
    for (let k = 0; k < gw * gh; k++) start[k + 1] += start[k];
    const fill = start.slice(0, gw * gh);
    const items = new Int32Array(start[gw * gh]);
    each((k, i) => {
      items[fill[k]++] = i;
    });
    this.start = start;
    this.items = items;
    this.stamp = new Int32Array(n);
    this.stampId = 0;
    // Sparse anchors (every 100 m) for far-away approximate distance.
    const coarse = [];
    for (let i = 0; i < n; i += 20) coarse.push(i);
    if (coarse.at(-1) !== n - 1) coarse.push(n - 1);
    this.coarse = Int32Array.from(coarse);
    this._q = { distance: 0, y: 0, d: 0, side: 0, i: 0, t: 0 };
  }

  // Calls fn(i) once for every segment whose cell overlaps the box.
  forSegments(xmin, zmin, xmax, zmax, fn) {
    const c = this.cell;
    const ax = Math.max(0, Math.floor((xmin - this.ox) / c));
    const bx = Math.min(this.gw - 1, Math.floor((xmax - this.ox) / c));
    const az = Math.max(0, Math.floor((zmin - this.oz) / c));
    const bz = Math.min(this.gh - 1, Math.floor((zmax - this.oz) / c));
    if (ax > bx || az > bz) return;
    if (++this.stampId > 2e9) {
      this.stamp.fill(0);
      this.stampId = 1;
    }
    const id = this.stampId;
    const { start, items, stamp, gw } = this;
    for (let gz = az; gz <= bz; gz++) {
      for (let gx = ax; gx <= bx; gx++) {
        const k = gz * gw + gx;
        for (let p = start[k]; p < start[k + 1]; p++) {
          const i = items[p];
          if (stamp[i] === id) continue;
          stamp[i] = id;
          fn(i);
        }
      }
    }
  }

  // Closest point on the road centreline within `radius` (ring search over
  // the grid, stops as soon as no closer cell can exist). Returns a fresh
  // { distance, y, d, side, i, t } or null.
  nearest(x, z, radius = 400) {
    const r = this.nearestInto(x, z, radius, this._q);
    return r ? { ...r } : null;
  }

  nearestInto(x, z, radius, out) {
    const c = this.cell;
    const { xs, zs, start, items, gw, gh } = this;
    const gx = Math.floor((x - this.ox) / c);
    const gz = Math.floor((z - this.oz) / c);
    let best = radius * radius;
    let bi = -1;
    let bt = 0;
    const R = Math.ceil(radius / c);
    for (let ring = 0; ring <= R; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        const cz = gz + dz;
        if (cz < 0 || cz >= gh) continue;
        const edge = dz === -ring || dz === ring;
        const stepX = edge || ring === 0 ? 1 : 2 * ring;
        for (let dx = -ring; dx <= ring; dx += stepX) {
          const cx = gx + dx;
          if (cx < 0 || cx >= gw) continue;
          const k = cz * gw + cx;
          for (let p = start[k]; p < start[k + 1]; p++) {
            const i = items[p];
            const ax = xs[i];
            const az = zs[i];
            const ex = xs[i + 1] - ax;
            const ez = zs[i + 1] - az;
            const l2 = ex * ex + ez * ez || 1;
            let t = ((x - ax) * ex + (z - az) * ez) / l2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const qx = ax + ex * t - x;
            const qz = az + ez * t - z;
            const d2 = qx * qx + qz * qz;
            if (d2 < best) {
              best = d2;
              bi = i;
              bt = t;
            }
          }
        }
      }
      if (bi >= 0 && Math.sqrt(best) <= ring * c) break;
    }
    if (bi < 0) return null;
    const ys = this.ys;
    const ex = xs[bi + 1] - xs[bi];
    const ez = zs[bi + 1] - zs[bi];
    out.distance = Math.sqrt(best);
    out.y = ys[bi] + (ys[bi + 1] - ys[bi]) * bt;
    out.d = (bi + bt) * 5;
    out.side = (x - xs[bi]) * ez - (z - zs[bi]) * ex >= 0 ? 1 : -1; // +1 = right of travel
    out.i = bi;
    out.t = bt;
    return out;
  }

  // Nearest of the sparse anchors: approximate, for far-away terrain.
  farthestFallback(x, z) {
    const { xs, zs, ys, coarse } = this;
    let best = Infinity;
    let bi = 0;
    for (let k = 0; k < coarse.length; k++) {
      const i = coarse[k];
      const dx = xs[i] - x;
      const dz = zs[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bi = i;
      }
    }
    return { distance: Math.sqrt(best), y: ys[bi], d: bi * 5 };
  }
}

// ---------------------------------------------------------------- terrain field

const NODE = 64; // Shepard node spacing (m)
const TILE = 16; // nodes per cache tile side

export class TerrainField {
  // opts (all optional; defaults give gentle hills, as the tests expect):
  //   seed, relief (hill multiplier), hillAmp (m), hillWave (m),
  //   roadHalfWidth, flat (m of level bed beyond the edge), feather (m),
  //   mountains: { amp, wave, near, far, bias }, floor: elevation | null,
  //   ocean: { nx, nz, c, width, depth, wobble }, peaks: [{ x, z, h, r }],
  //   summitCap: { x, z, y, slope }
  constructor(index, opts = {}) {
    this.index = index;
    this.seed = opts.seed ?? 7;
    this.relief = opts.relief ?? 1;
    this.hillAmp = (opts.hillAmp ?? 40) * this.relief;
    this.hillWave = opts.hillWave ?? 520;
    const hw = opts.roadHalfWidth ?? 4;
    this.e0 = hw + (opts.flat ?? 2.5);
    // The bed feathers out quickly on the uphill side (a carved cut) and
    // gently on the downhill side (a fill slope).
    this.fDown = opts.feather ?? 24;
    this.fUp = opts.featherUp ?? 10;
    this.e1 = this.e0 + Math.max(this.fDown, this.fUp);
    this.mountains = opts.mountains ?? null;
    this.floor = opts.floor ?? null;
    this.floorK = opts.floorSoft ?? 40;
    this.ocean = opts.ocean ?? null;
    this.peaks = opts.peaks ?? [];
    this.summitCap = opts.summitCap ?? null;
    this.mesas = opts.mesas ?? null;
    this.rubbleAbove = opts.rubbleAbove ?? null;
    this.basins = opts.basins ?? null;
    this.bedDrop = opts.bedDrop ?? 0.35;
    const rand = mulberry32(this.seed);
    this.tilt = rand() * Math.PI * 2;
    this.regional = opts.regional ?? 0.004;
    this.buildAnchors();
    this.regStep = Math.max(1, Math.round(this.am / 160));
    this.dome = opts.dome ? this.buildDome(opts.dome) : null;
    this.tiles = new Map();
    this._c = { dmin: 0, yhat: 0 };
    this._s = { base: 0, dA: 0 };
  }

  // Anchors every 25 m with a local slope (weighted least squares over
  // neighbours within 300 m, ridge-regularised so a lone straight road
  // gets no invented cross-slope).
  buildAnchors() {
    const { xs, zs, ys, n } = this.index;
    const ids = [];
    for (let i = 0; i < n; i += 5) ids.push(i);
    if (ids.at(-1) !== n - 1) ids.push(n - 1);
    const m = ids.length;
    const ax = new Float64Array(m);
    const az = new Float64Array(m);
    const ay = new Float64Array(m);
    const gx = new Float32Array(m);
    const gz = new Float32Array(m);
    let sumY = 0;
    let minY = Infinity;
    for (let k = 0; k < m; k++) {
      ax[k] = xs[ids[k]];
      az[k] = zs[ids[k]];
      ay[k] = ys[ids[k]];
      sumY += ay[k];
      minY = Math.min(minY, ay[k]);
    }
    this.meanY = sumY / m;
    this.minY = minY;
    // Anchor hash (CSR, 500 m cells).
    const c = 500;
    const b = this.index.bounds;
    const ox = b.minX - 3000;
    const oz = b.minZ - 3000;
    const w = Math.ceil((b.maxX - b.minX + 6000) / c) + 1;
    const h = Math.ceil((b.maxZ - b.minZ + 6000) / c) + 1;
    const start = new Int32Array(w * h + 1);
    const cellOf = (k) => Math.floor((az[k] - oz) / c) * w + Math.floor((ax[k] - ox) / c);
    for (let k = 0; k < m; k++) start[cellOf(k) + 1]++;
    for (let k = 0; k < w * h; k++) start[k + 1] += start[k];
    const fill = start.slice(0, w * h);
    const items = new Int32Array(m);
    for (let k = 0; k < m; k++) items[fill[cellOf(k)]++] = k;
    Object.assign(this, { ax, az, ay, gx, gz, am: m, aStart: start, aItems: items, aox: ox, aoz: oz, aw: w, ah: h, ac: c });
    for (let k = 0; k < m; k++) {
      let a11 = 0;
      let a12 = 0;
      let a22 = 0;
      let b1 = 0;
      let b2 = 0;
      this.forAnchors(ax[k], az[k], 300, (j, dx, dz, d2) => {
        const wt = 1 / (1 + d2 / 10000);
        const dy = ay[j] - ay[k];
        a11 += wt * dx * dx;
        a12 += wt * dx * dz;
        a22 += wt * dz * dz;
        b1 += wt * dx * dy;
        b2 += wt * dz * dy;
      });
      const lam = 0.04 * (a11 + a22) + 1;
      a11 += lam;
      a22 += lam;
      const det = a11 * a22 - a12 * a12 || 1;
      let g1 = (b1 * a22 - b2 * a12) / det;
      let g2 = (a11 * b2 - a12 * b1) / det;
      const gl = Math.hypot(g1, g2);
      if (gl > 0.45) {
        g1 *= 0.45 / gl;
        g2 *= 0.45 / gl;
      }
      gx[k] = g1;
      gz[k] = g2;
    }
  }

  forAnchors(x, z, radius, fn) {
    const c = this.ac;
    const x0 = Math.max(0, Math.floor((x - radius - this.aox) / c));
    const x1 = Math.min(this.aw - 1, Math.floor((x + radius - this.aox) / c));
    const z0 = Math.max(0, Math.floor((z - radius - this.aoz) / c));
    const z1 = Math.min(this.ah - 1, Math.floor((z + radius - this.aoz) / c));
    const r2 = radius * radius;
    const { ax, az, aStart, aItems, aw } = this;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = cz * aw + cx;
        for (let p = aStart[k]; p < aStart[k + 1]; p++) {
          const j = aItems[p];
          const dx = ax[j] - x;
          const dz = az[j] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < r2) fn(j, dx, dz, d2);
        }
      }
    }
  }

  // Shepard surface with linear nodal functions: { base, dA } where dA is
  // the distance to the nearest anchor (≈ distance to the road).
  // Local part: cubic falloff (the nearest legs dominate, so the surface
  // passes through the road and continues its slope); it hands over to a
  // broad regional surface of the whole route a few hundred metres out.
  shepard(x, z, out) {
    const R = 1000;
    const R2 = R * R;
    let ws = 0;
    let wy = 0;
    let dmin2 = Infinity;
    const c = this.ac;
    const x0 = Math.max(0, Math.floor((x - R - this.aox) / c));
    const x1 = Math.min(this.aw - 1, Math.floor((x + R - this.aox) / c));
    const z0 = Math.max(0, Math.floor((z - R - this.aoz) / c));
    const z1 = Math.min(this.ah - 1, Math.floor((z + R - this.aoz) / c));
    const { ax, az, ay, gx, gz, aStart, aItems, aw } = this;
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const k = cz * aw + cx;
        for (let p = aStart[k]; p < aStart[k + 1]; p++) {
          const j = aItems[p];
          let dx = x - ax[j];
          let dz = z - az[j];
          const d2 = dx * dx + dz * dz;
          if (d2 >= R2) continue;
          if (d2 < dmin2) dmin2 = d2;
          const f = 1 - d2 / R2;
          const q = d2 + 100;
          const wt = (f * f) / (q * Math.sqrt(q));
          // Slope extrapolation is limited to 220 m so far ground doesn't run away.
          if (d2 > 48400) {
            const s = 220 / Math.sqrt(d2);
            dx *= s;
            dz *= s;
          }
          ws += wt;
          wy += wt * (ay[j] + gx[j] * dx + gz[j] * dz);
        }
      }
    }
    const dA = dmin2 < Infinity ? Math.sqrt(dmin2) : this.index.farthestFallback(x, z).distance;
    // Regional surface takes over smoothly away from the road.
    const W = 4e-7 * smoothstep(20, 450, dA) + 1e-12;
    out.base = (wy + W * this.regionalAt(x, z)) / (ws + W);
    out.dA = dA;
    return out;
  }

  // Radial profile around a summit, taken from the road itself: elevation
  // as a (monotone) function of distance from the top. The road then lies
  // on one big dome whose flanks fall away on every side (Ventoux, Diablo).
  buildDome({ x, z, floor }) {
    const step = 100;
    const nb = 260;
    const lo = new Float32Array(nb).fill(Infinity);
    const { xs, zs, ys, n } = this.index;
    let top = -Infinity;
    for (let i = 0; i < n; i += 2) {
      const r = Math.hypot(xs[i] - x, zs[i] - z);
      const b = Math.min(nb - 1, Math.floor(r / step));
      lo[b] = Math.min(lo[b], ys[i]);
      top = Math.max(top, ys[i]);
    }
    const prof = new Float32Array(nb);
    let last = top;
    let lastB = 0;
    let slope = 0.1;
    for (let b = 0; b < nb; b++) {
      if (lo[b] < Infinity) {
        const y = Math.min(last, lo[b]);
        if (b > lastB) slope = Math.max(0.03, (last - y) / ((b - lastB) * step));
        prof[b] = y;
        last = y;
        lastB = b;
      } else {
        prof[b] = Math.max(floor ?? -Infinity, last - slope * 0.7 * (b - lastB) * step);
      }
    }
    // gentle smoothing
    const sm = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let sum = 0;
      let w = 0;
      for (let k = -2; k <= 2; k++) {
        const j = Math.max(0, Math.min(nb - 1, b + k));
        sum += prof[j];
        w++;
      }
      sm[b] = sum / w;
    }
    sm[0] = Math.max(sm[0], top);
    return { x, z, step, prof: sm };
  }

  domeAt(x, z) {
    const d = this.dome;
    const f = Math.hypot(x - d.x, z - d.z) / d.step;
    const b = Math.min(d.prof.length - 2, Math.floor(f));
    const t = Math.min(1, f - b);
    return d.prof[b] + (d.prof[b + 1] - d.prof[b]) * t;
  }

  // Broad IDW of the route's elevations (coarse anchors, 400 m softening).
  regionalAt(x, z) {
    if (this.dome) return this.domeAt(x, z);
    const { ax, az, ay } = this;
    const step = this.regStep;
    let ws = 0;
    let wy = 0;
    for (let k = 0; k < this.am; k += step) {
      const dx = ax[k] - x;
      const dz = az[k] - z;
      const w = 1 / (dx * dx + dz * dz + 160000);
      ws += w;
      wy += w * ay[k];
    }
    return wy / ws;
  }

  tile(tx, tz) {
    const key = (tx + 32768) * 65536 + (tz + 32768);
    if (key === this._lastKey) return this._lastTile;
    let t = this.tiles.get(key);
    if (t) {
      this._lastKey = key;
      this._lastTile = t;
      return t;
    }
    const N = TILE + 1;
    t = new Float32Array(N * N * 2);
    const s = { base: 0, dA: 0 };
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        this.shepard((tx * TILE + i) * NODE, (tz * TILE + j) * NODE, s);
        t[(j * N + i) * 2] = s.base;
        t[(j * N + i) * 2 + 1] = s.dA;
      }
    }
    if (this.tiles.size > 400) this.tiles.delete(this.tiles.keys().next().value);
    this.tiles.set(key, t);
    this._lastKey = key;
    this._lastTile = t;
    return t;
  }

  // Bilinear Shepard from cached nodes.
  shepardCached(x, z, out) {
    const fx = x / NODE;
    const fz = z / NODE;
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = Math.floor(ix / TILE);
    const tz = Math.floor(iz / TILE);
    const t = this.tile(tx, tz);
    const N = TILE + 1;
    const li = ix - tx * TILE;
    const lj = iz - tz * TILE;
    const u = fx - ix;
    const v = fz - iz;
    const k00 = (lj * N + li) * 2;
    const k10 = k00 + 2;
    const k01 = k00 + N * 2;
    const k11 = k01 + 2;
    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w01 = (1 - u) * v;
    const w11 = u * v;
    out.base = t[k00] * w00 + t[k10] * w10 + t[k01] * w01 + t[k11] * w11;
    out.dA = t[k00 + 1] * w00 + t[k10 + 1] * w10 + t[k01 + 1] * w01 + t[k11 + 1] * w11;
    return out;
  }

  // Everything except the road bed.
  natural(x, z, base, dA) {
    let h = base;
    const seed = this.seed;
    // Rolling hills: 15–60 m at 300–900 m wavelengths, growing away from the road.
    const ha = this.hillAmp * smoothstep(12, 320, dA);
    if (ha > 0.05) {
      const w = this.hillWave;
      h += ha * (gradNoise(x / w, z / w, seed) * 0.75 + gradNoise(x / (w * 0.37), z / (w * 0.37), seed + 7) * 0.25);
    }
    // Fine facet detail (a few metres) so even gentle ground paints in facets.
    h += 3.2 * gradNoise(x / 85, z / 85, seed + 13) * smoothstep(8, 70, dA);
    if (this.rubbleAbove != null && h > this.rubbleAbove - 100) {
      // bald limestone: broken, rubbly facets
      h += 5 * smoothstep(this.rubbleAbove - 100, this.rubbleAbove + 50, h) * gradNoise(x / 38, z / 38, seed + 17) * smoothstep(10, 50, dA);
    }
    // Regional tilt for variety.
    h += (Math.cos(this.tilt) * x + Math.sin(this.tilt) * z) * this.regional * smoothstep(0, 600, dA) * this.relief;
    const m = this.mountains;
    if (m) {
      const a = m.amp * smoothstep(m.near, m.far, dA);
      if (a > 0.5) h += a * (ridged(x / m.wave, z / m.wave, seed + 211, 4) - (m.bias ?? 0.3));
    }
    const ms = this.mesas;
    if (ms) {
      const a = ms.amp * smoothstep(ms.near ?? 300, ms.far ?? 1500, dA);
      if (a > 0.5) h += a * smoothstep(0.08, 0.16, gradFbm(x / ms.wave, z / ms.wave, seed + 404, 2));
    }
    const bs = this.basins;
    if (bs) {
      const a = bs.amp * smoothstep(bs.near ?? 60, bs.far ?? 400, dA);
      if (a > 0.5) h -= a * smoothstep(0.05, 0.35, gradFbm(x / bs.wave, z / bs.wave, seed + 505, 2));
    }
    for (let k = 0; k < this.peaks.length; k++) {
      const p = this.peaks[k];
      const dx = x - p.x;
      const dz = z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= p.r) continue;
      const f = 1 - d / p.r;
      const base0 = p.base ?? this.minY;
      const shape = Math.pow(f, p.pow ?? 1.4) * (0.82 + 0.18 * ridged(x / 900, z / 900, seed + k * 13, 3));
      h = smax(h, base0 + (p.h - base0) * shape, 120);
    }
    if (this.floor != null) {
      const fl = this.floor + gradNoise(x / 700, z / 700, seed + 31) * 6;
      h = smax(h, fl, this.floorK);
    }
    const cap = this.summitCap;
    if (cap) {
      const d = Math.hypot(x - cap.x, z - cap.z);
      const lim = cap.y + 6 + d * (cap.slope ?? 0.28);
      if (h > lim) h = lim + (h - lim) * 0.12;
    }
    const o = this.ocean;
    if (o) {
      let s;
      const r = o.radial;
      if (r) {
        // Shore follows the loop on its seaward side.
        const dx = x - r.cx;
        const dz = z - r.cz;
        const a = Math.atan2(dx, dz);
        const B = r.bins.length;
        const fk = ((a / (Math.PI * 2)) * B + B) % B;
        const k0 = Math.floor(fk);
        const t = fk - k0;
        const rr = r.bins[k0 % B] * (1 - t) + r.bins[(k0 + 1) % B] * t;
        const ob = (r.bearing * Math.PI) / 180;
        const ca = Math.cos(a - ob);
        const arc = smoothstep(Math.cos(((r.arc + 25) * Math.PI) / 180), Math.cos(((r.arc - 25) * Math.PI) / 180), ca);
        s = arc > 0 ? Math.hypot(dx, dz) - rr - r.offset + gradNoise(x / 700, z / 700, seed + 77) * 70 : -1e9;
        if (arc < 1 && s > -1e8) s = s - (1 - arc) * 600;
      } else {
        s = x * o.nx + z * o.nz - o.c + gradNoise(x / 900, z / 900, seed + 77) * (o.wobble ?? 220);
      }
      if (s > -o.width) {
        const f = smoothstep(-o.width, o.width, s);
        h += (-o.depth - h) * f;
      }
    }
    return h;
  }

  // Road bed: IDW of segment elevations within e1, plus exact distance.
  corridor(x, z, out) {
    const e1 = this.e1;
    const e12 = e1 * e1;
    const { xs, zs, ys } = this.index;
    let ws = 0;
    let wy = 0;
    let dmin2 = Infinity;
    this.index.forSegments(x - e1, z - e1, x + e1, z + e1, (i) => {
      const ax = xs[i];
      const az = zs[i];
      const ex = xs[i + 1] - ax;
      const ez = zs[i + 1] - az;
      const l2 = ex * ex + ez * ez || 1;
      let t = ((x - ax) * ex + (z - az) * ez) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t - x;
      const qz = az + ez * t - z;
      const d2 = qx * qx + qz * qz;
      if (d2 >= e12) return;
      if (d2 < dmin2) dmin2 = d2;
      const f = 1 - d2 / e12;
      const wt = (f * f) / (d2 + 0.0625);
      ws += wt;
      wy += wt * (ys[i] + (ys[i + 1] - ys[i]) * t);
    });
    out.dmin = Math.sqrt(dmin2);
    out.yhat = ws > 0 ? wy / ws : 0;
    return out;
  }

  blend(nat, dmin, yhat) {
    if (dmin >= this.e1) return nat;
    const k = 1 - smoothstep(this.e0, this.e0 + (nat > yhat ? this.fUp : this.fDown), dmin);
    return k * (yhat - this.bedDrop) + (1 - k) * nat;
  }

  // Point query (fine detail; matches near chunks exactly at their vertices).
  height(x, z) {
    const s = this.shepardCached(x, z, this._s);
    const nat = this.natural(x, z, s.base, s.dA);
    const c = this.corridor(x, z, this._c);
    return this.blend(nat, c.dmin, c.yhat);
  }

  // Natural ground without the road bed (for cut-bank shaping).
  naturalAt(x, z) {
    const s = this.shepardCached(x, z, this._s);
    return this.natural(x, z, s.base, s.dA);
  }

  // Bulk fill for a chunk: px/pz are vertex positions (route space) laid out
  // as an (nx × nz) grid with nominal origin (x0, z0) and spacing `step`
  // (vertices may be jittered by < 0.5 step). Writes heights to outH and
  // road distance to outD (exact within e1, approximate beyond).
  // Optional outBed receives the lowest road-bed elevation among road legs
  // within `bedReach` metres (NaN if none, or if the nearest road point is
  // an open route end).
  fill(px, pz, nx, nz, x0, z0, step, outH, outD, outBed = null, bedReach = 0) {
    const count = nx * nz;
    const ws = new Float64Array(count);
    const wy = new Float64Array(count);
    const d2min = new Float64Array(count).fill(Infinity);
    const atEnd = outBed ? new Uint8Array(count) : null;
    const minBed = outBed ? new Float64Array(count).fill(Infinity) : null;
    const br2 = bedReach * bedReach;
    const last = this.index.n - 2;
    const open = !this.index.route.loop;
    const e1 = this.e1;
    const e12 = e1 * e1;
    const { xs, zs, ys } = this.index;
    const xmax = x0 + (nx - 1) * step;
    const zmax = z0 + (nz - 1) * step;
    this.index.forSegments(x0 - e1 - step, z0 - e1 - step, xmax + e1 + step, zmax + e1 + step, (i) => {
      const ax = xs[i];
      const az = zs[i];
      const bx = xs[i + 1];
      const bz = zs[i + 1];
      const ex = bx - ax;
      const ez = bz - az;
      const l2 = ex * ex + ez * ez || 1;
      const ya = ys[i];
      const yb = ys[i + 1];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - e1 - x0) / step) - 1);
      const i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + e1 - x0) / step) + 1);
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - e1 - z0) / step) - 1);
      const j1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz) + e1 - z0) / step) + 1);
      for (let j = j0; j <= j1; j++) {
        for (let ii = i0; ii <= i1; ii++) {
          const k = j * nx + ii;
          const x = px[k];
          const z = pz[k];
          let t = ((x - ax) * ex + (z - az) * ez) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const qx = ax + ex * t - x;
          const qz = az + ez * t - z;
          const d2 = qx * qx + qz * qz;
          if (minBed && d2 < br2) {
            const yb0 = ya + (yb - ya) * t;
            if (yb0 < minBed[k]) minBed[k] = yb0;
          }
          if (d2 >= e12) continue;
          if (d2 < d2min[k]) {
            d2min[k] = d2;
            if (atEnd) atEnd[k] = open && ((i === 0 && t === 0) || (i === last && t === 1)) ? 1 : 0;
          }
          const f = 1 - d2 / e12;
          const wt = (f * f) / (d2 + 0.0625);
          ws[k] += wt;
          wy[k] += wt * (ya + (yb - ya) * t);
        }
      }
    });
    if (outBed) {
      for (let k = 0; k < count; k++) outBed[k] = minBed[k] < Infinity && !atEnd[k] ? minBed[k] - this.bedDrop : NaN;
    }
    const s = { base: 0, dA: 0 };
    const cached = step < NODE;
    for (let k = 0; k < count; k++) {
      const x = px[k];
      const z = pz[k];
      if (cached) this.shepardCached(x, z, s);
      else this.shepard(x, z, s);
      const nat = this.natural(x, z, s.base, s.dA);
      const dm = Math.sqrt(d2min[k]);
      outH[k] = ws[k] > 0 ? this.blend(nat, dm, wy[k] / ws[k]) : nat;
      outD[k] = dm < e1 ? dm : Math.max(e1, s.dA);
    }
  }
}

// Back-compatible factory: a height function h(x, z) with the field attached.
export function makeHeightField(index, opts = {}) {
  const field = new TerrainField(index, opts);
  const fn = (x, z) => field.height(x, z);
  fn.field = field;
  return fn;
}
