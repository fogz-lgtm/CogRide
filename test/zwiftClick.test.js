import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseControllerMessage, HANDSHAKE, MessageType, ZwiftClick, ZWIFT_CUSTOM_SERVICE, ASYNC_CHAR, SYNC_RX_CHAR, SYNC_TX_CHAR } from '../js/devices/zwiftClick.js';
import { FakeChar, FakeService, FakeServer } from './fakeGatt.js';

const hex = (s) => Uint8Array.from(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));
const names = (m) => [...m.pressed].sort();

test('handshake is the bare "RideOn"', () => {
  assert.deepEqual([...HANDSHAKE], [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);
  assert.deepEqual(parseControllerMessage(hex('52 69 64 65 4f 6e 02 03')), { kind: 'handshake', legacyEncryption: false, v2: true });
  const legacy = parseControllerMessage(Uint8Array.from([...HANDSHAKE, 1, 3, ...new Array(64).fill(7)]));
  assert.equal(legacy.legacyEncryption, true);
});

test('Click v1 frames (0 = pressed)', () => {
  assert.deepEqual(names(parseControllerMessage(hex('37 08 01 10 01'))), []);
  assert.deepEqual(names(parseControllerMessage(hex('37 08 00 10 01'))), ['plus']);
  assert.deepEqual(names(parseControllerMessage(hex('37 08 01 10 00'))), ['minus']);
});

test('Click v2 frames: + is 0x1000, − is 0x100, B and D-pad', () => {
  assert.deepEqual(names(parseControllerMessage(hex('23 08 ff ff ff ff 0f'))), []);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 ff df ff ff 0f'))), ['plus']);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 ff fd ff ff 0f'))), ['minus']);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 df ff ff ff 0f'))), ['b']);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 ef ff ff ff 0f'))), ['a']);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 bf ff ff ff 0f'))), ['y']);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 ff fe ff ff 0f'))), ['z']);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 fd ff ff ff 0f'))), ['up']);
  assert.deepEqual(names(parseControllerMessage(hex('23 08 f7 ff ff ff 0f'))), ['down']);
  // Ride frames with trailing analog groups still parse
  assert.deepEqual(names(parseControllerMessage(hex('23 08 fe ff ff ff 0f 1a 04 08 00 10 00'))), ['left']);
});

test('battery, lock and other frames', () => {
  assert.deepEqual(parseControllerMessage(hex('19 10 64')), { kind: 'battery', level: 100 });
  assert.equal(parseControllerMessage(hex('ff 05 00 ea 05 19 0a 0c')).kind, 'locked');
  assert.equal(parseControllerMessage(hex('ff 05 00 fa 05')).kind, 'locked');
  assert.equal(parseControllerMessage(hex('ff 03 01 02')).kind, 'vendor');
  assert.equal(parseControllerMessage(hex('15')).kind, 'empty');
  assert.equal(parseControllerMessage(hex('99 01')).kind, 'unknown');
  assert.equal(parseControllerMessage(hex('37 08')).kind, 'unknown'); // truncated
  assert.equal(parseControllerMessage(new Uint8Array()), null);
});

function fakeClickV2() {
  const asyncChar = new FakeChar(ASYNC_CHAR);
  const tx = new FakeChar(SYNC_TX_CHAR);
  const rx = new FakeChar(SYNC_RX_CHAR, {}, (data) => {
    if (data[0] === 0x52) setTimeout(() => tx.emit([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x03]), 1);
  });
  const unlock = new FakeChar('00000100-19ca-4651-86e5-fa29dcdd09d1');
  return { server: new FakeServer([new FakeService(ZWIFT_CUSTOM_SERVICE, [asyncChar, rx, tx, unlock])]), asyncChar, rx, tx };
}

test('Click v2 puck: handshake, press/release edges, B shifts down, lock resets', async () => {
  const f = fakeClickV2();
  const click = new ZwiftClick();
  const events = [];
  click.addEventListener('press', (e) => events.push(['press', e.detail.button, e.detail.shift]));
  click.addEventListener('release', (e) => events.push(['release', e.detail.button]));
  click.addEventListener('locked', () => events.push(['locked']));
  await click.setup(f.server);
  click.state = 'connected';
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(f.rx.writes[0], [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]);
  assert.deepEqual(f.rx.writes[1], [0xff, 0x04, 0x00]); // unlock ack after a v2 reply
  assert.equal(click.model, 'click-v2');

  f.asyncChar.emit([0x23, 0x08, 0xff, 0xdf, 0xff, 0xff, 0x0f]); // + down
  f.asyncChar.emit([0x23, 0x08, 0xff, 0xdf, 0xff, 0xff, 0x0f]); // repeated state: ignored
  f.asyncChar.emit([0x23, 0x08, 0xff, 0xff, 0xff, 0xff, 0x0f]); // released
  f.asyncChar.emit([0x23, 0x08, 0xdf, 0xff, 0xff, 0xff, 0x0f]); // B
  assert.deepEqual(events, [['press', 'plus', 1], ['release', 'plus'], ['press', 'b', -1]]);
  assert.equal(click.side, 'right');
  assert.equal(click.displayName, 'Click right (+)');

  f.asyncChar.emit([0xff, 0x05, 0x00, 0xea, 0x05]);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(events.at(-1), ['locked']);
  assert.deepEqual(f.rx.writes.at(-1), [0x18]); // reset
  click.disconnect();
});
