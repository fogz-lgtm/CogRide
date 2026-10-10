// A pretend trainer + HR strap so you can try the app without hardware.

export class SimulatedTrainer extends EventTarget {
  constructor() {
    super();
    this.label = 'Trainer';
    this.name = 'Simulator';
    this.state = 'disconnected';
    this.target = 120;
    this.power = 0;
    this.cadence = 0;
    this.heartRate = 70;
    this.timer = null;
  }

  get connected() {
    return this.state === 'connected';
  }

  async connect() {
    this.state = 'connected';
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'connected', message: '' } }));
    this.timer = setInterval(() => this.step(), 250);
  }

  disconnect() {
    clearInterval(this.timer);
    this.state = 'disconnected';
    this.dispatchEvent(new CustomEvent('status', { detail: { state: 'disconnected', message: '' } }));
  }

  setTargetPower(watts) {
    this.target = Math.max(0, watts);
  }

  step() {
    const noise = (n) => (Math.random() - 0.5) * n;
    this.cadence += (88 - this.cadence) * 0.2 + noise(3);
    // In gear mode the target tracks cadence, so the simulated power follows it.
    this.power += (Math.max(this.target, 30) - this.power) * 0.25 + noise(8);
    this.heartRate += (60 + this.power * 0.4 - this.heartRate) * 0.01;
    this.dispatchEvent(
      new CustomEvent('data', {
        detail: { power: Math.round(this.power), cadence: Math.round(this.cadence), heartRate: Math.round(this.heartRate) },
      }),
    );
  }
}
