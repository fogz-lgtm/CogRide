// Smart trainer control for a KICKR CORE 2 (and other trainers).
//
// The ride engine sets a *target*: { mode: 'sim', gradePct, gear } to ride a
// road with virtual gears, or { mode: 'erg', watts } to hold a power. This
// class turns it into commands on whichever path the trainer supports:
//
//  - 'zwift': the trainer's built-in virtual shifting (Zwift Cog trainers).
//    We send the gear ratio, rider/bike mass and grade; the trainer firmware
//    computes resistance, exactly as it does for Zwift.
//  - 'ftms': standard FTMS. Gears are folded into the simulated road
//    (see gearing.gearedSimulation).
//
// Commands go through one serialized queue and are coalesced: only the
// latest gear/grade/target matters, so rapid shifting never backs up.

import { BleDevice, writeCharacteristic, subscribe, bytesOf, UUID } from './bleDevice.js';
import * as ZP from './zwiftProtocol.js';
import { FTMS_SERVICE, INDOOR_BIKE_DATA, CONTROL_POINT, OpCode, parseIndoorBikeData, parseControlPointResponse, encodeSetTargetPower, encodeSimulation } from './ftmsTrainer.js';
import { gearedSimulation, estimatePhysicalRatio, ratioFor, gearValueFor, ZWIFT_CW, ZWIFT_CRR } from '../core/gearing.js';

// Wahoo's own BLE services (KICKR family), for diagnostics only.
const WAHOO_SERVICES = ['a026ee01', 'a026ee03', 'a026ee06', 'a026ee07', 'a026ee0b', 'a026ee0d'].map((p) => `${p}-0a7d-4ab3-97fa-f1500f9feb8b`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

export class SmartTrainer extends BleDevice {
  constructor({ physicalRatio = 34 / 14, forceFtms = false } = {}) {
    super('Trainer');
    this.forceFtms = forceFtms;
    this.fallbackPhysicalRatio = physicalRatio;
    this.physicalSamples = [];
    this.target = { mode: 'sim', gradePct: 0, gear: 8 };
    this.masses = { riderKg: 75, bikeKg: 8 };
    this.resetSent();
    this.path = null;
    this.zp = null;
    this.ftms = null;
    this.lastFtmsDataAt = 0;
    this.trainerSpeedMps = 0;
    this.cadence = 0;
    this.pumping = false;
    this.wake = null;
    this.echoMismatches = 0;
    this.recentGearValues = []; // gear ratios written, newest last, to match read-backs
    this.keepalive = null;
  }

  resetSent() {
    this.sent = { mode: null, gradePct: null, gradeAt: 0, gear: null, watts: null, masses: null, holdUntil: 0, simAt: 0 };
  }

  get nativeShifting() {
    return this.path === 'zwift';
  }

  requestOptions() {
    return {
      filters: [{ services: [FTMS_SERVICE] }, { services: [ZP.ZP_SERVICE] }, { services: [ZP.ZP_SERVICE_16] }],
      // Wahoo's own services are listed only so the trainer sheet can show
      // what this trainer offers (Web Bluetooth hides anything unlisted).
      optionalServices: [FTMS_SERVICE, ZP.ZP_SERVICE, ZP.ZP_SERVICE_16, UUID.CYCLING_POWER, UUID.DEVICE_INFO, ...WAHOO_SERVICES],
    };
  }

  async setup(server) {
    this.resetSent();
    this.path = null;
    this.echoMismatches = 0;
    this.services = server.getPrimaryServices
      ? await server
          .getPrimaryServices()
          .then((list) => list.map((s) => s.uuid))
          .catch(() => null)
      : null;
    this.ftms = await this.setupFtms(server).catch(() => null);
    this.zpStatus = this.forceFtms ? 'forced-ftms' : 'no-service';
    this.zp = this.forceFtms ? null : await this.setupZwift(server).catch(() => null);
    if (this.zp) {
      try {
        await this.initZwift();
        this.zpStatus = 'ok';
      } catch (err) {
        // No answer to the handshake: still ride, with gears worked out here.
        this.zpStatus = 'no-handshake';
        this.zp = null;
        if (!this.ftms) throw err;
      }
    }
    if (this.zp) {
      this.path = 'zwift';
    } else if (this.ftms) {
      this.path = 'ftms';
      await this.ftmsCommand([OpCode.REQUEST_CONTROL]);
      await this.ftmsCommand([OpCode.START]).catch(() => {});
    } else {
      throw new Error('This trainer has no controllable service (FTMS or Zwift).');
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

  // ---------------------------------------------------------------- FTMS

  async setupFtms(server) {
    const service = await server.getPrimaryService(FTMS_SERVICE);
    const cp = await service.getCharacteristic(CONTROL_POINT);
    await subscribe(cp, (v) => this.onFtmsResponse(v));
    const data = await service.getCharacteristic(INDOOR_BIKE_DATA);
    await subscribe(data, (v) => this.onFtmsData(parseIndoorBikeData(v)));
    return { cp, pending: null };
  }

  onFtmsData(d) {
    this.lastFtmsDataAt = now();
    if (d.speedKmh != null) this.trainerSpeedMps = d.speedKmh / 3.6;
    if (d.cadence != null) this.cadence = d.cadence;
    const ratio = estimatePhysicalRatio(this.trainerSpeedMps, this.cadence);
    if (ratio) {
      this.physicalSamples.push(ratio);
      if (this.physicalSamples.length > 60) this.physicalSamples.shift();
    }
    this.dispatchEvent(new CustomEvent('data', { detail: { power: d.power, cadence: d.cadence, heartRate: d.heartRate, source: 'ftms' } }));
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
    if (code === 5) {
      // Control was taken by someone else: ask again once.
      await this.ftmsCommand([OpCode.REQUEST_CONTROL]).catch(() => {});
    }
    if (code !== 1) throw new Error(`Trainer refused command 0x${opcode.toString(16)} (${code})`);
  }

  physicalRatio() {
    if (this.physicalSamples.length < 10) return this.fallbackPhysicalRatio;
    const sorted = [...this.physicalSamples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // ---------------------------------------------------------------- Zwift

  async setupZwift(server) {
    let service = null;
    for (const uuid of [ZP.ZP_SERVICE, ZP.ZP_SERVICE_16]) {
      try {
        service = await server.getPrimaryService(uuid);
        break;
      } catch {
        // try the next
      }
    }
    if (!service) return null;
    const chars = await service.getCharacteristics();
    const byUuid = (u) => chars.find((c) => c.uuid === u);
    const asyncChar = byUuid(ZP.ZP_ASYNC);
    const rx = byUuid(ZP.ZP_SYNC_RX);
    const tx = byUuid(ZP.ZP_SYNC_TX);
    if (!asyncChar || !rx || !tx) {
      this.zpStatus = 'no-chars';
      return null;
    }
    // Subscribe to both before the handshake (the trainer answers on SYNC_TX).
    await subscribe(asyncChar, (v) => this.onZwiftFrame(bytesOf(v)));
    await subscribe(tx, (v) => this.onZwiftFrame(bytesOf(v)));
    return { rx, rideOn: null };
  }

  async zwiftWrite(bytes) {
    await writeCharacteristic(this.zp.rx, bytes);
  }

  async initZwift() {
    let acknowledged = false;
    for (let attempt = 0; attempt < 3 && !acknowledged; attempt++) {
      const reply = new Promise((resolve) => {
        this.zp.rideOn = resolve;
        setTimeout(() => resolve(false), 4000);
      });
      await this.zwiftWrite(ZP.RIDE_ON_TRAINER);
      acknowledged = await reply;
    }
    this.zp.rideOn = null;
    if (!acknowledged) throw new Error('Trainer did not answer the virtual shifting handshake');
    await this.zwiftWrite(ZP.logLevelSet(5));
    // Zwift's order: masses + gear, then the full road, then read the gear back.
    // (Trainers ignore gear changes until a road has been sent.)
    const gear = this.target.mode === 'sim' ? this.target.gear : 8;
    await this.zwiftWrite(ZP.bikeSim({ gearRatioX10000: gearValueFor(gear), ...this.masses }));
    await this.zwiftWrite(ZP.envSim({ windMps: 0, gradePct: this.target.gradePct ?? 0, cw: ZWIFT_CW, crr: ZWIFT_CRR }));
    await this.zwiftWrite(ZP.getObject(ZP.DataObject.SIM_VIRT_GEAR_RATIO));
    this.sent = { ...this.sent, mode: 'sim', gear, gearValue: gearValueFor(gear), gradePct: this.target.gradePct ?? 0, gradeAt: now(), masses: { ...this.masses } };
  }

  onZwiftFrame(bytes) {
    const f = ZP.parseFrame(bytes);
    if (!f) return;
    if (f.kind === 'ride-on') this.zp?.rideOn?.(true);
    else if (f.kind === 'trainer') {
      if (f.realGearRatio) this.dispatchEvent(new CustomEvent('physical-ratio', { detail: { ratio: f.realGearRatio } }));
      // Prefer FTMS data (faster); use the Zwift stream if FTMS is quiet.
      if (now() - this.lastFtmsDataAt > 3000) {
        this.dispatchEvent(new CustomEvent('data', { detail: { power: f.power, cadence: f.cadence, source: 'zwift' } }));
      }
    } else if (f.kind === 'get-response' && f.gearRatioX10000 != null && this.recentGearValues.length) {
      // A read-back of the newest gear (or one just superseded by a quick
      // second shift) is fine. Anything else means the trainer isn't
      // applying gears: after three of those, fall back to FTMS.
      if (f.gearRatioX10000 === this.recentGearValues.at(-1)) this.echoMismatches = 0;
      else if (!this.recentGearValues.includes(f.gearRatioX10000) && ++this.echoMismatches >= 3) {
        this.fallBackToFtms('The trainer isn’t applying virtual gears; using standard trainer control instead.');
      }
    } else if (f.kind === 'lost-control') {
      this.dispatchEvent(new CustomEvent('warning', { detail: { message: 'Another app took control of the trainer. Close Zwift or the Wahoo app.' } }));
    }
  }

  async fallBackToFtms(message) {
    if (!this.ftms || this.path === 'ftms') return;
    this.path = 'ftms';
    this.zpStatus = 'gears-ignored';
    this.resetSent();
    this.dispatchEvent(new CustomEvent('warning', { detail: { message } }));
    this.dispatchEvent(new CustomEvent('path', { detail: { path: this.path } }));
    try {
      await this.zwiftWrite(ZP.releaseVirtualShifting());
    } catch {
      // ignore
    }
    await this.ftmsCommand([OpCode.REQUEST_CONTROL]).catch(() => {});
    this.kick();
  }

  // ---------------------------------------------------------------- targets

  setMasses(riderKg, bikeKg) {
    this.masses = { riderKg, bikeKg };
    this.kick();
  }

  // { mode: 'sim', gradePct, gear } | { mode: 'erg', watts }
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
        for (let guard = 0; guard < 8; guard++) {
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

  // Decide the single most important command to send next (or null).
  nextCommand(t) {
    const target = this.target;
    const sent = this.sent;
    if (t < sent.holdUntil) {
      setTimeout(() => this.kick(), sent.holdUntil - t + 5);
      return null;
    }
    const zwift = this.path === 'zwift';

    if (target.mode === 'erg') {
      const watts = Math.max(0, Math.round(target.watts ?? 0));
      if (sent.mode === 'erg' && sent.watts === watts) return null;
      return async () => {
        if (zwift) await this.zwiftWrite(ZP.ergPower(watts));
        else await this.ftmsCommand(encodeSetTargetPower(watts));
        this.sent = { ...this.sent, mode: 'erg', watts };
      };
    }

    // Leaving ERG: settle on a flat road briefly before restoring the road and
    // gear (avoids the power spike some firmware had on ERG→SIM switches).
    if (sent.mode === 'erg') {
      return async () => {
        if (zwift) await this.zwiftWrite(ZP.envSim({ gradePct: 0 }));
        else await this.ftmsCommand(encodeSimulation({ gradePct: 0 }));
        this.sent = { ...this.sent, mode: 'sim', gradePct: 0, gradeAt: now(), gear: null, holdUntil: now() + 500, simAt: now() };
      };
    }

    if (zwift) {
      // (A different gear table changes the value without changing the gear number.)
      if (!sameMasses(sent.masses, this.masses) || sent.gear !== target.gear || sent.gearValue !== gearValueFor(target.gear)) {
        const gear = target.gear;
        const massesChanged = !sameMasses(sent.masses, this.masses);
        return async () => {
          const value = gearValueFor(gear);
          await this.zwiftWrite(massesChanged ? ZP.bikeSim({ gearRatioX10000: value, ...this.masses }) : ZP.bikeSim({ gearRatioX10000: value }));
          this.recentGearValues = [...this.recentGearValues, value].slice(-3);
          await this.zwiftWrite(ZP.getObject(ZP.DataObject.SIM_VIRT_GEAR_RATIO));
          this.sent = { ...this.sent, mode: 'sim', gear, gearValue: value, masses: { ...this.masses } };
          this.dispatchEvent(new CustomEvent('gear-sent', { detail: { gear } }));
        };
      }
      const grade = round2(target.gradePct ?? 0);
      const changed = sent.gradePct == null || Math.abs(grade - sent.gradePct) >= 0.05;
      const stale = t - sent.gradeAt > 5000; // keep-alive, like Zwift's regular grade updates
      if ((changed && t - sent.gradeAt >= 250) || stale) {
        return async () => {
          await this.zwiftWrite(ZP.envSim({ gradePct: grade }));
          this.sent = { ...this.sent, mode: 'sim', gradePct: grade, gradeAt: now() };
        };
      }
      if (changed) setTimeout(() => this.kick(), 260);
      return null;
    }

    // FTMS: one simulation write carries grade + gear. Re-send when either
    // changes, and once a second while aero is being folded into grade.
    const sim = gearedSimulation({
      gradePct: target.gradePct ?? 0,
      gearRatio: ratioFor(target.gear),
      physicalRatio: this.physicalRatio(),
      trainerSpeedMps: this.trainerSpeedMps || 8,
      massKg: this.masses.riderKg + this.masses.bikeKg,
    });
    const key = `${round2(sim.gradePct)}|${Math.round(sim.crr * 10000)}|${Math.round(sim.cw * 100)}`;
    const gearChanged = sent.gear !== target.gear;
    if (sent.simKey === key && !gearChanged && t - sent.simAt < 5000) return null;
    if (!gearChanged && t - sent.simAt < 250) {
      setTimeout(() => this.kick(), 260);
      return null;
    }
    return async () => {
      await this.ftmsCommand(encodeSimulation({ windMps: 0, gradePct: sim.gradePct, crr: sim.crr, cw: sim.cw }));
      this.sent = { ...this.sent, mode: 'sim', simKey: key, simAt: now(), gear: target.gear, gradePct: target.gradePct };
      if (gearChanged) this.dispatchEvent(new CustomEvent('gear-sent', { detail: { gear: target.gear } }));
    };
  }
}

function sameMasses(a, b) {
  return !!a && a.riderKg === b.riderKg && a.bikeKg === b.bikeKg;
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

export { sleep };
