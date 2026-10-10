// Bluetooth FTMS (Fitness Machine Service) smart trainer: Zwift Hub, Wahoo KICKR,
// Tacx, Elite, Saris, JetBlack and most trainers from the last few years.

import { BleDevice, writeCharacteristic, subscribe, UUID } from './bleDevice.js';

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

export class FtmsTrainer extends BleDevice {
  constructor() {
    super('Trainer');
    this.queue = Promise.resolve();
    this.pendingResponse = null;
    this.desiredPower = null;
    this.lastSentPower = null;
    this.flushing = false;
  }

  requestOptions() {
    return { filters: [{ services: [FTMS_SERVICE] }], optionalServices: [UUID.DEVICE_INFO] };
  }

  async setup(server) {
    const service = await server.getPrimaryService(FTMS_SERVICE);
    this.controlPoint = await service.getCharacteristic(CONTROL_POINT);
    await subscribe(this.controlPoint, (v) => this.onControlResponse(v));

    const bikeData = await service.getCharacteristic(INDOOR_BIKE_DATA);
    await subscribe(bikeData, (v) => this.dispatchEvent(new CustomEvent('data', { detail: parseIndoorBikeData(v) })));

    this.lastSentPower = null;
    await this.command([OpCode.REQUEST_CONTROL]);
    await this.command([OpCode.START]).catch(() => {}); // optional on many trainers
  }

  command(bytes) {
    const run = () => this.sendCommand(Uint8Array.from(bytes));
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async sendCommand(bytes) {
    const opcode = bytes[0];
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResponse = null;
        reject(new Error('Trainer did not respond'));
      }, 3000);
      this.pendingResponse = {
        opcode,
        resolve: (code) => {
          clearTimeout(timer);
          resolve(code);
        },
      };
    });
    await writeCharacteristic(this.controlPoint, bytes);
    const code = await response;
    if (code !== 1) throw new Error(`Trainer refused command 0x${opcode.toString(16)}: ${RESULTS[code] ?? code}`);
  }

  onControlResponse(dv) {
    const response = parseControlPointResponse(dv);
    if (response && this.pendingResponse?.opcode === response.opcode) {
      const pending = this.pendingResponse;
      this.pendingResponse = null;
      pending.resolve(response.result);
    }
  }

  // Latest value wins: rapid shifts collapse into one write instead of queueing up.
  setTargetPower(watts) {
    this.desiredPower = Math.max(0, Math.round(watts));
    this.flushPower();
  }

  async flushPower() {
    if (this.flushing || !this.connected) return;
    this.flushing = true;
    try {
      while (this.desiredPower !== null && this.desiredPower !== this.lastSentPower) {
        const watts = this.desiredPower;
        try {
          await this.command(encodeSetTargetPower(watts));
          this.lastSentPower = watts;
        } catch (err) {
          if (/not permitted/.test(err.message)) await this.command([OpCode.REQUEST_CONTROL]).catch(() => {});
          this.dispatchEvent(new CustomEvent('warning', { detail: { message: err.message } }));
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

// FTMS "Set Indoor Bike Simulation Parameters": wind 0.001 m/s, grade 0.01 %,
// Crr 0.0001, Cw 0.01 kg/m.
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
