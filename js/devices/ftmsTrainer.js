// Bluetooth FTMS (Fitness Machine Service) encoding: the standard smart-trainer
// protocol. SmartTrainer uses it for data, and for control when the trainer
// has no Zwift virtual-shifting service.

import { UUID } from './bleDevice.js';

export const FTMS_SERVICE = UUID.FTMS;
export const INDOOR_BIKE_DATA = UUID.INDOOR_BIKE_DATA;
export const CONTROL_POINT = UUID.FTMS_CONTROL_POINT;

export const OpCode = { REQUEST_CONTROL: 0x00, RESET: 0x01, SET_TARGET_POWER: 0x05, START: 0x07, SET_SIMULATION: 0x11, RESPONSE: 0x80 };

const RESULTS = { 1: 'success', 2: 'not supported', 3: 'invalid parameter', 4: 'operation failed', 5: 'control not permitted' };

export function parseIndoorBikeData(dv) {
  const out = {};
  let o = 0;
  const has = (n) => o + n <= dv.byteLength;
  if (!has(2)) return out;
  const flags = dv.getUint16(o, true);
  o += 2;
  // Bit 0 ("more data") is inverted: when clear, instantaneous speed is present.
  if (!(flags & 0x0001) && has(2)) {
    out.speedKmh = dv.getUint16(o, true) / 100;
    o += 2;
  }
  if (flags & 0x0002) o += 2; // average speed
  if (flags & 0x0004 && has(2)) {
    out.cadence = dv.getUint16(o, true) / 2;
    o += 2;
  }
  if (flags & 0x0008) o += 2; // average cadence
  if (flags & 0x0010 && has(3)) {
    out.distanceM = dv.getUint16(o, true) + (dv.getUint8(o + 2) << 16);
    o += 3;
  }
  if (flags & 0x0020) o += 2; // resistance level
  if (flags & 0x0040 && has(2)) {
    out.power = dv.getInt16(o, true);
    o += 2;
  }
  if (flags & 0x0080) o += 2; // average power
  if (flags & 0x0100) o += 5; // expended energy
  if (flags & 0x0200 && has(1)) {
    out.heartRate = dv.getUint8(o);
    o += 1;
  }
  return out;
}

export function encodeSetTargetPower(watts) {
  const w = Math.max(-32768, Math.min(32767, Math.round(watts)));
  return Uint8Array.from([OpCode.SET_TARGET_POWER, w & 0xff, (w >> 8) & 0xff]);
}

export function parseControlPointResponse(dv) {
  if (dv.byteLength < 3 || dv.getUint8(0) !== OpCode.RESPONSE) return null;
  return { opcode: dv.getUint8(1), result: dv.getUint8(2) };
}

export function encodeSimulation({ windMps = 0, gradePct = 0, crr = 0.004, cw = 0.51 }) {
  const out = new Uint8Array(7);
  const view = new DataView(out.buffer);
  view.setUint8(0, OpCode.SET_SIMULATION);
  view.setInt16(1, Math.max(-32768, Math.min(32767, Math.round(windMps * 1000))), true);
  view.setInt16(3, Math.max(-32768, Math.min(32767, Math.round(gradePct * 100))), true);
  view.setUint8(5, Math.max(0, Math.min(255, Math.round(crr * 10000))));
  view.setUint8(6, Math.max(0, Math.min(255, Math.round(cw * 100))));
  return out;
}
