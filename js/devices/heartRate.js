import { BleDevice } from './bleDevice.js';

export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

export class HeartRateMonitor extends BleDevice {
  constructor() {
    super('HR');
  }

  requestOptions() {
    return { filters: [{ services: ['heart_rate'] }] };
  }

  async setup(server) {
    const service = await server.getPrimaryService('heart_rate');
    const measurement = await service.getCharacteristic('heart_rate_measurement');
    measurement.oncharacteristicvaluechanged = (e) =>
      this.dispatchEvent(new CustomEvent('data', { detail: { heartRate: parseHeartRate(e.target.value) } }));
    await measurement.startNotifications();
  }
}
