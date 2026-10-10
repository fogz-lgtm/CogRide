// Route furniture: one static mesh per route (one draw call) with a small
// canvas text atlas — hairpin signs at labelled turns ("Virage 14"),
// French bornes every km showing the next km's average gradient (§6.7),
// US mileposts with grade, plus unique landmarks: Ventoux's red-and-white
// observatory, a coastal lighthouse, Diablo's summit building.
//
// Main thread only (needs a 2D canvas for text); without a DOM the signs
// are drawn blank.

import * as THREE from '../../vendor/three/three.module.min.js';
import { rgb, faceNormal, ramp, hash3, dirFromAngles } from './paint.js';
import { polar } from './themes.js';

const CELL_W = 128;
const CELL_H = 96;
const ATLAS = 1024;

class Atlas {
  constructor() {
    this.cols = Math.floor(ATLAS / CELL_W);
    this.rows = Math.floor(ATLAS / CELL_H);
    this.next = 1; // cell 0 = plain white
    this.canvas = null;
    this.g = null;
    try {
      if (typeof OffscreenCanvas !== 'undefined') this.canvas = new OffscreenCanvas(ATLAS, ATLAS);
      else if (typeof document !== 'undefined') {
        this.canvas = document.createElement('canvas');
        this.canvas.width = ATLAS;
        this.canvas.height = ATLAS;
      }
      this.g = this.canvas?.getContext('2d') ?? null;
    } catch {
      this.g = null;
    }
    if (this.g) {
      this.g.fillStyle = '#ffffff';
      this.g.fillRect(0, 0, ATLAS, ATLAS);
    }
  }

  // UV rect of the white cell (untextured faces).
  white() {
    return this.rect(0, 0.3);
  }

  rect(cell, inset = 0.02) {
    const cx = cell % this.cols;
    const cy = Math.floor(cell / this.cols);
    const u0 = (cx * CELL_W + CELL_W * inset) / ATLAS;
    const u1 = ((cx + 1) * CELL_W - CELL_W * inset) / ATLAS;
    const v1 = 1 - (cy * CELL_H + CELL_H * inset) / ATLAS;
    const v0 = 1 - ((cy + 1) * CELL_H - CELL_H * inset) / ATLAS;
    return [u0, v0, u1, v1];
  }

  // Draw a label into the next cell: draw(g, w, h) in cell-local pixels.
  add(draw) {
    if (this.next >= this.cols * this.rows) return this.white();
    const cell = this.next++;
    const g = this.g;
    if (g) {
      const cx = (cell % this.cols) * CELL_W;
      const cy = Math.floor(cell / this.cols) * CELL_H;
      g.save();
      g.translate(cx, cy);
      g.beginPath();
      g.rect(0, 0, CELL_W, CELL_H);
      g.clip();
      draw(g, CELL_W, CELL_H);
      g.restore();
    }
    return this.rect(cell, 0.0);
  }

  texture() {
    if (!this.canvas) return null;
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 2;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    return t;
  }
}

const SERIF = '"Fraunces", "Iowan Old Style", Georgia, serif';
const SANS = '"Archivo", "Helvetica Neue", Arial, sans-serif';

class Builder {
  constructor(L) {
    this.p = [];
    this.c = [];
    this.uv = [];
    this.L = L;
    this.N = [0, 0, 0];
  }

  // flat-coloured triangle (uv → white cell)
  tri(a, b, c, pal, white, k = 1) {
    faceNormal(this.N, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const L = this.L;
    const t = ramp(this.N[0] * L[0] + this.N[1] * L[1] + this.N[2] * L[2], -0.3, 0.85);
    const lit = pal[0];
    const sh = pal[1];
    const col = [(sh[0] + (lit[0] - sh[0]) * t) * k, (sh[1] + (lit[1] - sh[1]) * t) * k, (sh[2] + (lit[2] - sh[2]) * t) * k];
    this.p.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.c.push(...col);
    const u = (white[0] + white[2]) / 2;
    const v = (white[1] + white[3]) / 2;
    this.uv.push(u, v, u, v, u, v);
  }

  quad(a, b, c, d, pal, white, k) {
    this.tri(a, b, c, pal, white, k);
    this.tri(a, c, d, pal, white, k);
  }

  // textured quad (a bottom-left, b bottom-right, c top-right, d top-left)
  texQuad(a, b, c, d, rect, tint = [1, 1, 1]) {
    faceNormal(this.N, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    const L = this.L;
    const t = 0.78 + 0.22 * ramp(this.N[0] * L[0] + this.N[1] * L[1] + this.N[2] * L[2], -0.3, 0.85);
    const col = [tint[0] * t, tint[1] * t, tint[2] * t];
    const [u0, v0, u1, v1] = rect;
    this.p.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) this.c.push(...col);
    this.uv.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
  }

  // Oriented box: centre c, half sizes (hx along `right`, hy up, hz along `fwd`).
  box(c, right, fwd, hx, hy, hz, pal, white, k = 1) {
    const P = (sx, sy, sz) => [c[0] + right[0] * hx * sx + fwd[0] * hz * sz, c[1] + hy * sy, c[2] + right[2] * hx * sx + fwd[2] * hz * sz];
    const f = (a, b, cc, d) => this.quad(a, b, cc, d, pal, white, k);
    f(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)); // −fwd face
    f(P(1, -1, 1), P(-1, -1, 1), P(-1, 1, 1), P(1, 1, 1)); // +fwd
    f(P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1)); // +right
    f(P(-1, -1, 1), P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1)); // −right
    f(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)); // top
  }

  // Vertical n-gon prism (tower), radius r0 → r1, from y0 to y1.
  tower(cx, cz, y0, y1, r0, r1, pal, white, n = 8, k = 1) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const p0 = [cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0];
      const p1 = [cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0];
      const q0 = [cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1];
      const q1 = [cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1];
      this.quad(p0, q0, q1, p1, pal, white, k);
    }
  }

  cap(cx, cz, y, r, pal, white, n = 8, apex = 0) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      this.tri([cx + Math.cos(a0) * r, y, cz + Math.sin(a0) * r], [cx, y + apex, cz], [cx + Math.cos(a1) * r, y, cz + Math.sin(a1) * r], pal, white);
    }
  }
}

function pair(hex, k = 0.62) {
  const c = rgb(hex);
  return [c, [c[0] * k, c[1] * k, c[2] * k]];
}

// Average gradient (%) of route distance [d, d + len].
function avgGrade(route, d, len) {
  const a = route.elevationAt(Math.min(route.length, d));
  const b = route.elevationAt(Math.min(route.length, d + len));
  const span = Math.min(route.length, d + len) - Math.min(route.length, d);
  return span > 50 ? ((b - a) / span) * 100 : 0;
}

// Apex of a labelled turn: max heading change within ±70 m of atKm.
function apexOf(route, atM) {
  let best = atM;
  let bestK = -1;
  for (let d = atM - 70; d <= atM + 70; d += 5) {
    if (d < 10 || d > route.length - 10) continue;
    const a = route.stateAt(d - 8).heading;
    const b = route.stateAt(d + 8).heading;
    let k = Math.abs(b - a);
    if (k > Math.PI) k = 2 * Math.PI - k;
    if (k > bestK) {
      bestK = k;
      best = d;
    }
  }
  return best;
}

export function buildFurniture(ctx, theme, route) {
  const atlas = new Atlas();
  const white = atlas.white();
  const L = dirFromAngles(theme.light.bearing, Math.max(12, theme.light.elevation));
  const B = new Builder(L);
  const F = theme.furniture ?? {};
  const field = ctx.field;
  const night = theme.timeOfDay === 'night';
  const glows = [];
  const so = ctx.so;
  const ink = pair('#2A2420', 0.7);
  const cream = pair(night ? '#B8B0A2' : '#E9DFCD', 0.72);
  const postCol = pair(night ? '#4A4440' : '#7A706A', 0.65);
  const out = route.loop ? route.length : route.length;

  // Downhill side at route distance d (+1 right / −1 left): the uphill side
  // has the cut bank, where a sign would be buried.
  const downhill = (d) => {
    const s = route.stateAt(Math.max(0, Math.min(route.length, d)));
    const rx = Math.cos(s.heading);
    const rz = -Math.sin(s.heading);
    return field.naturalAt(s.x + rx * 9, s.z + rz * 9) <= field.naturalAt(s.x - rx * 9, s.z - rz * 9) ? 1 : -1;
  };

  // Frame at route distance d: world position on the road edge + vectors.
  const frame = (d, side, off) => {
    const s = route.stateAt(Math.max(0, Math.min(route.length, d)));
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const rx = fz;
    const rz = -fx; // right, route space
    const x = s.x + rx * side * off;
    const z = s.z + rz * side * off;
    const y = Math.min(field.height(x, z), s.elevation);
    return {
      pos: [x, y, -z],
      fwd: [fx, 0, -fz], // world forward
      right: [rx, 0, -rz],
      heading: s.heading,
      elev: s.elevation,
    };
  };

  // Panel facing riders coming up the road (normal = −forward).
  const panel = (f, w, h, y0, rect, frameCol) => {
    const c = f.pos;
    const r = f.right;
    const n = f.fwd; // panel lies in the right/up plane, viewed from −fwd
    const off = [-n[0] * 0.03, 0, -n[2] * 0.03];
    // posts
    for (const sx of [-0.38, 0.38]) B.box([c[0] + r[0] * w * sx, c[1] + y0 / 2, c[2] + r[2] * w * sx], r, n, 0.035, y0 / 2 + 0.2, 0.035, postCol, white);
    // backing board
    B.box([c[0], c[1] + y0 + h / 2, c[2]], r, n, w / 2 + 0.04, h / 2 + 0.04, 0.025, frameCol, white);
    // face (seen from the approach side: left→right is +right)
    const bl = [c[0] - (r[0] * w) / 2 + off[0], c[1] + y0, c[2] - (r[2] * w) / 2 + off[2]];
    const br = [c[0] + (r[0] * w) / 2 + off[0], c[1] + y0, c[2] + (r[2] * w) / 2 + off[2]];
    const tr = [br[0], c[1] + y0 + h, br[2]];
    const tl = [bl[0], c[1] + y0 + h, bl[2]];
    B.texQuad(bl, br, tr, tl, rect, night ? [0.78, 0.76, 0.74] : [1, 1, 1]);
  };

  // ---------------- hairpin signs at labelled turns
  if (F.hairpins !== false) {
    const word = F.signs === 'it' ? 'TORNANTE' : F.signs === 'es' ? 'CURVA' : 'VIRAGE';
    for (const turn of route.turns ?? []) {
      if (!turn.label) continue;
      const num = (turn.label.match(/\d+/) ?? [''])[0];
      const d = apexOf(route, turn.atKm * 1000);
      const outside = turn.direction === 'right' ? -1 : 1;
      const f = frame(d - 6, outside, so + 1.4);
      const rect = atlas.add((g, w, h) => {
        g.fillStyle = '#E9DFCD';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = '#2A2420';
        g.lineWidth = 5;
        g.strokeRect(5, 5, w - 10, h - 10);
        g.fillStyle = '#2A2420';
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.font = `600 15px ${SANS}`;
        g.fillText(word, w / 2, 30);
        g.font = `600 50px ${SERIF}`;
        g.fillText(num, w / 2, 80);
      });
      panel(f, 1.25, 0.94, 1.05, rect, ink);
    }
  }

  // ---------------- bornes (FR/IT/ES climbs): every km, next km's average
  if (F.bornes && !route.loop) {
    for (let km = 1; km * 1000 < out - 200; km++) {
      const d = km * 1000;
      const g = avgGrade(route, d, 1000);
      const left = Math.round((route.length - d) / 1000);
      const f = frame(d, downhill(d), so + 0.9);
      const rect = atlas.add((g2, w, h) => {
        g2.fillStyle = '#F1EBDF';
        g2.fillRect(0, 0, w, h);
        g2.fillStyle = '#E2B93E';
        g2.fillRect(0, 0, w, 20);
        g2.fillStyle = '#2A2420';
        g2.textAlign = 'center';
        g2.font = `700 13px ${SANS}`;
        g2.fillText(left > 0 ? `SOMMET ${left} KM` : 'SOMMET', w / 2, 15);
        g2.font = `700 44px ${SANS}`;
        g2.fillText(`${Math.round(g)}%`, w / 2, 70);
        g2.font = `600 12px ${SANS}`;
        g2.fillText('PENTE MOYENNE', w / 2, 88);
      });
      // squat stone with a yellow cap
      const c = f.pos;
      B.box([c[0], c[1] + 0.45, c[2]], f.right, f.fwd, 0.3, 0.55, 0.12, pair(night ? '#B4AEA4' : '#EEE8DC', 0.7), white);
      B.box([c[0], c[1] + 1.06, c[2]], f.right, f.fwd, 0.31, 0.07, 0.13, pair(night ? '#9C8440' : '#E2B93E', 0.7), white);
      const n = f.fwd;
      const r = f.right;
      const z0 = -0.125;
      const bl = [c[0] - r[0] * 0.27 + n[0] * z0, c[1] + 0.2, c[2] - r[2] * 0.27 + n[2] * z0];
      const br = [c[0] + r[0] * 0.27 + n[0] * z0, c[1] + 0.2, c[2] + r[2] * 0.27 + n[2] * z0];
      B.texQuad(bl, br, [br[0], c[1] + 0.98, br[2]], [bl[0], c[1] + 0.98, bl[2]], rect, night ? [0.75, 0.73, 0.7] : [1, 1, 1]);
    }
  }

  // ---------------- US mileposts with grade
  if (F.mileposts && F.signs === 'us' && !theme.imported) {
    for (let mi = 1; mi * 1609.34 < route.length - 150; mi++) {
      const d = mi * 1609.34;
      const g = avgGrade(route, d, 1609.34);
      const f = frame(d, downhill(d), so + 0.8);
      const rect = atlas.add((g2, w, h) => {
        g2.fillStyle = '#2F4A3E';
        g2.fillRect(0, 0, w, h);
        g2.fillStyle = '#EDE4D5';
        g2.textAlign = 'center';
        g2.font = `700 14px ${SANS}`;
        g2.fillText('MILE', w / 2, 22);
        g2.font = `700 40px ${SANS}`;
        g2.fillText(String(mi), w / 2, 62);
        g2.font = `700 16px ${SANS}`;
        g2.fillText(`${g >= 0 ? '' : '−'}${Math.abs(Math.round(g))}%`, w / 2, 86);
      });
      const c = f.pos;
      B.box([c[0], c[1] + 0.6, c[2]], f.right, f.fwd, 0.05, 0.7, 0.05, postCol, white);
      const n = f.fwd;
      const r = f.right;
      const z0 = -0.07;
      const w = 0.42;
      const bl = [c[0] - r[0] * w / 2 + n[0] * z0, c[1] + 0.85, c[2] - r[2] * w / 2 + n[2] * z0];
      const br = [c[0] + r[0] * w / 2 + n[0] * z0, c[1] + 0.85, c[2] + r[2] * w / 2 + n[2] * z0];
      B.texQuad(bl, br, [br[0], c[1] + 1.17, br[2]], [bl[0], c[1] + 1.17, bl[2]], rect, night ? [0.7, 0.7, 0.68] : [1, 1, 1]);
    }
  }

  // ---------------- Ventoux observatory (red-and-white tower at the summit)
  if (F.observatory) {
    const n = route.x.length - 1;
    const f = frame(route.length - 30, -1, 34);
    const cx = f.pos[0];
    const cz = f.pos[2];
    const y = Math.min(field.height(cx, -cz), route.elevation[n]) - 1;
    const wcol = pair(night ? '#BDB6C4' : '#EFE6DA', 0.66);
    const red = pair(night ? '#8A4A4A' : '#C9564A', 0.62);
    const base = pair(night ? '#9E98A6' : '#D9CEC0', 0.64);
    B.box([cx, y + 4, cz], f.right, f.fwd, 13, 5, 7, base, white);
    const bands = [[0, 9, wcol], [9, 12, red], [12, 20, wcol], [20, 23, red], [23, 30, wcol]];
    for (const [a, b, c] of bands) B.tower(cx, cz, y + 8 + a, y + 8 + b, 5 - a * 0.02, 5 - b * 0.02, c, white, 10);
    B.cap(cx, cz, y + 38, 4.4, wcol, white, 10, 2.5);
    for (let k = 0; k < 6; k++) B.tower(cx, cz, y + 40 + k * 3.4, y + 40 + (k + 1) * 3.4, 0.9 - k * 0.08, 0.82 - k * 0.08, k % 2 ? red : wcol, white, 6);
    if (night) glows.push({ pos: [cx, y + 61, cz], color: '#FF6A55', size: 9, blink: 1 });
  }

  // ---------------- Diablo summit building + beacon
  if (F.beacon) {
    const f = frame(route.length - 20, -1, 26);
    const [cx, , cz] = f.pos;
    const y = Math.min(field.height(cx, -cz), route.maxElevation) - 1;
    const stone = pair(night ? '#7A6E66' : '#B8A48A', 0.62);
    B.box([cx, y + 3.5, cz], f.right, f.fwd, 9, 4.5, 6, stone, white);
    B.box([cx, y + 9.5, cz], f.right, f.fwd, 3, 2.5, 3, stone, white);
    if (night) glows.push({ pos: [cx, y + 13, cz], color: '#FFB27A', size: 10, blink: 0.25 });
  }

  // ---------------- lighthouse on a headland
  if (F.lighthouse && theme.terrain?.ocean) {
    const lh = F.lighthouse;
    const o = theme.terrain.ocean;
    let anchor;
    if (lh.from === 'west') {
      let minI = 0;
      for (let i = 0; i < route.x.length; i += 4) if (route.x[i] < route.x[minI]) minI = i;
      anchor = { x: route.x[minI], z: route.z[minI] };
    } else {
      const i = lh.from === 'end' ? route.x.length - 1 : 0;
      anchor = { x: route.x[i], z: route.z[i] };
    }
    const bearing = lh.bearing ?? o.bearing;
    let p = polar(anchor, bearing, lh.dist ?? 1200);
    // walk back toward land until the ground is comfortably above the sea
    for (let k = 0; k < 40 && field.height(p.x, p.z) < 12; k++) p = polar(p, bearing + 180, 60);
    const y = field.height(p.x, p.z) - 2;
    const cx = p.x;
    const cz = -p.z;
    const wcol = pair(night ? '#C8C2BE' : '#F2EDE4', 0.6);
    const dark = pair('#2E2A2C', 0.7);
    B.tower(cx, cz, y, y + 19, 2.6, 1.8, wcol, white, 10);
    B.tower(cx, cz, y + 19, y + 22.5, 1.6, 1.6, dark, white, 10);
    B.cap(cx, cz, y + 22.5, 2.1, dark, white, 10, 1.6);
    B.box([cx + 5, y + 2, cz], [1, 0, 0], [0, 0, 1], 3.5, 2.5, 3, wcol, white);
    glows.push({ pos: [cx, y + 21, cz], color: '#FFE7C2', size: night ? 46 : 14, blink: night ? 0.2 : 0, sweep: true });
  }

  const geo = new THREE.BufferGeometry();
  if (B.p.length) {
    geo.setAttribute('position', new THREE.Float32BufferAttribute(B.p, 3));
    const paint = new Uint8Array((B.p.length / 3) * 4);
    for (let i = 0, j = 0; i < B.c.length; i += 3, j += 4) {
      paint[j] = Math.max(0, Math.min(255, Math.round(B.c[i] * 255)));
      paint[j + 1] = Math.max(0, Math.min(255, Math.round(B.c[i + 1] * 255)));
      paint[j + 2] = Math.max(0, Math.min(255, Math.round(B.c[i + 2] * 255)));
      paint[j + 3] = 0;
    }
    geo.setAttribute('paint', new THREE.BufferAttribute(paint, 4, true));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
  }
  return { geometry: B.p.length ? geo : null, texture: atlas.next > 1 ? atlas.texture() : null, glows };
}
