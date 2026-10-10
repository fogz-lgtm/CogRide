// Low-poly prop models and the baker that drops them into a chunk's
// triangle soup with painterly per-face colour (lit/shade by N·L, ±4 %).
//
// Props are merged into their chunk's single mesh (one draw call per chunk)
// rather than instanced: each face gets its own baked colour, which is what
// makes a 24-triangle pine read as a two-tone painted cone. A per-vertex aux
// byte (paint.js) lets the shader sink props into the ground as they near
// their fade distance, so nothing pops in.
//
// Template space: unit height, y up, origin at the base. Each triangle has a
// colour slot: 0 = main (foliage / body), 1 = trunk / secondary,
// 2 = accent (pole tops), 3 = canopy (redwood tops).
//
// Pure JS (no Three.js): runs in the chunk worker.

import { faceNormal, ramp, rgb, hash3, auxProp } from './paint.js';

// ---------------------------------------------------------------- template builders

class T {
  constructor() {
    this.v = [];
    this.s = [];
  }

  tri(a, b, c, slot = 0) {
    this.v.push(...a, ...b, ...c);
    this.s.push(slot);
  }

  quad(a, b, c, d, slot = 0) {
    this.tri(a, b, c, slot);
    this.tri(a, c, d, slot);
  }

  // Side faces of a frustum/cone: n sides from (y0, r0) to (y1, r1); r1 = 0 → apex.
  frustum(n, y0, r0, y1, r1, slot = 0, phase = 0, sx = 1, sz = 1) {
    for (let k = 0; k < n; k++) {
      const a0 = phase + (k / n) * Math.PI * 2;
      const a1 = phase + ((k + 1) / n) * Math.PI * 2;
      const p0 = [Math.cos(a0) * r0 * sx, y0, Math.sin(a0) * r0 * sz];
      const p1 = [Math.cos(a1) * r0 * sx, y0, Math.sin(a1) * r0 * sz];
      if (r1 <= 0) {
        this.tri(p0, [0, y1, 0], p1, slot);
      } else if (r0 <= 0) {
        const q0 = [Math.cos(a0) * r1 * sx, y1, Math.sin(a0) * r1 * sz];
        const q1 = [Math.cos(a1) * r1 * sx, y1, Math.sin(a1) * r1 * sz];
        this.tri([0, y0, 0], q0, q1, slot);
      } else {
        const q0 = [Math.cos(a0) * r1 * sx, y1, Math.sin(a0) * r1 * sz];
        const q1 = [Math.cos(a1) * r1 * sx, y1, Math.sin(a1) * r1 * sz];
        this.quad(p0, q0, q1, p1, slot);
      }
    }
  }

  // Closed cap (fan) at height y, facing up (dir = 1) or down (−1).
  cap(n, y, r, dir, slot = 0, phase = 0) {
    for (let k = 0; k < n; k++) {
      const a0 = phase + (k / n) * Math.PI * 2;
      const a1 = phase + ((k + 1) / n) * Math.PI * 2;
      const p0 = [Math.cos(a0) * r, y, Math.sin(a0) * r];
      const p1 = [Math.cos(a1) * r, y, Math.sin(a1) * r];
      if (dir > 0) this.tri(p0, [0, y, 0], p1, slot);
      else this.tri(p1, [0, y, 0], p0, slot);
    }
  }

  // Blob: an irregular icosahedron-ish shell (20 faces) centred at c.
  blob(c, rx, ry, rz, slot = 0, seed = 1) {
    const t = (1 + Math.sqrt(5)) / 2;
    const raw = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    const pts = raw.map((p, i) => {
      const l = Math.hypot(...p);
      const j = 0.86 + 0.28 * hash3(i, seed, 7);
      return [c[0] + (p[0] / l) * rx * j, c[1] + (p[1] / l) * ry * j, c[2] + (p[2] / l) * rz * j];
    });
    const faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (const [a, b, cc] of faces) this.tri(pts[a], pts[b], pts[cc], slot);
  }

  // Octahedron-ish lump (8 faces), squashed.
  lump(c, rx, ry, rz, slot = 0, seed = 1, bottom = true) {
    const j = (i) => 0.8 + 0.4 * hash3(i, seed, 3);
    const top = [c[0], c[1] + ry * j(0), c[2]];
    const bot = [c[0], c[1] - ry * 0.4, c[2]];
    const ring = [0, 1, 2, 3].map((k) => {
      const a = (k / 4) * Math.PI * 2 + 0.3 * hash3(k, seed, 9);
      return [c[0] + Math.cos(a) * rx * j(k + 1), c[1] + (hash3(k, seed, 5) - 0.5) * ry * 0.3, c[2] + Math.sin(a) * rz * j(k + 5)];
    });
    for (let k = 0; k < 4; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % 4];
      this.tri(a, top, b, slot);
      if (bottom) this.tri(b, bot, a, slot);
    }
  }

  // Box from (x0,y0,z0) to (x1,y1,z1); `faces` to skip bottom.
  box(x0, y0, z0, x1, y1, z1, slot = 0, bottom = false) {
    const p = (x, y, z) => [x, y, z];
    this.quad(p(x0, y0, z1), p(x1, y0, z1), p(x1, y1, z1), p(x0, y1, z1), slot); // +z
    this.quad(p(x1, y0, z0), p(x0, y0, z0), p(x0, y1, z0), p(x1, y1, z0), slot); // −z
    this.quad(p(x1, y0, z1), p(x1, y0, z0), p(x1, y1, z0), p(x1, y1, z1), slot); // +x
    this.quad(p(x0, y0, z0), p(x0, y0, z1), p(x0, y1, z1), p(x0, y1, z0), slot); // −x
    this.quad(p(x0, y1, z1), p(x1, y1, z1), p(x1, y1, z0), p(x0, y1, z0), slot); // top
    if (bottom) this.quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y0, z1), p(x0, y0, z1), slot);
  }

  done() {
    return { v: Float32Array.from(this.v), s: Uint8Array.from(this.s), tris: this.s.length };
  }
}

function makeTemplates() {
  const out = {};
  // Pine: three stacked 6-sided cones + a 3-sided trunk = 24 tris.
  let t = new T();
  t.frustum(3, 0, 0.045, 0.22, 0.03, 1);
  t.frustum(6, 0.14, 0.3, 0.6, 0, 0, 0.2);
  t.frustum(6, 0.4, 0.23, 0.82, 0, 0, 0.7);
  t.frustum(6, 0.62, 0.15, 1.0, 0, 0, 1.2);
  out.pine = t.done();

  // Live oak "lollipop": 4-sided trunk (8) + squashed 20-face canopy ≈ 28–30.
  t = new T();
  t.frustum(4, 0, 0.06, 0.48, 0.045, 1, 0.4);
  t.blob([0, 0.66, 0], 0.5, 0.36, 0.48, 0, 3);
  out.oak = t.done();

  // Cypress: 4-sided bipyramid, 8 tris.
  t = new T();
  t.frustum(4, 0.02, 0, 0.28, 0.13, 0, 0.3);
  t.frustum(4, 0.28, 0.13, 1.0, 0, 0, 0.3);
  out.cypress = t.done();

  // Juniper: two lumps.
  t = new T();
  t.frustum(3, 0, 0.05, 0.3, 0.035, 1);
  t.lump([0, 0.55, 0], 0.42, 0.42, 0.38, 0, 2);
  t.lump([0.12, 0.85, 0.05], 0.26, 0.2, 0.24, 0, 5, false);
  out.juniper = t.done();

  // Far redwood: 4-sided trunk + crown (12 tris).
  t = new T();
  t.frustum(4, 0, 0.03, 1.0, 0.01, 0, 0.3);
  t.frustum(4, 0.55, 0.12, 1.03, 0, 3, 0.7);
  out.redwoodLow = t.done();

  // Redwood: 8-sided tapered trunk (16) + flared foot (8) + dark crown (6).
  t = new T();
  t.frustum(8, 0, 0.034, 0.05, 0.024, 0, 0.1);
  t.frustum(8, 0.05, 0.024, 1.0, 0.009, 0, 0.1);
  t.frustum(6, 0.55, 0.13, 1.03, 0, 3, 0.4);
  out.redwood = t.done();

  // Fern: 4 arching blades, both windings (8 tris).
  t = new T();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const w = 0.2;
    const base = [0, 0.05, 0];
    const l = [dx * 0.75 - dz * w, 0.8, dz * 0.75 + dx * w];
    const r = [dx * 1.0 + dz * w, 0.3, dz * 1.0 - dx * w];
    t.tri(base, l, r);
    t.tri(base, r, l);
  }
  out.fern = t.done();

  // Grass tuft: 3 blades, both windings (6 tris).
  t = new T();
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const p0 = [-dz * 0.12, 0, dx * 0.12];
    const p1 = [dz * 0.12, 0, -dx * 0.12];
    const tip = [dx * 0.35, 1, dz * 0.35];
    t.tri(p0, tip, p1);
    t.tri(p1, tip, p0);
  }
  out.tuft = t.done();

  // Coastal scrub / sage: a low rounded dome, 15 tris.
  t = new T();
  t.frustum(5, 0, 0.5, 0.42, 0.56, 0, 0.3, 1, 0.85);
  t.frustum(5, 0.42, 0.56, 0.86, 0, 0, 0.3, 1, 0.85);
  out.scrub = t.done();
  out.sage = out.scrub;

  // Rock: squashed irregular 20-face boulder, half buried.
  t = new T();
  t.blob([0, 0.12, 0], 0.62, 0.42, 0.5, 0, 6);
  out.rock = t.done();

  // Fallen log: 5-sided prism lying along x.
  t = new T();
  for (let k = 0; k < 5; k++) {
    const a0 = (k / 5) * Math.PI * 2;
    const a1 = ((k + 1) / 5) * Math.PI * 2;
    const r = 0.06;
    const p = (x, a) => [x, 0.06 + Math.sin(a) * r, Math.cos(a) * r];
    t.quad(p(-0.5, a0), p(0.5, a0), p(0.5, a1), p(-0.5, a1), 0);
  }
  out.log = t.done();

  // Snow pole (balise): cream shaft with a yellow top (unit = 1 m tall, scaled).
  t = new T();
  t.box(-0.035, 0, -0.035, 0.035, 0.76, 0.035, 0);
  t.box(-0.035, 0.76, -0.035, 0.035, 1.0, 0.035, 2);
  out.pole = t.done();

  // Wooden post (fence / trail).
  t = new T();
  t.box(-0.06, 0, -0.06, 0.06, 1, 0.06, 0);
  out.post = t.done();

  // Guard post (coast): white with a dark reflector band.
  t = new T();
  t.box(-0.07, 0, -0.07, 0.07, 0.8, 0.07, 0);
  t.box(-0.071, 0.8, -0.071, 0.071, 1.0, 0.071, 2);
  out.guard = t.done();

  return out;
}

export const TEMPLATES = makeTemplates();

// ---------------------------------------------------------------- baking

const tmpN = [0, 0, 0];
const tmpC = [0, 0, 0];
const P = new Float32Array(9);

// Bake one prop instance into `buf`.
//   x, y, z: world position of the base; s: uniform scale (height, m);
//   rot: yaw (rad); sq: horizontal squash; slots: [[lit, shade]|[lit, mid, shade]] per slot (rgb floats)
//   L: light direction (world); far: fade class; seed: noise seed
export function bakeProp(buf, tpl, x, y, z, s, rot, sq, slots, L, far, seed, rampLo = -0.3, rampHi = 0.85) {
  const v = tpl.v;
  const st = tpl.s;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const sx = s * sq;
  buf.reserve(tpl.tris * 3);
  for (let f = 0; f < tpl.tris; f++) {
    const o = f * 9;
    for (let k = 0; k < 3; k++) {
      const lx = v[o + k * 3] * sx;
      const ly = v[o + k * 3 + 1] * s;
      const lz = v[o + k * 3 + 2] * sx;
      P[k * 3] = x + lx * c - lz * sn;
      P[k * 3 + 1] = y + ly;
      P[k * 3 + 2] = z + lx * sn + lz * c;
    }
    faceNormal(tmpN, P[0], P[1], P[2], P[3], P[4], P[5], P[6], P[7], P[8]);
    const ndl = tmpN[0] * L[0] + tmpN[1] * L[1] + tmpN[2] * L[2];
    const pal = slots[st[f]] ?? slots[0];
    const noise = hash3(seed, f, 11);
    const k = 1 + (noise - 0.5) * 0.08;
    if (pal.length === 3) {
      // Three shades (redwood trunks): lit / mid / shade bands.
      const t = ramp(ndl, rampLo, rampHi);
      const col = t > 0.8 ? pal[0] : t > 0.36 ? pal[1] : pal[2];
      tmpC[0] = col[0] * k;
      tmpC[1] = col[1] * k;
      tmpC[2] = col[2] * k;
    } else {
      const t = ramp(ndl, rampLo, rampHi);
      const lit = pal[0];
      const sh = pal[1];
      tmpC[0] = (sh[0] + (lit[0] - sh[0]) * t) * k;
      tmpC[1] = (sh[1] + (lit[1] - sh[1]) * t) * k;
      tmpC[2] = (sh[2] + (lit[2] - sh[2]) * t) * k;
    }
    const a0 = auxProp(P[1] - y, far);
    const a1 = auxProp(P[4] - y, far);
    const a2 = auxProp(P[7] - y, far);
    buf.tri(P[0], P[1], P[2], P[3], P[4], P[5], P[6], P[7], P[8], tmpC, a0, a1, a2);
  }
}

// Palette entry (from the theme) → slot array of rgb colours.
// variants: [[lit, shade], ...] | [lit, shade] | [lit, mid, shade]
export function resolveVariants(entry) {
  if (!entry) return [[rgb('#808080'), rgb('#404040')]];
  if (Array.isArray(entry[0])) return entry.map((p) => p.map(rgb));
  return [entry.map(rgb)];
}
