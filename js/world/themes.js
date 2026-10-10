// World looks per region and time of day. Calm palettes: soft skies, haze
// that swallows the distance, a muted ground, and one quiet accent.

const base = {
  relief: 1,
  flatShading: true,
  camera: { distance: 7.5, height: 2.6 },
  road: { asphalt: '#3a3d42', edge: '#d9d6cc', center: '#d9c27a', shoulder: '#6b6a5f' },
  rider: { jersey: '#e9e4d8', shorts: '#202226', bike: '#cfcfcf', helmet: '#f4f4f4', skin: '#c99a7a' },
};

const SCENERY = {
  alpine: [
    { kind: 'conifer', density: 55, minRoad: 9, scale: [6, 16], colors: ['#2f4a3a', '#36543f', '#2a4234'], altitude: [-100, 2100], slopeMax: 1.2 },
    { kind: 'rock', density: 10, minRoad: 3, scale: [1.5, 6], colors: ['#8a8b86', '#9c9a92', '#6f716d'] },
    { kind: 'post', density: 6, minRoad: 0.5, maxRoad: 2.5, scale: [1.2, 1.4], colors: ['#c8553d', '#f2efe8'], altitude: [1700, 4000] },
  ],
  provence: [
    { kind: 'round', density: 30, minRoad: 9, scale: [4, 9], colors: ['#5b6b3c', '#6a7a45', '#4f5f36'], altitude: [-100, 1400] },
    { kind: 'shrub', density: 40, minRoad: 2, scale: [0.8, 2], colors: ['#8f86b8', '#7c8a52', '#a39dc4'], altitude: [-100, 1200] },
    { kind: 'rock', density: 26, minRoad: 2, scale: [0.8, 4], colors: ['#d8d3c6', '#cbc5b4', '#e6e1d4'], altitude: [1300, 3000] },
  ],
  mallorca: [
    { kind: 'round', density: 18, minRoad: 8, scale: [3, 7], colors: ['#5c6b45', '#6e7d52'] },
    { kind: 'rock', density: 30, minRoad: 2, scale: [1, 6], colors: ['#c9bfae', '#b5aa98', '#d8cfbf'] },
    { kind: 'shrub', density: 30, minRoad: 2, scale: [0.6, 1.6], colors: ['#7a8a5a', '#8c9a64'] },
  ],
  bayarea: [
    { kind: 'round', density: 22, minRoad: 9, scale: [5, 11], colors: ['#46532f', '#53603a', '#3e4a2b'], slopeMax: 0.9 },
    { kind: 'redwood', density: 10, minRoad: 10, scale: [18, 32], colors: ['#2e4334', '#33493a'] },
    { kind: 'shrub', density: 30, minRoad: 2, scale: [0.6, 1.8], colors: ['#7a7a4a', '#8a8450', '#6d7448'] },
  ],
  coast: [
    { kind: 'cypress', density: 8, minRoad: 9, scale: [5, 10], colors: ['#38493a', '#2f4033'] },
    { kind: 'shrub', density: 45, minRoad: 2, scale: [0.6, 1.8], colors: ['#8a8f5a', '#a49d68', '#77814f'] },
    { kind: 'rock', density: 6, minRoad: 3, scale: [1, 4], colors: ['#8d8a82', '#a29e94'] },
  ],
  redwoods: [
    { kind: 'redwood', density: 95, minRoad: 8, scale: [22, 45], colors: ['#284033', '#2d4738', '#233a2e'] },
    { kind: 'shrub', density: 60, minRoad: 2, scale: [0.6, 1.6], colors: ['#3f5a3a', '#4b6742'] },
  ],
  lakes: [
    { kind: 'conifer', density: 40, minRoad: 10, scale: [6, 14], colors: ['#2f4a3a', '#36543f'] },
    { kind: 'rock', density: 14, minRoad: 3, scale: [1, 5], colors: ['#9a9b97', '#b0afa8'] },
  ],
  mesa: [
    { kind: 'shrub', density: 22, minRoad: 3, scale: [1.2, 3.2], colors: ['#5f6b48', '#6d7650', '#556142'] },
    { kind: 'rock', density: 12, minRoad: 3, scale: [2, 9], colors: ['#b0704e', '#c28461', '#9e6344'] },
  ],
};

const TERRAIN = {
  alpine: { low: '#5f7a4d', mid: '#7d8a5c', high: '#9a9688', rock: '#8a8a86', snow: '#eef1f2', snowLine: 2550, noise: 0.05 },
  provence: { low: '#7a8250', mid: '#8f8f62', high: '#d9d4c6', rock: '#cfc9ba', noise: 0.05 },
  mallorca: { low: '#8a8a5c', mid: '#a59b78', high: '#c9bfab', rock: '#bcb19d', noise: 0.06 },
  bayarea: { low: '#a68f55', mid: '#b59b5f', high: '#9d8a5a', rock: '#8e826b', noise: 0.06 },
  coast: { low: '#a49565', mid: '#9a9a62', high: '#8b8f5e', rock: '#8a857b', noise: 0.05 },
  redwoods: { low: '#3c4f37', mid: '#46593d', high: '#556748', rock: '#5f5e55', noise: 0.04 },
  lakes: { low: '#5d7350', mid: '#6f805a', high: '#8f9182', rock: '#8c8c88', snow: '#eef1f2', snowLine: 2400, noise: 0.05 },
  mesa: { low: '#b98a5e', mid: '#c49a6c', high: '#a96f4d', rock: '#9c5f42', noise: 0.06 },
};

// Time-of-day lighting, applied on top of a region.
const LIGHT = {
  day: {
    sky: { top: '#7fa6c9', horizon: '#dfe6ea', bottom: '#cfd8dc', glow: '#fff4dc' },
    fog: { color: '#d8e0e4', near: 180, far: 1600 },
    sun: { color: '#fff3e0', intensity: 2.0, direction: [0.4, 0.75, -0.5] },
    hemi: { sky: '#dbe7f2', ground: '#6b6a55', intensity: 1.35 },
  },
  dusk: {
    sky: { top: '#3b4a75', horizon: '#e9a77f', bottom: '#b88a78', glow: '#ffcf9a' },
    fog: { color: '#c79a86', near: 160, far: 1400 },
    sun: { color: '#ffc28a', intensity: 1.6, direction: [-0.7, 0.18, -0.65] },
    hemi: { sky: '#8a86b0', ground: '#4a3b35', intensity: 1.1 },
  },
  night: {
    sky: { top: '#060a14', horizon: '#1b2740', bottom: '#111a2b', glow: '#3d5a8a' },
    fog: { color: '#141d30', near: 120, far: 1200 },
    sun: { color: '#9fb4e6', intensity: 0.7, direction: [0.3, 0.6, -0.4] },
    hemi: { sky: '#3a4c78', ground: '#0e121b', intensity: 0.9 },
    stars: true,
  },
};

const BACKDROP = {
  alpine: (L) => [
    { distance: 5200, height: 1300, roughness: 3.5, color: mix(L.fog.color, '#7e8aa0', 0.35) },
    { distance: 4300, height: 700, roughness: 5, color: mix(L.fog.color, '#5f6c7e', 0.45) },
  ],
  default: (L) => [
    { distance: 5200, height: 420, roughness: 2.5, color: mix(L.fog.color, '#7a8592', 0.3) },
    { distance: 4300, height: 220, roughness: 4, color: mix(L.fog.color, '#5f6a72', 0.4) },
  ],
};

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

export function regionFor(route) {
  const id = route?.id ?? '';
  if (/alpe|stelvio|tourmalet/.test(id)) return 'alpine';
  if (/ventoux/.test(id)) return 'provence';
  if (/calobra/.test(id)) return 'mallorca';
  if (/fogline|coast/.test(id)) return 'coast';
  if (/redwood/.test(id)) return 'redwoods';
  if (/lake/.test(id)) return 'lakes';
  if (/mesa|juniper/.test(id)) return 'mesa';
  return 'bayarea';
}

export function themeFor(route, timeOfDay = 'day') {
  const region = regionFor(route);
  const light = LIGHT[timeOfDay] ?? LIGHT.day;
  const night = timeOfDay === 'night';
  const terrain = { ...TERRAIN[region] };
  return {
    ...base,
    ...light,
    region,
    timeOfDay,
    terrain,
    scenery: SCENERY[region],
    backdrop: (BACKDROP[region] ?? BACKDROP.default)(light),
    water: region === 'coast' || region === 'lakes' ? { color: night ? '#1a2a40' : region === 'coast' ? '#3f6f8c' : '#5f8fa3', belowRoad: region === 'coast' ? 18 : 6 } : null,
    road: night ? { ...base.road, asphalt: '#26292e', shoulder: '#34342e' } : base.road,
  };
}

export const DEFAULT_THEME = themeFor(null, 'day');

// Time of day from the clock (he rides mostly at night).
export function timeOfDayNow(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 20.5 || h < 5.5) return 'night';
  if (h >= 18 || h < 7.5) return 'dusk';
  return 'day';
}
