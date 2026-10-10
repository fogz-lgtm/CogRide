import { BleDevice, subscribe, UUID } from './bleDevice.js';

export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

export class HeartRateMonitor extends BleDevice {
  constructor() {
    super('HR');
  }

  requestOptions() {
    // By service, not name: a Coros Pace 3's broadcast name isn't documented.
    return { filters: [{ services: [UUID.HEART_RATE] }] };
  }

  async setup(server) {
    const service = await server.getPrimaryService(UUID.HEART_RATE);
    const measurement = await service.getCharacteristic(UUID.HEART_RATE_MEASUREMENT);
    await subscribe(measurement, (v) => this.dispatchEvent(new CustomEvent('data', { detail: { heartRate: parseHeartRate(v) } })));
  }
}
