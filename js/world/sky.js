// Sky, stars and the skyline cards: everything drawn "at infinity" before
// the terrain, camera-centred and horizon-locked.
//
// - Sky dome: top / mid / horizon gradient, a warm glow hugging the horizon
//   toward the (set) sun, a poster-sized moon with halo at night, dithered.
//   Never darker than the palette's zenith (spec: L* ≥ 10 / ≥ 25 at horizon).
// - Stars: one Points draw, fading toward the horizon.
// - Skyline cards: 2–3 faceted ridge layers at 15–35 km, colour pre-fogged,
//   one merged mesh drawn far → near with depth test off, so the terrain
//   simply paints over them. They follow the camera horizontally (no
//   parallax) but keep absolute heights, so peaks sink as you climb.

import * as THREE from '../../vendor/three/three.module.min.js';
import { rgb, mixHex, hash3, faceNormal, ramp, dirFromAngles } from './paint.js';
import { gradNoise } from './terrain.js';

const LIN = THREE.LinearSRGBColorSpace;
export function col(hex, out = new THREE.Color()) {
  return out.setHex(parseInt(hex.slice(1), 16), LIN);
}

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const SKY_FS = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uGlow;
uniform vec3 uGlowDir;
uniform float uGlowAmt;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform vec3 uHalo;
uniform float uMoon;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float el = d.y;
  vec3 c = mix(uHorizon, uMid, smoothstep(0.0, 0.2, el));
  c = mix(c, uTop, smoothstep(0.12, 0.55, el));
  vec2 h = normalize(d.xz + vec2(1e-5));
  float az = max(dot(h, normalize(uGlowDir.xz + vec2(1e-5))), 0.0);
  float g = pow(az, 2.5) * exp(-max(el, 0.0) * 6.0) * uGlowAmt;
  c = mix(c, uGlow, clamp(g, 0.0, 1.0) * 0.85);
  c = mix(c, uGround, 1.0 - smoothstep(-0.05, 0.0, el));
  if (uMoon > 0.5) {
    float m = dot(d, uMoonDir);
    float halo = smoothstep(0.985, 1.0, m);
    c = mix(c, uHalo, halo * halo * 0.2 + smoothstep(0.95, 1.0, m) * 0.05);
    c = mix(c, uMoonColor, smoothstep(0.99978, 0.99988, m));
  }
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  c += (n - 0.5) / 160.0;
  gl_FragColor = vec4(c, 1.0);
}`;

const STAR_VS = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
uniform float uScale;
varying float vAlpha;
void main() {
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
  float el = normalize(position).y;
  vAlpha = aAlpha * smoothstep(0.03, 0.22, el);
  gl_PointSize = aSize * uScale;
}`;

const STAR_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float a = (1.0 - smoothstep(0.15, 0.5, length(q))) * vAlpha * uAmount;
  gl_FragColor = vec4(uColor * a, a);
}`;

const CARD_VS = /* glsl */ `
attribute vec4 paint;
varying vec3 vColor;
void main() {
  vColor = paint.rgb;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;

const CARD_FS = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

export class SkySystem {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'sky';
    scene.add(this.group);
    this.uniforms = {
      uTop: { value: new THREE.Color() },
      uMid: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uGround: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uGlowDir: { value: new THREE.Vector3(0, 0, -1) },
      uGlowAmt: { value: 0.5 },
      uMoonDir: { value: new THREE.Vector3(0, 0.5, -1).normalize() },
      uMoonColor: { value: new THREE.Color() },
      uHalo: { value: new THREE.Color() },
      uMoon: { value: 0 },
    };
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 14),
      new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false }),
    );
    dome.renderOrder = -100;
    dome.frustumCulled = false;
    this.dome = dome;
    this.group.add(dome);

    // Stars
    const count = 750;
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const alpha = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = hash3(i, 1, 3);
      const v = hash3(i, 2, 5);
      const el = Math.asin(0.04 + 0.96 * Math.pow(v, 0.8));
      const az = u * Math.PI * 2;
      pos[i * 3] = Math.cos(el) * Math.sin(az) * 9;
      pos[i * 3 + 1] = Math.sin(el) * 9;
      pos[i * 3 + 2] = Math.cos(el) * Math.cos(az) * 9;
      const b = hash3(i, 3, 7);
      size[i] = 1 + b * b * 1.6;
      alpha[i] = 0.25 + 0.75 * hash3(i, 4, 9);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    this.starUniforms = { uColor: { value: col('#FFF4E2') }, uAmount: { value: 0 }, uScale: { value: 1 } };
    this.stars = new THREE.Points(
      sg,
      new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, uniforms: this.starUniforms, transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.stars.renderOrder = -99;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);

    this.cardMaterial = new THREE.ShaderMaterial({ vertexShader: CARD_VS, fragmentShader: CARD_FS, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    this.cards = null;
  }

  apply(theme) {
    const s = theme.sky;
    const u = this.uniforms;
    col(s.top, u.uTop.value);
    col(s.mid, u.uMid.value);
    col(s.horizon, u.uHorizon.value);
    col(s.ground, u.uGround.value);
    col(s.glow, u.uGlow.value);
    u.uGlowAmt.value = s.glowAmt;
    const gd = dirFromAngles(theme.light.glowBearing, 0);
    u.uGlowDir.value.set(gd[0], 0, gd[2]);
    const md = dirFromAngles(theme.light.bearing, theme.light.moonElevation ?? 17);
    u.uMoonDir.value.set(md[0], md[1], md[2]).normalize();
    col(s.moonColor, u.uMoonColor.value);
    col(s.haloColor, u.uHalo.value);
    u.uMoon.value = s.moon ? 1 : 0;
    this.moonDir = u.uMoonDir.value;
    this.starUniforms.uAmount.value = s.stars;
    this.stars.visible = s.stars > 0.01;
    this.buildCards(theme);
  }

  setPixelRatio(pr) {
    this.starUniforms.uScale.value = pr;
  }

  // Faceted ridge layers, far → near, pre-fogged toward the haze colour.
  buildCards(theme) {
    if (this.cards) {
      this.group.remove(this.cards);
      this.cards.geometry.dispose();
      this.cards = null;
    }
    const layers = theme.skyline ?? [];
    if (!layers.length) return;
    const pos = [];
    const pnt = [];
    const L = dirFromAngles(theme.light.bearing, Math.max(10, theme.light.elevation));
    const haze = rgb(mixHex(theme.fog.color, theme.sky.horizon, 0.35));
    const N = [0, 0, 0];
    const seedBase = (theme.routeId ?? 'x').length * 131;
    const oceanB = theme.terrain?.ocean?.bearing;
    const sorted = [...layers].sort((a, b) => b.dist - a.dist);
    sorted.forEach((layer, li) => {
      const segs = 120;
      const rows = 4;
      const D = layer.dist;
      const lit = rgb(layer.lit);
      const shade = rgb(layer.shade);
      const capLit = layer.capLit ? rgb(layer.capLit) : null;
      const capShade = layer.capShade ? rgb(layer.capShade) : null;
      const seed = seedBase + li * 17;
      const peaks = [];
      const np = Math.max(1, layer.peaks ?? 6);
      for (let k = 0; k < np; k++) peaks.push({ a: hash3(seed, k, 1) * Math.PI * 2, w: 0.1 + 0.28 * hash3(seed, k, 2), h: 0.45 + 0.55 * hash3(seed, k, 3) });
      const profile = (a) => {
        let p = 0;
        for (const pk of peaks) {
          let da = Math.abs(a - pk.a);
          if (da > Math.PI) da = Math.PI * 2 - da;
          const t = Math.max(0, 1 - da / pk.w);
          p = Math.max(p, pk.h * (layer.cone ? t * t : layer.mesa ? (t > 0.35 ? 1 : t / 0.35) : t));
        }
        if (!layer.mesa && !layer.cone) p += (layer.rough ?? 0.4) * 0.35 * Math.abs(gradNoise(a * 6, seed * 0.1, seed));
        p = Math.min(1, p * 0.85 + 0.12);
        // Land-only ranges (coast): drop toward the sea.
        if (layer.arcLand && oceanB != null) {
          const ob = (oceanB * Math.PI) / 180;
          let da = Math.abs(a - ob);
          if (da > Math.PI) da = Math.PI * 2 - da;
          p *= Math.min(1, Math.max(0, (da - 1.0) / 0.6));
        }
        return p;
      };
      const ridge = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ridge.push(profile(a));
      }
      // rows: 0 = crest (far), rows = foot (near); plus a haze apron below.
      const vtx = (i, r) => {
        const a = (i / segs) * Math.PI * 2 + (r > 0 && r < rows ? (hash3(i, r, seed) - 0.5) * 0.02 : 0);
        const ii = i % segs;
        const p = ridge[ii];
        const f = r / rows;
        const top = layer.lo + (layer.hi - layer.lo) * p;
        const foot = layer.lo - 250;
        const y = r > rows ? foot - 6000 : top + (foot - top) * Math.pow(f, 0.85) + (r > 0 && r < rows ? (hash3(ii, r, seed + 1) - 0.5) * (layer.hi - layer.lo) * 0.12 : 0);
        const dd = D * (1 + 0.05 * (1 - Math.min(1, f)) * p) - D * 0.08 * Math.min(1, f);
        return [Math.sin(a) * dd, y, -Math.cos(a) * dd];
      };
      const grid = [];
      for (let r = 0; r <= rows + 1; r++) {
        const row = [];
        for (let i = 0; i <= segs; i++) row.push(vtx(i, r));
        grid.push(row);
      }
      const push = (A, B, C, color) => {
        pos.push(...A, ...B, ...C);
        for (let k = 0; k < 3; k++) pnt.push(color[0], color[1], color[2], 1);
      };
      for (let r = 0; r <= rows; r++) {
        for (let i = 0; i < segs; i++) {
          const a = grid[r][i];
          const b = grid[r][i + 1];
          const c = grid[r + 1][i];
          const d = grid[r + 1][i + 1];
          const flip = hash3(i, r, seed + 3) < 0.5;
          const tris = flip ? [[a, c, b], [b, c, d]] : [[a, c, d], [a, d, b]];
          for (const [A, B, C] of tris) {
            faceNormal(N, A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
            if (N[1] < 0) {
              N[0] = -N[0];
              N[1] = -N[1];
              N[2] = -N[2];
            }
            const ndl = N[0] * L[0] + N[1] * L[1] + N[2] * L[2];
            const t = ramp(ndl, -0.35, 0.75);
            const y = (A[1] + B[1] + C[1]) / 3;
            const capped = capLit && y > layer.cap + (hash3(i, r, seed + 9) - 0.5) * 180;
            const l = capped ? capLit : lit;
            const s = capped ? capShade : shade;
            const k = 1 + (hash3(i, r, seed + 5) - 0.5) * 0.08;
            const c3 = [(s[0] + (l[0] - s[0]) * t) * k, (s[1] + (l[1] - s[1]) * t) * k, (s[2] + (l[2] - s[2]) * t) * k];
            // Pre-fog: more haze toward the foot of each layer.
            const lowness = Math.min(1, Math.max(0, (layer.hi - y) / Math.max(1, layer.hi - layer.lo + 250)));
            const fog = Math.min(0.95, (layer.fog ?? 0.35) + lowness * lowness * 0.45 + (r > rows ? 0.5 : 0));
            push(A, B, C, [c3[0] + (haze[0] - c3[0]) * fog, c3[1] + (haze[1] - c3[1]) * fog, c3[2] + (haze[2] - c3[2]) * fog]);
          }
        }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('paint', new THREE.Float32BufferAttribute(pnt, 4));
    const mesh = new THREE.Mesh(geo, this.cardMaterial);
    mesh.renderOrder = -90;
    mesh.frustumCulled = false;
    this.cards = mesh;
    this.group.add(mesh);
  }

  // Follow the camera: dome and stars ride on its position; cards follow in
  // x/z only (absolute heights).
  update(camera) {
    this.dome.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    if (this.cards) this.cards.position.set(camera.position.x, 0, camera.position.z);
  }

  dispose() {
    this.dome.geometry.dispose();
    this.dome.material.dispose();
    this.stars.geometry.dispose();
    this.stars.material.dispose();
    this.cardMaterial.dispose();
    if (this.cards) this.cards.geometry.dispose();
  }
}
