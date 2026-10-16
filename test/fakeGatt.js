// A tiny fake GATT server for testing device classes without hardware.
export class FakeChar extends EventTarget {
  constructor(uuid, props = {}, onWrite = () => {}) {
    super();
    this.uuid = uuid;
    this.properties = { write: true, writeWithoutResponse: true, notify: true, indicate: true, ...props };
    this.writes = [];
    this.onWrite = onWrite;
    this.notifying = false;
  }
  async startNotifications() {
    this.notifying = true;
  }
  async writeValueWithResponse(data) {
    this.writes.push(Array.from(data));
    await this.onWrite(data);
  }
  async writeValueWithoutResponse(data) {
    return this.writeValueWithResponse(data);
  }
  emit(bytes) {
    const u8 = Uint8Array.from(bytes);
    const value = new DataView(u8.buffer);
    const event = new Event('characteristicvaluechanged');
    Object.defineProperty(event, 'target', { value: { value } });
    this.dispatchEvent(event);
  }
}

export class FakeService {
  constructor(uuid, chars) {
    this.uuid = uuid;
    this.chars = chars;
  }
  async getCharacteristic(uuid) {
    const c = this.chars.find((x) => x.uuid.toLowerCase() === uuid.toLowerCase()); // lookups ignore case, like iOS
    if (!c) throw new Error(`no characteristic ${uuid}`);
    return c;
  }
  async getCharacteristics() {
    return this.chars;
  }
}

export class FakeServer {
  constructor(services) {
    this.services = services;
    this.connected = true;
  }
  async getPrimaryService(uuid) {
    const s = this.services.find((x) => x.uuid.toLowerCase() === uuid.toLowerCase());
    if (!s) throw new Error(`no service ${uuid}`);
    return s;
  }
}
