// Strava without a backend, the same way OnPace does it: you create your own
// free Strava API app, and its Client ID + Secret live only in this browser's
// localStorage. The browser does the OAuth exchange and token refreshes itself,
// then uploads finished rides as FIT files.

const AUTH_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API = 'https://www.strava.com/api/v3';
const KEY = 'cogride.strava';
const STATE_KEY = 'cogride.strava.state';
const QUEUE_KEY = 'cogride.strava.queue';

// Upload rides, read runs to turn into routes, read weight/FTP for physics.
export const SCOPE = 'read,activity:read_all,activity:write,profile:read_all';

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
  } catch {
    // storage unavailable; the connection just won't persist
  }
}

export function loadStrava() {
  return read(KEY, null);
}

export function saveStrava(value) {
  write(KEY, value);
}

export function isConnected(s = loadStrava()) {
  return !!(s && s.refreshToken);
}

export function canUpload(s = loadStrava()) {
  return isConnected(s) && typeof s.scope === 'string' && s.scope.split(/[ ,]+/).includes('activity:write');
}

export function redirectUri(location = globalThis.location) {
  return `${location.origin}${location.pathname}`;
}

function randomState() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Step 1: remember the app credentials and send the browser to Strava.
export function authorizeUrl({ clientId, clientSecret }, location = globalThis.location) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^\d+$/.test(id)) throw new Error('Client ID should be the number shown on your Strava API app page');
  if (secret.length < 20) throw new Error('Client Secret looks too short; copy it from your Strava API app page');
  const state = randomState();
  saveStrava({ ...(loadStrava() || {}), clientId: id, clientSecret: secret });
  write(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(location),
    response_type: 'code',
    approval_prompt: 'auto',
    scope: SCOPE,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

async function tokenRequest(params, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Strava sign-in failed (${res.status})`);
  return data;
}

// Step 2: back from Strava with ?code=…; exchange it and clean the URL.
// Returns null when the page wasn't opened by a Strava redirect.
export async function completeAuthorization(location = globalThis.location, { fetchImpl, replaceUrl } = {}) {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return null;
  const clean = () => (replaceUrl ?? ((u) => globalThis.history?.replaceState(null, '', u)))(redirectUri(location) + location.hash);
  const expected = read(STATE_KEY, null);
  write(STATE_KEY, null);
  clean();
  if (error) return { ok: false, message: 'Strava connection was cancelled.' };
  if (!expected || params.get('state') !== expected) return { ok: false, message: 'That Strava sign-in link expired. Tap Connect again.' };
  const s = loadStrava();
  if (!s?.clientId || !s?.clientSecret) return { ok: false, message: 'Strava app details are missing. Enter them and tap Connect again.' };
  try {
    const data = await tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret, code, grant_type: 'authorization_code' }, fetchImpl);
    const granted = params.get('scope') || '';
    saveStrava({
      ...s,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      scope: granted,
      athlete: data.athlete ? { id: data.athlete.id, firstName: data.athlete.firstname, lastName: data.athlete.lastname } : null,
    });
    const missing = SCOPE.split(',').filter((sc) => !granted.split(/[ ,]+/).includes(sc));
    return {
      ok: true,
      message: missing.includes('activity:write') ? 'Connected, but upload permission was unticked, so rides won’t upload. Tap Connect again and leave every box ticked.' : 'Connected to Strava.',
    };
  } catch (err) {
    return { ok: false, message: `Strava connection failed: ${err.message}` };
  }
}

export function disconnect() {
  const s = loadStrava();
  if (s) saveStrava({ clientId: s.clientId, clientSecret: s.clientSecret });
}

export async function accessToken({ fetchImpl, now = Date.now() } = {}) {
  const s = loadStrava();
  if (!isConnected(s)) throw new Error('Strava is not connected');
  if (s.accessToken && s.expiresAt > now / 1000 + 120) return s.accessToken;
  const data = await tokenRequest(
    { client_id: s.clientId, client_secret: s.clientSecret, grant_type: 'refresh_token', refresh_token: s.refreshToken },
    fetchImpl,
  );
  saveStrava({ ...s, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: data.expires_at });
  return data.access_token;
}

async function api(path, { fetchImpl = globalThis.fetch, ...init } = {}) {
  const token = await accessToken({ fetchImpl });
  const res = await fetchImpl(`${API}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Strava error ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// Weight, FTP, units and HR zones: used to size the physics and set targets.
export async function fetchAthleteProfile(opts) {
  const [athlete, zones] = await Promise.all([api('/athlete', opts), api('/athlete/zones', opts).catch(() => null)]);
  const hr = zones?.heart_rate?.zones;
  return {
    firstName: athlete.firstname || null,
    weightKg: athlete.weight || null,
    ftp: athlete.ftp || null,
    units: athlete.measurement_preference === 'meters' ? 'metric' : 'imperial',
    hrZones: Array.isArray(hr) && hr.length >= 5 ? hr.map((z) => ({ min: z.min, max: z.max })) : null,
  };
}

// Recent activities of any kind (to notice a lifting session before a ride).
export async function fetchRecentActivities({ afterS, perPage = 15 } = {}, opts) {
  const q = new URLSearchParams({ per_page: String(perPage) });
  if (afterS) q.set('after', String(Math.floor(afterS)));
  const list = await api(`/athlete/activities?${q}`, opts);
  return list.map((a) => ({
    id: String(a.id),
    name: a.name,
    sportType: a.sport_type || a.type,
    start: Date.parse(a.start_date),
    elapsedS: a.elapsed_time || 0,
  }));
}

const STRENGTH = ['WeightTraining', 'Workout', 'Crossfit', 'HighIntensityIntervalTraining'];
export const isStrength = (a) => STRENGTH.includes(a.sportType);

const RUN_LIKE = ['Run', 'TrailRun', 'Hike', 'Walk'];

// Recent outdoor runs/hikes with real climbing, to ride as routes.
export async function fetchRideableRuns(opts) {
  const list = await api('/athlete/activities?per_page=100', opts);
  return list
    .filter((a) => RUN_LIKE.includes(a.sport_type || a.type) && !a.trainer && (a.total_elevation_gain || 0) >= 30 && a.map?.summary_polyline)
    .map((a) => ({
      id: String(a.id),
      name: a.name,
      sportType: a.sport_type || a.type,
      date: a.start_date_local,
      distanceM: a.distance,
      elevationGainM: a.total_elevation_gain,
      polyline: a.map.summary_polyline,
    }));
}

export async function fetchActivityTrack(id, opts) {
  if (!/^\d+$/.test(String(id))) throw new Error('Bad activity id');
  const [activity, streams] = await Promise.all([
    api(`/activities/${id}`, opts),
    api(`/activities/${id}/streams?keys=latlng,altitude,distance&key_by_type=true`, opts),
  ]);
  const latlng = streams?.latlng?.data;
  if (!Array.isArray(latlng) || latlng.length < 2) throw new Error('This activity has no GPS track');
  const alt = streams.altitude?.data;
  return { name: activity.name, points: latlng.map(([lat, lon], i) => ({ lat, lon, ele: alt?.[i] ?? null })) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Upload a FIT file; resolves once Strava has processed it.
export async function uploadFit(bytes, { name, description, externalId } = {}, { fetchImpl = globalThis.fetch, pollMs = 1500, timeoutMs = 60000 } = {}) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), `${externalId || 'cogride'}.fit`);
  form.append('data_type', 'fit');
  form.append('trainer', '1');
  if (name) form.append('name', name);
  if (description) form.append('description', description);
  if (externalId) form.append('external_id', externalId);
  let upload = await api('/uploads', { method: 'POST', body: form, fetchImpl });
  const started = Date.now();
  while (!upload.activity_id && !upload.error && Date.now() - started < timeoutMs) {
    await sleep(pollMs);
    upload = await api(`/uploads/${upload.id_str || upload.id}`, { fetchImpl });
  }
  if (upload.error) {
    const dup = /duplicate of (?:activity\s+|<a href='\/activities\/)?(\d+)/i.exec(upload.error);
    if (dup) return { activityId: dup[1], duplicate: true };
    throw new Error(upload.error);
  }
  if (!upload.activity_id) throw new Error('Strava is still processing the ride; it will appear shortly.');
  return { activityId: String(upload.activity_id), duplicate: false };
}

export function activityUrl(id) {
  return `https://www.strava.com/activities/${id}`;
}

// ---------------------------------------------------------------- offline queue

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Rides that couldn't upload (offline, Strava down) wait here for the next try.
export function queueUpload(bytes, meta) {
  const queue = read(QUEUE_KEY, []).filter((item) => !meta?.externalId || item.meta?.externalId !== meta.externalId);
  queue.push({ fit: toBase64(bytes), meta, queuedAt: Date.now() });
  write(QUEUE_KEY, queue.slice(-10));
}

export function removeQueued(externalId) {
  write(
    QUEUE_KEY,
    read(QUEUE_KEY, []).filter((item) => item.meta?.externalId !== externalId),
  );
}

export function pendingUploads() {
  return read(QUEUE_KEY, []).length;
}

let flushing = null;

export function flushUploadQueue(opts) {
  flushing ??= flush(opts).finally(() => (flushing = null));
  return flushing;
}

async function flush(opts) {
  if (!canUpload()) return [];
  const queue = read(QUEUE_KEY, []);
  const done = [];
  for (const item of queue) {
    try {
      done.push({ ...(await uploadFit(fromBase64(item.fit), item.meta, opts)), externalId: item.meta?.externalId });
      // Re-read: rides may have been queued while this one uploaded.
      write(
        QUEUE_KEY,
        read(QUEUE_KEY, []).filter((q) => q.queuedAt !== item.queuedAt || q.meta?.externalId !== item.meta?.externalId),
      );
    } catch {
      // stays queued for next time
    }
  }
  return done;
}
