// Terrain around a route, generated from the road itself (no map data).
//
// Height at any point blends the elevations of nearby road samples (inverse
// distance weighting), so the ground between stacked switchbacks forms one
// continuous mountainside; the road sits in a gentle cut; and detail noise
// grows with distance from the road so hills rise away from it.

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

// ---------------------------------------------------------------- road index

export class RoadIndex {
  // samples every `stride` route steps; cell size in metres
  constructor(route, { strideM = 20, cell = 100 } = {}) {
    this.route = route;
    this.cell = cell;
    this.points = [];
    const step = Math.max(1, Math.round(strideM / 5));
    for (let i = 0; i < route.x.length; i += step) this.points.push({ x: route.x[i], z: route.z[i], y: route.elevation[i], d: i * 5 });
    const last = route.x.length - 1;
    this.points.push({ x: route.x[last], z: route.z[last], y: route.elevation[last], d: last * 5 });
    this.grid = new Map();
    for (const p of this.points) {
      const key = this.key(Math.floor(p.x / cell), Math.floor(p.z / cell));
      if (!this.grid.has(key)) this.grid.set(key, []);
      this.grid.get(key).push(p);
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of this.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    // Sparse copy for points far from any road cell.
    this.coarse = this.points.filter((_, i) => i % 10 === 0);
  }

  // Nearest road sample anywhere (slow path for far-away terrain).
  farthestFallback(x, z) {
    let best = this.coarse[0];
    let bestD2 = Infinity;
    for (const p of this.coarse) {
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = p;
      }
    }
    return { distance: Math.sqrt(bestD2), y: best.y, d: best.d };
  }

  key(cx, cz) {
    return `${cx},${cz}`;
  }

  near(x, z, radius) {
    const c = this.cell;
    const r = Math.ceil(radius / c);
    const cx = Math.floor(x / c);
    const cz = Math.floor(z / c);
    const out = [];
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const list = this.grid.get(this.key(cx + i, cz + j));
        if (list) out.push(...list);
      }
    }
    return out;
  }

  // Closest point on the road centreline: coarse candidates from the index
  // (one per stretch of road, so a nearby switchback leg can't hide the
  // right one), each refined by projecting onto the route's 5 m segments.
  nearest(x, z, radius = 400) {
    const candidates = [];
    for (const p of this.near(x, z, radius)) candidates.push({ p, d2: (p.x - x) ** 2 + (p.z - z) ** 2 });
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.d2 - b.d2);
    const picked = [];
    for (const c of candidates) {
      if (picked.length >= 4) break;
      if (picked.every((q) => Math.abs(q.p.d - c.p.d) > 60)) picked.push(c);
    }
    const r = this.route;
    let out = { distance: Math.sqrt(picked[0].d2), y: picked[0].p.y, d: picked[0].p.d };
    for (const { p } of picked) {
      const center = Math.round(p.d / 5);
      for (let i = Math.max(0, center - 6); i < Math.min(r.x.length - 1, center + 6); i++) {
        const ax = r.x[i];
        const az = r.z[i];
        const dx = r.x[i + 1] - ax;
        const dz = r.z[i + 1] - az;
        const len2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
        const dist = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (dist < out.distance) out = { distance: dist, y: r.elevation[i] + (r.elevation[i + 1] - r.elevation[i]) * t, d: (i + t) * 5 };
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- height

export function makeHeightField(index, { seed = 7, relief = 1, roadHalfWidth = 4, flat = 4, shoulder = 14, influence = 320 } = {}) {
  const rand = mulberry32(seed);
  const tilt = rand() * Math.PI * 2;
  return function heightAt(x, z) {
    const near = index.near(x, z, influence);
    let wsum = 0;
    let hsum = 0;
    for (const p of near) {
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 > influence * influence) continue;
      const w = 1 / (d2 + 400); // softened IDW
      wsum += w;
      hsum += w * p.y;
    }
    const closest = index.nearest(x, z, influence) ?? index.farthestFallback(x, z);
    const dmin = closest.distance;
    const ynear = closest.y;
    const base = wsum ? hsum / wsum : ynear;
    // A flat cut a few metres either side of the road, then a smooth bank up
    // (or down) to the surrounding slope. Wide enough that coarse terrain
    // triangles can never bridge over the road surface.
    const edge = roadHalfWidth + flat;
    const t = dmin <= edge ? 0 : Math.min(1, (dmin - edge) / shoulder);
    const roadBlend = 1 - t * t * (3 - 2 * t);
    const ground = ynear * roadBlend + base * (1 - roadBlend);
    // Hills grow with distance from the road; a gentle regional tilt adds variety.
    const away = Math.max(0, dmin - edge - shoulder);
    const amp = relief * Math.min(90, away * 0.22);
    const detail = fbm(x / 420, z / 420, seed) * amp + fbm(x / 90, z / 90, seed + 99) * Math.min(6, away * 0.05) * relief;
    const regional = (Math.cos(tilt) * x + Math.sin(tilt) * z) * 0.004 * Math.min(1, away / 300) * relief;
    // Keep the ground a little below the road so the road always sits on top.
    return ground + detail + regional - 0.35 * roadBlend;
  };
}
