// The rider, seen from behind (spec §6.5): low-poly (< 1,500 tris), ink kit
// with a cream chest band, cream helmet, warm skin, cream socks, an ink
// bike with a red rear light that blinks at 1 Hz at night (additive glow),
// and a soft blob shadow.
//
// Pedalling integrates the real cadence into a crank angle; legs follow by
// two-bone IK. At > 10 % grade and > 110 % FTP the rider stands with a
// 0.4 Hz sway; coasting (cadence 0) settles into a still pose with level
// cranks. 6 draw calls: bike, body, legs (one dynamic mesh), light, glow,
// shadow. No per-frame allocations.
//
// Local space: x right, y up, −z forward; origin on the road under the
// bottom bracket.

import * as THREE from '../../vendor/three/three.module.min.js';

const LIN = THREE.LinearSRGBColorSpace;

function hexRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

// Tiny mesh builder: non-indexed triangles with per-face colour.
class Builder {
  constructor() {
    this.p = [];
    this.c = [];
  }

  tri(a, b, c, col) {
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let k = 0; k < 3; k++) this.c.push(col[0], col[1], col[2]);
  }

  quad(a, b, c, d, col) {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }

  box(cx, cy, cz, sx, sy, sz, col) {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    const P = (x, y, z) => [x, y, z];
    this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), col);
    this.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), col);
    this.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), col);
    this.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), col);
    this.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), col);
    this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), col);
  }

  // Tapered n-gon prism from a to b (radii ra → rb, x/z elliptical factor).
  prism(a, b, ra, rb, col, n = 6, ex = 1, ez = 1, caps = true) {
    const ax = b[0] - a[0];
    const ay = b[1] - a[1];
    const az = b[2] - a[2];
    const len = Math.hypot(ax, ay, az) || 1;
    const d = [ax / len, ay / len, az / len];
    // basis
    let u = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let w = cross(d, u);
    w = norm(w);
    u = cross(w, d);
    // keep "x" (w) roughly world-x for elliptical sections
    if (Math.abs(w[0]) < Math.abs(u[0])) [u, w] = [w, u];
    const ring = (c, r) => {
      const out = [];
      for (let k = 0; k < n; k++) {
        const t = (k / n) * Math.PI * 2 + Math.PI / n;
        const cx = Math.cos(t) * r * ex;
        const cz = Math.sin(t) * r * ez;
        out.push([c[0] + w[0] * cx + u[0] * cz, c[1] + w[1] * cx + u[1] * cz, c[2] + w[2] * cx + u[2] * cz]);
      }
      return out;
    };
    const A = ring(a, ra);
    const B = ring(b, rb);
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      this.quad(A[k], A[k1], B[k1], B[k], col);
    }
    if (caps) {
      for (let k = 1; k < n - 1; k++) {
        this.tri(B[0], B[k], B[k + 1], col);
        this.tri(A[0], A[k + 1], A[k], col);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    return g;
  }
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// Soft radial alpha texture (no DOM needed).
export function radialTexture(size = 64, power = 1.6) {
  const data = new Uint8Array(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const dx = (i + 0.5) / size - 0.5;
      const dy = (j + 0.5) / size - 0.5;
      const r = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = Math.pow(1 - r, power) * (1 - r * r * 0.2);
      const k = (j * size + i) * 4;
      data[k] = 255;
      data[k + 1] = 255;
      data[k + 2] = 255;
      data[k + 3] = Math.round(Math.max(0, a) * 255);
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const LEG_N = 5;

export function createRider(colors = {}) {
  const C = {
    jersey: '#2A2420',
    band: '#E9DFCD',
    helmet: '#ECE3D3',
    skin: '#A8705A',
    skinShade: '#6E4637',
    sock: '#E9DFCD',
    shoe: '#1A1715',
    shorts: '#1B1816',
    bike: '#1C1917',
    bikeLit: '#3B3430',
    tyre: '#0E0C0B',
    light: '#FF7A62',
    ...colors,
  };
  const group = new THREE.Group();
  group.name = 'rider';
  group.rotation.order = 'YXZ';
  const sway = new THREE.Group(); // bike lean / standing sway (roll)
  group.add(sway);
  // Double-sided: flat shading takes its normal from screen derivatives, so
  // winding never matters and thin parts (helmet shell, sleeves) always draw.
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });

  // ---------------- bike
  const bike = new Builder();
  const ink = hexRgb(C.bike);
  const tyre = hexRgb(C.tyre);
  const wheel = (z) => {
    const n = 12;
    const r0 = 0.3;
    const r1 = 0.345;
    const t = 0.028;
    for (let k = 0; k < n; k++) {
      const a0 = (k / n) * Math.PI * 2;
      const a1 = ((k + 1) / n) * Math.PI * 2;
      const P = (r, a, x) => [x, 0.345 + Math.cos(a) * r, z + Math.sin(a) * r];
      bike.quad(P(r1, a0, -t), P(r1, a1, -t), P(r1, a1, t), P(r1, a0, t), tyre); // tread
      bike.quad(P(r0, a0, -t), P(r0, a0, t), P(r0, a1, t), P(r0, a1, -t), tyre); // inner
      bike.quad(P(r0, a0, t), P(r1, a0, t), P(r1, a1, t), P(r0, a1, t), tyre); // right side
      bike.quad(P(r1, a0, -t), P(r0, a0, -t), P(r0, a1, -t), P(r1, a1, -t), tyre); // left side
    }
    bike.box(0, 0.345, z, 0.05, 0.06, 0.06, ink); // hub
  };
  wheel(0.5);
  wheel(-0.52);
  const tube = (a, b, r = 0.018) => bike.prism(a, b, r, r, ink, 4, 1, 1, false);
  const bb = [0, 0.29, 0];
  const seatTop = [0, 0.86, 0.17];
  const head = [0, 0.82, -0.44];
  tube(bb, seatTop, 0.02); // seat tube
  tube(seatTop, head, 0.018); // top tube
  tube(bb, [0, 0.74, -0.42], 0.024); // down tube
  tube([0, 0.74, -0.42], head, 0.024); // head tube
  tube(head, [0, 0.345, -0.52], 0.016); // fork
  for (const s of [-1, 1]) {
    tube([s * 0.05, 0.3, 0.02], [s * 0.06, 0.345, 0.5], 0.012); // chainstay
    tube([s * 0.03, 0.82, 0.16], [s * 0.06, 0.345, 0.5], 0.011); // seatstay
  }
  tube([0, 0.86, 0.17], [0, 0.94, 0.2], 0.014); // seatpost
  bike.box(0, 0.955, 0.17, 0.08, 0.035, 0.26, ink); // saddle
  tube(head, [0, 0.95, -0.47], 0.016); // stem riser
  tube([-0.21, 0.95, -0.48], [0.21, 0.95, -0.48], 0.013); // bars
  for (const s of [-1, 1]) tube([s * 0.2, 0.95, -0.48], [s * 0.2, 0.84, -0.53], 0.013); // drops
  bike.box(0, 0.41, 0.48, 0.035, 0.3, 0.12, ink); // rear mudguard-ish light mount
  const bikeMesh = new THREE.Mesh(bike.geometry(), material);
  bikeMesh.name = 'bike';
  sway.add(bikeMesh);

  // Rear light + glow.
  const lightMat = new THREE.MeshBasicMaterial({ color: new THREE.Color().setHex(parseInt(C.light.slice(1), 16), LIN) });
  const light = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.06, 0.02), lightMat);
  light.position.set(0, 0.62, 0.36);
  sway.add(light);
  const glowTex = radialTexture(64, 1.8);
  const glow = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color: new THREE.Color().setHex(0xff6a55, LIN), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.6 }),
  );
  glow.scale.set(0.55, 0.55, 1);
  glow.position.set(0, 0.62, 0.42);
  glow.renderOrder = 5;
  sway.add(glow);

  // ---------------- body (rigid; pivots at the hips)
  const body = new Builder();
  const jersey = hexRgb(C.jersey);
  const band = hexRgb(C.band);
  const skin = hexRgb(C.skin);
  const skinS = hexRgb(C.skinShade);
  const helm = hexRgb(C.helmet);
  const shorts = hexRgb(C.shorts);
  const vent = hexRgb('#3A322B');
  const hipC = [0, 0, 0]; // body group origin = hip centre
  const shC = [0, 0.33, -0.33]; // shoulders, relative to the hips (≈ 45° lean)
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  // torso in three bands: jersey / cream chest band / jersey
  body.prism(hipC, lerp3(hipC, shC, 0.5), 0.15, 0.165, jersey, 8, 1.05, 0.62, false);
  body.prism(lerp3(hipC, shC, 0.5), lerp3(hipC, shC, 0.66), 0.166, 0.172, band, 8, 1.05, 0.63, false);
  body.prism(lerp3(hipC, shC, 0.66), shC, 0.172, 0.16, jersey, 8, 1.08, 0.6, true);
  body.prism([0, -0.06, 0.04], [0, 0.06, -0.03], 0.15, 0.15, shorts, 8, 1.05, 0.75, true); // seat of the shorts
  // arms: sleeve + forearm to the hoods
  for (const s of [-1, 1]) {
    const sh = [s * 0.17, 0.33, -0.31];
    const elbow = [s * 0.2, 0.15, -0.48];
    const hand = [s * 0.2, -0.02, -0.64];
    body.prism(sh, lerp3(sh, elbow, 0.5), 0.055, 0.05, jersey, 5, 1, 1, false);
    body.prism(lerp3(sh, elbow, 0.5), elbow, 0.048, 0.042, s < 0 ? skin : skinS, 5, 1, 1, false);
    body.prism(elbow, hand, 0.04, 0.034, s < 0 ? skin : skinS, 5, 1, 1, true);
  }
  // neck + head + helmet
  body.prism([0, 0.34, -0.36], [0, 0.42, -0.42], 0.05, 0.05, skinS, 5, 1, 1, false);
  const hc = [0, 0.47, -0.45];
  const ico = (c, r, col) => {
    const t = (1 + Math.sqrt(5)) / 2;
    const raw = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => norm(p));
    const f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    for (const [a, b, cc] of f) {
      const P = (p) => [c[0] + p[0] * r * 0.92, c[1] + p[1] * r, c[2] + p[2] * r * 1.08];
      body.tri(P(raw[a]), P(raw[b]), P(raw[cc]), col);
    }
  };
  ico(hc, 0.1, skin);
  // helmet: squashed dome shell (8 × 3)
  {
    const n = 8;
    const rings = [0, 0.45, 0.8, 1.0];
    const R = 0.13;
    const pt = (k, r) => {
      const a = (k / n) * Math.PI * 2;
      const phi = rings[r] * (Math.PI / 2);
      const rr = Math.cos(phi) * R;
      return [hc[0] + Math.cos(a) * rr * 0.95, hc[1] + 0.02 + Math.sin(phi) * R * 0.85, hc[2] + 0.015 + Math.sin(a) * rr * 1.18];
    };
    for (let r = 0; r < 3; r++) {
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        if (r === 2) body.tri(pt(k, r), pt(k1, r), pt(k, 3), helm);
        else body.quad(pt(k, r), pt(k1, r), pt(k1, r + 1), pt(k, r + 1), helm);
      }
    }
    for (const s of [-1, 0, 1]) body.box(hc[0] + s * 0.045, hc[1] + 0.135, hc[2] + 0.03, 0.016, 0.02, 0.16, vent);
  }
  const bodyMesh = new THREE.Mesh(body.geometry(), material);
  bodyMesh.name = 'body';
  const bodyPivot = new THREE.Group();
  bodyPivot.position.set(0, 0.97, 0.16);
  bodyPivot.add(bodyMesh);
  sway.add(bodyPivot);

  // ---------------- legs (one dynamic mesh: 2 × thigh/shin/sock/shoe + cranks)
  const LEG_TRIS = 2 * (3 * 2 * LEG_N + (LEG_N - 2) + 24); // thigh, shin, sock (+cap), shoe, crank
  const legPos = new Float32Array(LEG_TRIS * 9);
  const legCol = new Float32Array(LEG_TRIS * 9);
  const legGeo = new THREE.BufferGeometry();
  legGeo.setAttribute('position', new THREE.BufferAttribute(legPos, 3).setUsage(THREE.DynamicDrawUsage));
  legGeo.setAttribute('color', new THREE.BufferAttribute(legCol, 3));
  legGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(LEG_TRIS * 9), 3).setUsage(THREE.DynamicDrawUsage));
  const legMesh = new THREE.Mesh(legGeo, material);
  legMesh.frustumCulled = false;
  legMesh.name = 'legs';
  sway.add(legMesh);
  const sock = hexRgb(C.sock);
  const shoe = hexRgb(C.shoe);

  // Preallocated scratch for the leg writer.
  const ringA = [];
  const ringB = [];
  for (let k = 0; k < LEG_N; k++) {
    ringA.push([0, 0, 0]);
    ringB.push([0, 0, 0]);
  }
  let wp = 0;
  const put = (a, b, c, col) => {
    legPos[wp] = a[0];
    legPos[wp + 1] = a[1];
    legPos[wp + 2] = a[2];
    legPos[wp + 3] = b[0];
    legPos[wp + 4] = b[1];
    legPos[wp + 5] = b[2];
    legPos[wp + 6] = c[0];
    legPos[wp + 7] = c[1];
    legPos[wp + 8] = c[2];
    for (let k = 0; k < 9; k += 3) {
      legCol[wp + k] = col[0];
      legCol[wp + k + 1] = col[1];
      legCol[wp + k + 2] = col[2];
    }
    wp += 9;
  };
  const tmpD = [0, 0, 0];
  const tmpU = [0, 0, 0];
  const tmpW = [0, 0, 0];
  const segment = (a, b, ra, rb, col, capEnd) => {
    tmpD[0] = b[0] - a[0];
    tmpD[1] = b[1] - a[1];
    tmpD[2] = b[2] - a[2];
    const l = Math.hypot(tmpD[0], tmpD[1], tmpD[2]) || 1;
    tmpD[0] /= l;
    tmpD[1] /= l;
    tmpD[2] /= l;
    // w = x axis (legs move in the y/z plane), u = d × w
    tmpW[0] = 1;
    tmpW[1] = 0;
    tmpW[2] = 0;
    tmpU[0] = tmpD[1] * tmpW[2] - tmpD[2] * tmpW[1];
    tmpU[1] = tmpD[2] * tmpW[0] - tmpD[0] * tmpW[2];
    tmpU[2] = tmpD[0] * tmpW[1] - tmpD[1] * tmpW[0];
    for (let k = 0; k < LEG_N; k++) {
      const t = (k / LEG_N) * Math.PI * 2 + 0.3;
      const cx = Math.cos(t);
      const cz = Math.sin(t);
      ringA[k][0] = a[0] + tmpW[0] * cx * ra + tmpU[0] * cz * ra;
      ringA[k][1] = a[1] + tmpW[1] * cx * ra + tmpU[1] * cz * ra;
      ringA[k][2] = a[2] + tmpW[2] * cx * ra + tmpU[2] * cz * ra;
      ringB[k][0] = b[0] + tmpW[0] * cx * rb + tmpU[0] * cz * rb;
      ringB[k][1] = b[1] + tmpW[1] * cx * rb + tmpU[1] * cz * rb;
      ringB[k][2] = b[2] + tmpW[2] * cx * rb + tmpU[2] * cz * rb;
    }
    for (let k = 0; k < LEG_N; k++) {
      const k1 = (k + 1) % LEG_N;
      put(ringA[k], ringA[k1], ringB[k1], col);
      put(ringA[k], ringB[k1], ringB[k], col);
    }
    if (capEnd) for (let k = 1; k < LEG_N - 1; k++) put(ringB[0], ringB[k], ringB[k + 1], col);
  };
  // Small box rotated about x by `pitch`, written without allocations.
  const BOX = [
    [0, 1, 2, 3], // +z
    [5, 4, 7, 6], // −z
    [1, 5, 6, 2], // +x
    [4, 0, 3, 7], // −x
    [3, 2, 6, 7], // top
    [4, 5, 1, 0], // bottom
  ];
  const corners = [];
  for (let k = 0; k < 8; k++) corners.push([0, 0, 0]);
  const boxAt = (c, sx, sy, sz, col, pitch) => {
    const cs = Math.cos(pitch);
    const sn = Math.sin(pitch);
    for (let k = 0; k < 8; k++) {
      const x = (k === 1 || k === 2 || k === 5 || k === 6 ? 0.5 : -0.5) * sx;
      const y = (k === 2 || k === 3 || k === 6 || k === 7 ? 0.5 : -0.5) * sy;
      const z = (k < 4 ? 0.5 : -0.5) * sz;
      const p = corners[k];
      p[0] = c[0] + x;
      p[1] = c[1] + y * cs - z * sn;
      p[2] = c[2] + y * sn + z * cs;
    }
    for (let f = 0; f < 6; f++) {
      const q = BOX[f];
      put(corners[q[0]], corners[q[1]], corners[q[2]], col);
      put(corners[q[0]], corners[q[2]], corners[q[3]], col);
    }
  };

  // ---------------- shadow
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: radialTexture(64, 1.3), color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }),
  );
  shadow.scale.set(0.95, 1, 2.3);
  shadow.position.y = 0.02;
  shadow.renderOrder = 2;
  group.add(shadow);

  // ---------------- state
  let crank = 0;
  let stand = 0; // 0 seated … 1 standing
  let t = 0;
  let coastBlend = 0;
  const hip = [0, 0, 0];
  const ankle = [0, 0, 0];
  const knee = [0, 0, 0];
  const pedal = [0, 0, 0];
  const shin1 = [0, 0, 0];
  const toe = [0, 0, 0];
  const crankEnd = [0, 0, 0];
  const L1 = 0.45;
  const L2 = 0.45;

  function writeLegs() {
    wp = 0;
    const bbY = 0.29;
    for (let side = 0; side < 2; side++) {
      const s = side ? 1 : -1;
      const a = crank + (s > 0 ? 0 : Math.PI);
      pedal[0] = s * 0.12;
      pedal[1] = bbY + Math.cos(a) * 0.17;
      pedal[2] = -Math.sin(a) * 0.17;
      // hip (seated → standing: up and forward)
      hip[0] = s * 0.09;
      hip[1] = 0.97 + stand * 0.16;
      hip[2] = 0.16 - stand * 0.2;
      ankle[0] = pedal[0];
      ankle[1] = pedal[1] + 0.07;
      ankle[2] = pedal[2] + 0.04;
      let dx = ankle[0] - hip[0];
      let dy = ankle[1] - hip[1];
      let dz = ankle[2] - hip[2];
      let d = Math.hypot(dx, dy, dz);
      const maxD = L1 + L2 - 0.005;
      if (d > maxD) {
        const k = maxD / d;
        ankle[0] = hip[0] + dx * k;
        ankle[1] = hip[1] + dy * k;
        ankle[2] = hip[2] + dz * k;
        dx *= k;
        dy *= k;
        dz *= k;
        d = maxD;
      }
      const along = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
      const hk = Math.sqrt(Math.max(0, L1 * L1 - along * along));
      const ux = dx / d;
      const uy = dy / d;
      const uz = dz / d;
      // perpendicular in the sagittal plane, pointing forward (−z)
      const px = 0;
      let py = -uz;
      let pz = uy;
      if (pz > 0) {
        py = -py;
        pz = -pz;
      }
      knee[0] = hip[0] + ux * along + px * hk + s * 0.02;
      knee[1] = hip[1] + uy * along + py * hk;
      knee[2] = hip[2] + uz * along + pz * hk;
      segment(hip, knee, 0.078, 0.058, shorts, false);
      // shin: skin, then a cream sock
      shin1[0] = knee[0] + (ankle[0] - knee[0]) * 0.72;
      shin1[1] = knee[1] + (ankle[1] - knee[1]) * 0.72;
      shin1[2] = knee[2] + (ankle[2] - knee[2]) * 0.72;
      segment(knee, shin1, 0.054, 0.04, s < 0 ? skin : skinS, false);
      segment(shin1, ankle, 0.04, 0.036, sock, true);
      // shoe on the pedal, pointing forward
      toe[0] = pedal[0];
      toe[1] = pedal[1] + 0.035;
      toe[2] = pedal[2] - 0.05;
      boxAt(toe, 0.075, 0.06, 0.24, shoe, 0.15);
      // crank arm
      crankEnd[0] = s * 0.07;
      crankEnd[1] = bbY + Math.cos(a) * 0.085;
      crankEnd[2] = -Math.sin(a) * 0.085;
      boxAt(crankEnd, 0.02, 0.03, 0.03, ink, 0);
    }
    // Zero any unused tail.
    legPos.fill(0, wp);
    legGeo.attributes.position.needsUpdate = true;
    legGeo.attributes.color.needsUpdate = true;
    computeFlatNormals();
  }

  const nrm = legGeo.attributes.normal.array;
  function computeFlatNormals() {
    for (let i = 0; i < wp; i += 9) {
      const ux = legPos[i + 3] - legPos[i];
      const uy = legPos[i + 4] - legPos[i + 1];
      const uz = legPos[i + 5] - legPos[i + 2];
      const vx = legPos[i + 6] - legPos[i];
      const vy = legPos[i + 7] - legPos[i + 1];
      const vz = legPos[i + 8] - legPos[i + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      for (let k = 0; k < 9; k += 3) {
        nrm[i + k] = nx;
        nrm[i + k + 1] = ny;
        nrm[i + k + 2] = nz;
      }
    }
    legGeo.attributes.normal.needsUpdate = true;
  }
  writeLegs();

  return {
    group,
    material,
    glow,
    light,
    shadow,
    setColors(c = {}) {
      // Kit colours are fixed by the art direction; the light colour may follow the theme.
      if (c.light) lightMat.color.setHex(parseInt(c.light.slice(1), 16), LIN);
    },
    // ride: { cadence, speed, grade, power, ftp, tucked, lean, time, blink }
    update(dt, { cadence = 0, grade = 0, effort = 0, tucked = false, lean = 0, blink = false } = {}) {
      t += dt;
      const coasting = cadence < 8;
      coastBlend += ((coasting ? 1 : 0) - coastBlend) * Math.min(1, dt * 3);
      if (!coasting) crank += (cadence / 60) * Math.PI * 2 * dt;
      else {
        // ease the cranks to level (3 and 9 o'clock) and hold still
        const target = Math.round((crank - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
        crank += (target - crank) * Math.min(1, dt * 2.5);
      }
      if (crank > 1e4) crank -= Math.PI * 2 * Math.floor(crank / (Math.PI * 2));
      const wantStand = grade > 10 && effort > 1.1 && !coasting ? 1 : 0;
      stand += (wantStand - stand) * Math.min(1, dt * 2.2);
      // Torso: more upright when standing/climbing, flatter when tucked.
      const climb = Math.max(0, Math.min(1, grade / 12));
      const tuck = tucked ? 1 : 0;
      bodyPivot.position.set(0, 0.97 + stand * 0.16, 0.16 - stand * 0.2);
      bodyPivot.rotation.x = stand * 0.32 + climb * 0.08 - tuck * 0.32;
      // Standing sway at 0.4 Hz; small bike lean into bends.
      const swayAmt = stand * 0.12 * Math.sin(t * Math.PI * 2 * 0.4);
      sway.rotation.z = -lean + swayAmt;
      bodyPivot.rotation.z = -swayAmt * 0.6;
      // Light: blink at 1 Hz at night (soft edges), steady glow by day.
      if (blink) {
        const ph = (t % 1) / 1;
        const on = ph < 0.5 ? Math.min(1, ph * 12) : Math.max(0, 1 - (ph - 0.5) * 12);
        glow.material.opacity = 0.18 + 0.72 * on;
        lightMat.color.setRGB(1, 0.48 * (0.55 + 0.45 * on), 0.38 * (0.55 + 0.45 * on), LIN);
        glow.visible = true;
      } else {
        glow.visible = false;
        lightMat.color.setRGB(0.85, 0.42, 0.34, LIN);
      }
      writeLegs();
    },
    triangles() {
      return bikeMesh.geometry.attributes.position.count / 3 + bodyMesh.geometry.attributes.position.count / 3 + LEG_TRIS;
    },
    dispose() {
      bikeMesh.geometry.dispose();
      bodyMesh.geometry.dispose();
      legGeo.dispose();
      material.dispose();
      lightMat.dispose();
      light.geometry.dispose();
      glow.material.dispose();
      glowTex.dispose();
      shadow.geometry.dispose();
      shadow.material.map.dispose();
      shadow.material.dispose();
    },
  };
}
