import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const L = await import('../js/log.js');

test('keeps a rolling window, survives a reload, and reads as text', () => {
  L.startLog('test.log');
  L.clearLog();
  for (let i = 0; i < 3100; i++) L.log('ride', 'tick', { i });
  const entries = L.logEntries();
  assert.equal(entries.length, 3000);
  assert.equal(entries[0].d.i, 100); // oldest dropped first
  L.flushLog();
  assert.equal(JSON.parse(store.get('test.log')).length, 3000);

  L.log('click', 'lock frame', { side: 'right', hex: L.hex([0xff, 0x05, 0x00, 0xea, 0x05]) });
  const text = L.logText(['CogRide diagnostics']);
  assert.match(text.split('\n')[0], /^CogRide diagnostics$/);
  assert.match(text, /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}  click\s+lock frame  \{"side":"right","hex":"ff 05 00 ea 05"\}/);
});

test('the log never holds Strava secrets', async () => {
  L.clearLog();
  const S = await import('../js/services/strava.js');
  const SECRET = 'abcdef0123456789abcdef0123456789abcdef01';
  const location = { origin: 'https://fogz-lgtm.github.io', pathname: '/CogRide/', search: '', hash: '' };
  const url = new URL(S.authorizeUrl({ clientId: '12345', clientSecret: SECRET }, location));
  const fetchImpl = async (u, init) => {
    const body = u.includes('oauth/token')
      ? JSON.parse(init.body).grant_type === 'refresh_token'
        ? { access_token: 'ACCESS-two-xyz', refresh_token: 'REFRESH-two-xyz', expires_at: 2e9 }
        : { access_token: 'ACCESS-one-xyz', refresh_token: 'REFRESH-one-xyz', expires_at: 100, athlete: { id: 9 } }
      : {};
    return { ok: true, status: 200, json: async () => body };
  };
  const back = { ...location, search: `?state=${url.searchParams.get('state')}&code=CODE-xyz&scope=read,activity:write` };
  await S.completeAuthorization(back, { fetchImpl, replaceUrl: () => {} });
  await S.accessToken({ fetchImpl });
  const all = JSON.stringify(L.logEntries());
  assert.match(all, /connected/);
  assert.match(all, /token renewed/);
  for (const secret of [SECRET, 'CODE-xyz', 'ACCESS-one-xyz', 'REFRESH-one-xyz', 'ACCESS-two-xyz', 'REFRESH-two-xyz']) assert.ok(!all.includes(secret), `log holds ${secret}`);
});
