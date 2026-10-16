// Strava without a backend, the same way OnPace does it: you create your own
// free Strava API app, and its Client ID + Secret live only in this browser's
// localStorage. The browser does the OAuth exchange and token refreshes itself,
// then uploads finished rides as FIT files.

const AUTH_URL = 'https://www.strava.com/oauth/authorize';
const TOKEN_URL = 'https://www.strava.com/oauth/token';
const API = 'https://www.strava.com/api/v3';
// Shared by CogRide and FluxRide on one phone (same site): connect once.
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

// Strava turned the saved sign-in down (revoked, replaced, or a permission
// unticked since): it needs a fresh sign-in, not retries.
export function needsReconnect(s = loadStrava()) {
  return isConnected(s) && !!s.needsReconnect;
}

function markSignIn(ok) {
  const s = loadStrava();
  if (s && !!s.needsReconnect === ok) saveStrava({ ...s, needsReconnect: !ok });
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
// force shows Strava's permission page again even if it was approved before.
export function authorizeUrl({ clientId, clientSecret }, location = globalThis.location, { force = false } = {}) {
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
    approval_prompt: force ? 'force' : 'auto',
    scope: SCOPE,
    state,
  });
  return `${AUTH_URL}?${params}`;
}

// Sign in again with the app details already saved here.
export function reconnectUrl(location = globalThis.location) {
  const s = loadStrava() || {};
  return authorizeUrl({ clientId: s.clientId, clientSecret: s.clientSecret }, location, { force: true });
}

async function tokenRequest(params, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Strava sign-in failed (${res.status})`);
    err.status = res.status;
    // A refused refresh token or app secret: retrying won't help.
    err.auth = res.status === 400 || res.status === 401;
    throw err;
  }
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
  const stale = !expected || params.get('state') !== expected;
  // An old sign-in link (a bookmark, a restored tab, a second load): when
  // Strava is already connected there's nothing to say.
  if (stale && isConnected()) return null;
  if (error) return { ok: false, message: 'Strava connection was cancelled.' };
  if (stale) return { ok: false, message: 'That Strava sign-in link expired. Tap Connect again.' };
  const s = loadStrava();
  if (!s?.clientId || !s?.clientSecret) return { ok: false, message: 'Strava app details are missing. Enter them and tap Connect again.' };
  try {
    const data = await tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret, code, grant_type: 'authorization_code' }, fetchImpl);
    const granted = params.get('scope') || '';
    const next = {
      ...s,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: data.expires_at,
      scope: granted,
      needsReconnect: false,
      athlete: data.athlete ? { id: data.athlete.id, firstName: data.athlete.firstname, lastName: data.athlete.lastname } : null,
    };
    saveStrava(next);
    // A new sign-in can retire OnPace's tokens for the same Strava app: hand it these.
    sharePeerTokens(next);
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

// ---------------------------------------------------------------- tokens
//
// Strava keeps one set of tokens per API app and athlete, and the refresh
// token can change whenever a new access token is issued. Everything that
// shares the sign-in has to stay on the newest tokens:
//  - this page: one refresh at a time (opening the app asks for several things at once);
//  - other tabs (CogRide and FluxRide): a lock, and a re-read before giving up;
//  - OnPace, on the same site and usually the same Strava app: it gets our
//    new tokens, and its copy is the fallback if ours are refused.

const PEERS = ['onpace:strava'];

// Same Strava app and, when both know it, the same athlete (OnPace keeps a name).
function samePeer(p, s) {
  if (!p?.refreshToken || !s?.clientId || String(p.clientId) !== String(s.clientId)) return false;
  const ours = s.athlete ? `${s.athlete.firstName ?? ''} ${s.athlete.lastName ?? ''}`.trim().toLowerCase() : '';
  const theirs = typeof p.athlete === 'string' ? p.athlete.trim().toLowerCase() : '';
  return !ours || !theirs || ours === theirs;
}

// A peer's sign-in to fall back on when ours is refused. (Only then: OnPace
// asks Strava for read-only access, so its tokens may not upload rides.)
function peerTokens(s, refused) {
  for (const key of PEERS) {
    const p = read(key, null);
    if (samePeer(p, s) && p.refreshToken !== refused) return { accessToken: p.accessToken, refreshToken: p.refreshToken, expiresAt: p.expiresAt };
  }
  return null;
}

// Give peers our tokens when they're newer than theirs.
function sharePeerTokens(s) {
  for (const key of PEERS) {
    const p = read(key, null);
    if (samePeer(p, s) && (s.expiresAt || 0) >= (p.expiresAt || 0)) write(key, { ...p, accessToken: s.accessToken, refreshToken: s.refreshToken, expiresAt: s.expiresAt });
  }
}

function withLock(fn) {
  const locks = globalThis.navigator?.locks;
  return locks?.request ? locks.request('cogride-strava-token', fn) : fn();
}

const fresh = (s, now, rejected) => !!(s.accessToken && s.accessToken !== rejected && s.expiresAt > now / 1000 + 120);

let refreshing = null;

// A working access token. `rejected`: one Strava just turned down.
export async function accessToken({ fetchImpl, now = Date.now(), rejected = null } = {}) {
  const s = loadStrava();
  if (!isConnected(s)) throw new Error('Strava is not connected');
  if (fresh(s, now, rejected)) return s.accessToken;
  refreshing ??= withLock(() => refresh(fetchImpl, rejected)).finally(() => (refreshing = null));
  return refreshing;
}

function keep(tokens) {
  const next = { ...loadStrava(), ...tokens };
  saveStrava(next);
  sharePeerTokens(next);
  return next.accessToken;
}

const refreshWith = (s, refreshToken, fetchImpl) =>
  tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl).then((d) =>
    keep({ accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: d.expires_at }),
  );

async function refresh(fetchImpl, rejected) {
  // Another tab may have refreshed while this one waited.
  const s = loadStrava();
  if (fresh(s, Date.now(), rejected)) return s.accessToken;
  const used = s.refreshToken;
  try {
    return await refreshWith(s, used, fetchImpl);
  } catch (err) {
    if (!err.auth) throw err;
    // Refused because another tab just refreshed with the same token? Its
    // new tokens are saved already.
    const now = loadStrava();
    if (now.refreshToken !== used && fresh(now, Date.now(), rejected)) return now.accessToken;
    // Or OnPace refreshed the shared sign-in: carry on from its copy.
    const peer = peerTokens(now, used);
    if (peer) {
      if (fresh(peer, Date.now(), rejected)) return keep(peer);
      try {
        return await refreshWith(now, peer.refreshToken, fetchImpl);
      } catch {
        // fall through: really signed out
      }
    }
    markSignIn(false);
    throw err;
  }
}

async function api(path, { fetchImpl = globalThis.fetch, ...init } = {}) {
  let rejected = null;
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken({ fetchImpl, rejected });
    const res = await fetchImpl(`${API}${path}`, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    const err = new Error(data.message || `Strava error ${res.status}`);
    err.status = res.status;
    err.body = data;
    // 401: the token was replaced (another app or tab refreshed), the
    // sign-in was revoked, or it lacks a permission. A missing read
    // permission only costs that one feature (HR zones, say).
    err.auth = res.status === 401;
    const missing = (Array.isArray(data.errors) ? data.errors : []).find((e) => e?.code === 'missing')?.field;
    // A replaced token: get the current one and try once more.
    if (err.auth && !missing && attempt === 0) {
      rejected = token;
      continue;
    }
    if (err.auth && !(missing && !/write/.test(missing))) markSignIn(false);
    throw err;
  }
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
    movingS: a.moving_time || 0,
    distanceM: a.distance || 0,
    elevM: a.total_elevation_gain || 0,
    sufferScore: a.suffer_score ?? null,
    trainer: !!a.trainer,
  }));
}

// ---------------------------------------------------------------- segments

// "https://www.strava.com/segments/229781", "strava.com/segments/229781?x" or "229781".
export function parseSegmentId(text) {
  const s = String(text || '').trim();
  // strava.com/activities/123/segments/456 is one effort on an activity, not the segment.
  if (/activities\/\d+\/segments/.test(s)) return null;
  const m = s.match(/segments\/(\d+)/) || s.match(/^(\d{3,})$/);
  return m ? m[1] : null;
}

export async function fetchStarredSegments(opts) {
  const list = await api('/segments/starred?per_page=100', opts);
  return list.map((s) => ({
    id: String(s.id),
    name: s.name,
    activityType: s.activity_type,
    distanceM: s.distance,
    averageGrade: s.average_grade,
    elevM: Math.max(0, (s.elevation_high ?? 0) - (s.elevation_low ?? 0)),
    place: [s.city, s.state].filter(Boolean).join(', '),
  }));
}

// A segment's real road and elevation, to ride as a route.
export async function fetchSegmentTrack(id, opts) {
  if (!/^\d+$/.test(String(id))) throw new Error('That isn’t a Strava segment link');
  const [segment, streams] = await Promise.all([
    api(`/segments/${id}`, opts),
    api(`/segments/${id}/streams?keys=latlng,altitude,distance&key_by_type=true`, opts),
  ]);
  const latlng = streams?.latlng?.data;
  if (!Array.isArray(latlng) || latlng.length < 2) throw new Error('This segment has no track');
  const alt = streams.altitude?.data;
  return { name: segment.name, points: latlng.map(([lat, lon], i) => ({ lat, lon, ele: alt?.[i] ?? null })) };
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
  form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), `${externalId || 'ride'}.fit`);
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
    if (dup) {
      markSignIn(true);
      return { activityId: dup[1], duplicate: true };
    }
    throw new Error(upload.error);
  }
  if (!upload.activity_id) throw new Error('Strava is still processing the ride; it will appear shortly.');
  markSignIn(true);
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
