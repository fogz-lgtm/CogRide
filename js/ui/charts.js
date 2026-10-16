// Small, quiet charts drawn as SVG at their real pixel size (so rings stay
// round and hairlines stay 1 px): the elevation strip, the workout profile,
// the Zone 2 trace, sparklines, summary small multiples and painted scenes.

import { html, useRef, useState, useLayoutEffect, useMemo } from './h.js';
import { POWER_ZONES, powerZone } from './format.js';
import { mulberry32, hashString } from '../core/route.js';

const M_PER_MI = 1609.344;

export function useSize(ref, fallback = { w: 358, h: 44 }) {
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize((s) => (Math.abs(s.w - r.width) > 0.5 || Math.abs(s.h - r.height) > 0.5 ? { w: r.width, h: r.height } : s));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');

// ---------------------------------------------------------------- elevation strip

// The whole climb (or one lap) with the ridden part inked in.
// The road's profile. With `ahead` (metres): the road coming up from where
// you are — what the 3D view is about to show — at a scale where a few per
// cent looks like a few per cent. Without: the whole route, with ridden part
// filled, exaggerated no more than needed (a rolling loop looks rolling, not
// alpine).
export function ElevationStrip({ route, distance = 0, units = 'imperial', className = '', ahead = null }) {
  const ref = useRef(null);
  const { w, h } = useSize(ref);
  const whole = useMemo(() => {
    if (!route) return null;
    const n = 160;
    const len = route.length;
    const es = Array.from({ length: n + 1 }, (_, i) => route.elevationAt((len * i) / n));
    const min = Math.min(...es);
    const max = Math.max(...es);
    return { len, es, min, span: Math.max(20, max - min, len * 0.015) };
  }, [route]);
  if (!whole) return html`<svg ref=${ref} class=${className}></svg>`;
  const pad = 3;
  const id = `es${route.id ?? 'r'}${ahead ? 'a' : ''}`.replace(/[^a-z0-9]/gi, '');
  const tickEvery = units === 'metric' ? 1000 : M_PER_MI;

  let pts;
  let xd;
  let yd;
  let ticks = [];
  let label = null;
  if (ahead) {
    // Sample along the rider's way (laps and out-and-back descents included).
    const behind = ahead * 0.12;
    const total = ahead + behind;
    const n = 120;
    const at = (x) => route.elevationAt(route.locate(Math.max(0, distance + x)).d);
    const es = Array.from({ length: n + 1 }, (_, i) => at(-behind + (total * i) / n));
    // Steady scale: snapped to 10 m so it doesn't twitch as the road scrolls.
    const lo = Math.floor(Math.min(...es) / 10) * 10;
    const span = Math.ceil(Math.max(Math.max(...es) - lo, total * 0.03) / 10) * 10;
    const top = 13; // room for the label
    const Y = (e) => h - 1 - ((e - lo) / span) * (h - top - 1);
    pts = es.map((e, i) => [(i / n) * w, Y(e)]);
    xd = (behind / total) * w;
    yd = Y(at(0));
    const half = tickEvery / 2;
    for (let m = half; m < ahead; m += half) ticks.push(xd + (m / total) * w);
    label = units === 'metric' ? `Next ${Math.round(ahead / 1000)} km` : `Next ${Math.round(ahead / M_PER_MI)} mi`;
  } else {
    const Y = (e) => h - 1 - ((e - whole.min) / whole.span) * (h - pad - 1);
    const X = (d) => (d / whole.len) * w;
    pts = whole.es.map((e, i) => [(i / (whole.es.length - 1)) * w, Y(e)]);
    const d = route.locate(distance).d;
    xd = X(d);
    yd = Y(route.elevationAt(d));
    for (let m = tickEvery; m < whole.len; m += tickEvery) ticks.push(X(m));
  }
  const ridden = pts.filter((p) => p[0] <= xd).concat([[xd, yd]]);
  const area = (p) => `${line(p)}L${p.at(-1)[0].toFixed(1)} ${h}L0 ${h}Z`;
  return html`<svg ref=${ref} class=${className} viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <defs>
      <pattern id="${id}h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="rgba(243,235,221,.12)" stroke-width="1.2" /></pattern>
      <linearGradient id="${id}g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(243,235,221,.22)" /><stop offset="1" stop-color="rgba(243,235,221,.04)" /></linearGradient>
    </defs>
    <path d=${area(pts)} fill="url(#${id}h)" />
    <path d=${line(pts)} fill="none" stroke="rgba(243,235,221,.38)" stroke-width="1.2" />
    ${ridden.length > 1 && html`<path d=${area(ridden)} fill="url(#${id}g)" /><path d=${line(ridden)} fill="none" stroke="var(--paper)" stroke-width="2" stroke-linejoin="round" />`}
    ${ticks.map((x) => html`<line x1=${x} x2=${x} y1=${h - 4} y2=${h} stroke="rgba(243,235,221,.3)" />`)}
    <line x1=${xd} x2=${xd} y1="0" y2=${h} stroke="var(--paper)" stroke-width="1.2" opacity=".6" />
    <circle cx=${xd} cy=${yd} r="4.5" fill="var(--ink-1)" stroke="var(--paper)" stroke-width="2" />
    ${label && html`<text x=${w} y="9" text-anchor="end" class="stripk">${label}</text>`}
  </svg>`;
}

// ---------------------------------------------------------------- workout profile

export function WorkoutProfile({ workout, clock = 0, className = 'wprofile', showPlayhead = true }) {
  const ref = useRef(null);
  const { w, h } = useSize(ref, { w: 358, h: 66 });
  const bars = useMemo(() => {
    if (!workout) return [];
    const total = workout.steps.reduce((s, x) => s + x.duration, 0) || 1;
    let t = 0;
    return workout.steps.map((s) => {
      const b = { s, t0: t / total, t1: (t + s.duration) / total, start: t, end: t + s.duration };
      t += s.duration;
      return b;
    });
  }, [workout]);
  if (!bars.length) return html`<svg ref=${ref} class=${className}></svg>`;
  const total = bars.at(-1).end;
  const maxF = Math.max(1.3, ...workout.steps.map((s) => (s.type === 'steady' ? s.power : s.type === 'ramp' ? Math.max(s.from, s.to) : 0.4)));
  const Y = (f) => h - (f / maxF) * (h - 4);
  const gap = bars.length > 60 ? 0 : 1;
  const shapes = bars.map((b) => {
    const x0 = b.t0 * w + gap / 2;
    const x1 = Math.max(x0 + 1, b.t1 * w - gap / 2);
    const s = b.s;
    const f0 = s.type === 'steady' ? s.power : s.type === 'ramp' ? s.from : 0.35;
    const f1 = s.type === 'steady' ? s.power : s.type === 'ramp' ? s.to : 0.35;
    const zone = s.type === 'free' ? null : POWER_ZONES[powerZone((f0 + f1) / 2)];
    return { b, d: `M${x0} ${h}L${x0} ${Y(f0)}L${x1} ${Y(f1)}L${x1} ${h}Z`, color: zone ? zone.hex : '#716659', x0, x1, y0: Y(f0), y1: Y(f1) };
  });
  const px = (Math.min(clock, total) / total) * w;
  const cur = shapes.find((s) => clock >= s.b.start && clock < s.b.end);
  const clipId = `wp${hashString(workout.id || workout.name || 'w')}`;
  return html`<svg ref=${ref} class=${className} viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <defs><clipPath id=${clipId}><rect x="0" y="0" width=${px} height=${h} /></clipPath></defs>
    ${shapes.map((s) => html`<path d=${s.d} fill=${s.color} opacity=${showPlayhead ? 0.3 : 0.9} />`)}
    ${showPlayhead && html`<g clip-path="url(#${clipId})">${shapes.map((s) => html`<path d=${s.d} fill=${s.color} opacity=".95" />`)}</g>`}
    ${showPlayhead && cur && html`<line x1=${cur.x0} y1=${cur.y0 - 1} x2=${cur.x1} y2=${cur.y1 - 1} stroke="var(--paper)" stroke-width="2" />`}
    ${showPlayhead && html`<line x1=${px} x2=${px} y1="0" y2=${h} stroke="var(--paper)" stroke-width="1.5" /><circle cx=${px} cy="3.5" r="3.5" fill="var(--paper)" />`}
  </svg>`;
}

// ---------------------------------------------------------------- sparkline

export function Sparkline({ values, w = 64, h = 22, stroke = 'var(--paper-2)' }) {
  if (!values?.length) return null;
  const min = Math.min(...values);
  const span = Math.max(1, Math.max(...values) - min);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)]);
  return html`<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d=${line(pts)} fill="none" stroke=${stroke} stroke-width="1.4" stroke-linejoin="round" /></svg>`;
}

// ---------------------------------------------------------------- Zone 2 trace

// Last `minutes` of heart rate over the Zone 2 band, with trainer watts faint behind.
export function Trace({ samples, zone, minutes = 20, className = 'trace' }) {
  const ref = useRef(null);
  const { w, h } = useSize(ref, { w: 358, h: 48 });
  const span = minutes * 60;
  const recent = samples.slice(-span);
  const lo = Math.min(zone.min - 20, ...recent.map((s) => s.heartRate || zone.min));
  const hi = Math.max(zone.max + 15, ...recent.map((s) => s.heartRate || zone.max));
  const Y = (v) => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
  const X = (i) => w - ((recent.length - 1 - i) / span) * w;
  const hr = [];
  recent.forEach((s, i) => s.heartRate && hr.push([X(i), Y(s.heartRate)]));
  const pmax = Math.max(50, ...recent.map((s) => s.power || 0)) * 1.15;
  const pw = recent.map((s, i) => [X(i), h - 2 - ((s.power || 0) / pmax) * (h - 6)]);
  return html`<svg ref=${ref} class=${className} viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <rect x="0" width=${w} y=${Y(zone.max)} height=${Math.max(1, Y(zone.min) - Y(zone.max))} fill="var(--pz2)" opacity=".13" rx="3" />
    ${pw.length > 1 && html`<path d=${line(pw)} fill="none" stroke="rgba(243,235,221,.28)" stroke-width="1.2" />`}
    ${hr.length > 1 && html`<path d=${line(hr)} fill="none" stroke="#e8735f" stroke-width="1.8" stroke-linejoin="round" />`}
  </svg>`;
}

// ---------------------------------------------------------------- summary multiples

export function MiniChart({ values, stroke = 'var(--paper)', fill = 'rgba(243,235,221,.10)', band = null, min = null, max = null }) {
  const ref = useRef(null);
  const { w, h } = useSize(ref, { w: 260, h: 34 });
  const vals = downsample(values.map((v) => v ?? 0), Math.max(20, Math.round(w / 2)));
  if (vals.length < 2) return html`<svg ref=${ref}></svg>`;
  const lo = min ?? Math.min(...vals);
  const hi = Math.max(lo + 1, max ?? Math.max(...vals));
  const Y = (v) => h - 1 - ((v - lo) / (hi - lo)) * (h - 3);
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * w, Y(v)]);
  return html`<svg ref=${ref} viewBox="0 0 ${w} ${h}" aria-hidden="true">
    ${band && html`<rect x="0" width=${w} y=${Y(band.max)} height=${Math.max(1, Y(band.min) - Y(band.max))} fill=${band.color} opacity=".14" />`}
    <path d=${`${line(pts)}L${w} ${h}L0 ${h}Z`} fill=${fill} />
    <path d=${line(pts)} fill="none" stroke=${stroke} stroke-width="1.5" stroke-linejoin="round" />
  </svg>`;
}

export function downsample(values, n) {
  if (values.length <= n) return values;
  const out = [];
  const k = values.length / n;
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * k);
    const b = Math.max(a + 1, Math.floor((i + 1) * k));
    let s = 0;
    for (let j = a; j < b; j++) s += values[j];
    out.push(s / (b - a));
  }
  return out;
}

// ---------------------------------------------------------------- painted scenes

// Gouache-poster landscapes for cards and thumbnails: sky, a moon or low sun,
// and ridges fading into haze. Colours follow the route's region and the hour.
const SKIES = {
  day: ['#7f9fbe', '#c9cfcf', '#e9d8bd'],
  golden: ['#28284a', '#b07a84', '#f6c892'],
  dusk: ['#1c2040', '#8a6380', '#edba92'],
  night: ['#0f1527', '#232b45', '#4a4762'],
};
const LANDS = {
  alpine: ['#a9788a', '#6a6488', '#4b6560', '#203036'],
  provence: ['#b07a84', '#a99a99', '#4e5b47', '#283329'],
  mallorca: ['#b58a7c', '#9a8576', '#6a6b4c', '#33362a'],
  bayarea: ['#6c6a8c', '#9b6f60', '#c69a5f', '#5a4532'],
  coast: ['#4a4762', '#3d4458', '#5a6250', '#1d221e'],
  redwoods: ['#4e5a54', '#3a4a40', '#2a3528', '#18201a'],
  lakes: ['#6c7290', '#566a74', '#4f6150', '#1f2a24'],
  mesa: ['#9b6f7c', '#b07a5e', '#a96f4d', '#4a2e22'],
};
LANDS.bayhills = LANDS.bayarea;
LANDS.redwood = LANDS.redwoods;

function hexMix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

export function Scene({ region = 'bayarea', tod = 'dusk', seed = 'x', w = 366, h = 210, profile = null, className = '' }) {
  const rand = mulberry32(hashString(String(seed)));
  const sky = SKIES[tod] ?? SKIES.dusk;
  const land = LANDS[region] ?? LANDS.bayarea;
  const night = tod === 'night';
  const haze = sky[2];
  const id = `sc${hashString(`${region}${tod}${seed}`)}`;
  const layers = land.map((color, i) => {
    const depth = i / (land.length - 1); // 0 far .. 1 near
    const base = h * (0.5 + depth * 0.3);
    const amp = h * (0.2 - depth * 0.09) * (region === 'alpine' ? 1.5 : region === 'redwoods' ? 0.5 : 1);
    const n = 9 + i * 3;
    const phase = rand() * 10;
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const x = (k / n) * w;
      let y = base - amp * (0.55 + 0.45 * Math.sin(phase + k * (0.9 + rand() * 0.5))) * (0.7 + rand() * 0.3);
      // The nearest layer follows the route's own profile when we have one.
      if (profile && i === land.length - 1) {
        const p = profile[Math.round((k / n) * (profile.length - 1))];
        const pmin = Math.min(...profile);
        const pspan = Math.max(1, Math.max(...profile) - pmin);
        y = h * 0.9 - ((p - pmin) / pspan) * h * 0.38;
      }
      pts.push([x, y]);
    }
    const fogged = hexMix(color, haze, (1 - depth) * (night ? 0.25 : 0.45));
    return html`<path d=${`${line(pts)}L${w} ${h}L0 ${h}Z`} fill=${fogged} />`;
  });
  const orb = night
    ? html`<circle cx=${w * (0.68 + rand() * 0.2)} cy=${h * 0.2} r=${h * 0.06} fill="#f6ead2" opacity=".92" />`
    : html`<circle cx=${w * (0.25 + rand() * 0.5)} cy=${h * (tod === 'day' ? 0.18 : 0.42)} r=${h * 0.09} fill=${tod === 'day' ? '#fff3df' : '#ffd3a0'} opacity=${tod === 'day' ? 0.6 : 0.85} />`;
  const stars = night
    ? Array.from({ length: 26 }, () => html`<circle cx=${rand() * w} cy=${rand() * h * 0.42} r=${0.4 + rand() * 0.7} fill="#f3ebdd" opacity=${0.25 + rand() * 0.5} />`)
    : null;
  const lights =
    night && (region === 'bayarea' || region === 'alpine')
      ? Array.from({ length: 30 }, () => html`<circle cx=${rand() * w} cy=${h * (0.66 + rand() * 0.08)} r=${0.5 + rand() * 0.8} fill="#ffd49a" opacity=${0.4 + rand() * 0.5} />`)
      : null;
  return html`<svg class=${className} viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id=${id} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color=${sky[0]} /><stop offset=".55" stop-color=${sky[1]} /><stop offset="1" stop-color=${sky[2]} /></linearGradient></defs>
    <rect width=${w} height=${h} fill="url(#${id})" />
    ${stars}${orb}${layers.slice(0, 2)}${lights}${layers.slice(2)}
  </svg>`;
}
