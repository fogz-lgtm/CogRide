// Rider physics: turns pedal power into road speed with momentum, the way a
// game engine like Zwift does. Speed is integrated from a force balance, so you
// carry speed over rollers, build it on descents and bleed it on climbs instead
// of snapping to a steady-state number.

// Constants follow Zwift's own model (recovered from game data and checked
// against Zwift Insider's bot speed tests to within ~1–2%): fixed air
// density, no drivetrain loss, CdA from rider height and weight plus a small
// per-bike bias, Crr by surface.
export const G = 9.81;
export const AIR_DENSITY = 1.226;

export const DEFAULT_RIDER = {
  riderKg: 75,
  heightCm: 178,
  bikeKg: 7.4, // Zwift Carbon frame + 32mm carbon wheels
  bikeCdaBias: 0.012,
};

// Rolling resistance by surface for road tyres (Zwift's table).
export const CRR = {
  tarmac: 0.004,
  brick: 0.0055,
  wood: 0.0065,
  cobbles: 0.0065,
  snow: 0.0055,
  gravel: 0.012,
  dirt: 0.016,
  grass: 0.025,
};

// Rider frontal drag area from height (cm) and weight (kg), as in Zwift:
// 183 cm / 75 kg on the default bike comes out at ~0.316 m².
export function estimateCdA(heightCm, massKg, bikeCdaBias = DEFAULT_RIDER.bikeCdaBias) {
  const area = 0.003014024 * heightCm ** 0.655 * massKg ** 0.44 - 0.1159;
  return 0.5 * AIR_DENSITY * area + bikeCdaBias;
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
    bikeCdaBias = DEFAULT_RIDER.bikeCdaBias,
    crr = CRR.tarmac,
    drivetrainEfficiency = 1,
    wheelInertiaKg = 1.0, // rotating wheels act like a little extra mass when speeding up
    maxSpeed = 120 / 3.6,
    useAltitudeDensity = false,
    autoBrake = true, // free-ride coast-down, like Zwift outside races
    supertuck = true,
  } = {}) {
    this.massKg = riderKg + bikeKg;
    this.cda = cda ?? estimateCdA(heightCm, riderKg, bikeCdaBias);
    this.crr = crr;
    this.drivetrainEfficiency = drivetrainEfficiency;
    this.effectiveMass = this.massKg + wheelInertiaKg;
    this.maxSpeed = maxSpeed;
    this.useAltitudeDensity = useAltitudeDensity;
    this.autoBrake = autoBrake;
    this.supertuck = supertuck;
    this.coastSeconds = 0;
    this.tucked = false;
  }

  // Resistive forces (N) at speed v on gradient (fraction, 0.05 = 5%).
  resistance(v, grade, altitudeM = 0) {
    const angle = Math.atan(grade);
    const rho = this.useAltitudeDensity ? airDensity(altitudeM) : AIR_DENSITY;
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

  // Light braking when you stop pedalling on flat or rolling road, so a
  // free-ride coast-down takes ~15 s instead of minutes (Zwift does this
  // outside races). Off on real descents, so you still freewheel downhill.
  brakeForce(dt, power, grade) {
    if (!this.autoBrake || power > 10 || grade <= -0.03) {
      this.coastSeconds = 0;
      return 0;
    }
    this.coastSeconds += dt;
    if (this.coastSeconds < 1) return 0;
    return this.speed < 7.5 ? 40 : 20;
  }

  // Advance dt seconds with the rider producing `power` watts on `grade`.
  // Integrates kinetic energy (midpoint), which is well behaved from a
  // standstill and gives Zwift-like momentum over rollers and descents.
  step(dt, power, grade, altitudeM = 0) {
    const sub = Math.max(1, Math.ceil(dt / 0.05));
    const h = dt / sub;
    const p = Math.max(0, power || 0) * this.drivetrainEfficiency;
    for (let i = 0; i < sub; i++) {
      // Supertuck: fast, steep descent, not pedalling: ~25% less drag.
      this.tucked = this.supertuck && this.speed > 16.1 && grade <= -0.03 && p < 11;
      const cdaScale = this.tucked ? 0.75 : 1;
      const brake = this.brakeForce(h, p, grade);
      const resist = (v) => {
        const r = this.resistance(v, grade, altitudeM);
        return r.gravity + r.rolling + r.aero * cdaScale + brake * Math.sign(v);
      };
      const m = this.effectiveMass;
      const v0 = this.speed;
      let v1;
      if (v0 < 1) {
        // From (near) standstill the energy form can't start moving under
        // gravity alone, so use forces with a capped pedal push instead.
        const accel = (p / Math.max(v0, 1) - resist(v0)) / m;
        v1 = Math.max(0, v0 + accel * h);
      } else {
        const e0 = 0.5 * m * v0 * v0;
        const eHalf = Math.max(0, e0 + 0.5 * h * (p - resist(v0) * v0));
        const vMid = Math.sqrt((2 * eHalf) / m);
        const e1 = Math.max(0, e0 + h * (p - resist(vMid) * vMid));
        // Bikes don't roll backwards in a game: stall on very steep climbs.
        v1 = Math.sqrt((2 * e1) / m);
      }
      v1 = Math.min(this.maxSpeed, v1);
      // Energy decay only approaches zero; come to a proper stop when coasting.
      if (brake > 0 && v1 < 0.3) v1 = 0;
      this.distance += ((v0 + v1) / 2) * h;
      this.speed = v1;
    }
    return this.speed;
  }
}
