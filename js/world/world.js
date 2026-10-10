// The 3D world: a calm, stylised landscape built around the route.
//
// Coordinates: world X = route x (east), world Z = −route z (north is −Z),
// Y = elevation in metres. The ride engine owns position; the world only
// follows it, smoothing between engine ticks so motion is fluid at 60 fps.

import * as THREE from '../../vendor/three/three.module.min.js';
import { RoadIndex, makeHeightField, valueNoise } from './terrain.js';
import { buildScenery } from './scenery.js';
import { createRider } from './rider.js';
import { DEFAULT_THEME } from './themes.js';

const CHUNK = 256; // metres
const NEAR_RES = 32; // segments per chunk side near the rider
const FAR_RES = 12;
const NEAR_RADIUS = 650;
const ROAD_HALF_WIDTH = 3.6;

const tmpColor = new THREE.Color();

export class World {
  constructor(canvas, { maxPixelRatio = 2, antialias = true } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(maxPixelRatio, globalThis.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.5, 9000);
    this.chunks = new Map();
    this.route = null;
    this.theme = DEFAULT_THEME;
    this.display = { distance: 0, heading: null, lean: 0 };
    this.cameraState = { heading: 0, pos: new THREE.Vector3(), look: new THREE.Vector3() };
    this.time = 0;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      if (this.route) this.setRoute(this.route, this.theme);
    });
    this.buildStatic();
  }

  // ---------------------------------------------------------------- setup

  buildStatic() {
    const scene = this.scene;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    scene.add(this.hemi, this.sun, this.sun.target);
    scene.fog = new THREE.Fog(0xcccccc, 200, 1600);

    // Sky dome with a vertical gradient (drawn behind everything, no fog).
    this.skyUniforms = { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color() }, glow: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 0.3, -1) } };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(8000, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: this.skyUniforms,
        vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 glow; uniform vec3 sunDir; varying vec3 vDir;
          void main(){ float h = vDir.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55)) : mix(horizon, bottom, clamp(-h*6.0,0.0,1.0));
            float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0); c += glow * pow(s, 24.0) * 0.6 + glow * pow(s, 3.0) * 0.12;
            gl_FragColor = vec4(c, 1.0); }`,
      }),
    );
    sky.renderOrder = -10;
    this.sky = sky;
    scene.add(sky);

    // Stars for night themes.
    const starGeo = new THREE.BufferGeometry();
    const starPos = [];
    for (let i = 0; i < 900; i++) {
      const u = Math.random();
      const v = Math.random() * 0.45 + 0.05;
      const th = u * Math.PI * 2;
      const r = 7000;
      starPos.push(Math.cos(th) * Math.cos(v * Math.PI / 2) * r, Math.sin(v * Math.PI / 2) * r, Math.sin(th) * Math.cos(v * Math.PI / 2) * r);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 }));
    scene.add(this.stars);

    this.rider = createRider();
    scene.add(this.rider.group);
  }

  applyTheme(theme) {
    this.theme = theme;
    const t = theme;
    this.skyUniforms.top.value.set(t.sky.top);
    this.skyUniforms.horizon.value.set(t.sky.horizon);
    this.skyUniforms.bottom.value.set(t.sky.bottom ?? t.fog.color);
    this.skyUniforms.glow.value.set(t.sky.glow ?? '#000000');
    const sd = new THREE.Vector3(...t.sun.direction).normalize();
    this.skyUniforms.sunDir.value.copy(sd);
    this.scene.fog.color.set(t.fog.color);
    this.scene.fog.near = t.fog.near;
    this.scene.fog.far = t.fog.far;
    this.renderer.setClearColor(t.fog.color);
    this.hemi.color.set(t.hemi.sky);
    this.hemi.groundColor.set(t.hemi.ground);
    this.hemi.intensity = t.hemi.intensity;
    this.sun.color.set(t.sun.color);
    this.sun.intensity = t.sun.intensity;
    this.sunDirection = sd;
    this.stars.visible = !!t.stars;
    this.rider.setColors(t.rider);
    if (this.roadMesh) this.buildRoad();
    this.clearChunks();
    this.buildBackdrop();
  }

  setRoute(route, theme = this.theme) {
    this.route = route;
    this.index = new RoadIndex(route);
    this.height = makeHeightField(this.index, { seed: hashSeed(route.id), relief: theme.relief ?? 1 });
    this.display = { distance: 0, heading: null, lean: 0 };
    this.applyTheme(theme);
    this.buildRoad();
    this.buildWater();
  }

  // ---------------------------------------------------------------- road

  buildRoad() {
    if (this.roadMesh) {
      this.scene.remove(this.roadMesh);
      this.roadMesh.geometry.dispose();
      this.roadMesh.material.dispose();
    }
    const r = this.route;
    const t = this.theme.road;
    const positions = [];
    const colors = [];
    const indices = [];
    const asphalt = new THREE.Color(t.asphalt);
    const edge = new THREE.Color(t.edge);
    const center = new THREE.Color(t.center);
    const shoulder = new THREE.Color(t.shoulder ?? t.asphalt);
    // Cross-section offsets (m from centre) and colours: shoulder, edge line,
    // asphalt, centre dash, asphalt, edge line, shoulder.
    const section = [
      [-ROAD_HALF_WIDTH - 0.9, shoulder],
      [-ROAD_HALF_WIDTH, shoulder],
      [-ROAD_HALF_WIDTH, edge],
      [-ROAD_HALF_WIDTH + 0.14, edge],
      [-ROAD_HALF_WIDTH + 0.14, asphalt],
      [-0.07, asphalt],
      [-0.07, center],
      [0.07, center],
      [0.07, asphalt],
      [ROAD_HALF_WIDTH - 0.14, asphalt],
      [ROAD_HALF_WIDTH - 0.14, edge],
      [ROAD_HALF_WIDTH, edge],
      [ROAD_HALF_WIDTH, shoulder],
      [ROAD_HALF_WIDTH + 0.9, shoulder],
    ];
    const cols = section.length;
    const stride = 2; // every 10 m
    let rows = 0;
    for (let i = 0; i < r.x.length; i += stride) {
      const i0 = Math.max(0, i - 1);
      const i1 = Math.min(r.x.length - 1, i + 1);
      const dx = r.x[i1] - r.x[i0];
      const dz = r.z[i1] - r.z[i0];
      const len = Math.hypot(dx, dz) || 1;
      const nx = dz / len; // right-hand normal in route space
      const nz = -dx / len;
      const y = r.elevation[i] + 0.06;
      const dash = Math.floor((i * 5) / 6) % 2 === 0; // 6 m dashes
      for (const [off, color] of section) {
        positions.push(r.x[i] + nx * off, y - (Math.abs(off) > ROAD_HALF_WIDTH ? 0.12 : 0), -(r.z[i] + nz * off));
        const c = color === center && !dash ? asphalt : color;
        colors.push(c.r, c.g, c.b);
      }
      rows++;
    }
    for (let row = 0; row < rows - 1; row++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = row * cols + c;
        const b = a + cols;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    this.roadMesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    this.scene.add(this.roadMesh);
  }

  buildWater() {
    if (this.water) {
      this.scene.remove(this.water);
      this.water.geometry.dispose();
    }
    this.water = null;
    const w = this.theme.water;
    if (!w) return;
    const level = this.route.minElevation - (w.belowRoad ?? 14);
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshLambertMaterial({ color: w.color, transparent: true, opacity: 0.92 }));
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = level;
    this.scene.add(this.water);
  }

  // Layered distant ridgelines beyond the fog for depth.
  buildBackdrop() {
    if (this.backdrop) {
      this.scene.remove(this.backdrop);
      this.backdrop.children.forEach((m) => m.geometry.dispose());
    }
    this.backdrop = new THREE.Group();
    const layers = this.theme.backdrop ?? [];
    layers.forEach((layer, li) => {
      const segs = 256;
      const radius = layer.distance;
      const pos = [];
      const idx = [];
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const n = 0.5 + 0.5 * valueNoise(Math.cos(a) * layer.roughness, Math.sin(a) * layer.roughness, 31 + li * 7);
        const n2 = 0.5 + 0.5 * valueNoise(Math.cos(a) * layer.roughness * 3.1, Math.sin(a) * layer.roughness * 3.1, 77 + li);
        const h = layer.height * (0.35 + 0.65 * n) + layer.height * 0.15 * n2;
        pos.push(Math.cos(a) * radius, -400, Math.sin(a) * radius, Math.cos(a) * radius, h, Math.sin(a) * radius);
        if (i < segs) {
          const b = i * 2;
          idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: layer.color, fog: false, side: THREE.DoubleSide, depthWrite: false }));
      mesh.renderOrder = -5 + li;
      this.backdrop.add(mesh);
    });
    this.scene.add(this.backdrop);
  }

  // ---------------------------------------------------------------- terrain chunks

  clearChunks() {
    for (const chunk of this.chunks.values()) this.disposeChunk(chunk);
    this.chunks.clear();
  }

  disposeChunk(chunk) {
    this.scene.remove(chunk.group);
    chunk.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !o.material.shared) o.material.dispose();
    });
  }

  terrainColor(y, slope, x, z, distRoad, out) {
    const t = this.theme.terrain;
    const n = valueNoise(x / 37, z / 37, 5) * (t.noise ?? 0.06);
    // Altitude bands relative to the route's range, plus slope → rock.
    const span = Math.max(200, this.route.maxElevation - this.route.minElevation);
    const u = Math.min(1, Math.max(0, (y - this.route.minElevation) / (span + 300)));
    out.set(t.low).lerp(tmpColor.set(t.mid), Math.min(1, u * 1.6));
    if (u > 0.55) out.lerp(tmpColor.set(t.high), Math.min(1, (u - 0.55) * 2.5));
    if (slope > 0.75) out.lerp(tmpColor.set(t.rock), Math.min(1, (slope - 0.75) * 2.2));
    if (t.snow && y > (t.snowLine ?? Infinity)) out.lerp(tmpColor.set(t.snow), Math.min(1, (y - t.snowLine) / 120));
    if (distRoad < ROAD_HALF_WIDTH + 3) out.lerp(tmpColor.set(this.theme.road.shoulder ?? t.low), 0.6);
    out.offsetHSL(0, 0, n);
    return out;
  }

  buildChunk(cx, cz, res) {
    const size = CHUNK;
    const step = size / res;
    const verts = res + 1;
    const positions = new Float32Array(verts * verts * 3);
    const colors = new Float32Array(verts * verts * 3);
    const heights = new Float32Array(verts * verts);
    const x0 = cx * size;
    const z0 = cz * size; // route-space z
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const x = x0 + i * step;
        const z = z0 + j * step;
        heights[j * verts + i] = this.height(x, z);
      }
    }
    const c = new THREE.Color();
    for (let j = 0; j < verts; j++) {
      for (let i = 0; i < verts; i++) {
        const k = j * verts + i;
        const x = x0 + i * step;
        const z = z0 + j * step;
        const y = heights[k];
        const hx = heights[j * verts + Math.min(verts - 1, i + 1)] - heights[j * verts + Math.max(0, i - 1)];
        const hz = heights[Math.min(verts - 1, j + 1) * verts + i] - heights[Math.max(0, j - 1) * verts + i];
        const slope = Math.hypot(hx, hz) / (2 * step);
        const near = res === NEAR_RES ? this.index.nearest(x, z, 60) : null;
        this.terrainColor(y, slope, x, z, near ? near.distance : 99, c);
        positions[k * 3] = x;
        positions[k * 3 + 1] = y;
        positions[k * 3 + 2] = -z;
        colors[k * 3] = c.r;
        colors[k * 3 + 1] = c.g;
        colors[k * 3 + 2] = c.b;
      }
    }
    const index = [];
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const a = j * verts + i;
        const b = a + verts;
        index.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.terrainMaterial());
    const group = new THREE.Group();
    group.add(mesh);
    if (res === NEAR_RES) {
      const props = buildScenery({ theme: this.theme, cx, cz, size, height: this.height, index: this.index, roadHalfWidth: ROAD_HALF_WIDTH });
      if (props) group.add(props);
    }
    this.scene.add(group);
    return { group, res };
  }

  terrainMaterial() {
    if (!this._terrainMaterial || this._terrainMaterial.userData.theme !== this.theme) {
      this._terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: !!this.theme.flatShading });
      this._terrainMaterial.userData.theme = this.theme;
      this._terrainMaterial.shared = true;
    }
    return this._terrainMaterial;
  }

  // Keep chunks around the rider; build at most `budget` per frame.
  streamChunks(x, z, budget = 2) {
    const radius = this.theme.fog.far + CHUNK;
    const ccx = Math.floor(x / CHUNK);
    const ccz = Math.floor(z / CHUNK);
    const r = Math.ceil(radius / CHUNK);
    const wanted = [];
    for (let i = -r; i <= r; i++) {
      for (let j = -r; j <= r; j++) {
        const cx = ccx + i;
        const cz = ccz + j;
        const mx = (cx + 0.5) * CHUNK;
        const mz = (cz + 0.5) * CHUNK;
        const d = Math.hypot(mx - x, mz - z);
        if (d > radius) continue;
        wanted.push({ key: `${cx},${cz}`, cx, cz, d, res: d < NEAR_RADIUS ? NEAR_RES : FAR_RES });
      }
    }
    const keep = new Set(wanted.map((w) => w.key));
    for (const [key, chunk] of this.chunks) {
      if (!keep.has(key)) {
        this.disposeChunk(chunk);
        this.chunks.delete(key);
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    let built = 0;
    for (const w of wanted) {
      const have = this.chunks.get(w.key);
      if (have && have.res === w.res) continue;
      if (built >= budget) break;
      if (have) this.disposeChunk(have);
      this.chunks.set(w.key, this.buildChunk(w.cx, w.cz, w.res));
      built++;
    }
    return built;
  }

  // Build everything near the start before the first frame (loading screen).
  async prewarm(onProgress) {
    const s = this.route.stateAt(0);
    let pending = 1;
    while (pending) {
      pending = this.streamChunks(s.x, s.z, 6);
      onProgress?.(this.chunks.size);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // ---------------------------------------------------------------- per frame

  // ride: { distance, speed, cadence, tucked } from the engine snapshot
  update(ride, dt) {
    if (!this.route || this.lost) return;
    this.time += dt;
    // Follow the engine smoothly: advance by speed, ease toward truth.
    const d = this.display;
    d.distance += (ride.speed ?? 0) * dt;
    d.distance += (ride.distance - d.distance) * Math.min(1, dt * 2.5);
    const s = this.route.stateAt(d.distance);
    if (d.heading == null) d.heading = s.heading;
    d.heading = lerpAngle(d.heading, s.heading, Math.min(1, dt * 4));

    const fx = Math.sin(d.heading);
    const fz = Math.cos(d.heading);
    const rx = fz;
    const rz = -fx;
    const lane = 1.4; // ride right of centre
    const px = s.x + rx * lane;
    const pz = s.z + rz * lane;
    const py = s.elevation + 0.06;

    // Lean into bends a little.
    const ahead = this.route.stateAt(d.distance + 12);
    const turn = wrap(ahead.heading - s.heading);
    d.lean += (Math.max(-0.35, Math.min(0.35, turn * 1.4)) - d.lean) * Math.min(1, dt * 3);

    this.rider.group.position.set(px, py, -pz);
    this.rider.group.rotation.set(0, -d.heading, 0);
    this.rider.update(dt, { cadence: ride.cadence ?? 0, speed: ride.speed ?? 0, lean: d.lean, grade: s.grade, tucked: ride.tucked });

    // Chase camera: behind, above, looking down the road ahead.
    const cam = this.cameraState;
    cam.heading = lerpAngle(cam.heading || d.heading, d.heading, Math.min(1, dt * 2.2));
    const back = this.theme.camera?.distance ?? 7.5;
    const up = this.theme.camera?.height ?? 2.6;
    const cfx = Math.sin(cam.heading);
    const cfz = Math.cos(cam.heading);
    const camX = px - cfx * back;
    const camZ = pz - cfz * back;
    const ground = this.height(camX, camZ);
    const camY = Math.max(py + up, ground + 1.2);
    cam.pos.set(camX, camY, -camZ);
    // Look past the rider along the (smoothed) heading, pitched with the road.
    const lookDist = 14;
    const pitch = Math.atan((s.grade ?? 0) / 100) * 0.5;
    cam.look.set(px + cfx * lookDist, py + 1.1 + Math.tan(pitch) * lookDist, -(pz + cfz * lookDist));
    this.camera.position.copy(cam.pos);
    this.camera.lookAt(cam.look);

    // Sky, stars and backdrop travel with the camera.
    this.sky.position.copy(cam.pos);
    this.stars.position.copy(cam.pos);
    if (this.backdrop) this.backdrop.position.set(cam.pos.x, this.route.minElevation, cam.pos.z);
    if (this.water) this.water.position.set(cam.pos.x, this.water.position.y, cam.pos.z);
    this.sun.position.set(px + this.sunDirection.x * 500, py + this.sunDirection.y * 500, -pz + this.sunDirection.z * 500);
    this.sun.target.position.set(px, py, -pz);

    this.streamChunks(px, pz, 2);
  }

  resize(width, height) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render() {
    if (this.lost) return;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.clearChunks();
    this.renderer.dispose();
  }
}

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function lerpAngle(a, b, t) {
  return a + wrap(b - a) * t;
}

function hashSeed(text) {
  let h = 7;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 100000;
}
