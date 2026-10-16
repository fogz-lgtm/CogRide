// Shared Web Bluetooth plumbing: pairing, status events and auto-reconnect.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function bluetoothAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

// Bluefy (iPhone) only accepts full 128-bit UUID strings: short numbers or
// names like 'heart_rate' make it reject the whole request.
export function uuid16(short) {
  return `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
}

export const UUID = {
  FTMS: uuid16(0x1826),
  INDOOR_BIKE_DATA: uuid16(0x2ad2),
  FTMS_CONTROL_POINT: uuid16(0x2ad9),
  CYCLING_POWER: uuid16(0x1818),
  HEART_RATE: uuid16(0x180d),
  HEART_RATE_MEASUREMENT: uuid16(0x2a37),
  BATTERY: uuid16(0x180f),
  BATTERY_LEVEL: uuid16(0x2a19),
  DEVICE_INFO: uuid16(0x180a),
};

export async function writeCharacteristic(characteristic, bytes, { preferWithoutResponse = false } = {}) {
  // Always hand over an exact-size copy: Bluefy sends a view's whole
  // underlying buffer, not just the view's bytes.
  const data = Uint8Array.from(bytes);
  const props = characteristic.properties ?? {};
  const withoutResponse = preferWithoutResponse ? props.writeWithoutResponse !== false : !props.write;
  if (withoutResponse && characteristic.writeValueWithoutResponse) return characteristic.writeValueWithoutResponse(data);
  if (characteristic.writeValueWithResponse) return characteristic.writeValueWithResponse(data);
  return characteristic.writeValue(data);
}

// Subscribe to notifications/indications. Uses addEventListener (Bluefy is
// unreliable with the on… property) and replaces any earlier handler, so a
// reconnect never doubles up events.
const handlers = new WeakMap();
export async function subscribe(characteristic, handler) {
  const previous = handlers.get(characteristic);
  if (previous) characteristic.removeEventListener('characteristicvaluechanged', previous);
  const listener = (event) => handler(event.target.value);
  handlers.set(characteristic, listener);
  characteristic.addEventListener('characteristicvaluechanged', listener);
  await characteristic.startNotifications();
}

// UUIDs as the page sees them. Web Bluetooth says lowercase, but Bluefy hands
// over iOS's uppercase ones, so compare (and keep) them lowercased.
export const uuidOf = (u) => String(u ?? '').toLowerCase();
export const sameUuid = (a, b) => uuidOf(a) === uuidOf(b);

export function bytesOf(dataView) {
  return new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
}

export class BleDevice extends EventTarget {
  constructor(label) {
    super();
    this.label = label;
    this.device = null;
    this.state = 'disconnected';
    this.message = '';
    this.userDisconnected = false;
    this.reconnecting = false;
    // How hard to try after the link drops: tries, and the wait before each.
    this.reconnectTries = 5;
    this.reconnectDelayMs = (attempt) => 1000 * attempt;
    this.reconnectMessage = (attempt) => `Reconnecting (${attempt}/${this.reconnectTries})…`;
    this.handleDisconnect = () => this.onGattDisconnected();
  }

  get connected() {
    return this.state === 'connected';
  }

  get name() {
    return this.device?.name || this.label;
  }

  setState(state, message = '') {
    this.state = state;
    this.message = message;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, message } }));
  }

  // Subclasses provide requestOptions() and setup(gattServer).
  async connect() {
    if (!bluetoothAvailable()) {
      throw new Error('Web Bluetooth is not available here. Use Chrome or Edge on desktop or Android (or Bluefy on iPhone/iPad).');
    }
    const device = await navigator.bluetooth.requestDevice(this.requestOptions());
    this.device?.removeEventListener('gattserverdisconnected', this.handleDisconnect);
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnect);
    this.userDisconnected = false;
    await this.open();
  }

  async open() {
    this.setState('connecting');
    try {
      const server = await this.device.gatt.connect();
      await this.setup(server);
      this.setState('connected');
    } catch (err) {
      this.setState('disconnected', err.message);
      throw err;
    }
  }

  async onGattDisconnected() {
    if (this.userDisconnected || this.reconnecting) return;
    this.reconnecting = true;
    try {
      for (let attempt = 1; attempt <= this.reconnectTries; attempt++) {
        this.setState('connecting', this.reconnectMessage(attempt));
        await delay(this.reconnectDelayMs(attempt));
        if (this.userDisconnected) return;
        try {
          await this.open();
          return;
        } catch {
          // try again
        }
      }
      this.setState('disconnected', 'Connection lost');
    } finally {
      this.reconnecting = false;
    }
  }

  disconnect() {
    this.userDisconnected = true;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.setState('disconnected');
  }
}
