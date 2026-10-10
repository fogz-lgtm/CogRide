import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseControllerMessage, HANDSHAKE, MessageType } from '../js/devices/zwiftClick.js';
import { decodeVarint } from '../js/protobuf.js';

const msg = (...bytes) => Uint8Array.from(bytes);

test('handshake is "RideOn" + start request', () => {
  assert.deepEqual([...HANDSHAKE], [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x00, 0x09]);
  assert.equal(parseControllerMessage(HANDSHAKE).kind, 'handshake');
});

test('Click: 0 means pressed, 1 means released', () => {
  // field 1 (plus) = 0, field 2 (minus) = 1
  assert.deepEqual([...parseControllerMessage(msg(MessageType.CLICK, 0x08, 0x00, 0x10, 0x01)).pressed], ['shiftUp']);
  assert.deepEqual([...parseControllerMessage(msg(MessageType.CLICK, 0x08, 0x01, 0x10, 0x00)).pressed], ['shiftDown']);
  assert.equal(parseControllerMessage(msg(MessageType.CLICK, 0x08, 0x01, 0x10, 0x01)).pressed.size, 0);
});

test('Ride bitmap: cleared bit means pressed', () => {
  // all buttons released except right shift-up (0x2000)
  const map = 0x3ffff & ~0x2000;
  const varint = [];
  for (let v = map; ; v = Math.floor(v / 128)) {
    if (v < 128) { varint.push(v); break; }
    varint.push((v & 0x7f) | 0x80);
  }
  assert.deepEqual(decodeVarint(Uint8Array.from(varint), 0)[0], map);
  const result = parseControllerMessage(msg(MessageType.RIDE, 0x08, ...varint));
  assert.deepEqual([...result.pressed], ['shiftUp']);
});

test('Play: shift on right pad shifts up, left pad shifts down', () => {
  const right = parseControllerMessage(msg(MessageType.PLAY, 0x08, 0x00, 0x10, 1, 0x18, 1, 0x20, 1, 0x28, 1, 0x30, 0x00));
  assert.ok(right.pressed.has('shiftUp'));
  const left = parseControllerMessage(msg(MessageType.PLAY, 0x08, 0x01, 0x10, 1, 0x18, 1, 0x20, 1, 0x28, 1, 0x30, 0x00));
  assert.ok(left.pressed.has('shiftDown'));
});

test('battery and junk messages', () => {
  assert.deepEqual(parseControllerMessage(msg(MessageType.BATTERY, 87)), { kind: 'battery', level: 87 });
  assert.equal(parseControllerMessage(msg(0x99, 1, 2)).kind, 'unknown');
  assert.equal(parseControllerMessage(msg(MessageType.CLICK, 0x08)).kind, 'unknown'); // truncated
  assert.equal(parseControllerMessage(msg()), null);
});
