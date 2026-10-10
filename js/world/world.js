// The 3D world — "The Evening Edition" art direction (spec §6): a calm,
// flat-shaded, gouache-travel-poster landscape built around the route,
// rendered into the small "photo" frame of the ride HUD.
//
// Coordinates: world X = route x (east), world Z = −route z (north is −Z),
// Y = elevation in metres. The ride engine owns position; the world only
// follows it, smoothing between engine ticks so motion is fluid at 60 fps.
//
// ─── Public API ──────────────────────────────────────────────────────────
//   new World(canvas, opts?)
//       opts.maxPixelRatio   cap on devicePixelRatio (default 2)
//       opts.antialias       default true (only honoured at DPR ≤ 2)
//       opts.aspectMode      'auto' | 'portrait' | 'landscape' (default 'auto':
//                            landscape when width/height > 1.3)
//       opts.ftp             watts, for the standing pose (default 250;
//                            ride.ftp overrides per update)
//       opts.useWorker       build chunks in a Worker (default true; falls
//                            back to the main thread automatically)
//       opts.adaptive        adaptive render scale (default true)
//   setRoute(route, theme?)         theme from themeFor(route, timeOfDay);
//                                   omitted → derived for this route
//   applyTheme(theme)               e.g. themeFor(route, timeOfDayNow()); on
//                                   the same route the old terrain stays on
//                                   screen until the recoloured one is ready
//   setTimeOfDay(tod)               shorthand: applyTheme(themeFor(route, tod))
//   update(ride, dt)                ride = { distance, speed, cadence, tucked,
//                                           power?, grade?, ftp? }
//   render()
//   resize(width, height)           CSS pixels of the photo frame (366×334 pt
//                                   portrait; 472×292 landscape)
//   prewarm(onProgress?, { distance }?) → Promise  builds everything visible
//                                   from the current (or given) distance;
//                                   call before the ride starts
//   streamChunks(x, z, budget?)     route-space; returns the number of wanted
//                                   leaves still missing or in flight (0 =
//                                   complete); normally called by update()
//   setGhost(total | null)          ghost of your best (total distance ridden
//                                   on its attempt), drawn translucent beside
//                                   you; null hides it
//   setRunning(bool) / running      false = update/render/streaming are
//                                   no-ops (TV mode, pause sheet, summary)
//   start(getRide) / stop()         optional built-in rAF loop; getRide()
//                                   returns the latest engine snapshot
//   setAspectMode(mode)             'auto' | 'portrait' (FOV 54°) |
//                                   'landscape' (FOV 42°, camera a bit further back)
//   setRenderScale(s | null)        fixed render scale (0.4–1), or null for
//                                   adaptive (drops to 0.75 when frame time
//                                   > 20 ms for 3 s; recovers after 10 s < 13 ms)
//   stats                           { fps, frameMs (between renders), cpuMs
//                                     (update), triangles, calls, leaves,
//                                     perLevel, pending, lastBuildMs,
//                                     avgBuildMs, renderScale, pixelRatio }
//   dispose()
//
// Themes (themes.js): themeFor(route, 'golden' | 'dusk' | 'night' | 'day'),
// timeOfDayNow(date?, { alwaysGolden }?) — golden < 19:30 ≤ dusk < 20:30 ≤ night.
// ─────────────────────────────────────────────────────────────────────────
//
// Look (spec §6.1): every surface is baked per face — lit/shade palette
// colours mixed by N·L with ±4 % noise — and drawn unlit with one tiny
// shader: linear fog with a ceiling (distant ranges stay readable as hazy
// silhouettes), props that sink into the ground as they reach their fade
// distance (no popping), and a depth bias that keeps the road ribbon on top
// of the terrain. The hemisphere + key lights only light the rider.
//
// Streaming: a world-aligned quadtree (512 m → 8 km leaves, chunks.js), one
// merged mesh per leaf (near leaves split in four for culling). Near the
// road the ribbon carries the true ground (cut banks, verges) and the coarse
// terrain beneath is trenched, so nothing can poke over the road.
//
// Camera (§6.6): trails 6 m back / 2.8 m up *along the road* (critically
// damped spring, ω 3.5), 0.75 m left of the rider, yaw toward a point 25 m
// (+0.6 s) ahead but never letting the rider leave the frame, pitch = base +
// 40 % of the grade, no roll or shake; lifts over a hairpin's inside slope.
//
// Measured (366×334, swiftshader in CI; Chrome V8 for builds): 50–95 k
// triangles on average, ≤ 120 k worst case, 20–45 draw calls (≤ 53); chunk
// builds 1–5 ms for far levels, 8–16 ms median for near ones, in a Worker.
// No shadow maps, no post-processing, no per-frame allocations in the hot path.

import * as THREE from '../../vendor/three/three.module.min.js';
import { createContext, buildLeaf, LEVELS } from './chunks.js';
import { createRider, radialTexture } from './rider.js';
import { SkySystem, col } from './sky.js';
import { buildFurniture } from './furniture.js';
import { DEFAULT_THEME, themeFor, timeOfDayNow } from './themes.js';
import { rgb, hash3, dirFromAngles } from './paint.js';
import { gradNoise } from './terrain.js';

const LIN = THREE.LinearSRGBColorSpace;
const SPLIT = [0, 0.3, 0.55, 0.7, 0.8]; // split a level-l node when the camera is closer than SPLIT[l] × size
const TOP = LEVELS.length - 1;

// ---------------------------------------------------------------- shaders

const WORLD_VS = /* glsl */ `
attribute vec4 paint;
uniform vec3 uFog;        // near, far, max
uniform vec4 uPropFade;   // near class start/end, far class start/end
uniform float uCamNear;
varying vec3 vColor;
varying float vFog;
#ifdef USE_MAP
varying vec2 vUv;
#endif
void main() {
  vColor = paint.rgb;
  float aux = floor(paint.a * 255.0 + 0.5);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float dist = distance(wp.xyz, cameraPosition);
  if (aux > 0.5 && aux < 254.5) {
    float far = step(127.5, aux);
    float rise = (aux - mix(1.0, 128.0, far)) * 0.6;
    // grown = 1 near, 0 at the fade end (edge0 < edge1: defined on every GPU)
    float sunk = smoothstep(mix(uPropFade.x, uPropFade.z, far), mix(uPropFade.y, uPropFade.w, far), dist);
    wp.y -= rise * sunk;
  }
  gl_Position = projectionMatrix * viewMatrix * wp;
  if (aux > 254.5) {
    float w = max(gl_Position.w, 1.0);
    gl_Position.z -= 2.0 * uCamNear * (0.45 + 0.004 * w) / w;
  }
  vFog = clamp((dist - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0) * uFog.z;
#ifdef USE_MAP
  vUv = uv;
#endif
}`;

const WORLD_FS = /* glsl */ `
uniform vec3 uFogColor;
varying vec3 vColor;
varying float vFog;
#ifdef USE_MAP
uniform sampler2D map;
varying vec2 vUv;
#endif
void main() {
  vec3 c = vColor;
#ifdef USE_MAP
  c *= texture2D(map, vUv).rgb;
#endif
  gl_FragColor = vec4(mix(c, uFogColor, vFog), 1.0);
}`;

const WATER_VS = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WATER_FS = /* glsl */ `
uniform vec3 uNear;
uniform vec3 uFar;
uniform vec3 uGlint;
uniform vec3 uFogColor;
uniform vec3 uFog;
uniform vec3 uLightDir;
uniform float uTime;
uniform float uGlintAmt;
varying vec3 vWorld;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 V = normalize(vWorld - cameraPosition);
  float dist = length(vWorld.xz - cameraPosition.xz);
  float t = smoothstep(40.0, 9000.0, dist);
  vec3 c = mix(uNear, uFar, pow(t, 0.55));
  // Moon/sun glitter: a path of short dashes toward the light.
  vec2 p = vWorld.xz;
  vec2 cell = floor(p / vec2(3.0, 1.2) + vec2(0.0, uTime * 0.6));
  float n = h21(cell);
  float wob = (n - 0.5) * 0.22 + 0.06 * sin(uTime * 1.7 + n * 40.0);
  vec3 N = normalize(vec3(wob, 1.0, (h21(cell + 7.0) - 0.5) * 0.22));
  vec3 R = reflect(V, N);
  float s = dot(R, uLightDir);
  float path = smoothstep(0.965, 0.995, s) * step(0.52, n) * (0.6 + 0.4 * sin(uTime * 2.3 + n * 31.0));
  c = mix(c, uGlint, clamp(path * uGlintAmt, 0.0, 1.0));
  float fog = clamp((distance(vWorld, cameraPosition) - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0) * uFog.z * 0.8;
  gl_FragColor = vec4(mix(c, uFogColor, fog), 1.0);
}`;

const LIGHTS_VS = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
uniform float uScale;
uniform float uCamNear;
uniform vec3 uFog;
varying vec3 vColor;
varying float vFade;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float dist = distance(wp.xyz, cameraPosition);
  vColor = aColor;
  vFade = 1.0 - clamp((dist - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0) * uFog.z * 0.55;
  vec4 p = projectionMatrix * viewMatrix * wp;
  float w = max(p.w, 1.0);
  p.z -= 2.0 * uCamNear * (2.0 + 0.1 * w) / w; // pull 10 % closer: coarse far terrain must not swallow them
  gl_Position = p;
  gl_PointSize = aSize * uScale * clamp(1800.0 / dist, 0.9, 1.7);
}`;

const LIGHTS_FS = /* glsl */ `
uniform float uStrength;
varying vec3 vColor;
varying float vFade;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q) * 2.0;
  float a = ((1.0 - smoothstep(0.0, 1.0, r)) * 0.55 + (1.0 - smoothstep(0.0, 0.45, r)) * 0.6) * vFade * uStrength;
  gl_FragColor = vec4(vColor * a, a);
}`;

const SHAFT_VS = /* glsl */ `
varying float vA;
void main() {
  // a column of lit mist: even along its length, soft at the ends and edges
  vA = smoothstep(0.0, 0.06, uv.y) * (1.0 - smoothstep(0.75, 1.0, uv.y)) * smoothstep(0.0, 0.45, 1.0 - abs(uv.x - 0.5) * 2.0);
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const SHAFT_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uAmount;
varying float vA;
void main() { float a = vA * uAmount; gl_FragColor = vec4(uColor * a, a); }`;

// ---------------------------------------------------------------- helpers

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Exact critically damped spring step (value x, velocity v → target).
function spring(state, key, vkey, target, omega, dt) {
  const x = state[key];
  const v = state[vkey];
  const delta = x - target;
  const e = Math.exp(-omega * dt);
  const temp = (v + omega * delta) * dt;
  state[vkey] = (v - omega * temp) * e;
  state[key] = target + (delta + temp) * e;
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// Plain copy of the route for the worker / chunk builder (no methods).
function routeData(route) {
  return {
    id: route.id,
    name: route.name,
    kind: route.kind,
    loop: !!route.loop,
    length: route.length,
    x: Float64Array.from(route.x),
    z: Float64Array.from(route.z),
    elevation: Float64Array.from(route.elevation),
    minElevation: route.minElevation,
    maxElevation: route.maxElevation,
  };
}

// ---------------------------------------------------------------- World

export class World {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = { maxPixelRatio: 2, antialias: true, aspectMode: 'auto', ftp: 250, useWorker: true, adaptive: true, ...opts };
    const dpr = Math.min(this.opts.maxPixelRatio, globalThis.devicePixelRatio || 1);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.opts.antialias && dpr <= 2,
      powerPreference: 'low-power',
      alpha: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.outputColorSpace = LIN; // palettes are final sRGB values: no conversion
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = false;
    this.renderer.info.autoReset = true;
    this.basePixelRatio = dpr;
    this.renderScale = 1;
    this.fixedScale = null;
    this.renderer.setPixelRatio(dpr);
    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = true;
    this.camera = new THREE.PerspectiveCamera(54, 1, 1, 14000);
    this.camera.rotation.order = 'YXZ';
    this.aspectMode = this.opts.aspectMode;
    this.landscape = false;
    this.width = 1;
    this.height = 1;

    this.route = null;
    this.theme = DEFAULT_THEME;
    this.ctx = null;
    this.leaves = new Map(); // key → leaf record
    this.tree = new Map(); // selection tree of the last streaming pass
    this.roots = [];
    this.splitNodes = new Set();
    this.gen = 0;
    this.pending = 0;
    this.lastSelect = { x: Infinity, z: Infinity, t: 0 };
    this.display = { distance: 0, heading: null, lean: 0 };
    this.cam = { s: 0, vs: 0, x: 0, y: 0, z: 0, vy: 0, yaw: 0, vyaw: 0, pitch: 0, vpitch: 0, lift: 0, crane: 0, vcrane: 0, ready: false };
    this.time = 0;
    this.lost = false;
    this._running = true;
    this.stats = { fps: 0, frameMs: 0, cpuMs: 0, triangles: 0, calls: 0, leaves: 0, pending: 0, lastBuildMs: 0, avgBuildMs: 0, buildCount: 0, renderScale: 1, pixelRatio: dpr };
    this._frame = { last: 0, slow: 0, fast: 0 };
    this._s = { x: 0, z: 0, elevation: 0, heading: 0, grade: 0, d: 0, direction: 1 };
    this._s2 = { x: 0, z: 0, elevation: 0, heading: 0, grade: 0, d: 0, direction: 1 };
    this._t = { x: 0, y: 0, z: 0 };
    this._riderArgs = { cadence: 0, grade: 0, effort: 0, tucked: false, lean: 0, blink: false };
    this._dirty = true;

    this.onLost = (e) => {
      e.preventDefault();
      this.lost = true;
      // Drop GPU-side copies while the context is gone (deletes are no-ops
      // now); geometry/texture data stays in JS and re-uploads on restore.
      this.releaseGPU();
    };
    this.onRestored = () => {
      this.lost = false;
      this.resize(this.width, this.height);
    };
    canvas.addEventListener('webglcontextlost', this.onLost, false);
    canvas.addEventListener('webglcontextrestored', this.onRestored, false);

    this.buildStatic();
    this.initWorker();
  }

  // ---------------------------------------------------------------- setup

  releaseGPU() {
    const seen = new Set();
    const drop = (o) => {
      if (o && !seen.has(o) && typeof o.dispose === 'function') {
        seen.add(o);
        o.dispose();
      }
    };
    this.scene.traverse((obj) => {
      drop(obj.geometry);
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        drop(m.map);
        if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u?.value?.isTexture) drop(u.value);
        drop(m);
      }
    });
  }

  buildStatic() {
    const scene = this.scene;
    this.worldUniforms = {
      uFog: { value: new THREE.Vector3(150, 4000, 0.65) },
      uFogColor: { value: new THREE.Color() },
      uPropFade: { value: new THREE.Vector4(360, 520, 1050, 1500) },
      uCamNear: { value: this.camera.near },
    };
    this.worldMaterial = new THREE.ShaderMaterial({ vertexShader: WORLD_VS, fragmentShader: WORLD_FS, uniforms: this.worldUniforms });

    this.sky = new SkySystem(scene);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 2);
    this.key = new THREE.DirectionalLight(0xffffff, 2);
    scene.add(this.hemi, this.key, this.key.target);

    this.leafGroup = new THREE.Group();
    this.leafGroup.name = 'terrain';
    scene.add(this.leafGroup);

    this.rider = createRider();
    scene.add(this.rider.group);
    this.ghost = null; // created on first use
    this.ghostTarget = null;
    this.ghostDisplay = null;

    this.glowTexture = radialTexture(64, 2.2);
    this.glows = [];

    this.waterUniforms = {
      uNear: { value: new THREE.Color() },
      uFar: { value: new THREE.Color() },
      uGlint: { value: new THREE.Color() },
      uFogColor: this.worldUniforms.uFogColor,
      uFog: this.worldUniforms.uFog,
      uLightDir: { value: new THREE.Vector3(0, 0.4, -1).normalize() },
      uTime: { value: 0 },
      uGlintAmt: { value: 1 },
    };
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000, 1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({ vertexShader: WATER_VS, fragmentShader: WATER_FS, uniforms: this.waterUniforms }));
    this.water.visible = false;
    this.water.frustumCulled = false;
    scene.add(this.water);

    this.lightsUniforms = { uScale: { value: 1 }, uFog: this.worldUniforms.uFog, uStrength: { value: 1 }, uCamNear: this.worldUniforms.uCamNear };
    this.lightsPoints = null;
    this.shafts = null;
  }

  initWorker() {
    this.worker = null;
    if (!this.opts.useWorker || typeof Worker === 'undefined') return;
    try {
      const w = new Worker(new URL('./chunkWorker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => this.onWorkerMessage(e.data);
      w.onerror = (e) => {
        e.preventDefault?.();
        this.workerFailed('worker error');
      };
      w.onmessageerror = () => this.workerFailed('message error');
      this.worker = w;
      this.workerReady = false;
    } catch {
      this.worker = null;
    }
  }

  workerFailed() {
    if (!this.worker) return;
    try {
      this.worker.terminate();
    } catch {
      /* ignore */
    }
    this.worker = null;
    // Everything in flight is rebuilt on the main thread.
    for (const leaf of this.leaves.values()) if (leaf.pending) leaf.pending = false;
    this.pending = 0;
  }

  onWorkerMessage(m) {
    if (m.gen !== this.gen) return;
    if (m.type === 'ready') {
      this.workerReady = true;
      return;
    }
    if (m.type === 'error') {
      const leaf = this.leaves.get(m.key);
      if (leaf) leaf.failed = (leaf.failed ?? 0) + 1;
      this.pending = Math.max(0, this.pending - 1);
      console.warn('[world] chunk build failed', m.message);
      return;
    }
    if (m.type === 'leaf') {
      this.pending = Math.max(0, this.pending - 1);
      this._dirty = true;
      this.integrateLeaf(m.key, m);
      this.resolveDisplay();
    }
  }

  // ---------------------------------------------------------------- route & theme

  setRoute(route, theme) {
    this.route = route;
    this.display = { distance: 0, heading: null, lean: 0 };
    this.cam.ready = false;
    const ok = theme && (theme.routeId == null || theme.routeId === route.id);
    this.applyTheme(ok ? theme : themeFor(route, theme?.timeOfDay ?? this.theme?.timeOfDay ?? timeOfDayNow()));
  }

  setTimeOfDay(tod) {
    if (this.route) this.applyTheme(themeFor(this.route, tod));
  }

  applyTheme(theme) {
    this.theme = theme;
    const t = theme;
    if (!this.route) {
      this.sky.apply(t);
      return;
    }
    this.gen++;
    const sameRoute = this.ctx && this.ctx.route === this.route;
    // Same route, new colours: keep today's leaves on screen until the new
    // generation covers the view (no blank frames at 19:30 / 20:30).
    if (sameRoute && this.leaves.size) this.retireLeaves();
    else this.clearLeaves();
    this.ctx = createContext(this.route, t, sameRoute ? this.ctx : null);
    if (this.worker) {
      this.workerReady = false;
      this.worker.postMessage({ type: 'init', gen: this.gen, route: routeData(this.route), theme: t });
    }
    // Fog & props fade.
    col(t.fog.color, this.worldUniforms.uFogColor.value);
    this.worldUniforms.uFog.value.set(t.fog.near, t.fog.far, t.fog.max);
    const [pn, pf] = t.propFar;
    this.worldUniforms.uPropFade.value.set(pn * 0.7, pn, pf * 0.7, pf);
    this.camera.far = Math.max(1500, Math.min(16000, t.view * 1.25));
    this.camera.updateProjectionMatrix();
    this.renderer.setClearColor(col(t.sky.ground), 1);
    // Lights for the rider.
    // The rider is the subject: keep the kit readable at night (ink stays ink,
    // cream stays cream) — sky/ground tints only nudge it toward the scene.
    col(t.light.hemiSky, this.hemi.color).lerp(new THREE.Color(1, 0.97, 0.92), 0.55);
    col(t.light.hemiGround, this.hemi.groundColor).lerp(new THREE.Color(0.55, 0.5, 0.46), 0.5);
    this.hemi.intensity = Math.PI * 1.0;
    col(t.light.color, this.key.color).lerp(new THREE.Color(1, 0.95, 0.88), 0.4);
    this.key.intensity = Math.PI * (0.55 + t.light.intensity * 0.35);
    this.rider.setColors(t.rider);
    this.sky.apply(t);
    this.buildWater();
    this.buildLights();
    this.buildFurniture();
    this.buildShafts();
    this.lastSelect.x = Infinity;
  }

  buildWater() {
    const w = this.theme.water;
    this.water.visible = !!w;
    if (!w) return;
    col(w.near, this.waterUniforms.uNear.value);
    col(w.far, this.waterUniforms.uFar.value);
    col(w.glint, this.waterUniforms.uGlint.value);
    const L = dirFromAngles(this.theme.light.bearing, this.theme.timeOfDay === 'night' ? this.theme.light.moonElevation ?? 17 : Math.max(6, this.theme.light.elevation));
    this.waterUniforms.uLightDir.value.set(L[0], L[1], L[2]).normalize();
    this.waterUniforms.uGlintAmt.value = this.theme.timeOfDay === 'night' ? 0.95 : this.theme.timeOfDay === 'day' ? 0.35 : 0.75;
    this.water.position.y = w.level ?? 0;
  }

  // Valley / village lights at dusk and night: clusters near the road plus
  // towns scattered over flat valley floors (one Points draw).
  buildLights() {
    if (this.lightsPoints) {
      this.scene.remove(this.lightsPoints);
      this.lightsPoints.geometry.dispose();
      this.lightsPoints.material.dispose();
      this.lightsPoints = null;
    }
    const spec = this.theme.lights;
    if (!spec || !this.ctx) return;
    const { field, index } = this.ctx;
    const route = this.route;
    const pos = [];
    const colr = [];
    const size = [];
    const c1 = rgb(spec.colors[0]);
    const c2 = rgb(spec.colors[1]);
    const add = (x, z, y, k) => {
      pos.push(x, y, -z);
      const c = hash3(k, 7, 3) < 0.25 ? c2 : c1;
      const b = 0.75 + 0.25 * hash3(k, 8, 1);
      colr.push(c[0] * b, c[1] * b, c[2] * b);
      size.push(2.2 + 2.6 * hash3(k, 9, 2));
    };
    const q = { distance: 0, y: 0, d: 0, side: 0, i: 0, t: 0 };
    let k = 0;
    for (const cl of spec.clusters ?? []) {
      let cx;
      let cz;
      if (cl.at === 'end') {
        cx = route.x[route.x.length - 1];
        cz = route.z[route.z.length - 1];
      } else if (cl.at === 'start') {
        cx = route.x[0];
        cz = route.z[0];
      } else {
        const s = route.stateAt(cl.atM ?? 0);
        cx = s.x;
        cz = s.z;
      }
      for (let i = 0; i < cl.count * 3 && k < 4000; i++) {
        const a = hash3(i, 11, k) * Math.PI * 2;
        const r = cl.radius * Math.sqrt(hash3(i, 13, 5));
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const near = index.nearestInto(x, z, 14, q);
        if (near && near.distance < 9) continue;
        const y = field.height(x, z);
        // villages sit on gentle ground, not up the walls
        if (Math.abs(field.height(x + 15, z) - y) + Math.abs(field.height(x, z + 15) - y) > 7) continue;
        add(x, z, y + 2.5, k++);
        if (i > cl.count) break;
      }
    }
    // Towns on valley floors (Bay Area, Provence plain, Alpine valleys):
    // clusters of street lights where the ground is low and gentle.
    const T = this.theme.terrain;
    if (spec.plain && T.floor != null) {
      const b = index.bounds;
      const cx = (b.minX + b.maxX) / 2;
      const cz = (b.minZ + b.maxZ) / 2;
      const R = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 11000;
      const seed = this.ctx.seed;
      for (let i = 0; i < 36000 && k < 9000; i++) {
        const x = cx + (hash3(i, 21, seed) * 2 - 1) * R;
        const z = cz + (hash3(i, 23, seed) * 2 - 1) * R;
        const town = gradNoise(x / 2200, z / 2200, seed + 3) + 0.45 * gradNoise(x / 500, z / 500, seed + 4);
        if (town < 0.05) continue;
        const near = index.farthestFallback(x, z);
        if (near.distance < 700) continue;
        const y = field.height(x, z);
        if (y > T.floor + 45 || y < 1.5) continue;
        // a little street of lights
        const n = 3 + Math.floor(hash3(i, 25, seed) * 7 * Math.min(1, town * 2));
        const a = hash3(i, 27, seed) * Math.PI;
        for (let j = 0; j < n; j++) {
          const t = (j - n / 2) * (22 + 18 * hash3(i, j, 29));
          add(x + Math.cos(a) * t + (hash3(i, j, 31) - 0.5) * 30, z + Math.sin(a) * t + (hash3(i, j, 33) - 0.5) * 30, y + 3, k++);
        }
      }
    }
    // A city across the water (e.g. San Francisco from Hawk Hill).
    if (spec.city) {
      const end = { x: route.x[route.x.length - 1], z: route.z[route.z.length - 1] };
      for (let i = 0; i < 900; i++) {
        const bearing = ((spec.city.bearing + (hash3(i, 31, 1) - 0.5) * spec.city.spread) * Math.PI) / 180;
        const r = 3800 + 3200 * hash3(i, 33, 2);
        const x = end.x + Math.sin(bearing) * r;
        const z = end.z + Math.cos(bearing) * r;
        add(x, z, 4 + Math.pow(hash3(i, 35, 3), 3) * 120, k++);
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(colr, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    this.lightsUniforms.uStrength.value = spec.strength;
    const m = new THREE.ShaderMaterial({ vertexShader: LIGHTS_VS, fragmentShader: LIGHTS_FS, uniforms: this.lightsUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.lightsPoints = new THREE.Points(g, m);
    this.lightsPoints.renderOrder = 10;
    this.scene.add(this.lightsPoints);
  }

  buildFurniture() {
    if (this.furniture) {
      this.scene.remove(this.furniture);
      this.furniture.geometry.dispose();
      this.furniture.material.uniforms.map?.value?.dispose();
      this.furniture.material.dispose();
      this.furniture = null;
    }
    for (const g of this.glows) {
      this.scene.remove(g.sprite);
      g.sprite.material.dispose();
    }
    this.glows = [];
    if (!this.ctx) return;
    const f = buildFurniture(this.ctx, this.theme, this.route);
    if (f.geometry) {
      const uniforms = { ...this.worldUniforms, map: { value: f.texture } };
      const m = new THREE.ShaderMaterial({ vertexShader: WORLD_VS, fragmentShader: WORLD_FS, uniforms, defines: f.texture ? { USE_MAP: '' } : {} });
      this.furniture = new THREE.Mesh(f.geometry, m);
      this.furniture.name = 'furniture';
      this.scene.add(this.furniture);
    }
    for (const gl of f.glows) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTexture, color: col(gl.color), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
      sprite.position.set(gl.pos[0], gl.pos[1], gl.pos[2]);
      sprite.scale.set(gl.size, gl.size, 1);
      sprite.renderOrder = 11;
      this.scene.add(sprite);
      this.glows.push({ sprite, ...gl });
    }
  }

  // Moonlight shafts through the redwood canopy (5 %), world-fixed along the road.
  buildShafts() {
    if (this.shafts) {
      this.scene.remove(this.shafts);
      this.shafts.geometry.dispose();
      this.shafts.material.dispose();
      this.shafts = null;
    }
    if (!this.theme.shafts) return;
    const geo = new THREE.PlaneGeometry(7, 60, 1, 1).translate(0, 30, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: SHAFT_VS,
      fragmentShader: SHAFT_FS,
      uniforms: { uColor: { value: col('#EDE2C8') }, uAmount: { value: this.theme.timeOfDay === 'night' ? 0.07 : 0.09 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.shafts = new THREE.InstancedMesh(geo, mat, 8);
    this.shafts.frustumCulled = false;
    this.shafts.renderOrder = 12;
    this.scene.add(this.shafts);
    this._shaftObj = new THREE.Object3D();
  }

  // ---------------------------------------------------------------- leaves

  retireLeaves() {
    this.dropRetired();
    const old = new THREE.Group();
    old.name = 'retiring';
    for (const leaf of this.leaves.values()) {
      if (leaf.mesh && leaf.mesh.visible) {
        this.leafGroup.remove(leaf.mesh);
        old.add(leaf.mesh);
        leaf.mesh = null;
      } else this.disposeLeaf(leaf);
    }
    this.leaves.clear();
    this.tree.clear();
    this.roots = [];
    this.splitNodes.clear();
    this.pending = 0;
    this.scene.add(old);
    this.retired = old;
    this.retiredAt = this.time;
    this.leafGroup.visible = false;
  }

  dropRetired() {
    if (!this.retired) return;
    this.scene.remove(this.retired);
    for (const g of this.retired.children) for (const m of g.children) m.geometry.dispose();
    this.retired = null;
    this.leafGroup.visible = true;
  }

  clearLeaves() {
    this.dropRetired();
    for (const leaf of this.leaves.values()) this.disposeLeaf(leaf);
    this.leaves.clear();
    this.tree.clear();
    this.roots = [];
    this.splitNodes.clear();
    this.pending = 0;
  }

  disposeLeaf(leaf) {
    if (leaf.mesh) {
      this.leafGroup.remove(leaf.mesh);
      for (const m of leaf.mesh.children) m.geometry.dispose();
      leaf.mesh = null;
    }
  }

  integrateLeaf(key, data) {
    let leaf = this.leaves.get(key);
    if (!leaf) {
      leaf = { key, level: data.level, ix: data.ix, iz: data.iz, mesh: null, meshes: null, pending: false, used: this.time };
      this.leaves.set(key, leaf);
    }
    leaf.pending = false;
    if (leaf.mesh) this.disposeLeaf(leaf);
    // One group per leaf; near leaves arrive as four quadrant meshes (finer culling).
    const group = new THREE.Group();
    group.name = key;
    group.visible = false;
    group.matrixAutoUpdate = false;
    for (const part of data.parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
      geo.setAttribute('paint', new THREE.BufferAttribute(part.paint, 4, true));
      const b = part.box;
      const box = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5]));
      geo.boundingBox = box;
      geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(geo, this.worldMaterial);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    this.leafGroup.add(group);
    leaf.mesh = group;
    leaf.triangles = data.triangles;
    const s = this.stats;
    s.lastBuildMs = data.ms;
    s.buildCount++;
    s.avgBuildMs += (data.ms - s.avgBuildMs) / Math.min(s.buildCount, 30);
  }

  // Quadtree selection around (x, z) in route space.
  select(x, z) {
    const view = this.theme.view ?? 10000;
    const tree = this.tree;
    tree.clear();
    this.roots.length = 0;
    const S = LEVELS[TOP].size;
    const r = Math.ceil((view + S) / S);
    const cx = Math.floor(x / S);
    const cz = Math.floor(z / S);
    const prevSplit = this.splitNodes;
    const nextSplit = new Set();
    const visit = (level, ix, iz) => {
      const size = LEVELS[level].size;
      const x0 = ix * size;
      const z0 = iz * size;
      const dx = Math.max(x0 - x, 0, x - (x0 + size));
      const dz = Math.max(z0 - z, 0, z - (z0 + size));
      const d = Math.hypot(dx, dz);
      if (d > view) return null;
      const key = `${level}:${ix}:${iz}`;
      const wasSplit = prevSplit.has(key);
      const split = level > 0 && d < SPLIT[level] * size * (wasSplit ? 1.15 : 1);
      const node = { key, level, ix, iz, d, split, kids: null };
      if (split) {
        nextSplit.add(key);
        node.kids = [];
        for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
          const k = visit(level - 1, ix * 2 + a, iz * 2 + b);
          if (k) node.kids.push(k);
        }
      }
      tree.set(key, node);
      return key;
    };
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const k = visit(TOP, cx + i, cz + j);
      if (k) this.roots.push(k);
    }
    this.splitNodes = nextSplit;
  }

  isBuilt(key) {
    const l = this.leaves.get(key);
    return !!(l && l.mesh);
  }

  // Cover a node's area with built leaves (itself or descendants).
  cover(level, ix, iz, out) {
    const key = `${level}:${ix}:${iz}`;
    if (this.isBuilt(key)) {
      out.push(key);
      return true;
    }
    if (level === 0) return false;
    const mark = out.length;
    for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
      if (!this.cover(level - 1, ix * 2 + a, iz * 2 + b, out)) {
        out.length = mark;
        return false;
      }
    }
    return true;
  }

  resolveNode(key, out) {
    const node = this.tree.get(key);
    if (!node) return true;
    if (!node.split) return this.cover(node.level, node.ix, node.iz, out);
    const mark = out.length;
    let ok = true;
    for (const k of node.kids) {
      if (!this.resolveNode(k, out)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
    out.length = mark;
    if (this.isBuilt(key)) {
      out.push(key);
      return true;
    }
    return false;
  }

  // Show exactly one built version of every area (no overlaps, no holes once built).
  resolveDisplay() {
    const show = [];
    let complete = this.roots.length > 0;
    for (const r of this.roots) {
      const mark = show.length;
      if (!this.resolveNode(r, show)) {
        complete = false;
        show.length = mark;
        // partial: show whatever built leaves exist in this root's tree
        this.partial(r, show);
      }
    }
    if (this.retired && (complete || this.time - this.retiredAt > 6)) this.dropRetired();
    const visible = new Set(show);
    let tris = 0;
    const perLevel = [0, 0, 0, 0, 0];
    for (const leaf of this.leaves.values()) {
      const v = visible.has(leaf.key);
      if (leaf.mesh) leaf.mesh.visible = v;
      if (v) {
        leaf.used = this.time;
        tris += leaf.triangles ?? 0;
        perLevel[leaf.level]++;
      }
    }
    this.stats.leaves = visible.size;
    this.stats.leafTriangles = tris;
    this.stats.perLevel = perLevel.join('/');
  }

  partial(key, out) {
    const node = this.tree.get(key);
    if (!node) return;
    if (this.isBuilt(key) && !node.split) {
      out.push(key);
      return;
    }
    if (node.split) {
      const mark = out.length;
      let all = true;
      for (const k of node.kids) {
        const m2 = out.length;
        if (!this.resolveNode(k, out)) {
          out.length = m2;
          all = false;
          this.partial(k, out);
        }
      }
      if (!all && this.isBuilt(key)) {
        out.length = mark;
        out.push(key);
      }
    }
  }

  // Wanted leaves that still need building, nearest first.
  missing() {
    const list = [];
    for (const node of this.tree.values()) {
      if (node.split) continue;
      const leaf = this.leaves.get(node.key);
      if (leaf && (leaf.mesh || leaf.pending)) continue;
      list.push(node);
    }
    list.sort((a, b) => a.d - b.d || a.level - b.level);
    return list;
  }

  request(node) {
    let leaf = this.leaves.get(node.key);
    if (!leaf) {
      leaf = { key: node.key, level: node.level, ix: node.ix, iz: node.iz, mesh: null, pending: false, used: this.time };
      this.leaves.set(node.key, leaf);
    }
    if (this.worker) {
      leaf.pending = true;
      this.pending++;
      this.worker.postMessage({ type: 'build', gen: this.gen, key: node.key, level: node.level, ix: node.ix, iz: node.iz });
      return false;
    }
    try {
      const data = buildLeaf(this.ctx, node.level, node.ix, node.iz);
      this.integrateLeaf(node.key, data);
    } catch (err) {
      leaf.pending = true; // don't retry a leaf that throws
      console.warn('[world] chunk build failed', err);
    }
    return true;
  }

  // Keep the quadtree around (x, z) (route space); build at most `budget`
  // leaves now on the main thread (or keep ≤ 3 requests in flight in the
  // worker). Returns how many wanted leaves are still missing or in flight
  // (0 = the view is complete), so a sliced loader can loop while it is
  // non-zero — although prewarm() is the better loader.
  streamChunks(x, z, budget = 2) {
    if (!this.ctx) return 0;
    const moved = Math.hypot(x - this.lastSelect.x, z - this.lastSelect.z);
    if (moved > 18) {
      this.select(x, z);
      this.lastSelect.x = x;
      this.lastSelect.z = z;
      this.lastSelect.t = this.time;
      this.resolveDisplay();
      this.evict();
      this._dirty = true;
    }
    let built = 0;
    if (!this._dirty) return this.pending;
    if (this.worker && this.pending >= 3) return this.pending + this.stats.pending;
    const missing = this.missing();
    if (!missing.length) this._dirty = false;
    if (this.worker) {
      for (const node of missing) {
        if (this.pending >= 3) break;
        this.request(node);
        built++;
      }
    } else {
      const t0 = now();
      for (const node of missing) {
        if (built >= budget || (built > 0 && now() - t0 > 12)) break;
        this.request(node);
        built++;
      }
      if (built) this.resolveDisplay();
    }
    this.stats.pending = missing.length - built;
    return this.stats.pending + this.pending;
  }

  // Drop leaves that are neither wanted nor shown, oldest first (keep a cache).
  evict() {
    const keep = 90;
    if (this.leaves.size <= keep) return;
    const idle = [];
    for (const leaf of this.leaves.values()) {
      if (leaf.pending) continue;
      if (leaf.mesh?.visible) continue;
      const node = this.tree.get(leaf.key);
      if (node && !node.split) continue;
      idle.push(leaf);
    }
    idle.sort((a, b) => a.used - b.used);
    for (let i = 0; i < idle.length && this.leaves.size > keep; i++) {
      this.disposeLeaf(idle[i]);
      this.leaves.delete(idle[i].key);
    }
  }

  // Build everything visible from the current position before the ride starts.
  async prewarm(onProgress, { distance } = {}) {
    if (!this.route) return;
    if (distance != null) this.display.distance = distance;
    this.placeCameraNow();
    const x = this.cam.x;
    const z = -this.cam.z;
    this.select(x, z);
    this.lastSelect.x = x;
    this.lastSelect.z = z;
    this.lastSelect.t = this.time;
    const total = this.missing().length;
    const gen = this.gen;
    let guard = 0;
    for (;;) {
      if (gen !== this.gen) return;
      const missing = this.missing();
      if (!missing.length && this.pending === 0) break;
      if (this.worker) {
        for (const node of missing) {
          if (this.pending >= 6) break;
          this.request(node);
        }
        await new Promise((r) => setTimeout(r, 8));
        if (++guard > 4000) break;
      } else {
        const t0 = now();
        for (const node of missing) {
          this.request(node);
          if (now() - t0 > 30) break;
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      onProgress?.(Math.max(0, total - this.missing().length - this.pending), total);
    }
    this.resolveDisplay();
    onProgress?.(total, total);
  }

  // ---------------------------------------------------------------- per frame

  // Allocation-free equivalent of route.stateAt(total).
  sample(total, out) {
    const r = this.route;
    const lap = r.lapLength;
    let t = ((total % lap) + lap) % lap;
    let dir = 1;
    if (!r.loop && t > r.length) {
      t = 2 * r.length - t;
      dir = -1;
    }
    out.d = t;
    out.direction = dir;
    out.x = r.sample(r.x, t);
    out.z = r.sample(r.z, t);
    out.elevation = r.elevationAt(t);
    const fwd = Math.min(r.length, t + 3);
    const back = Math.max(0, fwd - 6);
    let h = Math.atan2(r.sample(r.x, fwd) - r.sample(r.x, back), r.sample(r.z, fwd) - r.sample(r.z, back));
    if (dir < 0) h = wrap(h + Math.PI);
    out.heading = h;
    out.grade = r.gradeAt(t) * dir;
    return out;
  }

  cameraConfig() {
    const c = this.theme.camera ?? {};
    const k = this.cam?.crane ?? 0; // 0 … 1 through tight hairpins
    if (this.landscape) return { back: 8.6 + 2 * k, up: 2.7 + 2.4 * k, lateral: -0.9, pitch: -0.025 - 0.12 * k, fov: 42 };
    return { back: (c.back ?? 6) + 2 * k, up: (c.height ?? 2.8) + 2.4 * k, lateral: c.lateral ?? -0.75, pitch: -0.056 - 0.12 * k, fov: 54 };
  }

  laneOffset() {
    return this.theme.road?.kind === 'trail' ? 0 : 1.1;
  }

  // Camera position on the road path at along-route distance `d` (no smoothing).
  cameraAt(d, out) {
    const cfg = this.cameraConfig();
    const s = this.sample(d, this._s2);
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const lat = this.laneOffset() + cfg.lateral;
    out.x = s.x + fz * lat;
    out.z = s.z - fx * lat;
    out.y = s.elevation + cfg.up;
    return out;
  }

  // Along-route gap that puts the camera `back` metres behind on the ground.
  cameraGap(back) {
    const d0 = this.display.distance;
    const a = this.sample(d0 - back - 2, this._s2);
    const ax = a.x;
    const az = a.z;
    const b = this.sample(d0 + 2, this._s2);
    const k = Math.max(0.5, Math.min(1.6, Math.hypot(b.x - ax, b.z - az) / (back + 4)));
    return back / k;
  }

  placeCameraNow() {
    const cfg = this.cameraConfig();
    const c = this.cam;
    c.s = this.display.distance - this.cameraGap(cfg.back);
    c.vs = 0;
    const t = this.cameraAt(c.s, this._t);
    c.x = t.x;
    c.y = t.y;
    c.z = -t.z;
    c.vy = 0;
    const s = this.sample(this.display.distance, this._s);
    c.yaw = -s.heading;
    c.vyaw = 0;
    c.pitch = cfg.pitch;
    c.vpitch = 0;
    c.lift = 0;
    c.ready = true;
  }

  // ride: { distance, speed, cadence, tucked, power?, grade?, ftp? } from the engine snapshot
  update(ride, dt) {
    if (!this.route || this.lost || !this._running) return;
    const t0 = now();
    dt = Math.min(0.1, Math.max(0, dt || 0));
    this.time += dt;
    const D = this.display;
    const speed = ride.speed ?? 0;
    D.distance += speed * dt;
    D.distance += (ride.distance - D.distance) * Math.min(1, dt * 2.5);
    if (Math.abs(ride.distance - D.distance) > 150) D.distance = ride.distance;
    const s = this.sample(D.distance, this._s);
    if (D.heading == null) D.heading = s.heading;
    D.heading = s.heading;

    // Rider on the road, right of centre.
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const lane = this.laneOffset();
    const px = s.x + fz * lane;
    const pz = s.z - fx * lane;
    const py = s.elevation + 0.05;
    // Lean from curvature (v²κ/g).
    const ahead = this.sample(D.distance + 6, this._s2);
    const kappa = wrap(ahead.heading - s.heading) / 6;
    const leanT = Math.max(-0.3, Math.min(0.3, Math.atan((speed * speed * kappa) / 9.81)));
    D.lean += (leanT - D.lean) * Math.min(1, dt * 3);
    const rg = this.rider.group;
    rg.position.set(px, py, -pz);
    rg.rotation.set(Math.atan(s.grade / 100), -s.heading, 0);
    const ftp = ride.ftp ?? this.opts.ftp;
    const ra = this._riderArgs;
    ra.cadence = ride.cadence ?? 0;
    ra.grade = s.grade;
    ra.effort = ride.power != null && ftp ? ride.power / ftp : 0;
    ra.tucked = !!ride.tucked;
    ra.lean = D.lean;
    ra.blink = !!this.theme.rider?.blink;
    this.rider.update(dt, ra);
    this.updateGhost(dt, ra);

    this.updateCamera(dt, s, px, py, pz, speed);
    this.updateLights(px, py, pz);

    // Things that ride along with the camera.
    const cam = this.camera;
    this.sky.update(cam);
    if (this.water.visible) {
      this.water.position.x = cam.position.x;
      this.water.position.z = cam.position.z;
      this.waterUniforms.uTime.value = this.time;
    }
    this.updateGlows();
    this.updateShafts();

    this.streamChunks(cam.position.x, -cam.position.z, 1);
    this.stats.cpuMs = now() - t0;
  }

  // ---------------------------------------------------------------- ghost

  setGhost(total) {
    this.ghostTarget = total == null || !Number.isFinite(total) ? null : total;
    if (this.ghostTarget == null) this.ghostDisplay = null;
  }

  makeGhost() {
    // Paper-coloured and see-through: a memory, not a rival.
    const p = '#F3EBDD';
    const g = createRider({ jersey: p, band: p, helmet: p, sock: p, skin: '#CDC1AF', skinShade: '#948877', shorts: '#CDC1AF', shoe: '#CDC1AF', bike: '#CDC1AF', bikeLit: p, tyre: '#948877' });
    g.material.transparent = true;
    g.material.opacity = 0.34;
    g.material.depthWrite = false;
    g.glow.visible = false;
    g.light.visible = false;
    g.shadow.visible = false;
    g.group.traverse((o) => (o.renderOrder = 6));
    this.scene.add(g.group);
    return g;
  }

  updateGhost(dt, ra) {
    const target = this.ghostTarget;
    if (target == null) {
      if (this.ghost) this.ghost.group.visible = false;
      return;
    }
    this.ghost ??= this.makeGhost();
    const g = this.ghost;
    // Glide toward the reported position (it arrives 4× a second).
    if (this.ghostDisplay == null || Math.abs(target - this.ghostDisplay) > 200) this.ghostDisplay = target;
    else this.ghostDisplay += (target - this.ghostDisplay) * Math.min(1, dt * 3);
    const s = this.sample(this.ghostDisplay, this._s2);
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const lane = this.laneOffset() - 1.1; // ride side by side, nearer the centre line
    g.group.visible = true;
    g.group.position.set(s.x + fz * lane, s.elevation + 0.05, -(s.z - fx * lane));
    g.group.rotation.set(Math.atan(s.grade / 100), -s.heading, 0);
    // The ghost has no tail light, whatever the hour.
    const ga = (this._ghostArgs ??= {});
    Object.assign(ga, ra);
    ga.blink = false;
    g.update(dt, ga);
  }

  updateCamera(dt, s, px, py, pz, speed) {
    const c = this.cam;
    // Crane up a little through tight hairpins (heading turns > ~60° within 20 m).
    const h0 = this.sample(this.display.distance - 8, this._s2).heading;
    const h1 = this.sample(this.display.distance + 12, this._s2).heading;
    const turn = Math.abs(wrap(h1 - h0));
    const craneT = Math.max(0, Math.min(1, (turn - 1.0) / 1.2));
    spring(c, 'crane', 'vcrane', craneT, 1.6, dt);
    c.crane = Math.max(0, Math.min(1, c.crane));
    const cfg = this.cameraConfig();
    if (!c.ready || Math.abs(c.s - (this.display.distance - cfg.back)) > 60) this.placeCameraNow();
    // Position: a critically damped spring (ω = 3.5 rad/s) *along the road*
    // with speed feed-forward, so the camera trails 6 m behind on the road
    // itself and never cuts the inside of a hairpin. Route distance is scaled
    // to ground distance (fictional loops are not sampled evenly).
    c.s += speed * dt;
    spring(c, 's', 'vs', this.display.distance - this.cameraGap(cfg.back), 3.5, dt);
    const t = this.cameraAt(c.s, this._t);
    c.x = t.x;
    c.z = -t.z;
    spring(c, 'y', 'vy', t.y, 3.5, dt);
    // Never inside the cut bank.
    const field = this.ctx.field;
    const ground = field.height(c.x, -c.z);
    if (c.y < ground + 1.1) {
      c.y = ground + 1.1;
      c.vy = Math.max(0, c.vy);
    }
    // Keep the rider in sight: inside tight hairpins the slope can rise between
    // camera and rider; lift the camera just enough to see over it (smoothed).
    let need = 0;
    const hx = px;
    const hy = py + 1.3;
    const hz = -pz;
    for (let k = 1; k <= 4; k++) {
      const f = k / 5;
      const x = c.x + (hx - c.x) * f;
      const y = c.y + (hy - c.y) * f;
      const z = c.z + (hz - c.z) * f;
      const g = field.height(x, -z) + 0.6;
      if (g > y) need = Math.max(need, (g - y) / (1 - f));
    }
    c.lift += (Math.min(need, 25) - c.lift) * Math.min(1, dt * (need > c.lift ? 6 : 1.5));
    // Yaw: look 25 m (+0.6 s) ahead along the road, but keep the rider in frame.
    const look = this.sample(this.display.distance + 25 + speed * 0.6, this._s2);
    const lane = this.laneOffset();
    const lx = look.x + Math.cos(look.heading) * lane;
    const lz = look.z - Math.sin(look.heading) * lane;
    const yawLook = Math.atan2(lx - c.x, lz + c.z); // compass bearing camera → look point
    const yawRider = Math.atan2(px - c.x, pz + c.z);
    const lookClamp = 0.24 * (1 - 0.8 * c.crane);
    const bearing = yawRider + Math.max(-lookClamp, Math.min(lookClamp, wrap(yawLook - yawRider)));
    const targetYaw = c.yaw + wrap(-bearing - c.yaw);
    spring(c, 'yaw', 'vyaw', targetYaw, 4, dt);
    c.yaw = wrap(c.yaw);
    // Hard limit: through a hairpin the bearing to the rider swings faster
    // than the spring follows; never let the rider leave the frame.
    const off = wrap(-yawRider - c.yaw);
    const maxOff = 0.3;
    if (Math.abs(off) > maxOff) {
      c.yaw = wrap(c.yaw + off - Math.sign(off) * maxOff);
      c.vyaw *= 0.5;
    }
    // Pitch: 40 % of the (smoothed) grade so climbs read as climbs (§6.7).
    const r = this.route;
    const d = s.d;
    const span = 15;
    const g = ((r.elevationAt(Math.min(r.length, d + span)) - r.elevationAt(Math.max(0, d - span))) / (2 * span)) * s.direction;
    spring(c, 'pitch', 'vpitch', cfg.pitch + 0.4 * Math.atan(g), 3, dt);
    const cam = this.camera;
    cam.position.set(c.x, c.y + c.lift, c.z);
    // When lifted, tilt down a little so the rider stays in frame.
    let pitch = c.pitch + (c.lift > 0.05 ? -Math.atan2(c.lift, 6.5) * 0.85 : 0);
    // Never let the rider's wheels drop out of the bottom of the frame.
    const horiz = Math.hypot(px - c.x, -pz - c.z) || 1;
    const feet = Math.atan2(py - (c.y + c.lift), horiz);
    const maxPitch = feet + (cfg.fov / 2 - 5) * (Math.PI / 180);
    if (pitch > maxPitch) pitch = maxPitch;
    cam.rotation.set(pitch, c.yaw, 0, 'YXZ');
    if (cam.fov !== cfg.fov) {
      cam.fov = cfg.fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }

  // Key light sits up and to the left of the camera so the rider's left side
  // reads lit (as in the mockups); colour/intensity follow the sun or moon.
  updateLights(px, py, pz) {
    const yaw = this.cam.yaw;
    const lx = -Math.cos(yaw);
    const lz = Math.sin(yaw);
    const bx = Math.sin(yaw);
    const bz = Math.cos(yaw);
    this.key.position.set(px + lx * 4 + bx * 3, py + 5, -pz + lz * 4 + bz * 3);
    this.key.target.position.set(px, py + 1, -pz);
    this.key.target.updateMatrixWorld();
  }

  updateGlows() {
    for (const g of this.glows) {
      let k = 1;
      if (g.sweep) k = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(this.time * 1.25), 6);
      else if (g.blink) k = 1 - g.blink + g.blink * (Math.sin(this.time * Math.PI * 2 * 0.5) > 0 ? 1 : 0.2);
      g.sprite.material.opacity = k;
    }
  }

  updateShafts() {
    const sh = this.shafts;
    if (!sh) return;
    const o = this._shaftObj;
    const d0 = Math.floor((this.display.distance - 40) / 45) * 45;
    for (let i = 0; i < 8; i++) {
      const d = d0 + i * 45;
      const s = this.sample(d, this._s2);
      const side = hash3(Math.round(d / 45), 3, 1) < 0.5 ? -1 : 1;
      const off = side * (4 + hash3(Math.round(d / 45), 5, 1) * 10);
      const x = s.x + Math.cos(s.heading) * off;
      const z = s.z - Math.sin(s.heading) * off;
      o.position.set(x, s.elevation - 1, -z);
      o.rotation.set(0.32, (this.theme.light.bearing * Math.PI) / 180 + i, 0.25 * side, 'YXZ');
      o.updateMatrix();
      sh.setMatrixAt(i, o.matrix);
    }
    sh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- output

  resize(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.applyPixelRatio();
    this.camera.aspect = this.width / this.height;
    this.landscape = this.aspectMode === 'landscape' || (this.aspectMode === 'auto' && this.camera.aspect > 1.3);
    this.camera.fov = this.cameraConfig().fov;
    this.camera.updateProjectionMatrix();
  }

  setAspectMode(mode = 'auto') {
    this.aspectMode = mode;
    this.resize(this.width, this.height);
    this.cam.ready = false;
  }

  applyPixelRatio() {
    const scale = this.fixedScale ?? this.renderScale;
    const pr = this.basePixelRatio * scale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(this.width, this.height, false);
    this.sky.setPixelRatio(pr);
    this.lightsUniforms.uScale.value = pr;
    this.stats.renderScale = scale;
    this.stats.pixelRatio = pr;
  }

  setRenderScale(s) {
    this.fixedScale = s == null ? null : Math.max(0.4, Math.min(1, s));
    this.applyPixelRatio();
  }

  setRunning(on) {
    this._running = !!on;
    this._frame.last = 0;
    if (!on) this.stopLoop();
    else if (this._provider) this.startLoop();
  }

  get running() {
    return this._running;
  }

  start(getRide) {
    this._provider = getRide;
    this._running = true;
    this.startLoop();
  }

  stop() {
    this._provider = null;
    this.stopLoop();
  }

  startLoop() {
    if (this._raf || typeof requestAnimationFrame === 'undefined') return;
    let last = now();
    const tick = (t) => {
      this._raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const ride = this._provider?.();
      if (ride) this.update(ride, dt);
      this.render();
    };
    this._raf = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  render() {
    if (this.lost || !this._running) return;
    const t = now();
    const f = this._frame;
    if (f.last) {
      const ms = t - f.last;
      if (ms < 250) {
        const s = this.stats;
        s.frameMs += (ms - s.frameMs) * 0.1;
        s.fps = 1000 / Math.max(1, s.frameMs);
        this.adapt(ms);
      }
    }
    f.last = t;
    if (!this.cam.ready && this.route) {
      this.placeCameraNow();
      this.camera.position.set(this.cam.x, this.cam.y, this.cam.z);
      this.camera.rotation.set(this.cam.pitch, this.cam.yaw, 0, 'YXZ');
      this.camera.updateMatrixWorld();
      this.sky.update(this.camera);
    }
    this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info.render;
    this.stats.triangles = info.triangles;
    this.stats.calls = info.calls;
  }

  // Adaptive render scale (§6.9): 0.75 after 3 s above 20 ms, back after 10 s under 13 ms.
  adapt(ms) {
    if (!this.opts.adaptive || this.fixedScale != null) return;
    const f = this._frame;
    const dt = ms / 1000;
    if (this.stats.frameMs > 20) {
      f.slow += dt;
      f.fast = 0;
    } else if (this.stats.frameMs < 13) {
      f.fast += dt;
      f.slow = 0;
    } else {
      f.slow = Math.max(0, f.slow - dt);
    }
    if (this.renderScale === 1 && f.slow > 3) {
      this.renderScale = 0.75;
      f.slow = 0;
      this.applyPixelRatio();
    } else if (this.renderScale < 1 && f.fast > 10) {
      this.renderScale = 1;
      f.fast = 0;
      this.applyPixelRatio();
    }
  }

  dispose() {
    this.stop();
    this.clearLeaves();
    this.worker?.terminate();
    this.worker = null;
    this.gen++;
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    if (this.furniture) {
      this.furniture.geometry.dispose();
      this.furniture.material.uniforms.map?.value?.dispose();
      this.furniture.material.dispose();
    }
    for (const g of this.glows) g.sprite.material.dispose();
    if (this.lightsPoints) {
      this.lightsPoints.geometry.dispose();
      this.lightsPoints.material.dispose();
    }
    if (this.shafts) {
      this.shafts.geometry.dispose();
      this.shafts.material.dispose();
    }
    this.water.geometry.dispose();
    this.water.material.dispose();
    this.glowTexture.dispose();
    this.sky.dispose();
    this.rider.dispose();
    this.ghost?.dispose();
    this.worldMaterial.dispose();
    this.renderer.dispose();
  }
}
