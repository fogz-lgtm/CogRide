// Painterly colour helpers and a growable triangle buffer.
//
// Everything here is plain JS (no Three.js) so it runs in the chunk worker
// too. Colours are kept as sRGB floats 0..1: the renderer outputs them
// untouched, so a palette hex in themes.js is exactly the colour on screen
// before fog. Mixing happens in sRGB too, which is how paint mixes.

const hexCache = new Map();

// '#A9788A' → [r, g, b] in 0..1 (cached; callers must not mutate)
export function rgb(hex) {
  if (Array.isArray(hex)) return hex;
  let c = hexCache.get(hex);
  if (!c) {
    const v = parseInt(hex.slice(1), 16);
    c = [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
    hexCache.set(hex, c);
  }
  return c;
}

export function mixHex(a, b, t) {
  const ca = rgb(a);
  const cb = rgb(b);
  const ch = (i) => Math.round(Math.max(0, Math.min(1, ca[i] + (cb[i] - ca[i]) * t)) * 255).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

export function scaleHex(a, k) {
  const c = rgb(a);
  const ch = (i) => Math.round(Math.max(0, Math.min(1, c[i] * k)) * 255).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

export function mix3(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// Cheap integer hash → 0..1 (deterministic across threads).
export function hash3(a, b, c) {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483587);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// Lit/shade ramp from N·L, softened so facets read as paint, not plastic.
export function ramp(ndl, lo = -0.25, hi = 0.8) {
  let t = (ndl - lo) / (hi - lo);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// Paint one face: mix shade→lit by ramp(N·L) then ±4 % value noise.
// lit/shade are [r,g,b]; returns `out`.
export function shadeFace(out, lit, shade, ndl, noise, lo, hi) {
  const t = ramp(ndl, lo, hi);
  const k = 1 + (noise - 0.5) * 0.08;
  out[0] = (shade[0] + (lit[0] - shade[0]) * t) * k;
  out[1] = (shade[1] + (lit[1] - shade[1]) * t) * k;
  out[2] = (shade[2] + (lit[2] - shade[2]) * t) * k;
  return out;
}

// Growable non-indexed triangle soup: position (f32×3) + paint (u8×4).
// paint.a is an "aux" byte read by the world shader:
//   0 = ground, 255 = road (depth-biased over terrain),
//   1..127 = near prop (height above its base = (a−1)·0.6 m),
//   128..254 = far prop (same, (a−128)·0.6 m) — props sink into the ground
//   as they approach their fade distance instead of popping.
export const AUX_ROAD = 255;
export function auxProp(rise, far) {
  const q = Math.max(0, Math.min(126, Math.round(rise / 0.6)));
  return far ? 128 + q : 1 + q;
}

export class TriBuffer {
  constructor(triangles = 4096) {
    this.pos = new Float32Array(triangles * 9);
    this.col = new Uint8Array(triangles * 12);
    this.n = 0; // vertices
  }

  reserve(vertices) {
    const need = (this.n + vertices) * 3;
    if (need <= this.pos.length) return;
    let size = this.pos.length;
    while (size < need) size = Math.ceil(size * 1.6);
    const p = new Float32Array(size);
    p.set(this.pos.subarray(0, this.n * 3));
    const c = new Uint8Array((size / 3) * 4);
    c.set(this.col.subarray(0, this.n * 4));
    this.pos = p;
    this.col = c;
  }

  // Triangle with one flat colour (sRGB floats) and aux byte per vertex.
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, color, auxA = 0, auxB = auxA, auxC = auxA) {
    if ((this.n + 3) * 3 > this.pos.length) this.reserve(3);
    const p = this.pos;
    let i = this.n * 3;
    p[i] = ax; p[i + 1] = ay; p[i + 2] = az;
    p[i + 3] = bx; p[i + 4] = by; p[i + 5] = bz;
    p[i + 6] = cx; p[i + 7] = cy; p[i + 8] = cz;
    const r = to8(color[0]);
    const g = to8(color[1]);
    const b = to8(color[2]);
    const c = this.col;
    i = this.n * 4;
    c[i] = r; c[i + 1] = g; c[i + 2] = b; c[i + 3] = auxA;
    c[i + 4] = r; c[i + 5] = g; c[i + 6] = b; c[i + 7] = auxB;
    c[i + 8] = r; c[i + 9] = g; c[i + 10] = b; c[i + 11] = auxC;
    this.n += 3;
  }

  get triangles() {
    return this.n / 3;
  }

  // Exact-size copies (transferable).
  finish() {
    return { position: this.pos.slice(0, this.n * 3), paint: this.col.slice(0, this.n * 4), vertices: this.n };
  }
}

function to8(v) {
  const x = Math.round(v * 255);
  return x < 0 ? 0 : x > 255 ? 255 : x;
}

// Face normal of a triangle (unit), written to out; returns out.
export function faceNormal(out, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  out[0] = nx;
  out[1] = ny;
  out[2] = nz;
  return out;
}

// Direction (world space, Y up, −Z north) from compass bearing and elevation, degrees.
export function dirFromAngles(bearingDeg, elevationDeg) {
  const b = (bearingDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e)];
}

// Routes triangles into four quadrant buffers (finer frustum culling for
// near chunks) or a single buffer. Call at(x, zWorld) before writing.
export class SplitBuffer {
  constructor(x0, z0, size, split, estimate = 4096) {
    this.split = split;
    this.mx = x0 + size / 2;
    this.mz = -(z0 + size / 2); // world z of the leaf centre
    const n = split ? 4 : 1;
    this.bufs = [];
    for (let i = 0; i < n; i++) this.bufs.push(new TriBuffer(Math.ceil(estimate / n)));
    this.cur = this.bufs[0];
  }

  at(x, zw) {
    if (this.split) this.cur = this.bufs[(zw >= this.mz ? 2 : 0) + (x >= this.mx ? 1 : 0)];
  }

  reserve(v) {
    this.cur.reserve(v);
  }

  tri(ax, ay, az, bx, by, bz, cx, cy, cz, color, a0 = 0, a1 = a0, a2 = a0) {
    this.cur.tri(ax, ay, az, bx, by, bz, cx, cy, cz, color, a0, a1, a2);
  }

  get triangles() {
    let t = 0;
    for (const b of this.bufs) t += b.triangles;
    return t;
  }

  // [{ position, paint, vertices, box: [minX, minY, minZ, maxX, maxY, maxZ] }]
  finish() {
    const parts = [];
    for (const b of this.bufs) {
      if (!b.n) continue;
      const out = b.finish();
      const p = out.position;
      let x0 = Infinity;
      let y0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      let z1 = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i];
        const y = p[i + 1];
        const z = p[i + 2];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (z < z0) z0 = z;
        if (z > z1) z1 = z;
      }
      out.box = [x0, y0, z0, x1, y1, z1];
      parts.push(out);
    }
    return parts;
  }
}
