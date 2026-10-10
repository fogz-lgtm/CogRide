// Route model: elevation, gradient and 2D road geometry sampled every few metres.
//
// Routes come from gradient tables (famous climbs, designed rolling routes) or
// from GPX files. Both end up as the same evenly-sampled arrays so the physics,
// trainer and 3D world can ask "where am I, how steep is it, which way does the
// road point" at any distance.
//
// Laps: a `loop` route wraps around; any other route is ridden out-and-back
// (climb to the summit, then descend the same road), like riding a real climb.

export const STEP_M = 5;

// Small deterministic PRNG so a route always looks the same.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Monotone cubic (PCHIP) interpolation: smooth, but never overshoots, so a
// gradient table doesn't sprout fake bumps between its sample points.
export function pchip(xs, ys) {
  const n = xs.length;
  const h = [];
  const delta = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i]);
    delta.push((ys[i + 1] - ys[i]) / h[i]);
  }
  const m = new Array(n);
  m[0] = delta[0] ?? 0;
  m[n - 1] = delta[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * h[lo] * m[lo] + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * h[lo] * m[lo + 1]
    );
  };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

export class Route {
  // samples: { elevation: Float64Array, x: Float64Array, z: Float64Array, lat?, lon? } every STEP_M
  constructor(meta, samples) {
    Object.assign(this, meta);
    this.elevation = samples.elevation;
    this.x = samples.x;
    this.z = samples.z;
    this.lat = samples.lat ?? null;
    this.lon = samples.lon ?? null;
    this.length = (this.elevation.length - 1) * STEP_M;
    this.loop = !!meta.loop;
    let gain = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.elevation.length; i++) {
      const e = this.elevation[i];
      if (i) gain += Math.max(0, e - this.elevation[i - 1]);
      min = Math.min(min, e);
      max = Math.max(max, e);
    }
    this.ascent = gain;
    this.minElevation = min;
    this.maxElevation = max;
  }

  // Lap length: a loop is ridden once around; out-and-back is up and down again.
  get lapLength() {
    return this.loop ? this.length : this.length * 2;
  }

  // Map total distance ridden to a position on the base road.
  locate(total) {
    const t = ((total % this.lapLength) + this.lapLength) % this.lapLength;
    const lap = Math.floor(total / this.lapLength);
    if (this.loop || t <= this.length) return { d: t, direction: 1, lap };
    return { d: 2 * this.length - t, direction: -1, lap };
  }

  sample(array, d) {
    const f = Math.min(Math.max(d, 0), this.length) / STEP_M;
    const i = Math.min(Math.floor(f), array.length - 2);
    const t = f - i;
    return array[i] + (array[i + 1] - array[i]) * t;
  }

  elevationAt(d) {
    return this.sample(this.elevation, d);
  }

  // Gradient (%) along the base road, measured over the bike's footprint.
  gradeAt(d) {
    const span = 10;
    let a = d - span / 2;
    let b = d + span / 2;
    if (this.loop) {
      a = ((a % this.length) + this.length) % this.length;
      b = ((b % this.length) + this.length) % this.length;
      const rise = this.elevationAt(b) - this.elevationAt(a);
      return (rise / span) * 100;
    }
    a = Math.max(0, a);
    b = Math.min(this.length, b);
    if (b - a < 1) return 0;
    return ((this.elevationAt(b) - this.elevationAt(a)) / (b - a)) * 100;
  }

  // Everything the rider needs at total distance ridden.
  stateAt(total) {
    const { d, direction, lap } = this.locate(total);
    const fwd = Math.min(this.length, d + 1);
    const back = Math.max(0, fwd - 2);
    let heading = Math.atan2(this.sample(this.x, fwd) - this.sample(this.x, back), this.sample(this.z, fwd) - this.sample(this.z, back));
    if (direction < 0) heading = wrapAngle(heading + Math.PI);
    return {
      d,
      direction,
      lap,
      x: this.sample(this.x, d),
      z: this.sample(this.z, d),
      elevation: this.elevationAt(d),
      grade: this.gradeAt(d) * direction,
      heading,
      lat: this.lat ? this.sample(this.lat, d) : null,
      lon: this.lon ? this.sample(this.lon, d) : null,
    };
  }

  // Elevation profile of the next `ahead` metres of riding (in riding order).
  profileAhead(total, ahead, points = 120) {
    const out = [];
    for (let i = 0; i <= points; i++) {
      const dist = total + (ahead * i) / points;
      out.push({ distance: dist, elevation: this.elevationAt(this.locate(dist).d) });
    }
    return out;
  }

  // Whole-lap profile, in riding order.
  lapProfile(points = 200) {
    return this.profileAhead(0, this.lapLength, points);
  }
}

// ---------------------------------------------------------------- builders

// Smoothly interpolated elevation from a gradient table, with gentle seeded
// micro-variation inside each segment (real roads aren't constant gradient).
// Segment end elevations are preserved exactly.
export function elevationFromGradients({ gradientsPct, resolutionM, lengthM, startElevationM = 0, seed = 1, texture = 0.6 }) {
  const total = lengthM ?? gradientsPct.length * resolutionM;
  const xs = [0];
  const ys = [startElevationM];
  let d = 0;
  gradientsPct.forEach((g, i) => {
    const seg = i === gradientsPct.length - 1 ? total - d : resolutionM;
    d += seg;
    xs.push(d);
    ys.push(ys.at(-1) + (seg * g) / 100);
  });
  // Anchor at segment midpoints too, so each segment's average gradient holds
  // while PCHIP smooths the corners between segments.
  const mx = [xs[0]];
  const my = [ys[0]];
  for (let i = 1; i < xs.length; i++) {
    mx.push((xs[i - 1] + xs[i]) / 2, xs[i]);
    my.push((ys[i - 1] + ys[i]) / 2, ys[i]);
  }
  const base = pchip(mx, my);
  const rand = mulberry32(seed);
  const waves = Array.from({ length: 3 }, (_, k) => ({
    period: [180, 420, 900][k] * (0.8 + rand() * 0.4),
    phase: rand() * Math.PI * 2,
    amp: [0.35, 0.8, 1.6][k] * texture,
  }));
  const n = Math.round(total / STEP_M) + 1;
  const elevation = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = Math.min(total, i * STEP_M);
    // Find the containing segment to fade the texture to zero at its ends.
    const segIndex = Math.min(gradientsPct.length - 1, Math.floor(x / resolutionM));
    const segStart = segIndex * resolutionM;
    const segLen = Math.min(resolutionM, total - segStart) || 1;
    const envelope = Math.sin((Math.PI * (x - segStart)) / segLen);
    let wobble = 0;
    for (const w of waves) wobble += w.amp * Math.sin((2 * Math.PI * x) / w.period + w.phase);
    elevation[i] = base(x) + wobble * envelope;
  }
  return elevation;
}

// Road shape: gentle seeded meanders plus explicit turns (hairpins etc.).
// turns: [{ atKm, kind: 'hairpin' | 'bend', direction: 'left' | 'right', angleDeg? }]
export function pathFromTurns({ lengthM, turns = [], seed = 1, wander = 1 }) {
  const n = Math.round(lengthM / STEP_M) + 1;
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const meanders = Array.from({ length: 4 }, (_, k) => ({
    period: [260, 610, 1400, 3100][k] * (0.75 + rand() * 0.5),
    phase: rand() * Math.PI * 2,
    amp: [0.0035, 0.0022, 0.0012, 0.0006][k] * wander, // curvature (rad/m)
  }));
  const turnList = turns.map((t) => {
    const angle = ((t.angleDeg ?? (t.kind === 'hairpin' ? 180 : 60)) * Math.PI) / 180;
    const arc = t.kind === 'hairpin' ? 45 : 90; // metres the turn takes
    return { start: t.atKm * 1000 - arc / 2, arc, curvature: ((t.direction === 'left' ? 1 : -1) * angle) / arc };
  });
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  let heading = 0;
  for (let i = 1; i < n; i++) {
    const d = i * STEP_M;
    let k = 0;
    for (const m of meanders) k += m.amp * Math.sin((2 * Math.PI * d) / m.period + m.phase);
    for (const t of turnList) if (d >= t.start && d < t.start + t.arc) k += t.curvature;
    heading += k * STEP_M;
    x[i] = x[i - 1] + Math.sin(heading) * STEP_M;
    z[i] = z[i - 1] + Math.cos(heading) * STEP_M;
  }
  return { x, z };
}

// A closed loop: a wobbly circle with the right perimeter.
export function loopPath({ lengthM, seed = 1, wobble = 0.18 }) {
  const n = Math.round(lengthM / STEP_M) + 1;
  const rand = mulberry32(seed ^ 0x51ed27);
  const harmonics = [2, 3, 5].map((k) => ({ k, amp: wobble * (0.5 + rand()) / k, phase: rand() * Math.PI * 2 }));
  const radiusAt = (theta) => 1 + harmonics.reduce((s, h) => s + h.amp * Math.cos(h.k * theta + h.phase), 0);
  // Arc-length parametrise a unit-ish shape, then scale to the target length.
  const fine = 4000;
  const pts = [];
  let perimeter = 0;
  for (let i = 0; i <= fine; i++) {
    const th = (i / fine) * 2 * Math.PI;
    const r = radiusAt(th);
    const p = { x: r * Math.sin(th), z: r * Math.cos(th) };
    if (i) perimeter += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
    p.s = perimeter;
    pts.push(p);
  }
  const scale = lengthM / perimeter;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = Math.min(perimeter, (i * STEP_M) / scale);
    while (j < fine - 1 && pts[j + 1].s < s) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
    x[i] = (a.x + (b.x - a.x) * t - pts[0].x) * scale;
    z[i] = (a.z + (b.z - a.z) * t - pts[0].z) * scale;
  }
  return { x, z };
}

export function buildRoute(def) {
  const lengthM = def.lengthM ?? def.gradientsPct.length * def.resolutionM;
  const seed = hashString(def.id);
  let elevation = elevationFromGradients({ ...def, lengthM, seed, texture: def.texture ?? 0.6 });
  if (def.loop) {
    // Close the loop: spread any start/finish mismatch evenly along the route.
    const drift = elevation[elevation.length - 1] - elevation[0];
    elevation = elevation.map((e, i) => e - (drift * i) / (elevation.length - 1));
  }
  const path = def.loop ? loopPath({ lengthM, seed, wobble: def.wobble ?? 0.18 }) : pathFromTurns({ lengthM, turns: def.turns, seed, wander: def.wander ?? 1 });
  return new Route({ ...def, lengthM, gradientsPct: undefined }, { elevation, ...path });
}

// ---------------------------------------------------------------- GPX

const EARTH_R = 6371008.8;

export function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function parseGpx(xml) {
  const name = xml.match(/<name>([\s\S]*?)<\/name>/i)?.[1]?.trim().replace(/<!\[CDATA\[|\]\]>/g, '') || 'Imported route';
  const points = [];
  const re = /<(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/gi;
  for (const m of xml.matchAll(re)) {
    const lat = Number(m[2].match(/lat\s*=\s*["']([^"']+)["']/i)?.[1]);
    const lon = Number(m[2].match(/lon\s*=\s*["']([^"']+)["']/i)?.[1]);
    const ele = Number(m[4]?.match(/<ele>([^<]+)<\/ele>/i)?.[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }
  if (points.length < 2) throw new Error('No track points found in this GPX file');
  return { name, points };
}

function gaussianSmooth(values, sigmaSamples) {
  if (sigmaSamples < 0.5) return values;
  const radius = Math.ceil(sigmaSamples * 3);
  const kernel = [];
  for (let k = -radius; k <= radius; k++) kernel.push(Math.exp(-(k * k) / (2 * sigmaSamples * sigmaSamples)));
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let wsum = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= values.length) continue;
      sum += values[j] * kernel[k + radius];
      wsum += kernel[k + radius];
    }
    out[i] = sum / wsum;
  }
  return out;
}

export function routeFromGpx(xml, { id } = {}) {
  const { name, points } = parseGpx(xml);
  return routeFromPoints({ name, points, id });
}

// points: [{ lat, lon, ele|null }] in travel order (GPX track, Strava streams)
export function routeFromPoints({ name, points, id, kind = 'imported', source }) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('This route has no track points');
  // Cumulative distance, dropping duplicate points.
  const pts = [{ ...points[0], d: 0 }];
  for (const p of points.slice(1)) {
    const prev = pts.at(-1);
    const step = haversine(prev.lat, prev.lon, p.lat, p.lon);
    if (step < 0.5) continue;
    pts.push({ ...p, d: prev.d + step });
  }
  const total = pts.at(-1).d;
  if (total < 200) throw new Error('This GPX route is too short to ride');
  const hasEle = pts.some((p) => p.ele != null);
  const n = Math.round(total / STEP_M) + 1;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const rawEle = new Float64Array(n);
  let j = 0;
  let lastEle = pts.find((p) => p.ele != null)?.ele ?? 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(total, i * STEP_M);
    while (j < pts.length - 2 && pts[j + 1].d < d) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const t = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    lat[i] = a.lat + (b.lat - a.lat) * t;
    lon[i] = a.lon + (b.lon - a.lon) * t;
    if (a.ele != null && b.ele != null) lastEle = a.ele + (b.ele - a.ele) * t;
    rawEle[i] = hasEle ? lastEle : 0;
  }
  // GPS/barometric elevation is noisy; ~25 m Gaussian keeps real ramps but kills spikes.
  const elevation = gaussianSmooth(rawEle, 25 / STEP_M);
  const lat0 = lat[0];
  const lon0 = lon[0];
  const kx = (Math.PI / 180) * EARTH_R * Math.cos((lat0 * Math.PI) / 180);
  const kz = (Math.PI / 180) * EARTH_R;
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (lon[i] - lon0) * kx;
    z[i] = (lat[i] - lat0) * kz;
  }
  const closes = haversine(lat[0], lon[0], lat[n - 1], lon[n - 1]) < Math.max(150, total * 0.01);
  return new Route(
    { id: id ?? `gpx-${hashString(name + total)}`, name, kind, source, description: '', loop: closes, imported: true, lengthM: total },
    { elevation, x, z, lat, lon },
  );
}
