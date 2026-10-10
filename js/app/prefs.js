// Rider profile and app preferences, kept in this browser's localStorage.
// Everything is SI inside; the units preference only changes what's shown.

const KEY = 'cogride.prefs';

export const HR_ZONES_DEFAULT = [
  { min: 0, max: 121 },
  { min: 122, max: 151 },
  { min: 152, max: 161 },
  { min: 162, max: 171 },
  { min: 172, max: 220 },
];

export const DEFAULT_PREFS = {
  name: '',
  ftp: 200,
  riderKg: 75,
  heightCm: 178,
  bikeKg: 8,
  units: 'imperial',
  hrZones: HR_ZONES_DEFAULT,
  difficulty: 0.5, // Zwift's Trainer Difficulty default
  ergStepPct: 0.01, // one Click = 1 % FTP, like Zwift
  fuelEveryMin: 45,
  sound: 'normal', // normal | quiet | off
  tvSound: 'on', // on | off  (cues while a show plays)
  timeOfDay: 'auto', // auto | day | dusk | night
  autoUpload: true,
  workoutRouteId: 'fogline-coast',
  freeRouteId: 'fogline-coast',
  tvIntroSeen: false,
  ftpSource: null, // 'strava' | 'ramp' | 'manual'
  weightSource: null,
};

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPrefs() {
  try {
    const raw = storage()?.getItem(KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...DEFAULT_PREFS, ...saved };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs) {
  try {
    storage()?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // private mode: preferences last for this visit only
  }
}

export function zone2(prefs) {
  const z = prefs.hrZones?.[1] ?? HR_ZONES_DEFAULT[1];
  return { min: z.min, max: z.max };
}

export function hrZoneIndex(hr, zones = HR_ZONES_DEFAULT) {
  if (!hr) return null;
  for (let i = zones.length - 1; i >= 0; i--) if (hr >= zones[i].min) return i;
  return 0;
}

// Engine settings derived from the profile.
export function engineSettings(p) {
  return {
    ftp: p.ftp,
    riderKg: p.riderKg,
    bikeKg: p.bikeKg,
    heightCm: p.heightCm,
    difficulty: p.difficulty,
    ergStepPct: p.ergStepPct,
    fuelEveryMin: p.fuelEveryMin,
  };
}
