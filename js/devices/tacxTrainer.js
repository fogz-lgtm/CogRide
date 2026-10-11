// Tacx Flux S (and other Tacx smart trainers), ridden with the bike's own
// gears: FluxRide's trainer.
//
// Tacx trainers speak ANT+ FE-C over Bluetooth: ANT messages written to, and
// notified from, Tacx's own service. That works on every firmware, so it's
// the first choice; newer firmware also offers standard FTMS, used when the
// FE-C service isn't there.
//
// The engine's target is { mode: 'sim', gradePct } to ride the road (any
// gear field is ignored: the rider shifts the bike) or { mode: 'erg', watts }.
// Commands are coalesced like SmartTrainer's: only the latest target matters.

import { BleDevice, writeCharacteristic, subscribe, bytesOf, UUID } from './bleDevice.js';
import { FTMS_SERVICE, INDOOR_BIKE_DATA, CONTROL_POINT, OpCode, parseIndoorBikeData, parseControlPointResponse, encodeSetTargetPower, encodeSimulation } from './ftmsTrainer.js';
import { ZWIFT_CW, ZWIFT_CRR } from '../core/gearing.js';

export const FEC_SERVICE = '6e40fec1-b5a3-f393-e0a9-e50e24dcca9e';
export const FEC_NOTIFY = '6e40fec2-b5a3-f393-e0a9-e50e24dcca9e';
export const FEC_WRITE = '6e40fec3-b5a3-f393-e0a9-e50e24dcca9e';

// The Flux S simulates climbs up to 10 %.
export const FLUX_S_MAX_GRADE = 10;

const SYNC = 0xa4;
const BROADCAST = 0x4e;
const ACKNOWLEDGED = 0x4f;
const CHANNEL = 5; // FE-C over BLE always uses channel 5

export const Page = { GENERAL: 0x10, TRAINER: 0x19, BASIC: 0x30, TARGET_POWER: 0x31, WIND: 0x32, TRACK: 0x33, USER: 0x37, COMMAND_STATUS: 0x47 };

const KEEPALIVE_MS = 3000; // re-send the current target, like Zwift's regular updates
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const now = () => Date.now();

// ---------------------------------------------------------------- FE-C encoding

// An acknowledged ANT message carrying one 8-byte data page, XOR checksum last.
export function antMessage(page) {
  const msg = [SYNC, 0x09, ACKNOWLEDGED, CHANNEL, ...page];
  let sum = 0;
  for (const b of msg) sum ^= b;
  return Uint8Array.from([...msg, sum]);
}

// Page 0x33: grade in 0.01 % from −200 %, rolling resistance in 5×10⁻⁵.
export function fecTrackResistance(gradePct, crr = ZWIFT_CRR) {
  const raw = Math.round((clamp(gradePct, -200, 200) + 200) * 100);
  return antMessage([Page.TRACK, 0xff, 0xff, 0xff, 0xff, raw & 0xff, raw >> 8, clamp(Math.round(crr / 0.00005), 0, 254)]);
}

// Page 0x32: wind resistance coefficient in 0.01 kg/m, wind in km/h from
// −127, drafting factor in %. 1.0 = riding alone in still air.
export function fecWindResistance(cw = ZWIFT_CW, windKmh = 0, drafting = 1) {
  return antMessage([Page.WIND, 0xff, 0xff, 0xff, 0xff, clamp(Math.round(cw * 100), 0, 186), clamp(Math.round(windKmh + 127), 0, 254), clamp(Math.round(drafting * 100), 0, 100)]);
}

// Page 0x31: ERG target in 0.25 W.
export function fecTargetPower(watts) {
  const raw = clamp(Math.round(watts * 4), 0, 0xfffe);
  return antMessage([Page.TARGET_POWER, 0xff, 0xff, 0xff, 0xff, 0xff, raw & 0xff, raw >> 8]);
}

// Page 0x37: rider weight (0.01 kg) and bike weight (12 bits of 0.05 kg),
// so climbs weigh what the rider does; wheel diameter in cm (700c ≈ 0.70 m).
export function fecUserConfig(riderKg, bikeKg, wheelM = 0.7) {
  const rider = clamp(Math.round(riderKg * 100), 0, 0xfffe);
  const bike = clamp(Math.round(bikeKg / 0.05), 0, 0xffe);
  return antMessage([Page.USER, rider & 0xff, rider >> 8, 0xff, ((bike & 0x0f) << 4) | 0x0f, bike >> 4, clamp(Math.round(wheelM * 100), 0, 254), 0x00]);
}

// ---------------------------------------------------------------- FE-C decoding

// One notification may hold one or more ANT messages; return their pages.
export function parseFecNotification(bytes) {
  const pages = [];
  let i = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== SYNC) {
      i++;
      continue;
    }
    const len = bytes[i + 1];
    const end = i + len + 4; // sync, length, type, payload…, checksum
    if (end > bytes.length) break;
    const type = bytes[i + 2];
    let sum = 0;
    for (let k = i; k < end - 1; k++) sum ^= bytes[k];
    // Payload = channel + 8-byte page.
    if (sum === bytes[end - 1] && (type === BROADCAST || type === ACKNOWLEDGED) && len === 9) pages.push(bytes.slice(i + 4, i + 12));
    i = end;
  }
  return pages;
}

export function parseFecPage(p) {
  switch (p[0]) {
    case Page.GENERAL: {
      const speed = p[4] | (p[5] << 8);
      return { kind: 'general', speedMps: speed === 0xffff ? null : speed / 1000, heartRate: p[6] === 0xff || p[6] === 0 ? null : p[6] };
    }
    case Page.TRAINER: {
      const power = p[5] | ((p[6] & 0x0f) << 8);
      const flags = p[6] >> 4;
      return {
        kind: 'trainer',
        cadence: p[2] === 0xff ? null : p[2],
        power: power === 0xfff ? null : power,
        calibrationNeeded: !!(flags & 0x03),
        userConfigNeeded: !!(flags & 0x04),
        // 0 at target, 1 too slow to brake that hard, 2 too fast to brake that little, 3 at the limit.
        powerLimit: p[7] & 0x0f,
      };
    }
    case Page.COMMAND_STATUS:
      return { kind: 'command-status', command: p[1], status: p[3] };
    default:
      return { kind: 'other', page: p[0] };
  }
}

// ---------------------------------------------------------------- Cycling Power

export const CYCLING_POWER_MEASUREMENT = '00002a63-0000-1000-8000-00805f9b34fb';

// Cycling Power Measurement: power, plus crank revolutions (for cadence) when
// present. Returns { power, crank: { revs, time } | null }.
export function parseCyclingPower(dv) {
  if (dv.byteLength < 4) return null;
  const flags = dv.getUint16(0, true);
  const power = dv.getInt16(2, true);
  let o = 4;
  if (flags & 0x0001) o += 1; // pedal power balance
  if (flags & 0x0004) o += 2; // accumulated torque
  if (flags & 0x0010) o += 6; // wheel revolutions + event time
  const crank = flags & 0x0020 && o + 4 <= dv.byteLength ? { revs: dv.getUint16(o, true), time: dv.getUint16(o + 2, true) } : null;
  return { power, crank };
}

// Cadence from two crank readings (16-bit counters; time in 1/1024 s).
export function cadenceBetween(a, b) {
  if (!a || !b) return null;
  const revs = (b.revs - a.revs + 0x10000) % 0x10000;
  const ticks = (b.time - a.time + 0x10000) % 0x10000;
  if (!ticks) return null;
  return Math.round((revs * 60 * 1024) / ticks);
}

// ---------------------------------------------------------------- the trainer

export class TacxTrainer extends BleDevice {
  constructor({ showAll = false, maxGradePct = FLUX_S_MAX_GRADE } = {}) {
    super('Trainer');
    this.showAll = showAll;
    this.maxGradePct = maxGradePct;
    this.target = { mode: 'sim', gradePct: 0 };
    this.masses = { riderKg: 75, bikeKg: 8 };
    this.path = null; // 'fec' | 'ftms'
    this.fec = null;
    this.ftms = null;
    this.lastFecDataAt = 0;
    this.lastFtmsDataAt = 0;
    this.lastCrank = null;
    this.lastCrankAt = 0;
    this.limitSince = 0;
    this.limitKind = 0;
    this.hintedAt = -Infinity;
    this.calibrationWarned = false;
    this.pumping = false;
    this.wake = false;
    this.keepalive = null;
    this.resetSent();
  }

  // The bike's own gears: nothing to shift here.
  get nativeShifting() {
    return false;
  }

  resetSent() {
    this.sent = { mode: null, gradePct: null, watts: null, at: 0, masses: null, wind: false };
  }

  requestOptions() {
    const optionalServices = [FEC_SERVICE, FTMS_SERVICE, UUID.CYCLING_POWER, UUID.DEVICE_INFO];
    // Fallback: list everything nearby and let the rider pick "Tacx Flux S …".
    if (this.showAll) return { acceptAllDevices: true, optionalServices };
    return {
      filters: [{ namePrefix: 'Tacx' }, { services: [FEC_SERVICE] }, { services: [FTMS_SERVICE] }, { services: [UUID.CYCLING_POWER] }],
      optionalServices,
    };
  }

  async setup(server) {
    this.resetSent();
    this.path = null;
    this.services = server.getPrimaryServices
      ? await server
          .getPrimaryServices()
          .then((list) => list.map((s) => s.uuid))
          .catch(() => null)
      : null;
    this.fec = await this.setupFec(server).catch(() => null);
    // FTMS: data always (a second source), control only without FE-C.
    this.ftms = await this.setupFtms(server).catch(() => null);
    // Cycling Power: a last data source, should neither of the others talk.
    await this.setupPower(server).catch(() => null);
    if (this.fec) {
      this.path = 'fec';
    } else if (this.ftms) {
      this.path = 'ftms';
      await this.ftmsCommand([OpCode.REQUEST_CONTROL]);
      await this.ftmsCommand([OpCode.START]).catch(() => {});
    } else {
      throw new Error('This doesn’t look like a Tacx smart trainer (no FE-C or FTMS service). Close the Tacx Training app and try again.');
    }
    this.dispatchEvent(new CustomEvent('path', { detail: { path: this.path } }));
    clearInterval(this.keepalive);
    this.keepalive = setInterval(() => this.kick(), 1000);
    this.keepalive?.unref?.(); // (Node tests) don't hold the process open
    this.kick();
  }

  disconnect() {
    clearInterval(this.keepalive);
    super.disconnect();
  }

  // ---------------------------------------------------------------- FE-C

  async setupFec(server) {
    const service = await server.getPrimaryService(FEC_SERVICE);
    const notify = await service.getCharacteristic(FEC_NOTIFY);
    const write = await service.getCharacteristic(FEC_WRITE);
    await subscribe(notify, (v) => this.onFecNotification(bytesOf(v)));
    return { write };
  }

  async fecWrite(bytes) {
    await writeCharacteristic(this.fec.write, bytes, { preferWithoutResponse: true });
  }

  onFecNotification(bytes) {
    for (const page of parseFecNotification(bytes)) {
      const d = parseFecPage(page);
      if (d.kind === 'trainer') {
        this.lastFecDataAt = now();
        this.dispatchEvent(new CustomEvent('data', { detail: { power: d.power ?? undefined, cadence: d.cadence ?? undefined, source: 'fec' } }));
        this.watchLimits(d);
        if (d.userConfigNeeded) this.sent.masses = null; // send it again
        if (d.calibrationNeeded && !this.calibrationWarned) {
          this.calibrationWarned = true;
          this.dispatchEvent(new CustomEvent('warning', { detail: { message: 'The trainer is asking for a calibration. Run one in the Tacx Training app when you have a minute; power may read a little off until then.' } }));
        }
      } else if (d.kind === 'general' && d.heartRate) {
        this.dispatchEvent(new CustomEvent('data', { detail: { heartRate: d.heartRate, source: 'fec' } }));
      }
    }
  }

  // In ERG the brake needs some wheel speed: too slow in a small gear and it
  // can't hold the watts, too fast in a big one and it can't let go. Say
  // which way to shift once it has lasted 4 s (at most every 30 s).
  watchLimits(d) {
    const t = now();
    const kind = this.target.mode === 'erg' && (d.powerLimit === 1 || d.powerLimit === 2) ? d.powerLimit : 0;
    if (kind !== this.limitKind) {
      this.limitKind = kind;
      this.limitSince = t;
      return;
    }
    if (!kind || t - this.limitSince < 4000 || t - this.hintedAt < 30000) return;
    this.hintedAt = t;
    this.dispatchEvent(new CustomEvent('gear-hint', { detail: { direction: kind === 1 ? 1 : -1 } }));
  }

  // ---------------------------------------------------------------- FTMS

  async setupFtms(server) {
    const service = await server.getPrimaryService(FTMS_SERVICE);
    const data = await service.getCharacteristic(INDOOR_BIKE_DATA);
    await subscribe(data, (v) => this.onFtmsData(parseIndoorBikeData(v)));
    let cp = null;
    if (!this.fec) {
      cp = await service.getCharacteristic(CONTROL_POINT);
      await subscribe(cp, (v) => this.onFtmsResponse(v));
    }
    return { cp, pending: null };
  }

  onFtmsData(d) {
    // FE-C data is the Tacx's own; FTMS only fills in when FE-C is quiet.
    if (now() - this.lastFecDataAt < 3000) return;
    this.lastFtmsDataAt = now();
    this.dispatchEvent(new CustomEvent('data', { detail: { power: d.power, cadence: d.cadence, heartRate: d.heartRate, source: 'ftms' } }));
  }

  async setupPower(server) {
    const service = await server.getPrimaryService(UUID.CYCLING_POWER);
    const measurement = await service.getCharacteristic(CYCLING_POWER_MEASUREMENT);
    await subscribe(measurement, (v) => this.onPower(parseCyclingPower(v)));
  }

  onPower(d) {
    if (!d) return;
    const t = now();
    let cadence;
    if (d.crank) {
      if (this.lastCrank && d.crank.time !== this.lastCrank.time) {
        cadence = cadenceBetween(this.lastCrank, d.crank);
        this.lastCrank = d.crank;
        this.lastCrankAt = t;
      } else if (!this.lastCrank) {
        this.lastCrank = d.crank;
        this.lastCrankAt = t;
      } else if (t - this.lastCrankAt > 2500) {
        cadence = 0; // no new pedal stroke in a while
      }
    }
    if (t - this.lastFecDataAt < 3000 || t - this.lastFtmsDataAt < 3000) return;
    this.dispatchEvent(new CustomEvent('data', { detail: { power: d.power, cadence, source: 'power' } }));
  }

  onFtmsResponse(dv) {
    const r = parseControlPointResponse(dv);
    if (r && this.ftms?.pending?.opcode === r.opcode) {
      const p = this.ftms.pending;
      this.ftms.pending = null;
      p.resolve(r.result);
    }
  }

  async ftmsCommand(bytes) {
    const opcode = bytes[0];
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ftms.pending = null;
        reject(new Error('Trainer did not respond'));
      }, 3000);
      this.ftms.pending = { opcode, resolve: (code) => (clearTimeout(timer), resolve(code)) };
    });
    await writeCharacteristic(this.ftms.cp, Uint8Array.from(bytes));
    const code = await result;
    if (code === 5) await this.ftmsCommand([OpCode.REQUEST_CONTROL]).catch(() => {});
    if (code !== 1) throw new Error(`Trainer refused command 0x${opcode.toString(16)} (${code})`);
  }

  // ---------------------------------------------------------------- targets

  setMasses(riderKg, bikeKg) {
    this.masses = { riderKg, bikeKg };
    this.kick();
  }

  setTarget(target) {
    this.target = { ...target };
    this.kick();
  }

  kick() {
    if (this.pumping) {
      this.wake = true;
      return;
    }
    this.pump();
  }

  async pump() {
    if (!this.connected || !this.path) return;
    this.pumping = true;
    try {
      do {
        this.wake = false;
        for (let guard = 0; guard < 6; guard++) {
          const cmd = this.nextCommand(now());
          if (!cmd) break;
          await cmd();
        }
      } while (this.wake);
    } catch (err) {
      this.dispatchEvent(new CustomEvent('warning', { detail: { message: err.message } }));
    } finally {
      this.pumping = false;
    }
  }

  // The single most important command to send next (or null).
  nextCommand(t) {
    const fec = this.path === 'fec';
    const sent = this.sent;
    if (fec && !sameMasses(sent.masses, this.masses)) {
      const masses = { ...this.masses };
      return async () => {
        await this.fecWrite(fecUserConfig(masses.riderKg, masses.bikeKg));
        this.sent = { ...this.sent, masses };
      };
    }

    if (this.target.mode === 'erg') {
      const watts = Math.max(0, Math.round(this.target.watts ?? 0));
      if (sent.mode === 'erg' && sent.watts === watts && t - sent.at < KEEPALIVE_MS) return null;
      return async () => {
        if (fec) await this.fecWrite(fecTargetPower(watts));
        else await this.ftmsCommand(encodeSetTargetPower(watts));
        this.sent = { ...this.sent, mode: 'erg', watts, at: now() };
      };
    }

    const grade = Math.round(clamp(this.target.gradePct ?? 0, -10, this.maxGradePct) * 100) / 100;
    const changed = sent.mode !== 'sim' || sent.gradePct == null || Math.abs(grade - sent.gradePct) >= 0.05;
    if (!changed && t - sent.at < KEEPALIVE_MS) return null;
    if (changed && sent.mode === 'sim' && t - sent.at < 250) {
      setTimeout(() => this.kick(), 260);
      return null;
    }
    if (fec && !sent.wind) {
      return async () => {
        await this.fecWrite(fecWindResistance());
        this.sent = { ...this.sent, wind: true };
      };
    }
    return async () => {
      if (fec) await this.fecWrite(fecTrackResistance(grade));
      else await this.ftmsCommand(encodeSimulation({ windMps: 0, gradePct: grade, crr: ZWIFT_CRR, cw: ZWIFT_CW }));
      this.sent = { ...this.sent, mode: 'sim', gradePct: grade, at: now() };
    };
  }
}

function sameMasses(a, b) {
  return !!a && a.riderKg === b.riderKg && a.bikeKg === b.bikeKg;
}
