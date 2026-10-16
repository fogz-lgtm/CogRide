// Zwift Click v1, Click v2 (two pucks) and Play controllers.
//
// Each controller exposes Zwift's service with three characteristics: async
// (notify, button frames), syncRx (write) and syncTx (indicate). Writing the
// bare "RideOn" makes current firmware stream plaintext frames: one opcode
// byte + a protobuf body. Buttons are active-low (0 / a cleared bit = pressed).
//
// Click v2 is two separate Bluetooth devices, both named "Zwift Click": the
// right puck (+, A/B/Y/Z) and the left puck (−, D-pad). Zwift locks the left
// puck to its own app about a minute after another app connects (unless Zwift
// unlocked it in the last ~24 h). So B on the right puck also shifts down.
// A locked left puck is let go (resetting it only re-locks it a minute
// later, round and round); the app explains how to unlock it via Zwift.

import { BleDevice, writeCharacteristic, subscribe, bytesOf, sameUuid, uuidOf, UUID } from './bleDevice.js';
import { decodeFields, firstField } from '../protobuf.js';

export const ZWIFT_MANUFACTURER_ID = 0x094a;
export const ZWIFT_CUSTOM_SERVICE = '00000001-19ca-4651-86e5-fa29dcdd09d1';
export const ZWIFT_FC82_SERVICE = '0000fc82-0000-1000-8000-00805f9b34fb';
export const ASYNC_CHAR = '00000002-19ca-4651-86e5-fa29dcdd09d1';
export const SYNC_RX_CHAR = '00000003-19ca-4651-86e5-fa29dcdd09d1';
export const SYNC_TX_CHAR = '00000004-19ca-4651-86e5-fa29dcdd09d1';

export const RIDE_ON = [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e]; // "RideOn"
export const HANDSHAKE = Uint8Array.from(RIDE_ON);
export const VENDOR_UNLOCK_ACK = Uint8Array.from([0xff, 0x04, 0x00]);
export const RESET = Uint8Array.from([0x18]);
export const GET_DEVICE_INFO = Uint8Array.from([0x00, 0x08, 0x00]);

export const MessageType = { PLAY: 0x07, EMPTY: 0x15, BATTERY: 0x19, CONTROLLER: 0x23, CLICK: 0x37, VENDOR: 0xff, LOST_CONTROL: 0xfe };

// Click v2 / Ride button map (bit clear = pressed).
const CONTROLLER_BUTTONS = [
  ['left', 0x1],
  ['up', 0x2],
  ['right', 0x4],
  ['down', 0x8],
  ['a', 0x10],
  ['b', 0x20],
  ['y', 0x40],
  ['z', 0x80],
  ['minus', 0x100], // Click v2 "−" (Ride: left shift up)
  ['rideLeftDown', 0x200],
  ['rideLeftPower', 0x400],
  ['rideLeftOnOff', 0x800],
  ['plus', 0x1000], // Click v2 "+" (Ride: right shift up)
  ['rideRightDown', 0x2000],
  ['rideRightPower', 0x4000],
  ['rideRightOnOff', 0x8000],
];

const LEFT_PUCK_BUTTONS = new Set(['minus', 'left', 'up', 'right', 'down']);
const RIGHT_PUCK_BUTTONS = new Set(['plus', 'a', 'b', 'y', 'z']);

// Which way each button shifts. B doubles as "down" so a right puck alone
// can shift both ways.
export const SHIFT_MAP = { plus: 1, minus: -1, b: -1, rideRightDown: -1, rideLeftDown: -1 };

const isPressed = (value) => (value ?? 0) === 0;

function startsWith(bytes, prefix) {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

export function parseControllerMessage(bytes) {
  if (!bytes?.length) return null;
  if (startsWith(bytes, RIDE_ON)) {
    // "RideOn" + 02 03… = Click v2; > 8 bytes = old firmware wanting encryption.
    return { kind: 'handshake', legacyEncryption: bytes.length > 8 + 32, v2: bytes[6] === 0x02 && bytes[7] === 0x03 };
  }
  const type = bytes[0];
  const body = bytes.subarray(1);
  try {
    switch (type) {
      case MessageType.CLICK: {
        const pressed = new Set();
        if (!body.length) return { kind: 'buttons', pressed, model: 'click-v1' };
        const f = decodeFields(body);
        if (isPressed(firstField(f, 1))) pressed.add('plus');
        if (isPressed(firstField(f, 2))) pressed.add('minus');
        return { kind: 'buttons', pressed, model: 'click-v1' };
      }
      case MessageType.CONTROLLER: {
        const pressed = new Set();
        const map = firstField(decodeFields(body), 1);
        if (typeof map !== 'number') return { kind: 'buttons', pressed };
        for (const [name, mask] of CONTROLLER_BUTTONS) if ((map & mask) === 0) pressed.add(name);
        return { kind: 'buttons', pressed };
      }
      case MessageType.PLAY: {
        const pressed = new Set();
        if (!body.length) return { kind: 'buttons', pressed };
        const f = decodeFields(body);
        const rightPad = isPressed(firstField(f, 1));
        const named = rightPad ? [[2, 'y'], [3, 'z'], [4, 'a'], [5, 'b']] : [[2, 'up'], [3, 'left'], [4, 'right'], [5, 'down']];
        for (const [field, name] of named) if (isPressed(firstField(f, field))) pressed.add(name);
        if (isPressed(firstField(f, 6))) pressed.add(rightPad ? 'plus' : 'minus');
        return { kind: 'buttons', pressed };
      }
      case MessageType.BATTERY: {
        const f = decodeFields(body);
        return { kind: 'battery', level: firstField(f, 2) ?? null };
      }
      case MessageType.VENDOR:
        // FF 05 00 EA 05 / FF 05 00 FA 05: the left puck locked itself.
        if (bytes[1] === 0x05 && bytes[2] === 0x00 && (bytes[3] === 0xea || bytes[3] === 0xfa) && bytes[4] === 0x05) return { kind: 'locked' };
        return { kind: 'vendor', subtype: bytes[1] };
      case MessageType.EMPTY:
        return { kind: 'empty' };
      case MessageType.LOST_CONTROL:
        return { kind: 'lost-control' };
      default:
        return { kind: 'unknown', type };
    }
  } catch {
    return { kind: 'unknown', type };
  }
}

export class ZwiftClick extends BleDevice {
  constructor({ autoResetWhenLocked = false, showAll = false } = {}) {
    super('Click');
    this.showAll = showAll;
    this.pressed = new Set();
    this.battery = null;
    this.side = null; // 'left' | 'right' once known
    this.model = null; // 'click-v1' | 'click-v2' | null
    this.autoResetWhenLocked = autoResetWhenLocked;
    this.poll = null;
    this.lastFrameAt = 0;
  }

  get displayName() {
    if (this.model === 'click-v2' && this.side) return `Click ${this.side === 'right' ? 'right (+)' : 'left (−)'}`;
    return this.device?.name || 'Click';
  }

  requestOptions() {
    const optionalServices = [ZWIFT_CUSTOM_SERVICE, ZWIFT_FC82_SERVICE, UUID.BATTERY, UUID.DEVICE_INFO];
    // Fallback: list every nearby device and let him pick "Zwift Click".
    if (this.showAll) return { acceptAllDevices: true, optionalServices };
    // Pucks advertise Zwift's 128-bit service, some firmware its 16-bit FC82,
    // and Bluefy's name filters are hit and miss — so offer all three.
    return {
      filters: [{ services: [ZWIFT_CUSTOM_SERVICE] }, { services: [ZWIFT_FC82_SERVICE] }, { namePrefix: 'Zwift' }],
      optionalServices,
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
    const byUuid = (uuid) => chars.find((c) => sameUuid(c.uuid, uuid));
    const asyncChar = byUuid(ASYNC_CHAR) ?? chars.find((c) => c.properties.notify);
    this.syncRx = byUuid(SYNC_RX_CHAR) ?? chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
    const syncTx = byUuid(SYNC_TX_CHAR) ?? chars.find((c) => c.properties.indicate);
    if (!asyncChar || !this.syncRx) throw new Error('Zwift controller characteristics not found.');
    // Click v2 pucks have two extra "unlock" characteristics.
    if (chars.some((c) => uuidOf(c.uuid).startsWith('00000100-19ca') || uuidOf(c.uuid).startsWith('00000101-19ca'))) this.model = 'click-v2';

    await subscribe(asyncChar, (v) => this.handleMessage(v));
    if (syncTx) await subscribe(syncTx, (v) => this.handleMessage(v));
    this.pressed = new Set();
    await writeCharacteristic(this.syncRx, HANDSHAKE, { preferWithoutResponse: true });

    // A gentle poll keeps a lone right puck from switching itself off.
    clearInterval(this.poll);
    this.poll = setInterval(() => this.write(GET_DEVICE_INFO), 20000);
    this.poll?.unref?.();
  }

  disconnect() {
    clearInterval(this.poll);
    super.disconnect();
  }

  async write(bytes) {
    if (!this.connected || !this.syncRx) return;
    try {
      await writeCharacteristic(this.syncRx, bytes, { preferWithoutResponse: true });
    } catch {
      // a missed poll is harmless
    }
  }

  handleMessage(dataView) {
    const message = parseControllerMessage(bytesOf(dataView));
    if (!message) return;
    this.lastFrameAt = Date.now();
    switch (message.kind) {
      case 'handshake':
        if (message.legacyEncryption) {
          this.dispatchEvent(new CustomEvent('warning', { detail: { message: 'This Click needs a firmware update (open Zwift Companion, then pair the Click there once).' } }));
        }
        if (message.v2) {
          this.model = 'click-v2';
          // Harmless if the puck wasn't unlocked by Zwift; required if it was.
          this.write(VENDOR_UNLOCK_ACK);
        }
        break;
      case 'battery':
        if (message.level != null) {
          this.battery = message.level;
          this.dispatchEvent(new CustomEvent('battery', { detail: { level: message.level } }));
        }
        break;
      case 'locked':
        if (this.locked) break;
        this.side = 'left';
        this.locked = true;
        this.dispatchEvent(new CustomEvent('locked', { detail: { willReset: this.autoResetWhenLocked } }));
        if (this.autoResetWhenLocked) this.write(RESET);
        // Otherwise stop talking to it, so it doesn't reconnect and re-lock forever.
        else setTimeout(() => this.disconnect(), 0);
        break;
      case 'buttons':
        if (message.model) this.model = message.model;
        this.handleButtons(message.pressed);
        break;
      default:
        break;
    }
  }

  handleButtons(pressed) {
    for (const name of pressed) {
      if (this.pressed.has(name)) continue;
      if (!this.side && LEFT_PUCK_BUTTONS.has(name) && this.model === 'click-v2') this.side = 'left';
      if (!this.side && RIGHT_PUCK_BUTTONS.has(name) && this.model === 'click-v2') this.side = 'right';
      this.dispatchEvent(new CustomEvent('press', { detail: { button: name, shift: SHIFT_MAP[name] ?? 0 } }));
    }
    for (const name of this.pressed) {
      if (!pressed.has(name)) this.dispatchEvent(new CustomEvent('release', { detail: { button: name, shift: SHIFT_MAP[name] ?? 0 } }));
    }
    this.pressed = pressed;
  }
}
