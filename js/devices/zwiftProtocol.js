// Zwift "ZP" protocol for trainers with built-in virtual shifting (Zwift Hub,
// KICKR CORE with Zwift Cog firmware). Frames are one opcode byte followed by
// a protobuf body; trainers use no encryption. Byte layouts and the gear table
// match captures of Zwift talking to a KICKR CORE.

import { decodeFields, firstField } from '../protobuf.js';

export const ZP_SERVICE = '00000001-19ca-4651-86e5-fa29dcdd09d1';
export const ZP_SERVICE_16 = '0000fc82-0000-1000-8000-00805f9b34fb';
export const ZP_ASYNC = '00000002-19ca-4651-86e5-fa29dcdd09d1'; // notify
export const ZP_SYNC_RX = '00000003-19ca-4651-86e5-fa29dcdd09d1'; // write
export const ZP_SYNC_TX = '00000004-19ca-4651-86e5-fa29dcdd09d1'; // indicate

export const Op = {
  GET: 0x00,
  TRAINER_NOTIF: 0x03,
  TRAINER_CONFIG_SET: 0x04,
  TRAINER_CONFIG_STATUS: 0x05,
  LOG_DATA: 0x2a,
  GET_RESPONSE: 0x3c,
  STATUS_RESPONSE: 0x3e,
  LOG_LEVEL_SET: 0x41,
  DATA_CHANGE_NOTIFICATION: 0x42,
  LOST_CONTROL: 0xfe,
};

export const DataObject = { DEV_INFO: 0, TRAINER_CONFIG: 512, SIM_VIRT_GEAR_RATIO: 520 };

// The exact integers Zwift sends for its 24 gears (some truncated, not rounded).
export const ZWIFT_GEAR_VALUES = [
  7500, 8700, 9900, 11100, 12300, 13800, 15300, 16800, 18600, 20400, 22200, 24000, 26099, 28200, 30300, 32400, 34900, 37400, 39900,
  42399, 45400, 48400, 51400, 54899,
];
export const ZWIFT_START_GEAR = 12; // 1-based, ratio 2.40

export const RIDE_ON_TRAINER = Uint8Array.from([0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e, 0x02, 0x01]);

// ---------------------------------------------------------------- encoding

export function varint(value) {
  let v = Math.floor(value);
  if (v < 0) throw new Error('varint must be non-negative');
  const out = [];
  while (v > 0x7f) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

export const zigzag = (n) => (n >= 0 ? n * 2 : -n * 2 - 1);

// fields: [[fieldNumber, kind, value]] with kind 'uint' | 'sint' | 'bool' | 'msg'
export function message(fields) {
  const out = [];
  for (const [num, kind, value] of fields) {
    if (value == null) continue;
    if (kind === 'msg') {
      out.push((num << 3) | 2, ...varint(value.length), ...value);
    } else {
      const v = kind === 'sint' ? zigzag(Math.round(value)) : kind === 'bool' ? (value ? 1 : 0) : Math.round(value);
      out.push((num << 3) | 0, ...varint(v));
    }
  }
  return out;
}

const frame = (op, body = []) => Uint8Array.from([op, ...body]);

export const logLevelSet = (level = 5) => frame(Op.LOG_LEVEL_SET, message([[1, 'uint', level]]));
export const getObject = (id) => frame(Op.GET, message([[1, 'uint', id]]));

// TrainerConfigSet.bikeSim: virtual gear (ratio ×10000) and optionally masses (kg ×100).
export function bikeSim({ gearRatioX10000, bikeKg, riderKg }) {
  const sim = message([
    [2, 'uint', gearRatioX10000],
    [4, 'uint', bikeKg != null ? bikeKg * 100 : null],
    [5, 'uint', riderKg != null ? riderKg * 100 : null],
  ]);
  return frame(Op.TRAINER_CONFIG_SET, message([[5, 'msg', sim]]));
}

export const setGear = (gear) => bikeSim({ gearRatioX10000: ZWIFT_GEAR_VALUES[gear - 1] });
export const releaseVirtualShifting = () => bikeSim({ gearRatioX10000: 0 });

// TrainerConfigSet.envSim: grade in %, wind m/s, CW (kg/m), CRR.
export function envSim({ gradePct, windMps, cw, crr }) {
  const sim = message([
    [1, 'sint', windMps != null ? windMps * 100 : null],
    [2, 'sint', gradePct != null ? gradePct * 100 : null],
    [3, 'uint', cw != null ? cw * 10000 : null],
    [4, 'uint', crr != null ? crr * 100000 : null],
  ]);
  return frame(Op.TRAINER_CONFIG_SET, message([[4, 'msg', sim]]));
}

export const ergPower = (watts) => frame(Op.TRAINER_CONFIG_SET, message([[3, 'uint', Math.max(0, watts)]]));

// ---------------------------------------------------------------- decoding

const unzigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

export function startsWithRideOn(bytes) {
  return bytes.length >= 6 && [0x52, 0x69, 0x64, 0x65, 0x4f, 0x6e].every((b, i) => bytes[i] === b);
}

export function parseFrame(bytes) {
  if (!bytes?.length) return null;
  if (startsWithRideOn(bytes)) return { kind: 'ride-on' };
  const op = bytes[0];
  const body = bytes.subarray(1);
  try {
    switch (op) {
      case Op.TRAINER_NOTIF: {
        const f = decodeFields(body);
        return {
          kind: 'trainer',
          power: firstField(f, 1) ?? 0,
          cadence: firstField(f, 2) ?? 0,
          speedCms: firstField(f, 3) ?? 0, // 0.01 m/s (trainer's own flywheel speed)
          realGearRatio: firstField(f, 6) != null ? firstField(f, 6) / 10000 : null,
        };
      }
      case Op.GET_RESPONSE: {
        const f = decodeFields(body);
        const id = firstField(f, 1);
        const data = firstField(f, 2);
        const out = { kind: 'get-response', id };
        if (id === DataObject.SIM_VIRT_GEAR_RATIO && data instanceof Uint8Array) {
          const page = firstField(decodeFields(data), 1);
          if (page instanceof Uint8Array) out.gearRatioX10000 = firstField(decodeFields(page), 8) ?? null;
        }
        return out;
      }
      case Op.STATUS_RESPONSE: {
        const f = decodeFields(body);
        return { kind: 'status', command: firstField(f, 1), status: firstField(f, 2) };
      }
      case Op.LOST_CONTROL:
        return { kind: 'lost-control' };
      case Op.LOG_DATA:
      case Op.DATA_CHANGE_NOTIFICATION:
      case Op.TRAINER_CONFIG_STATUS:
        return { kind: 'info', op };
      default:
        return { kind: 'unknown', op };
    }
  } catch {
    return { kind: 'unknown', op };
  }
}

export { unzigzag };
