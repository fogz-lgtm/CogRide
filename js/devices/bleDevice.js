// Shared Web Bluetooth plumbing: pairing, status events and auto-reconnect.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function bluetoothAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export async function writeCharacteristic(characteristic, bytes, { preferWithoutResponse = false } = {}) {
  const props = characteristic.properties ?? {};
  const withoutResponse = preferWithoutResponse ? props.writeWithoutResponse !== false : !props.write;
  if (withoutResponse && characteristic.writeValueWithoutResponse) return characteristic.writeValueWithoutResponse(bytes);
  if (characteristic.writeValueWithResponse) return characteristic.writeValueWithResponse(bytes);
  return characteristic.writeValue(bytes);
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
      for (let attempt = 1; attempt <= 5; attempt++) {
        this.setState('connecting', `Reconnecting (${attempt}/5)…`);
        await delay(1000 * attempt);
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
