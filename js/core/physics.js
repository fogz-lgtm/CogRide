// Rider physics: turns pedal power into road speed with momentum, the way a
// game engine like Zwift does. Speed is integrated from a force balance, so you
// carry speed over rollers, build it on descents and bleed it on climbs instead
// of snapping to a steady-state number.

export const G = 9.80665;

export const DEFAULT_RIDER = {
  riderKg: 75,
  heightCm: 178,
  bikeKg: 8,
};

// Rolling resistance by surface (road tyres).
export const CRR = {
  tarmac: 0.004,
  brick: 0.0055,
  wood: 0.0065,
  cobbles: 0.0085,
  gravel: 0.012,
  dirt: 0.025,
};

// Frontal area x drag coefficient from rider size: drops-ish road position.
// Fit to published bike-fit data; taller/heavier riders punch a bigger hole.
export function estimateCdA(heightCm, massKg) {
  const h = heightCm / 100;
  return 0.0293 * h ** 0.725 * massKg ** 0.425 + 0.0604;
}

export function airDensity(altitudeM = 0, temperatureC = 20) {
  // Barometric formula at constant temperature, good enough to ~3000 m.
  const p0 = 101325;
  const t = temperatureC + 273.15;
  const p = p0 * Math.exp((-0.0289644 * G * altitudeM) / (8.31447 * t));
  return p / (287.058 * t);
}

export class RiderPhysics {
  constructor(options = {}) {
    this.configure(options);
    this.speed = 0; // m/s
    this.distance = 0; // m
  }

  configure({
    riderKg = DEFAULT_RIDER.riderKg,
    heightCm = DEFAULT_RIDER.heightCm,
    bikeKg = DEFAULT_RIDER.bikeKg,
    cda,
    crr = CRR.tarmac,
    drivetrainEfficiency = 0.975,
    wheelInertiaKg = 1.4, // rotating wheels act like extra mass when speeding up
    maxSpeed = 120 / 3.6,
    useAltitudeDensity = false,
  } = {}) {
    this.massKg = riderKg + bikeKg;
    this.cda = cda ?? estimateCdA(heightCm, riderKg);
    this.crr = crr;
    this.drivetrainEfficiency = drivetrainEfficiency;
    this.effectiveMass = this.massKg + wheelInertiaKg;
    this.maxSpeed = maxSpeed;
    this.useAltitudeDensity = useAltitudeDensity;
  }

  // Resistive forces (N) at speed v on gradient (fraction, 0.05 = 5%).
  resistance(v, grade, altitudeM = 0) {
    const angle = Math.atan(grade);
    const rho = this.useAltitudeDensity ? airDensity(altitudeM) : 1.225;
    const gravity = this.massKg * G * Math.sin(angle);
    const rolling = this.massKg * G * this.crr * Math.cos(angle) * Math.sign(v || 1);
    const aero = 0.5 * rho * this.cda * v * Math.abs(v);
    return { gravity, rolling, aero, total: gravity + rolling + aero, rho };
  }

  // Power needed to hold speed v (steady state).
  powerFor(v, grade, altitudeM = 0) {
    return Math.max(0, (this.resistance(v, grade, altitudeM).total * v) / this.drivetrainEfficiency);
  }

  // Steady-state speed for power (bisection on powerFor).
  steadySpeed(power, grade, altitudeM = 0) {
    let lo = 0;
    let hi = this.maxSpeed;
    if (power <= 0 && this.resistance(0.1, grade, altitudeM).total >= 0) return 0;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      const net = (power * this.drivetrainEfficiency) / Math.max(mid, 0.1) - this.resistance(mid, grade, altitudeM).total;
      if (net > 0) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Advance dt seconds with the rider producing `power` watts on `grade`.
  step(dt, power, grade, altitudeM = 0) {
    const sub = Math.max(1, Math.ceil(dt / 0.05));
    const h = dt / sub;
    for (let i = 0; i < sub; i++) {
      const v = this.speed;
      // Force from the pedals; near standstill use a capped "push" so a
      // standing start accelerates instead of dividing by zero.
      const drive = power > 0 ? (power * this.drivetrainEfficiency) / Math.max(v, 1.0) : 0;
      const { total } = this.resistance(v, grade, altitudeM);
      let accel = (drive - total) / this.effectiveMass;
      let next = v + accel * h;
      if (next < 0) {
        // Bikes don't roll backwards in a game: stall on very steep climbs.
        next = 0;
        accel = 0;
      }
      next = Math.min(next, this.maxSpeed);
      this.distance += ((v + next) / 2) * h;
      this.speed = next;
    }
    return this.speed;
  }
}
