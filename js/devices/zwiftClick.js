// Zwift Click (and Zwift Play / Ride) controller protocol.
//
// The controllers expose a custom service with three characteristics:
//   async  (notify)   – button state messages
//   syncRx (write)    – we send the "RideOn" handshake here
//   syncTx (indicate) – handshake replies and other sync messages
// After writing "RideOn" + start request, the controller streams unencrypted
// messages: one type byte followed by a protobuf body. Button fields use
// ON = 0 / OFF = 1, i.e. 0 means pressed.

import { BleDevice, writeCharacteristic } from './bleDevice.js';
import { decodeFields, firstField } from '../protobuf.js';

export const ZWIFT_MANUFACTURER_ID = 0x094a;
export const ZWIFT_CUSTOM_SERVICE = '00000001-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_FC82_SERVICE = '0000fc82-0000-1000-8000-00805f9b34fb';
export const ASYNC_CHAR = '00000002-19ca-4651-86e5-fa29dcdd09d1';
export const SYNC_RX_CHAR = '00000003-19ca-4651-86e5-fa29dcdd09d1';
export const SYNC_TX_CHAR = '00000004-19ca-4651-86e5-fa29dcdd09d1';

export const RIDE_ON = [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]; // "RideOn"
export const REQUEST_START = [0x00, 0x09];
export const HANDSHAKE = Uint8Array.from([...RIDE_ON, ...REQUEST_START]);

export const MessageType = { PLAY: 0x07, EMPTY: 0x15, BATTERY: 0x19, RIDE: 0x23, CLICK: 0x37 };

// Zwift Ride button bitmap (bit cleared = pressed). Newer Click firmware also uses it.
const RIDE_BUTTONS = [
  ['left', 0x1],
  ['up', 0x2],
  ['right', 0x4],
  ['down', 0x8],
  ['a', 0x10],
  ['b', 0x20],
  ['y', 0x40],
  ['z', 0x100],
  ['shiftUp', 0x200], // left shift-up paddle
  ['shiftDown', 0x400], // left shift-down paddle
  ['powerUpLeft', 0x800],
  ['onOffLeft', 0x1000],
  ['shiftUp', 0x2000], // right shift-up paddle
  ['shiftDown', 0x4000], // right shift-down paddle
  ['powerUpRight', 0x10000],
  ['onOffRight', 0x20000],
];

const isPressed = (value) => (value ?? 0) === 0;

function startsWith(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

export function parseControllerMessage(bytes) {
  if (!bytes.length) return null;
  if (startsWith(bytes, RIDE_ON)) return { kind: 'handshake' };
  const type = bytes[0];
  const body = bytes.subarray(1);
  try {
    switch (type) {
      case MessageType.CLICK: {
        const pressed = new Set();
        if (!body.length) return { kind: 'buttons', pressed };
        const f = decodeFields(body);
        if (isPressed(firstField(f, 1))) pressed.add('shiftUp');
        if (isPressed(firstField(f, 2))) pressed.add('shiftDown');
        return { kind: 'buttons', pressed };
      }
      case MessageType.RIDE: {
        const pressed = new Set();
        const map = firstField(decodeFields(body), 1);
        if (typeof map !== 'number') return { kind: 'buttons', pressed };
        for (const [name, mask] of RIDE_BUTTONS) if ((map & mask) === 0) pressed.add(name);
        return { kind: 'buttons', pressed };
      }
      case MessageType.PLAY: {
        const pressed = new Set();
        if (!body.length) return { kind: 'buttons', pressed };
        const f = decodeFields(body);
        const rightPad = isPressed(firstField(f, 1));
        const named = rightPad
          ? [[2, 'y'], [3, 'z'], [4, 'a'], [5, 'b']]
          : [[2, 'up'], [3, 'left'], [4, 'right'], [5, 'down']];
        for (const [field, name] of named) if (isPressed(firstField(f, field))) pressed.add(name);
        if (isPressed(firstField(f, 6))) pressed.add(rightPad ? 'shiftUp' : 'shiftDown');
        return { kind: 'buttons', pressed };
      }
      case MessageType.BATTERY:
        return { kind: 'battery', level: bytes[1] };
      case MessageType.EMPTY:
        return { kind: 'empty' };
      default:
        return { kind: 'unknown', type };
    }
  } catch {
    return { kind: 'unknown', type };
  }
}

export class ZwiftClick extends BleDevice {
  constructor() {
    super('Click');
    this.pressed = new Set();
    this.battery = null;
  }

  requestOptions() {
    return {
      filters: [{ manufacturerData: [{ companyIdentifier: ZWIFT_MANUFACTURER_ID }] }, { namePrefix: 'Zwift Click' }, { namePrefix: 'Zwift Play' }, { namePrefix: 'Zwift Ride' }],
      optionalServices: [ZWIFT_CUSTOM_SERVICE, ZWIFT_FC82_SERVICE, 'battery_service'],
    };
  }

  async setup(server) {
    let service = null;
    for (const uuid of [ZWIFT_CUSTOM_SERVICE, ZWIFT_FC82_SERVICE]) {
      try {
        service = await server.getPrimaryService(uuid);
        break;
      } catch {
        // try the next one
      }
    }
    if (!service) throw new Error("This doesn't look like a Zwift controller (no Zwift service found).");

    const chars = await service.getCharacteristics();
    const byUuid = (uuid) => chars.find((c) => c.uuid === uuid);
    const asyncChar = byUuid(ASYNC_CHAR) ?? chars.find((c) => c.properties.notify);
    const syncRx = byUuid(SYNC_RX_CHAR) ?? chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    const syncTx = byUuid(SYNC_TX_CHAR) ?? chars.find((c) => c.properties.indicate);
    if (!asyncChar || !syncRx) throw new Error('Zwift controller characteristics not found.');

    const onValue = (event) => this.handleMessage(event.target.value);
    asyncChar.oncharacteristicvaluechanged = onValue;
    await asyncChar.startNotifications();
    if (syncTx) {
      syncTx.oncharacteristicvaluechanged = onValue;
      await syncTx.startNotifications();
    }
    this.pressed = new Set();
    await writeCharacteristic(syncRx, HANDSHAKE, { preferWithoutResponse: true });
    this.readBattery(server);
  }

  async readBattery(server) {
    try {
      const svc = await server.getPrimaryService('battery_service');
      const level = await svc.getCharacteristic('battery_level');
      this.battery = (await level.readValue()).getUint8(0);
      this.dispatchEvent(new CustomEvent('battery', { detail: { level: this.battery } }));
    } catch {
      // battery is optional
    }
  }

  handleMessage(dataView) {
    const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
    const message = parseControllerMessage(bytes);
    if (!message) return;
    if (message.kind === 'battery') {
      this.battery = message.level;
      this.dispatchEvent(new CustomEvent('battery', { detail: { level: message.level } }));
    } else if (message.kind === 'buttons') {
      for (const name of message.pressed) {
        if (this.pressed.has(name)) continue;
        this.dispatchEvent(new CustomEvent('button', { detail: { name } }));
        if (name === 'shiftUp') this.dispatchEvent(new CustomEvent('shift', { detail: { direction: 1 } }));
        if (name === 'shiftDown') this.dispatchEvent(new CustomEvent('shift', { detail: { direction: -1 } }));
      }
      this.pressed = message.pressed;
    }
  }
}
