// World looks — "The Evening Edition" (spec §6): a calm, flat-shaded,
// gouache-travel-poster world. Every route belongs to a biome; every biome
// has a palette per time of day:
//
//   golden  before 19:30   warm peach horizon, low sun #FFD3A0 @ 0.9
//   dusk    19:30–20:30    indigo → mauve → peach, sun just set, pink rim on peaks
//   night   after 20:30    navy → plum, stars, moon #F6EAD2 @ 0.45, valley lights
//   day     (kept for completeness)
//
// Colours are final sRGB hexes (the renderer does no colour conversion).
// Ground and prop colours come in [lit, shade] pairs that the chunk builder
// mixes per face by N·L with ±4 % noise — the faceted painting look.
//
// themeFor(route, timeOfDay) returns a plain object (no Three.js) that the
// chunk worker can receive as-is.

import { mixHex, scaleHex } from './paint.js';

// ---------------------------------------------------------------- biomes per route

const ROUTE_ART = {
  'alpe-dhuez': {
    biome: 'alpine',
    snowLine: 1900,
    floor: 712,
    signs: 'fr',
    // Grandes Rousses NE of the resort, Taillefer W, Muzelle S, Belledonne N.
    peaks: [
      { from: 'end', bearing: 40, dist: 5200, h: 3320, r: 4200 },
      { from: 'end', bearing: 75, dist: 9000, h: 3460, r: 5000 },
      { from: 'start', bearing: 262, dist: 9500, h: 2860, r: 5200 },
      { from: 'start', bearing: 185, dist: 10500, h: 3420, r: 5600 },
      { from: 'start', bearing: 345, dist: 11000, h: 2900, r: 5200 },
    ],
    lights: [
      { at: 'end', radius: 650, count: 260 },
      { at: 'start', radius: 1100, count: 320 },
      { atM: 9400, radius: 260, count: 50 },
    ],
  },
  'stelvio-prato': {
    biome: 'alpine',
    snowLine: 2380,
    floor: 900,
    signs: 'it',
    peaks: [
      { from: 'end', bearing: 120, dist: 7200, h: 3905, r: 6000 },
      { from: 'end', bearing: 160, dist: 6000, h: 3550, r: 4200 },
      { from: 'end', bearing: 20, dist: 6500, h: 3300, r: 4500 },
    ],
    lights: [{ at: 'start', radius: 900, count: 200 }, { at: 'end', radius: 250, count: 40 }, { atM: 7000, radius: 350, count: 60 }],
  },
  'tourmalet-luz': {
    biome: 'alpine',
    snowLine: 1980,
    floor: 700,
    signs: 'fr',
    peaks: [
      { from: 'end', bearing: 10, dist: 3200, h: 2877, r: 3200 },
      { from: 'end', bearing: 200, dist: 6500, h: 3000, r: 4500 },
      { from: 'start', bearing: 250, dist: 8000, h: 2700, r: 5000 },
    ],
    lights: [{ at: 'start', radius: 900, count: 240 }, { atM: 7000, radius: 400, count: 90 }],
  },
  'mont-ventoux-bedoin': {
    biome: 'provence',
    capLine: 1500,
    floor: 280,
    signs: 'fr',
    summitCap: true,
    observatory: true,
    peaks: [{ from: 'start', bearing: 300, dist: 11000, h: 720, r: 4500, pow: 1.1 }],
    lights: [{ at: 'start', radius: 900, count: 260 }, { at: 'end', radius: 120, count: 14 }],
    plainLights: true,
  },
  'sa-calobra': { biome: 'mallorca', signs: 'es', ocean: { from: 'start', bearing: 330, offset: 140 }, lights: [{ at: 'start', radius: 260, count: 60 }] },
  'mount-diablo-south-gate': { biome: 'bayhills', floor: 115, signs: 'us', summitCap: true, plainLights: true, beacon: true },
  'claremont-ave': { biome: 'bayhills', floor: 18, signs: 'us', plainLights: true, ocean: { from: 'start', bearing: 262, offset: 4200 } },
  'south-park-dr': { biome: 'bayhills', floor: 60, signs: 'us', plainLights: true },
  'mount-tam-mill-valley': { biome: 'tam', floor: 4, signs: 'us', plainLights: true, ocean: { from: 'end', bearing: 235, offset: 3400 } },
  'old-la-honda': { biome: 'redwood', signs: 'us' },
  'cathedral-redwoods': { biome: 'redwood', signs: 'us' },
  'hawk-hill': { biome: 'coast', signs: 'us', ocean: { from: 'end', bearing: 205, offset: 650 }, lighthouse: { from: 'end', bearing: 235, dist: 1500 }, cityLights: { bearing: 120, spread: 40 } },
  'fogline-coast': { biome: 'coast', signs: 'us', ocean: { from: 'west', offset: 120 }, lighthouse: { from: 'west', dist: 900 } },
  'glasswater-lakes': { biome: 'lakes', signs: 'us' },
  'juniper-mesa': { biome: 'mesa', signs: 'us' },
};

export function regionFor(route) {
  const id = route?.id ?? '';
  if (ROUTE_ART[id]) return ROUTE_ART[id].biome;
  if (route?.kind === 'imported' || route?.imported) return importedBiome(route);
  if (/alpe|stelvio|tourmalet|galibier|izoard/.test(id)) return 'alpine';
  if (/ventoux/.test(id)) return 'provence';
  if (/calobra|mallorca/.test(id)) return 'mallorca';
  if (/fogline|coast|hawk/.test(id)) return 'coast';
  if (/redwood|honda/.test(id)) return 'redwood';
  if (/lake/.test(id)) return 'lakes';
  if (/mesa|juniper/.test(id)) return 'mesa';
  return 'bayhills';
}

// "Ride your run": biome from the run's location and elevation.
function importedBiome(route) {
  const lat = route.lat?.[0];
  const lon = route.lon?.[0];
  const top = route.maxElevation ?? 0;
  if (top > 1700) return 'alpine';
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    // Santa Cruz Mountains / west Marin redwood belt, else Bay hills.
    if (lat > 36.9 && lat < 37.45 && lon < -122.0) return 'redwood';
    if (lat > 37.85 && lat < 38.1 && lon < -122.5 && top < 500) return 'redwood';
    if (lat > 36.8 && lat < 38.6 && lon > -123.2 && lon < -121.3) return 'bayhills';
    if (lat > 43 && lat < 48 && lon > 5 && lon < 16) return 'alpine';
  }
  return top > 1200 ? 'mesa' : 'bayhills';
}

// ---------------------------------------------------------------- time of day

export const TIMES = ['golden', 'dusk', 'night', 'day'];

// Evening Edition timing (spec §6.2). Early morning reads as night too.
export function timeOfDayNow(date = new Date(), { alwaysGolden = false } = {}) {
  if (alwaysGolden) return 'golden';
  const h = date.getHours() + date.getMinutes() / 60;
  if (h >= 20.5 || h < 5) return 'night';
  if (h >= 19.5) return 'dusk';
  return 'golden';
}

// ---------------------------------------------------------------- palettes

// Light: bearing offset from the route's main direction (deg) and elevation;
// used for the baked facets and the rider's key light.
const LIGHT = {
  golden: { offset: -38, elevation: 13, color: '#FFD3A0', intensity: 0.9, hemiSky: '#E9C9B0', hemiGround: '#5A4A40', hemi: 0.75, stars: 0, moon: false },
  dusk: { offset: -52, elevation: 9, color: '#F2B9B0', intensity: 0.35, hemiSky: '#B58FA6', hemiGround: '#3E3442', hemi: 0.95, stars: 0.18, moon: false },
  night: { offset: 48, elevation: 30, color: '#F6EAD2', intensity: 0.45, hemiSky: '#6E6A92', hemiGround: '#262433', hemi: 0.85, stars: 1, moon: true },
  day: { offset: 115, elevation: 48, color: '#FFF4E2', intensity: 1.1, hemiSky: '#D7E0E8', hemiGround: '#6A6455', hemi: 0.9, stars: 0, moon: false },
};

// Per-biome palettes. `warm` = the golden/dusk family, `night` explicit;
// golden/day are graded from `warm`.
const BIOMES = {
  alpine: {
    relief: { hillAmp: 55, hillWave: 640, mountains: { amp: 1500, wave: 2900, near: 280, far: 3600, bias: 0.28 }, view: 12000 },
    sky: {
      golden: { top: '#35467C', mid: '#C69490', horizon: '#FAD2A2', glow: '#FFD3A0', glowAmt: 0.8 },
      dusk: { top: '#1C2040', mid: '#8A6380', horizon: '#EDBA92', glow: '#F2B48E', glowAmt: 0.6 },
      night: { top: '#121528', mid: '#262946', horizon: '#6E4E62', glow: '#6E4E62', glowAmt: 0.25 },
      day: { top: '#5E86B4', mid: '#9DB6CC', horizon: '#E2DED6', glow: '#FFF2DA', glowAmt: 0.4 },
    },
    fog: {
      golden: { color: '#C69C94', near: 180, far: 5200, max: 0.6 },
      dusk: { color: '#8C6E86', near: 160, far: 4600, max: 0.66 },
      night: { color: '#2E2F4A', near: 120, far: 3600, max: 0.72 },
      day: { color: '#B4BCC6', near: 220, far: 6500, max: 0.55 },
    },
    ground: {
      warm: {
        meadow: ['#78855A', '#323C2C'],
        pasture: ['#8C9562', '#3E4632'],
        forest: ['#4B6560', '#203036'],
        rock: ['#A9788A', '#4A4166'],
        crag: ['#958A86', '#4A424C'],
        scree: ['#8E7C84', '#463E58'],
        snow: ['#F4C7B6', '#9D7E98'],
        verge: ['#7E8A5C', '#3C4432'],
        cut: ['#7A6C66', '#3E3640'],
      },
      night: {
        meadow: ['#47503A', '#1C2219'],
        pasture: ['#4E553E', '#20261C'],
        forest: ['#33433F', '#161F22'],
        rock: ['#5B5674', '#2B2B45'],
        crag: ['#504C58', '#24232C'],
        scree: ['#504C66', '#26263C'],
        snow: ['#B9B6CF', '#6C6A8A'],
        verge: ['#4C5440', '#20261E'],
        cut: ['#4E4A58', '#24232F'],
      },
    },
    props: {
      warm: { pine: [['#33473A', '#18221C'], ['#2F4541', '#182528'], ['#3A4E3C', '#1C281F']], rock: [['#9C8C8E', '#4A4258']], pole: ['#EFE7DA', '#A89E92'], poleTop: ['#E8C64A', '#9C8030'], trunk: ['#5A4436', '#2E2420'], wall: ['#9A8C86', '#4E4650'] },
      night: { pine: [['#26302A', '#111612'], ['#24302E', '#121A1B']], rock: [['#5A566C', '#26243A']], pole: ['#C9C2C8', '#5E5A6E'], poleTop: ['#C8A848', '#6A5830'], trunk: ['#3A2E2A', '#1A1616'], wall: ['#57525E', '#26242E'] },
    },
    road: {
      warm: { asphalt: '#3F3935', edge: '#CFC4B6', centre: null, shoulder: '#55573E' },
      night: { asphalt: '#2A2724', edge: '#8E8678', centre: null, shoulder: '#2E3125' },
    },
    groundBy: {
      golden: { snow: ['#FBE4CF', '#A897AE'], rock: ['#B88C8C', '#54476C'] },
      day: { snow: ['#F2F0EC', '#A9B3C4'], rock: ['#A49C9C', '#5C5A6C'], crag: ['#9C9894', '#55525A'], scree: ['#A09A96', '#5E5A64'] },
    },
    rim: { dusk: { color: '#F4C7B6', amount: 0.55, from: 2100 }, golden: { color: '#FFD9B8', amount: 0.3, from: 2300 } },
    skyline: {
      warm: [
        { dist: 26000, lo: 2200, hi: 3900, rough: 0.55, peaks: 9, lit: '#A9788A', shade: '#4A4166', cap: 2900, capLit: '#F4C7B6', capShade: '#9D7E98', fog: 0.38 },
        { dist: 17000, lo: 1500, hi: 2600, rough: 0.4, peaks: 7, lit: '#6E7E78', shade: '#2E3A44', fog: 0.3 },
      ],
      night: [
        { dist: 26000, lo: 2200, hi: 3900, rough: 0.55, peaks: 9, lit: '#5B5674', shade: '#2B2B45', cap: 2900, capLit: '#B9B6CF', capShade: '#6C6A8A', fog: 0.35 },
        { dist: 17000, lo: 1500, hi: 2600, rough: 0.4, peaks: 7, lit: '#33433F', shade: '#161F22', fog: 0.32 },
      ],
    },
    scatter: [
      { kind: 'pine', along: 16, band: [7, 55], area: 2.6, on: ['forest'], alt: [-100, 2150], slopeMax: 1.3, scale: [7, 15], colors: 'pine', far: true },
      { kind: 'pine', area: 0.25, on: ['meadow', 'pasture'], alt: [-100, 2050], slopeMax: 0.9, scale: [6, 12], colors: 'pine', far: true },
      { kind: 'rock', along: 6, band: [5, 40], area: 0.8, on: ['rock', 'scree', 'meadow', 'pasture'], scale: [1.2, 4.5], colors: 'rock' },
    ],
    furniture: { snowPoles: { every: 50, from: 1250 }, bornes: true, hairpins: true },
    lightsColor: ['#FFD49A', '#FFE8C4'],
  },

  provence: {
    relief: { hillAmp: 45, hillWave: 700, mountains: { amp: 320, wave: 3200, near: 600, far: 5000, bias: 0.5 }, view: 11000 },
    sky: {
      golden: { top: '#28284A', mid: '#B07A84', horizon: '#F6C892', glow: '#FFD3A0', glowAmt: 0.85 },
      dusk: { top: '#21234A', mid: '#8A6684', horizon: '#E9A784', glow: '#F2B48E', glowAmt: 0.6 },
      night: { top: '#13162C', mid: '#2A2B4A', horizon: '#5E4A62', glow: '#5E4A62', glowAmt: 0.2 },
      day: { top: '#6496C6', mid: '#A9C2D8', horizon: '#ECE4D4', glow: '#FFF2DA', glowAmt: 0.4 },
    },
    fog: {
      golden: { color: '#B98A8A', near: 200, far: 5600, max: 0.6 },
      dusk: { color: '#93738A', near: 170, far: 4800, max: 0.64 },
      night: { color: '#2C2D46', near: 120, far: 3600, max: 0.72 },
      day: { color: '#C0BEC2', near: 240, far: 7000, max: 0.5 },
    },
    ground: {
      warm: {
        meadow: ['#7E7E4E', '#3C3F2E'],
        field: ['#6E7046', '#34372A'],
        forest: ['#4E5B47', '#283329'],
        scrub: ['#77744E', '#3A3A2C'],
        cap: ['#EEE1CF', '#A99A99'],
        rock: ['#D6C8BA', '#8E8290'],
        verge: ['#86825A', '#44432F'],
        cut: ['#CFC1B2', '#8A7E86'],
      },
      night: {
        meadow: ['#4A4C38', '#1E2019'],
        field: ['#424430', '#1C1E17'],
        forest: ['#2E3A33', '#141C18'],
        scrub: ['#46463A', '#1E1E19'],
        cap: ['#B9B4C4', '#6C6880'],
        rock: ['#A09CB0', '#555268'],
        verge: ['#4E4E3C', '#22221A'],
        cut: ['#8E8A9C', '#46445A'],
      },
    },
    props: {
      warm: { pine: [['#3D4A3B', '#1F2A22'], ['#46533F', '#222C22']], oak: [['#55603F', '#272D20'], ['#5E6A44', '#2C3422']], cypress: [['#3A4634', '#1D261C']], lavender: ['#8A77B4', '#6A5893'], lavenderGap: ['#5A5A3C', '#2E2E22'], rock: [['#DCD0C2', '#9A8E96']], wall: ['#B4A898', '#6A6070'], trunk: ['#5A4436', '#2E2420'] },
      night: { pine: [['#26302A', '#111612']], oak: [['#2E3426', '#141812']], cypress: [['#232B22', '#0F140F']], lavender: ['#4E4670', '#2E2846'], lavenderGap: ['#2E2E24', '#16160F'], rock: [['#A8A4B6', '#5A5670']], wall: ['#6A6474', '#302E3A'], trunk: ['#3A2E2A', '#1A1616'] },
    },
    road: {
      warm: { asphalt: '#5E544F', edge: '#E4D8C6', centre: null, shoulder: '#5A5240' },
      night: { asphalt: '#2E2A28', edge: '#8A8274', centre: null, shoulder: '#2C2A22' },
    },
    rim: { dusk: { color: '#F6C8B8', amount: 0.35, from: 1650 } },
    skyline: {
      warm: [
        { dist: 30000, lo: 600, hi: 1500, rough: 0.35, peaks: 6, lit: '#9E7A93', shade: '#6A587A', fog: 0.45 },
        { dist: 15000, lo: 300, hi: 760, rough: 0.6, peaks: 9, lit: '#7A7466', shade: '#4A4A50', fog: 0.38 },
      ],
      night: [
        { dist: 30000, lo: 600, hi: 1500, rough: 0.35, peaks: 6, lit: '#4E4A66', shade: '#2E2C46', fog: 0.4 },
        { dist: 15000, lo: 300, hi: 760, rough: 0.6, peaks: 9, lit: '#33363A', shade: '#1A1C22', fog: 0.38 },
      ],
    },
    scatter: [
      { kind: 'pine', along: 18, band: [7, 55], area: 2.2, on: ['forest'], alt: [520, 1480], slopeMax: 1.2, scale: [6, 12], colors: 'pine', far: true },
      { kind: 'oak', along: 8, band: [8, 50], area: 0.8, on: ['forest', 'scrub', 'meadow'], alt: [-100, 1100], scale: [3.5, 7], colors: 'oak', far: true },
      { kind: 'cypress', along: 7, band: [6, 40], area: 0.3, on: ['field', 'meadow'], alt: [-100, 650], scale: [8, 14], colors: 'cypress', far: true },
      { kind: 'rock', along: 6, band: [4, 40], area: 1.0, on: ['cap', 'rock'], scale: [0.8, 3.2], colors: 'rock' },
    ],
    lavender: { below: 600 },
    furniture: { bornes: true, hairpins: true, walls: true },
    lightsColor: ['#FFD49A', '#FFF0D6'],
  },

  mallorca: {
    relief: { hillAmp: 70, hillWave: 520, mountains: { amp: 650, wave: 1800, near: 220, far: 2800, bias: 0.25 }, view: 9000 },
    sky: {
      golden: { top: '#2C3C6C', mid: '#B48A8A', horizon: '#F8D0A0', glow: '#FFD3A0', glowAmt: 0.8 },
      dusk: { top: '#1E2448', mid: '#86668A', horizon: '#E8AC8C', glow: '#F2B48E', glowAmt: 0.6 },
      night: { top: '#111629', mid: '#252B48', horizon: '#56506A', glow: '#56506A', glowAmt: 0.2 },
      day: { top: '#5A90C8', mid: '#A2C2DC', horizon: '#E8E6DC', glow: '#FFF2DA', glowAmt: 0.4 },
    },
    fog: {
      golden: { color: '#B4908E', near: 200, far: 5200, max: 0.55 },
      dusk: { color: '#8A6E86', near: 160, far: 4400, max: 0.62 },
      night: { color: '#2A2E48', near: 120, far: 3400, max: 0.7 },
      day: { color: '#BCC6CE', near: 240, far: 6500, max: 0.5 },
    },
    ground: {
      warm: { meadow: ['#8A8A5E', '#3E3E30'], scrub: ['#6E7D52', '#2E3826'], rock: ['#D2C6B4', '#76707E'], cliff: ['#BCAE9C', '#625C6A'], verge: ['#8E8A62', '#46442F'], cut: ['#C2B4A2', '#6E6672'], sand: ['#E2D2B2', '#9A8E7E'] },
      night: { meadow: ['#4A4A3A', '#1E1E18'], scrub: ['#38402E', '#161A12'], rock: ['#8C889C', '#46445A'], cliff: ['#7A7688', '#3A384A'], verge: ['#4C4A3A', '#20201A'], cut: ['#7A7686', '#3A3848'], sand: ['#8E8A8A', '#46444C'] },
    },
    props: {
      warm: { oak: [['#5C6B45', '#283020'], ['#6E7D52', '#2E3826']], rock: [['#D0C4B2', '#7A7482']], wall: ['#C4B6A2', '#726A74'], pine: [['#4A5A3E', '#222C1E']], trunk: ['#5A4436', '#2E2420'] },
      night: { oak: [['#2E3426', '#141812']], rock: [['#8C889C', '#46445A']], wall: ['#7A7484', '#363444'], pine: [['#26302A', '#111612']], trunk: ['#3A2E2A', '#1A1616'] },
    },
    road: { warm: { asphalt: '#4A4440', edge: '#E4D8C6', centre: null, shoulder: '#6A6450' }, night: { asphalt: '#2A2724', edge: '#8A8274', centre: null, shoulder: '#2E2C24' } },
    water: {
      golden: { near: '#3E7E92', far: '#5A7C9A', glint: '#FFE6BE' },
      dusk: { near: '#2E4A66', far: '#4E5A7A', glint: '#F6D6C0' },
      night: { near: '#151B2B', far: '#2C3550', glint: '#F2E2C2' },
      day: { near: '#2E8AA2', far: '#5E9AB8', glint: '#FFFFFF' },
    },
    skyline: {
      warm: [{ dist: 22000, lo: 400, hi: 1450, rough: 0.6, peaks: 8, lit: '#A88E96', shade: '#5C5476', fog: 0.42 }],
      night: [{ dist: 22000, lo: 400, hi: 1450, rough: 0.6, peaks: 8, lit: '#4E4A66', shade: '#2A2944', fog: 0.38 }],
    },
    scatter: [
      { kind: 'oak', along: 16, band: [5, 50], area: 1.6, on: ['scrub', 'meadow'], scale: [2.5, 6], colors: 'oak', far: true },
      { kind: 'rock', along: 10, band: [4, 40], area: 1.2, on: ['rock', 'cliff', 'scrub'], scale: [1, 5], colors: 'rock' },
    ],
    furniture: { walls: true, hairpins: true },
    lightsColor: ['#FFD49A', '#FFF0D6'],
  },

  bayhills: {
    relief: { hillAmp: 60, hillWave: 560, mountains: { amp: 560, wave: 2600, near: 350, far: 4200, bias: 0.5 }, view: 12000 },
    sky: {
      golden: { top: '#37487C', mid: '#D29C88', horizon: '#FFDAA6', glow: '#FFD3A0', glowAmt: 0.85 },
      dusk: { top: '#222C50', mid: '#A87484', horizon: '#F0B88E', glow: '#F3B58A', glowAmt: 0.65 },
      night: { top: '#1C2644', mid: '#9B6F7C', horizon: '#EBB68C', glow: '#F3B58A', glowAmt: 0.45 },
      day: { top: '#6494C4', mid: '#A8C2D6', horizon: '#ECE4D2', glow: '#FFF2DA', glowAmt: 0.4 },
    },
    fog: {
      golden: { color: '#C79C8A', near: 220, far: 5600, max: 0.58 },
      dusk: { color: '#97747E', near: 180, far: 5000, max: 0.62 },
      night: { color: '#86687A', near: 160, far: 4400, max: 0.66 },
      day: { color: '#C6C2BC', near: 260, far: 7200, max: 0.5 },
    },
    // Blue hour on Diablo is the spec's signature (§6.3), so night keeps a warm horizon.
    ground: {
      warm: {
        grass: ['#D8AA66', '#6A5038'],
        dry: ['#C89E66', '#5E4836'],
        oakwood: ['#5E6844', '#2A3022'],
        chaparral: ['#6E6A48', '#33312A'],
        rock: ['#B09A84', '#5E5060'],
        verge: ['#B89466', '#5A4636'],
        cut: ['#A08468', '#54443E'],
      },
      night: {
        grass: ['#C69A5F', '#5A4532'],
        dry: ['#B48C5C', '#4E3C30'],
        oakwood: ['#4A5038', '#262B21'],
        chaparral: ['#5C5842', '#2A2822'],
        rock: ['#9A8678', '#4A3E48'],
        verge: ['#A88658', '#4A3A2E'],
        cut: ['#8C7460', '#443834'],
      },
    },
    props: {
      warm: { oak: [['#5E6A44', '#2A3022'], ['#55603F', '#272D20'], ['#68744A', '#2E3524']], tuft: ['#D6AE6E', '#7A5E40'], post: ['#8A7A68', '#4A4038'], milepost: ['#3E5A4A', '#1E2C26'], rock: [['#B4A08A', '#5E5060']], pine: [['#3E4E3C', '#1C261E']], trunk: ['#4A3A30', '#241C18'] },
      night: { oak: [['#55603F', '#272D20'], ['#4E5838', '#22281C']], tuft: ['#B48C58', '#4E3C2C'], post: ['#6E6458', '#2E2A26'], milepost: ['#2E4438', '#141E1A'], rock: [['#8E7C70', '#40363E']], pine: [['#2E3A2E', '#141A14']], trunk: ['#3A2E2A', '#1A1616'] },
    },
    road: {
      warm: { asphalt: '#3A3533', edge: '#E9DFCF', centre: '#D2A848', centreStyle: 'double', shoulder: '#6B5A40' },
      night: { asphalt: '#3A3533', edge: '#B8AE9E', centre: '#D2A848', centreStyle: 'double', shoulder: '#4E4232' },
    },
    skyline: {
      warm: [
        { dist: 30000, lo: 250, hi: 1200, rough: 0.3, peaks: 6, lit: '#8A7E9A', shade: '#5A5878', fog: 0.45 },
        { dist: 16000, lo: 120, hi: 620, rough: 0.35, peaks: 7, lit: '#9C7A55', shade: '#4E3E35', fog: 0.38 },
      ],
      night: [
        { dist: 30000, lo: 250, hi: 1200, rough: 0.3, peaks: 6, lit: '#6C6A8C', shade: '#45486A', fog: 0.4 },
        { dist: 16000, lo: 120, hi: 620, rough: 0.35, peaks: 7, lit: '#7A6050', shade: '#3A2E2E', fog: 0.36 },
      ],
    },
    scatter: [
      { kind: 'oak', along: 8, band: [12, 80], area: 2.6, on: ['oakwood'], scale: [4, 8], colors: 'oak', far: true },
      { kind: 'oak', area: 0.18, on: ['grass', 'dry', 'chaparral'], band: [14], scale: [4, 9], colors: 'oak', far: true },
      { kind: 'tuft', along: 60, band: [3.5, 16], scale: [0.5, 1.1], colors: 'tuft' },
      { kind: 'rock', along: 2, band: [5, 30], area: 0.15, on: ['rock', 'grass'], scale: [1.2, 3.5], colors: 'rock' },
    ],
    furniture: { fence: { every: 50 }, mileposts: true },
    lightsColor: ['#FFD49A', '#FFF0D6'],
  },

  redwood: {
    relief: { hillAmp: 34, hillWave: 420, mountains: { amp: 140, wave: 1500, near: 200, far: 2000, bias: 0.3 }, view: 480 },
    sky: {
      golden: { top: '#2E3E36', mid: '#6E7A68', horizon: '#B8B08E', glow: '#E8D2A0', glowAmt: 0.35, canopy: true },
      dusk: { top: '#1E2A28', mid: '#46524C', horizon: '#76807A', glow: '#A89A90', glowAmt: 0.2, canopy: true },
      night: { top: '#16211F', mid: '#2A3835', horizon: '#4A5752', glow: '#4A5752', glowAmt: 0.1, canopy: true },
      day: { top: '#4E6A5E', mid: '#8EA290', horizon: '#C8CCB4', glow: '#F2EAD0', glowAmt: 0.3, canopy: true },
    },
    fog: {
      golden: { color: '#A6A48A', near: 20, far: 150, max: 0.9 },
      dusk: { color: '#7E8A82', near: 16, far: 125, max: 0.92 },
      night: { color: '#4E5A54', near: 15, far: 110, max: 0.93 },
      day: { color: '#AEB4A2', near: 22, far: 170, max: 0.88 },
    },
    ground: {
      warm: { floor: ['#4A5A36', '#26301E'], moss: ['#6E8248', '#34401E'], verge: ['#56482E', '#2C2418'], cut: ['#6A5034', '#34281C'], rock: ['#6E6A5C', '#36342E'] },
      night: { floor: ['#2A3528', '#18201A'], moss: ['#34442E', '#1A2418'], verge: ['#3A3326', '#1E1A14'], cut: ['#4A3A2A', '#241C16'], rock: ['#4A4A42', '#22221E'] },
    },
    props: {
      warm: { redwood: ['#C8784E', '#7E4630', '#4A2A1E'], canopy: ['#2E4030', '#18241A'], fern: [['#5A7A3E', '#2E4220'], ['#4F7A3A', '#28401E']], log: ['#7A4A34', '#3A2418'], post: ['#7A6248', '#3E3226'], milepost: ['#3E5A4A', '#1E2C26'] },
      night: { redwood: ['#B0684A', '#6A3B2B', '#3E231B'], canopy: ['#16201C', '#0E1612'], fern: [['#3A4F35', '#1E2A1C'], ['#34482F', '#1A2618']], log: ['#5A3626', '#2A1A12'], post: ['#5A4A38', '#2A221A'], milepost: ['#2E4438', '#141E1A'] },
    },
    road: {
      warm: { asphalt: '#34322E', edge: '#D8CEBC', centre: '#C9A24A', centreStyle: 'double', shoulder: '#4A3E2A' },
      night: { asphalt: '#2B2B2A', edge: '#A49A88', centre: '#C9A24A', centreStyle: 'double', shoulder: '#3A3326' },
    },
    skyline: { warm: [], night: [] },
    scatter: [
      { kind: 'redwood', along: 20, band: [5.5, 34], area: 6, on: ['floor', 'moss'], scale: [34, 62], colors: 'redwood', far: true },
      { kind: 'fern', along: 26, band: [3.6, 14], area: 9, on: ['floor', 'moss'], scale: [0.7, 1.5], colors: 'fern' },
      { kind: 'log', along: 1.2, band: [6, 20], scale: [6, 12], colors: 'log' },
    ],
    shafts: true,
    furniture: { mileposts: true },
    lightsColor: ['#FFD49A', '#FFF0D6'],
  },

  coast: {
    relief: { hillAmp: 40, hillWave: 520, mountains: { amp: 240, wave: 2200, near: 300, far: 3000, bias: 0.3 }, view: 9000 },
    sky: {
      golden: { top: '#34406A', mid: '#C08A86', horizon: '#F8C898', glow: '#FFD3A0', glowAmt: 0.8 },
      dusk: { top: '#1E2444', mid: '#6E5274', horizon: '#D89A88', glow: '#F0A888', glowAmt: 0.6 },
      night: { top: '#0F1527', mid: '#232B45', horizon: '#4A4762', glow: '#4A4762', glowAmt: 0.15 },
      day: { top: '#5E92C6', mid: '#A6C4DA', horizon: '#E6E6E0', glow: '#FFF2DA', glowAmt: 0.4 },
    },
    fog: {
      golden: { color: '#B48E92', near: 180, far: 4600, max: 0.6 },
      dusk: { color: '#6A5A78', near: 150, far: 4000, max: 0.64 },
      night: { color: '#2A2F45', near: 120, far: 3000, max: 0.7 },
      day: { color: '#C4CCD2', near: 240, far: 6000, max: 0.55 },
    },
    ground: {
      warm: { scrub: ['#8A9460', '#3A4230'], grass: ['#C9A86A', '#5E4C36'], rock: ['#A49A92', '#4E4A58'], verge: ['#A89466', '#4E4432'], cut: ['#9A8C7C', '#4A4048'], sand: ['#D8C6A2', '#8A7E70'] },
      night: { scrub: ['#5A6250', '#1D221E'], grass: ['#6A6450', '#26241E'], rock: ['#5A5868', '#24232E'], verge: ['#5E5A48', '#22211C'], cut: ['#55505A', '#24222A'], sand: ['#7A7680', '#36343E'] },
    },
    props: {
      warm: { scrub: [['#7A8452', '#36402A'], ['#6B7F5A', '#2E3826']], cypress: [['#3A4A3A', '#1C261E']], guard: ['#EDE4D4', '#9A9088'], rock: [['#9C948C', '#4A4654']], post: ['#8A7A68', '#4A4038'], milepost: ['#3E5A4A', '#1E2C26'] },
      night: { scrub: [['#525C48', '#283027'], ['#4C5644', '#222A20']], cypress: [['#26302A', '#111612']], guard: ['#D8D0C4', '#6E6A70'], rock: [['#5A5868', '#24232E']], post: ['#5A5248', '#24201C'], milepost: ['#2E4438', '#141E1A'] },
    },
    road: {
      warm: { asphalt: '#3A3836', edge: '#E7DDCB', centre: '#C9A24A', centreStyle: 'double', shoulder: '#4A4636' },
      night: { asphalt: '#2C2B2D', edge: '#A69E92', centre: '#C9A24A', centreStyle: 'double', shoulder: '#2B2C2A' },
    },
    water: {
      golden: { near: '#3A4A6A', far: '#8A7A96', glint: '#FFE0B0' },
      dusk: { near: '#232A44', far: '#5A4E6E', glint: '#F6D2B8' },
      night: { near: '#151B2B', far: '#2C3550', glint: '#F2E2C2' },
      day: { near: '#2E5A7A', far: '#6E96B4', glint: '#FFFFFF' },
    },
    skyline: {
      warm: [{ dist: 20000, lo: 60, hi: 520, rough: 0.35, peaks: 5, lit: '#8A7A92', shade: '#56506E', fog: 0.45, arcLand: true }],
      night: [{ dist: 20000, lo: 60, hi: 520, rough: 0.35, peaks: 5, lit: '#3D4260', shade: '#2A2E48', fog: 0.4, arcLand: true }],
    },
    scatter: [
      { kind: 'scrub', along: 40, band: [4, 60], area: 2.4, on: ['scrub', 'grass'], scale: [0.8, 2.2], colors: 'scrub' },
      { kind: 'cypress', along: 1.5, band: [10, 80], area: 0.12, on: ['scrub', 'grass'], scale: [7, 13], colors: 'cypress', far: true },
      { kind: 'rock', along: 2, band: [5, 40], area: 0.4, on: ['rock'], scale: [1.2, 4], colors: 'rock' },
    ],
    furniture: { guardPosts: { every: 7 }, mileposts: true },
    lightsColor: ['#FFD49A', '#FFF0D6'],
  },

  lakes: {
    relief: { hillAmp: 45, hillWave: 520, mountains: { amp: 900, wave: 2600, near: 450, far: 4000, bias: 0.3 }, view: 11000, basins: true },
    sky: {
      golden: { top: '#2E4274', mid: '#B48C90', horizon: '#F8D0A2', glow: '#FFD3A0', glowAmt: 0.75 },
      dusk: { top: '#1C2244', mid: '#7C6488', horizon: '#F2A65A', glow: '#F2A65A', glowAmt: 0.55 },
      night: { top: '#111629', mid: '#252A48', horizon: '#56506A', glow: '#56506A', glowAmt: 0.2 },
      day: { top: '#5C92CC', mid: '#9CC3E6', horizon: '#E6EAE8', glow: '#FFF2DA', glowAmt: 0.4 },
    },
    fog: {
      golden: { color: '#AE9298', near: 200, far: 5600, max: 0.55 },
      dusk: { color: '#866E8A', near: 170, far: 4800, max: 0.6 },
      night: { color: '#2A2E48', near: 120, far: 3600, max: 0.7 },
      day: { color: '#BCC6D0', near: 260, far: 7200, max: 0.48 },
    },
    ground: {
      warm: { meadow: ['#A3B18A', '#4E5A42'], granite: ['#C8C0B2', '#6E6872'], forest: ['#3E5A48', '#1E2E28'], snow: ['#F6E6D8', '#A69AB2'], verge: ['#9EA67E', '#4C523C'], cut: ['#B8B0A2', '#646070'] },
      night: { meadow: ['#4E5642', '#1E2219'], granite: ['#7A7686', '#383646'], forest: ['#26342E', '#111A16'], snow: ['#B9B6CF', '#6C6A8A'], verge: ['#4A5040', '#1E221A'], cut: ['#6E6A7A', '#323040'] },
    },
    props: {
      warm: { pine: [['#2F4A3A', '#15241C'], ['#36543F', '#18281E']], rock: [['#C2BAAC', '#6A6470']], post: ['#7A6248', '#3E3226'], milepost: ['#3E5A4A', '#1E2C26'], trunk: ['#5A4436', '#2E2420'] },
      night: { pine: [['#22302A', '#0F1612']], rock: [['#7A7686', '#383646']], post: ['#5A4A38', '#2A221A'], milepost: ['#2E4438', '#141E1A'], trunk: ['#3A2E2A', '#1A1616'] },
    },
    road: {
      warm: { asphalt: '#46423E', edge: '#E4DACA', centre: '#C9A24A', centreStyle: 'dash', shoulder: '#6A6A50' },
      night: { asphalt: '#2A2826', edge: '#8E887C', centre: '#9A7E40', centreStyle: 'dash', shoulder: '#2E2E26' },
    },
    water: {
      golden: { near: '#3E6E7C', far: '#7A8AA0', glint: '#FFE6BE' },
      dusk: { near: '#283E58', far: '#5A5A7A', glint: '#F6D2B8' },
      night: { near: '#121A2A', far: '#2A3350', glint: '#F2E2C2' },
      day: { near: '#2E6A7C', far: '#7AA6C2', glint: '#FFFFFF' },
    },
    skyline: {
      warm: [{ dist: 24000, lo: 2300, hi: 3900, rough: 0.5, peaks: 8, lit: '#A28C9E', shade: '#56507A', cap: 3200, capLit: '#F6E2D6', capShade: '#A69AB2', fog: 0.4 }],
      night: [{ dist: 24000, lo: 2300, hi: 3900, rough: 0.5, peaks: 8, lit: '#52506E', shade: '#2A2A46', cap: 3200, capLit: '#B9B6CF', capShade: '#6C6A8A', fog: 0.36 }],
    },
    scatter: [
      { kind: 'pine', along: 18, band: [7, 60], area: 1.6, on: ['forest', 'meadow'], scale: [6, 14], colors: 'pine', far: true },
      { kind: 'rock', along: 6, band: [4, 40], area: 0.8, on: ['granite'], scale: [1.2, 5], colors: 'rock' },
    ],
    furniture: { mileposts: true },
    lightsColor: ['#FFD49A', '#FFF0D6'],
  },

  mesa: {
    relief: { hillAmp: 30, hillWave: 600, mountains: { amp: 260, wave: 2600, near: 500, far: 4000, bias: 0.4 }, view: 12000, mesas: true },
    sky: {
      golden: { top: '#2E4A84', mid: '#BC8E86', horizon: '#F8D2A0', glow: '#FFD3A0', glowAmt: 0.8 },
      dusk: { top: '#1E2448', mid: '#6E5A8A', horizon: '#E8A47C', glow: '#F2A880', glowAmt: 0.6 },
      night: { top: '#111629', mid: '#262A4A', horizon: '#56486A', glow: '#56486A', glowAmt: 0.2 },
      day: { top: '#3D7CC9', mid: '#94B8DC', horizon: '#E8E2D4', glow: '#FFF2DA', glowAmt: 0.4 },
    },
    fog: {
      golden: { color: '#C2988A', near: 220, far: 6400, max: 0.52 },
      dusk: { color: '#8E7088', near: 180, far: 5200, max: 0.58 },
      night: { color: '#2C2C48', near: 120, far: 3800, max: 0.7 },
      day: { color: '#C8C6C0', near: 260, far: 8000, max: 0.45 },
    },
    ground: {
      warm: { sage: ['#9AA58A', '#4E5644'], rim: ['#C27048', '#6E3428'], ochre: ['#D39A5B', '#8A5A34'], wash: ['#E3D3B0', '#9A8A70'], verge: ['#A8A486', '#565440'], cut: ['#B87A52', '#6A3E2E'], snow: ['#F6E6D8', '#A69AB2'] },
      night: { sage: ['#50564A', '#202420'], rim: ['#6E4A44', '#2E1E22'], ochre: ['#7A6050', '#3A2A26'], wash: ['#8A8480', '#3E3A3C'], verge: ['#4E4E42', '#20201C'], cut: ['#6A4A44', '#2E2024'], snow: ['#B9B6CF', '#6C6A8A'] },
    },
    props: {
      warm: { juniper: [['#4A5D3F', '#23301E'], ['#55684A', '#283422']], sage: [['#9AA58A', '#55604A']], rock: [['#C27048', '#6E3428']], post: ['#7A6248', '#3E3226'], milepost: ['#3E5A4A', '#1E2C26'], trunk: ['#5A4436', '#2E2420'] },
      night: { juniper: [['#2A3426', '#121810']], sage: [['#4E5646', '#22281E']], rock: [['#6E4A44', '#2E1E22']], post: ['#5A4A38', '#2A221A'], milepost: ['#2E4438', '#141E1A'], trunk: ['#3A2E2A', '#1A1616'] },
    },
    road: {
      warm: { asphalt: '#45403C', edge: '#E8DCC8', centre: '#D2A848', centreStyle: 'double', shoulder: '#8A7A5C' },
      night: { asphalt: '#2A2826', edge: '#8E887C', centre: '#9A7E40', centreStyle: 'double', shoulder: '#3A342A' },
    },
    skyline: {
      warm: [
        { dist: 34000, lo: 1500, hi: 3300, rough: 0.2, peaks: 1, lit: '#A88A9A', shade: '#5A5276', cap: 2800, capLit: '#F6E6D8', capShade: '#A69AB2', fog: 0.42, cone: true },
        { dist: 18000, lo: 1300, hi: 1700, rough: 0.1, peaks: 6, lit: '#B5653D', shade: '#6E3E3A', fog: 0.4, mesa: true },
      ],
      night: [
        { dist: 34000, lo: 1500, hi: 3300, rough: 0.2, peaks: 1, lit: '#4E4A66', shade: '#2A2944', cap: 2800, capLit: '#B9B6CF', capShade: '#6C6A8A', fog: 0.38, cone: true },
        { dist: 18000, lo: 1300, hi: 1700, rough: 0.1, peaks: 6, lit: '#4A3A44', shade: '#241C26', fog: 0.38, mesa: true },
      ],
    },
    scatter: [
      { kind: 'juniper', along: 10, band: [6, 70], area: 0.9, on: ['sage', 'ochre'], scale: [3, 6], colors: 'juniper', far: true },
      { kind: 'sage', along: 40, band: [3.5, 30], area: 4, on: ['sage', 'wash'], scale: [0.6, 1.3], colors: 'sage' },
      { kind: 'rock', along: 4, band: [4, 40], area: 0.6, on: ['rim', 'ochre'], scale: [1.5, 5], colors: 'rock' },
    ],
    furniture: { fence: { every: 60 }, mileposts: true },
    lightsColor: ['#FFD49A', '#FFF0D6'],
  },
};

// Mt Tam: redwood groves low, serpentine grassland and chaparral high, ocean west.
BIOMES.tam = {
  ...BIOMES.bayhills,
  relief: { ...BIOMES.bayhills.relief, mountains: { amp: 260, wave: 2000, near: 300, far: 3000, bias: 0.3 }, view: 10000 },
  scatter: [
    { kind: 'redwood', along: 10, band: [5.5, 40], area: 2.4, on: ['grove'], alt: [-100, 340], scale: [30, 52], colors: 'redwood', far: true },
    ...BIOMES.bayhills.scatter,
  ],
  ground: {
    warm: { ...BIOMES.bayhills.ground.warm, grove: ['#4A5A36', '#26301E'] },
    night: { ...BIOMES.bayhills.ground.night, grove: ['#2A3528', '#18201A'] },
  },
  props: {
    warm: { ...BIOMES.bayhills.props.warm, redwood: BIOMES.redwood.props.warm.redwood, canopy: BIOMES.redwood.props.warm.canopy },
    night: { ...BIOMES.bayhills.props.night, redwood: BIOMES.redwood.props.night.redwood, canopy: BIOMES.redwood.props.night.canopy },
  },
  water: BIOMES.coast.water,
};

export const BIOME_NAMES = Object.keys(BIOMES);

// ---------------------------------------------------------------- grading

// golden = warm, a touch lighter and warmer; day = neutral daylight.
function gradePair(pair, tod) {
  if (tod === 'golden') return [mixHex(scaleHex(pair[0], 1.16), '#FFD3A0', 0.15), mixHex(scaleHex(pair[1], 1.05), '#5A4560', 0.08)];
  if (tod === 'day') return [mixHex(scaleHex(pair[0], 1.12), '#D8DCD4', 0.12), mixHex(scaleHex(pair[1], 1.25), '#6A707A', 0.18)];
  return pair;
}

function gradeTriple(t, tod) {
  if (tod === 'golden') return t.map((c, i) => mixHex(scaleHex(c, 1.08), i === 0 ? '#FFD3A0' : '#5A4560', 0.08));
  if (tod === 'day') return t.map((c) => mixHex(scaleHex(c, 1.15), '#C8CCC4', 0.1));
  return t;
}

function gradeSet(set, tod) {
  const out = {};
  for (const [k, v] of Object.entries(set)) {
    if (Array.isArray(v) && Array.isArray(v[0])) out[k] = v.map((p) => (p.length === 2 ? gradePair(p, tod) : gradeTriple(p, tod)));
    else if (Array.isArray(v) && v.length === 2) out[k] = gradePair(v, tod);
    else if (Array.isArray(v) && v.length === 3) out[k] = gradeTriple(v, tod);
    else out[k] = v;
  }
  return out;
}

function gradeHex(c, tod) {
  if (!c) return c;
  if (tod === 'golden') return mixHex(scaleHex(c, 1.08), '#FFD3A0', 0.06);
  if (tod === 'day') return mixHex(scaleHex(c, 1.12), '#C8CCC4', 0.1);
  return c;
}

// Lift a colour's value (keeping its hue) until CIE L* ≥ min.
function lstar(hex) {
  const v = parseInt(hex.slice(1), 16);
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

function atLeastL(hex, min) {
  let c = hex;
  for (let k = 1; k < 40 && lstar(c) < min; k++) c = scaleHex(hex, 1 + k * 0.04);
  return c;
}

function pick(set, tod) {
  return tod === 'night' ? set.night : set.warm;
}

// ---------------------------------------------------------------- route geometry helpers

function routeEnds(route) {
  if (!route?.x?.length) return null;
  const n = route.x.length - 1;
  let sx = 0;
  let sz = 0;
  let minX = Infinity;
  let minI = 0;
  let count = 0;
  for (let i = 0; i <= n; i += 4) {
    sx += route.x[i];
    sz += route.z[i];
    count++;
    if (route.x[i] < minX) {
      minX = route.x[i];
      minI = i;
    }
  }
  return {
    start: { x: route.x[0], z: route.z[0], y: route.elevation[0] },
    end: { x: route.x[n], z: route.z[n], y: route.elevation[n] },
    centre: { x: sx / count, z: sz / count },
    west: { x: route.x[minI], z: route.z[minI], y: route.elevation[minI], i: minI },
  };
}

// Main riding direction (compass bearing): start → end, or the first km for loops.
function mainBearing(route) {
  if (!route?.x?.length) return 0;
  const n = route.x.length - 1;
  const j = route.loop ? Math.min(n, 200) : n;
  const dx = route.x[j] - route.x[0];
  const dz = route.z[j] - route.z[0];
  if (Math.hypot(dx, dz) < 50) return 0;
  return (Math.atan2(dx, dz) * 180) / Math.PI;
}

function anchorPoint(ends, from) {
  if (!ends) return { x: 0, z: 0, y: 0 };
  return ends[from] ?? ends.start;
}

export function polar(p, bearing, dist) {
  const b = (bearing * Math.PI) / 180;
  return { x: p.x + Math.sin(b) * dist, z: p.z + Math.cos(b) * dist };
}

// Coastline that hugs a loop's seaward side: for each direction around the
// loop's centre, the sea starts `offset` metres beyond the road.
function radialCoast(route, bearing, offset) {
  const B = 72;
  let cx = 0;
  let cz = 0;
  let n = 0;
  for (let i = 0; i < route.x.length; i += 4) {
    cx += route.x[i];
    cz += route.z[i];
    n++;
  }
  cx /= n;
  cz /= n;
  const bins = new Array(B).fill(-1);
  for (let i = 0; i < route.x.length; i += 2) {
    const dx = route.x[i] - cx;
    const dz = route.z[i] - cz;
    const a = Math.atan2(dx, dz);
    const k = ((Math.round((a / (Math.PI * 2)) * B) % B) + B) % B;
    bins[k] = Math.max(bins[k], Math.hypot(dx, dz));
  }
  for (let pass = 0; pass < B; pass++) {
    let done = true;
    for (let k = 0; k < B; k++) {
      if (bins[k] >= 0) continue;
      const a = bins[(k + B - 1) % B];
      const b = bins[(k + 1) % B];
      if (a >= 0 || b >= 0) bins[k] = Math.max(a, b);
      else done = false;
    }
    if (done) break;
  }
  // smooth a little so the shore doesn't zig-zag with every bend
  const sm = bins.map((_, k) => Math.max(bins[(k + B - 1) % B], bins[k], bins[(k + 1) % B]));
  return { cx, cz, bins: sm, offset, arc: 100, bearing };
}

function oceanBearing(art) {
  const o = art.ocean;
  if (!o) return null;
  return o.from === 'west' ? 270 : o.bearing;
}

// ---------------------------------------------------------------- theme

export function themeFor(route, timeOfDay = 'golden') {
  const tod = TIMES.includes(timeOfDay) ? timeOfDay : 'golden';
  const biome = regionFor(route);
  const B = BIOMES[biome] ?? BIOMES.bayhills;
  const art = ROUTE_ART[route?.id] ?? {};
  const imported = route?.kind === 'imported' || !!route?.imported;
  const L = LIGHT[tod];
  const ends = routeEnds(route);
  const bearing = mainBearing(route);

  // Light direction (baked into facets + rider key light). Coast: moon over the sea.
  let lightBearing = bearing + L.offset;
  const ob = oceanBearing(art);
  if (ob != null && tod === 'night') lightBearing = ob;
  const sky = { ...B.sky[tod] };
  const fog = { ...B.fog[tod] };
  const ground = gradeSet(pick(B.ground, tod), tod);
  if (B.groundBy?.[tod]) Object.assign(ground, B.groundBy[tod]);
  const props = gradeSet(pick(B.props, tod), tod);
  const roadSet = pick(B.road, tod);
  const road = {
    asphalt: gradeHex(roadSet.asphalt, tod),
    edge: gradeHex(roadSet.edge, tod),
    centre: gradeHex(roadSet.centre, tod),
    centreStyle: roadSet.centreStyle ?? (roadSet.centre ? 'dash' : null),
    shoulder: gradeHex(roadSet.shoulder, tod),
    halfWidth: 2.7,
    shoulderWidth: 0.7,
    kind: 'road',
  };
  if (imported) {
    // Singletrack: 1.2 m packed earth with grass verges, no lane paint.
    Object.assign(road, {
      kind: 'trail',
      halfWidth: 0.6,
      shoulderWidth: 0.3,
      asphalt: tod === 'night' ? '#4A3E32' : gradeHex('#7A6248', tod),
      edge: null,
      centre: null,
      centreStyle: null,
      shoulder: ground.verge ? ground.verge[0] : '#6A6A4A',
    });
  }

  const skyline = pick(B.skyline, tod).map((l) => ({
    ...l,
    lit: gradeHex(l.lit, tod),
    shade: gradeHex(l.shade, tod),
    capLit: gradeHex(l.capLit, tod),
    capShade: gradeHex(l.capShade, tod),
  }));

  // Terrain shape for this route.
  const relief = B.relief;
  const terrain = {
    hillAmp: relief.hillAmp * (imported ? 0.8 : 1),
    hillWave: relief.hillWave,
    mountains: relief.mountains,
    floor: imported ? null : art.floor ?? null,
    peaks: [],
    ocean: null,
    summitCap: null,
    basins: !!relief.basins,
    mesas: !!relief.mesas,
    snowLine: art.snowLine ?? (biome === 'alpine' ? 1900 : biome === 'lakes' ? 2600 : biome === 'mesa' ? 3000 : null),
    capLine: art.capLine ?? null,
    treeLine: biome === 'alpine' ? Math.min(2150, (art.snowLine ?? 1900) + 150) : null,
  };
  if (ends) {
    for (const p of art.peaks ?? []) {
      const at = polar(anchorPoint(ends, p.from), p.bearing, p.dist);
      terrain.peaks.push({ x: at.x, z: at.z, h: p.h, r: p.r, pow: p.pow, base: art.floor ?? route.minElevation });
    }
    if (art.summitCap) terrain.summitCap = { x: ends.end.x, z: ends.end.z, y: route.maxElevation, slope: 0.3 };
    if (ob != null) {
      const o = art.ocean;
      const p = anchorPoint(ends, o.from);
      const b = (ob * Math.PI) / 180;
      const nx = Math.sin(b);
      const nz = Math.cos(b);
      // Coastline perpendicular to the bearing, `offset` metres beyond the
      // anchor and at least 70 m beyond every road sample (no flooded road).
      let c = p.x * nx + p.z * nz + o.offset;
      for (let i = 0; i < route.x.length; i += 4) c = Math.max(c, route.x[i] * nx + route.z[i] * nz + 70);
      terrain.ocean = { nx, nz, c, width: 120, depth: 30, wobble: biome === 'coast' ? 240 : 160, bearing: ob };
      if (route.loop) terrain.ocean.radial = radialCoast(route, ob, o.offset);
    }
  }

  const water = B.water ? { ...B.water[tod], level: 0 } : null;
  if (water && biome === 'lakes') water.level = (route?.minElevation ?? 0) - 5;

  const lightsOn = tod === 'night' || (tod === 'dusk' && biome !== 'redwood');
  const lights = lightsOn
    ? {
        colors: B.lightsColor ?? ['#FFD49A', '#FFF0D6'],
        strength: tod === 'night' ? 1 : 0.55,
        clusters: art.lights ?? [],
        plain: !!art.plainLights,
        city: art.cityLights ?? null,
      }
    : null;

  return {
    biome,
    routeId: route?.id ?? null,
    imported,
    timeOfDay: tod,
    bearing,
    sky: {
      // Spec §6.2: never below L* 10 at the zenith or L* 25 at the horizon.
      top: atLeastL(sky.top, 10.5),
      mid: sky.mid,
      horizon: atLeastL(sky.horizon, 25.5),
      glow: sky.glow,
      glowAmt: sky.glowAmt,
      ground: mixHex(fog.color, sky.horizon, 0.2),
      canopy: !!sky.canopy,
      stars: L.stars * (sky.canopy ? 0.15 : 1),
      moon: L.moon && !sky.canopy,
      moonColor: '#F6EAD2',
      haloColor: '#E9D9BA',
    },
    fog,
    light: {
      bearing: lightBearing,
      elevation: L.elevation,
      moonElevation: 13,
      glowBearing: tod === 'night' ? lightBearing : bearing + L.offset,
      color: L.color,
      intensity: L.intensity,
      hemiSky: L.hemiSky,
      hemiGround: L.hemiGround,
      hemi: L.hemi,
    },
    ground,
    props,
    rim: B.rim?.[tod] ?? null,
    road,
    terrain,
    view: relief.view,
    propFar: biome === 'redwood' ? [150, 300] : [520, 1500],
    skyline,
    water: terrain.ocean || biome === 'lakes' ? water : null,
    lights,
    scatter: B.scatter,
    lavender: B.lavender ?? null,
    shafts: !!B.shafts && tod !== 'day',
    furniture: {
      ...(B.furniture ?? {}),
      signs: imported ? 'trail' : art.signs ?? 'us',
      observatory: !!art.observatory,
      beacon: !!art.beacon,
      lighthouse: art.lighthouse ?? null,
      trailPosts: imported,
    },
    rider: {
      jersey: '#2A2420',
      jerseyLit: '#463B33',
      band: '#E9DFCD',
      helmet: '#ECE3D3',
      helmetShade: '#A99D8C',
      skin: '#A8705A',
      skinShade: '#6E4637',
      sock: '#E9DFCD',
      shoe: '#1A1715',
      shorts: '#1B1816',
      bike: '#1C1917',
      bikeLit: '#3B3430',
      tyre: '#0E0C0B',
      light: '#FF7A62',
      blink: tod === 'night' || tod === 'dusk' || biome === 'redwood',
    },
    camera: { height: 2.8, back: 6, lateral: -0.75 },
  };
}

export const DEFAULT_THEME = themeFor(null, 'golden');
