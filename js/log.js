// Diagnostics: a rolling log of what the devices, the trainer, the ride and
// Strava did, kept on this phone (never sent anywhere) so a ride that went
// wrong can be explained afterwards. Settings → Diagnostics shares it as a
// text file.
//
// Never log secrets: no tokens, client secret or sign-in codes.

const MAX = 3000;
const SAVE_MS = 10000;

let entries = [];
let key = null;
let timer = null;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// area: 'app' | 'ble' | 'trainer' | 'click' | 'hr' | 'ride' | 'strava' …
export function log(area, event, data) {
  const e = { t: Date.now(), a: area, e: event };
  if (data !== undefined) e.d = data;
  entries.push(e);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  if (key && !timer) {
    timer = setTimeout(flushLog, SAVE_MS);
    timer?.unref?.();
  }
}

// Keep the log across reloads under this localStorage key.
export function startLog(storageKey) {
  key = storageKey;
  try {
    const saved = JSON.parse(storage()?.getItem(key) || '[]');
    if (Array.isArray(saved)) entries = [...saved, ...entries].slice(-MAX);
  } catch {
    // a broken log is just dropped
  }
  globalThis.addEventListener?.('pagehide', flushLog);
  globalThis.document?.addEventListener?.('visibilitychange', () => document.visibilityState === 'hidden' && flushLog());
}

export function flushLog() {
  clearTimeout(timer);
  timer = null;
  if (!key) return;
  try {
    storage()?.setItem(key, JSON.stringify(entries));
  } catch {
    // storage full: keep the newer half and try once more
    entries = entries.slice(-Math.floor(MAX / 2));
    try {
      storage()?.setItem(key, JSON.stringify(entries));
    } catch {
      // give up quietly; the log is a nicety
    }
  }
}

export function clearLog() {
  entries = [];
  flushLog();
}

export const logEntries = () => entries.slice();

const pad = (n, w = 2) => String(n).padStart(w, '0');

function stamp(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// One line per event, local time: "2026-10-16 19:42:01.234  click  locked  {…}".
export function logText(header = []) {
  const lines = entries.map((e) => `${stamp(e.t)}  ${e.a.padEnd(7)} ${e.e}${e.d !== undefined ? `  ${JSON.stringify(e.d)}` : ''}`);
  return [...header, '', ...lines, ''].join('\n');
}

// Bytes as hex, for frames nothing recognised.
export const hex = (bytes) => Array.from(bytes ?? [], (b) => b.toString(16).padStart(2, '0')).join(' ');
