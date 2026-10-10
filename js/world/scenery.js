// Scattered scenery (trees, rocks, shrubs) as one instanced mesh per kind per
// terrain chunk. Placement is deterministic per chunk, so the world looks the
// same every ride.

import * as THREE from '../../vendor/three/three.module.min.js';
import { mulberry32 } from '../core/route.js';

const geometries = new Map();
const materials = new Map();

function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo.toNonIndexed ? geo.toNonIndexed() : geo;
}

function merge(parts) {
  // Minimal merge of non-indexed geometries with position/normal/color.
  const arrays = { position: [], normal: [], color: [] };
  for (const g of parts) {
    const geo = g.index ? g.toNonIndexed() : g;
    geo.computeVertexNormals();
    for (const key of Object.keys(arrays)) arrays[key].push(...geo.attributes[key].array);
  }
  const out = new THREE.BufferGeometry();
  for (const [key, list] of Object.entries(arrays)) out.setAttribute(key, new THREE.Float32BufferAttribute(list, 3));
  return out;
}

// Unit-height models (scaled per instance). White foliage is tinted per instance.
function model(kind) {
  if (geometries.has(kind)) return geometries.get(kind);
  const trunk = (h, r) => colored(new THREE.CylinderGeometry(r * 0.7, r, h, 5).translate(0, h / 2, 0), '#5b4636');
  let geo;
  switch (kind) {
    case 'conifer':
      geo = merge([trunk(0.25, 0.05), colored(new THREE.ConeGeometry(0.28, 0.6, 6).translate(0, 0.52, 0), '#ffffff'), colored(new THREE.ConeGeometry(0.21, 0.45, 6).translate(0, 0.78, 0), '#ffffff')]);
      break;
    case 'redwood':
      geo = merge([trunk(0.55, 0.045), colored(new THREE.ConeGeometry(0.13, 0.62, 6).translate(0, 0.69, 0), '#ffffff')]);
      break;
    case 'round':
      geo = merge([trunk(0.35, 0.06), colored(new THREE.IcosahedronGeometry(0.34, 0).scale(1.15, 0.85, 1.15).translate(0, 0.62, 0), '#ffffff')]);
      break;
    case 'cypress':
      geo = merge([trunk(0.4, 0.07), colored(new THREE.IcosahedronGeometry(0.4, 0).scale(1.5, 0.45, 1.2).translate(0, 0.72, 0), '#ffffff')]);
      break;
    case 'shrub':
      geo = merge([colored(new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.7, 1).translate(0, 0.3, 0), '#ffffff')]);
      break;
    case 'rock':
      geo = merge([colored(new THREE.DodecahedronGeometry(0.5, 0).scale(1.2, 0.6, 1).translate(0, 0.15, 0), '#ffffff')]);
      break;
    case 'post': // roadside marker posts (snow poles on Alpine passes)
      geo = merge([colored(new THREE.BoxGeometry(0.06, 1, 0.06).translate(0, 0.5, 0), '#ffffff')]);
      break;
    default:
      geo = merge([colored(new THREE.ConeGeometry(0.3, 1, 5).translate(0, 0.5, 0), '#ffffff')]);
  }
  geometries.set(kind, geo);
  return geo;
}

function material(flat) {
  const key = flat ? 'flat' : 'smooth';
  if (!materials.has(key)) {
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: flat });
    m.shared = true;
    materials.set(key, m);
  }
  return materials.get(key);
}

const dummy = new THREE.Object3D();
const tint = new THREE.Color();

export function buildScenery({ theme, cx, cz, size, height, index, roadHalfWidth }) {
  const specs = theme.scenery ?? [];
  if (!specs.length) return null;
  const group = new THREE.Group();
  const areaHa = (size * size) / 10000;
  specs.forEach((spec, si) => {
    const rand = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ (si * 83492791));
    const want = Math.round(spec.density * areaHa);
    if (!want) return;
    const placed = [];
    for (let n = 0; n < want; n++) {
      const x = cx * size + rand() * size;
      const z = cz * size + rand() * size;
      const near = index.nearest(x, z, Math.max(80, (spec.maxRoad ?? 0) + 10));
      const dist = near ? near.distance : 999;
      if (dist < roadHalfWidth + (spec.minRoad ?? 6)) continue;
      if (spec.maxRoad != null && dist > spec.maxRoad) continue;
      const y = height(x, z);
      if (spec.altitude && (y < spec.altitude[0] || y > spec.altitude[1])) continue;
      if (theme.water && y < theme.waterLevel) continue;
      if (spec.slopeMax != null) {
        const slope = Math.hypot(height(x + 3, z) - y, height(x, z + 3) - y) / 3;
        if (slope > spec.slopeMax) continue;
      }
      const s = spec.scale[0] + rand() * (spec.scale[1] - spec.scale[0]);
      placed.push({ x, y, z, s, rot: rand() * Math.PI * 2, color: spec.colors[Math.floor(rand() * spec.colors.length)], squash: 0.85 + rand() * 0.3 });
    }
    if (!placed.length) return;
    const mesh = new THREE.InstancedMesh(model(spec.kind), material(!!theme.flatShading), placed.length);
    placed.forEach((p, i) => {
      dummy.position.set(p.x, p.y - 0.2, -p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.set(p.s * p.squash, p.s, p.s * p.squash);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tint.set(p.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
  });
  return group;
}
