import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage for Node.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const S = await import('../js/services/strava.js');

const location = { origin: 'https://fogz-lgtm.github.io', pathname: '/CogRide/', search: '', hash: '' };
const SECRET = 'abcdef0123456789abcdef0123456789abcdef01';

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    const { status = 200, body = {} } = (await handler(url, init, calls.length)) || {};
    return { ok: status < 400, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

beforeEach(() => store.clear());

test('authorize URL carries scopes, redirect and a state', () => {
  const url = new URL(S.authorizeUrl({ clientId: '12345', clientSecret: SECRET }, location));
  assert.equal(url.origin + url.pathname, 'https://www.strava.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), '12345');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://fogz-lgtm.github.io/CogRide/');
  assert.equal(url.searchParams.get('scope'), 'read,activity:read_all,activity:write,profile:read_all');
  assert.match(url.searchParams.get('state'), /^[0-9a-f]{32}$/);
  assert.throws(() => S.authorizeUrl({ clientId: 'abc', clientSecret: SECRET }, location), /Client ID/);
  assert.throws(() => S.authorizeUrl({ clientId: '1', clientSecret: 'short' }, location), /Secret/);
});

test('completing the redirect exchanges the code and stores tokens', async () => {
  const url = new URL(S.authorizeUrl({ clientId: '12345', clientSecret: SECRET }, location));
  const state = url.searchParams.get('state');
  const fetchImpl = fakeFetch(() => ({ body: { access_token: 'A1', refresh_token: 'R1', expires_at: 2e9, athlete: { id: 9, firstname: 'Patrick' } } }));
  let replaced = null;
  const back = { ...location, search: `?state=${state}&code=CODE&scope=read,activity:read_all,activity:write,profile:read_all` };
  const result = await S.completeAuthorization(back, { fetchImpl, replaceUrl: (u) => (replaced = u) });
  assert.equal(result.ok, true);
  assert.equal(replaced, 'https://fogz-lgtm.github.io/CogRide/');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.deepEqual(body, { client_id: '12345', client_secret: SECRET, code: 'CODE', grant_type: 'authorization_code' });
  assert.equal(S.isConnected(), true);
  assert.equal(S.canUpload(), true);
  assert.equal(S.loadStrava().athlete.firstName, 'Patrick');
});

test('rejects a mismatched state and warns about missing upload scope', async () => {
  S.authorizeUrl({ clientId: '12345', clientSecret: SECRET }, location);
  const bad = await S.completeAuthorization({ ...location, search: '?state=nope&code=X' }, { replaceUrl: () => {} });
  assert.equal(bad.ok, false);
  const url = new URL(S.authorizeUrl({ clientId: '12345', clientSecret: SECRET }, location));
  const fetchImpl = fakeFetch(() => ({ body: { access_token: 'A', refresh_token: 'R', expires_at: 2e9 } }));
  const partial = await S.completeAuthorization(
    { ...location, search: `?state=${url.searchParams.get('state')}&code=C&scope=read,activity:read_all` },
    { fetchImpl, replaceUrl: () => {} },
  );
  assert.equal(partial.ok, true);
  assert.match(partial.message, /upload permission/);
  assert.equal(S.canUpload(), false);
  assert.equal(await S.completeAuthorization(location), null);
});

test('refreshes an expired token before calling the API', async () => {
  S.saveStrava({ clientId: '1', clientSecret: SECRET, accessToken: 'old', refreshToken: 'R', expiresAt: 100, scope: 'activity:write' });
  const fetchImpl = fakeFetch((url) => (url.includes('oauth/token') ? { body: { access_token: 'new', refresh_token: 'R2', expires_at: 2e9 } } : null));
  assert.equal(await S.accessToken({ fetchImpl }), 'new');
  assert.equal(S.loadStrava().refreshToken, 'R2');
  assert.equal(await S.accessToken({ fetchImpl }), 'new'); // cached now
  assert.equal(fetchImpl.calls.length, 1);
});

test('uploads a FIT and waits for processing; duplicates resolve', async () => {
  S.saveStrava({ clientId: '1', clientSecret: SECRET, accessToken: 'T', refreshToken: 'R', expiresAt: 2e9, scope: 'read,activity:write' });
  const fetchImpl = fakeFetch((url, init, n) => {
    if (n === 1) return { status: 201, body: { id: 5, id_str: '5' } };
    if (n === 2) return { body: { id: 5, id_str: '5' } };
    return { body: { id: 5, id_str: '5', activity_id: 777 } };
  });
  const r = await S.uploadFit(new Uint8Array([1, 2, 3]), { name: 'Zone 2', externalId: 'cogride-1' }, { fetchImpl, pollMs: 1 });
  assert.deepEqual(r, { activityId: '777', duplicate: false });
  const first = fetchImpl.calls[0];
  assert.equal(first.url, 'https://www.strava.com/api/v3/uploads');
  assert.equal(first.init.headers.Authorization, 'Bearer T');
  assert.equal(first.init.body.get('data_type'), 'fit');
  assert.equal(first.init.body.get('trainer'), '1');

  const dupFetch = fakeFetch((url, init, n) =>
    n === 1 ? { status: 201, body: { id: 6, id_str: '6' } } : { body: { id: 6, error: "x.fit duplicate of <a href='/activities/123'>Ride</a>" } },
  );
  assert.deepEqual(await S.uploadFit(new Uint8Array([1]), {}, { fetchImpl: dupFetch, pollMs: 1 }), { activityId: '123', duplicate: true });
});

test('failed uploads queue and flush later', async () => {
  S.saveStrava({ clientId: '1', clientSecret: SECRET, accessToken: 'T', refreshToken: 'R', expiresAt: 2e9, scope: 'activity:write' });
  S.queueUpload(new Uint8Array(70000).fill(7), { name: 'Queued ride' });
  assert.equal(S.pendingUploads(), 1);
  const fetchImpl = fakeFetch((url, init, n) => (n === 1 ? { status: 201, body: { id: 1, id_str: '1', activity_id: 42 } } : null));
  const done = await S.flushUploadQueue({ fetchImpl, pollMs: 1 });
  assert.equal(done[0].activityId, '42');
  assert.equal(fetchImpl.calls[0].init.body.get('name'), 'Queued ride');
  const sent = new Uint8Array(await fetchImpl.calls[0].init.body.get('file').arrayBuffer());
  assert.equal(sent.length, 70000);
  assert.equal(sent[69999], 7);
  assert.equal(S.pendingUploads(), 0);
});

test('athlete profile maps weight, FTP, units and HR zones', async () => {
  S.saveStrava({ clientId: '1', clientSecret: SECRET, accessToken: 'T', refreshToken: 'R', expiresAt: 2e9, scope: '' });
  const fetchImpl = fakeFetch((url) =>
    url.endsWith('/athlete')
      ? { body: { firstname: 'Patrick', weight: 72.57, ftp: 161, measurement_preference: 'feet' } }
      : { body: { heart_rate: { zones: [{ min: 0, max: 121 }, { min: 122, max: 151 }, { min: 152, max: 166 }, { min: 167, max: 180 }, { min: 181, max: -1 }] } } },
  );
  const p = await S.fetchAthleteProfile({ fetchImpl });
  assert.equal(p.units, 'imperial');
  assert.equal(p.ftp, 161);
  assert.equal(p.hrZones[1].max, 151);
});

test('duplicate uploads are recognised in either wording', async () => {
  S.saveStrava({ clientId: '1', clientSecret: SECRET, accessToken: 'T', refreshToken: 'R', expiresAt: 2e9, scope: 'activity:write' });
  const f = fakeFetch((url, init, n) => (n === 1 ? { status: 201, body: { id: 7, id_str: '7' } } : { body: { id: 7, error: 'ride.fit duplicate of activity 987654' } }));
  assert.deepEqual(await S.uploadFit(new Uint8Array([1]), {}, { fetchImpl: f, pollMs: 1 }), { activityId: '987654', duplicate: true });
});

test('queue: re-queueing a ride replaces it; removeQueued drops it; flush keeps rides queued meanwhile', async () => {
  S.saveStrava({ clientId: '1', clientSecret: SECRET, accessToken: 'T', refreshToken: 'R', expiresAt: 2e9, scope: 'activity:write' });
  S.queueUpload(new Uint8Array([1]), { name: 'A', externalId: 'a' });
  S.queueUpload(new Uint8Array([2]), { name: 'A again', externalId: 'a' });
  assert.equal(S.pendingUploads(), 1);
  S.removeQueued('a');
  assert.equal(S.pendingUploads(), 0);
  S.queueUpload(new Uint8Array([3]), { name: 'B', externalId: 'b' });
  let queuedDuringFlush = false;
  const f = fakeFetch(() => {
    if (!queuedDuringFlush) {
      queuedDuringFlush = true;
      S.queueUpload(new Uint8Array([4]), { name: 'C', externalId: 'c' });
    }
    return { status: 201, body: { id: 1, id_str: '1', activity_id: 5 } };
  });
  await S.flushUploadQueue({ fetchImpl: f, pollMs: 1 });
  // B uploaded and removed; C (queued mid-flush) is still waiting.
  assert.equal(S.pendingUploads(), 1);
});
