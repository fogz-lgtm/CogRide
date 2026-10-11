// Ride history (summaries only) and a rolling checkpoint of the ride in
// progress, so a reload or a crash in the middle of a ride loses nothing.

import { storeKey } from '../variant.js';

const HISTORY_KEY = storeKey('history');
const CHECKPOINT_KEY = storeKey('checkpoint');
const WORKOUTS_KEY = storeKey('workouts');

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function read(key, fallback) {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    if (value == null) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadHistory() {
  return read(HISTORY_KEY, []);
}

export function addHistory(entry) {
  const list = loadHistory().filter((e) => e.id !== entry.id);
  list.unshift(entry);
  write(HISTORY_KEY, list.slice(0, 60));
}

export function updateHistory(id, patch) {
  write(
    HISTORY_KEY,
    loadHistory().map((e) => (e.id === id ? { ...e, ...patch } : e)),
  );
}

// Samples packed as arrays to keep an hour's ride well under storage limits.
const FIELDS = ['time', 'power', 'cadence', 'heartRate', 'speed', 'distance', 'altitude', 'grade', 'lat', 'lon'];
const round = (v, k) => (v == null ? null : Math.round(v * k) / k);

export function packSamples(samples) {
  return samples.map((s) => [s.time, s.power, s.cadence, s.heartRate, round(s.speed, 100), round(s.distance, 10), round(s.altitude, 10), round(s.grade, 10), round(s.lat, 1e6), round(s.lon, 1e6)]);
}

export function unpackSamples(rows) {
  return rows.map((r) => Object.fromEntries(FIELDS.map((f, i) => [f, r[i] ?? null])));
}

export function saveCheckpoint(meta, samples) {
  return write(CHECKPOINT_KEY, { meta, savedAt: Date.now(), samples: packSamples(samples) });
}

export function loadCheckpoint(maxAgeMs = 24 * 3600 * 1000) {
  const cp = read(CHECKPOINT_KEY, null);
  if (!cp || !Array.isArray(cp.samples) || cp.samples.length < 60) return null;
  if (Date.now() - cp.savedAt > maxAgeMs) return null;
  return { meta: cp.meta, savedAt: cp.savedAt, samples: unpackSamples(cp.samples) };
}

export function clearCheckpoint() {
  write(CHECKPOINT_KEY, null);
}

// Workouts you wrote or imported.
export function loadCustomWorkouts() {
  return read(WORKOUTS_KEY, []);
}

export function saveCustomWorkouts(list) {
  write(WORKOUTS_KEY, list);
}

// ---------------------------------------------------------------- bests

const BESTS_KEY = storeKey('bests');
const POWER_KEY = storeKey('powerBests');

// Your best time over each road: { [routeId]: { timeS, splits, at } }.
export function loadBest(routeId) {
  return routeId ? read(BESTS_KEY, {})[routeId] ?? null : null;
}

export function saveBest(routeId, best) {
  if (!routeId) return;
  const all = read(BESTS_KEY, {});
  all[routeId] = best;
  write(BESTS_KEY, all);
}

export function loadPowerBests() {
  return read(POWER_KEY, {});
}

export function savePowerBests(bests) {
  write(POWER_KEY, bests);
}
