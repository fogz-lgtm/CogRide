// localStorage wrappers that never throw (private windows, blocked storage).

const SETTINGS_KEY = 'cogride.settings';
const WORKOUTS_KEY = 'cogride.customWorkouts';

export const DEFAULT_SETTINGS = { ftp: 200, riderKg: 70, bikeKg: 9, ergShiftStep: 0.02 };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore: settings just won't persist
  }
}

export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) });
export const saveSettings = (settings) => write(SETTINGS_KEY, settings);
export const loadCustomWorkouts = () => read(WORKOUTS_KEY, []);
export const saveCustomWorkouts = (workouts) => write(WORKOUTS_KEY, workouts);
