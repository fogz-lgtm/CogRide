// Virtual drivetrain. The Zwift Cog is a single physical cog, so "shifting" means
// the app changes how hard the trainer resists. We model a road bike: for the
// selected virtual gear we work out bike speed from cadence, then the power that
// speed costs on the chosen grade, and ask the trainer for that power (ERG).
// Because the target follows cadence, spinning faster or slower in a gear feels
// like it does outdoors.

// 24 gear ratios (chainring / cog), spanning a compact-with-big-cassette low gear
// to a 53x11-ish top gear.
export const GEAR_RATIOS = [
  0.75, 0.87, 0.99, 1.11, 1.23, 1.38, 1.53, 1.68, 1.86, 2.04, 2.22, 2.4,
  2.61, 2.82, 3.03, 3.24, 3.49, 3.74, 3.99, 4.24, 4.54, 4.84, 5.14, 5.49,
];
export const DEFAULT_GEAR_INDEX = 11;
export const WHEEL_CIRCUMFERENCE_M = 2.105; // 700x28c

const G = 9.80665;

export const DEFAULT_PHYSICS = {
  massKg: 84, // rider + bike
  grade: 0, // fraction, 0.05 = 5%
  crr: 0.004,
  cda: 0.32,
  airDensity: 1.225,
};

export function clampGear(index) {
  return Math.min(GEAR_RATIOS.length - 1, Math.max(0, index));
}

// m/s
export function virtualSpeed(cadenceRpm, ratio) {
  if (!cadenceRpm || cadenceRpm <= 0) return 0;
  return (cadenceRpm / 60) * ratio * WHEEL_CIRCUMFERENCE_M;
}

// Steady-state power (W) needed to hold speed v (m/s).
export function powerForSpeed(v, physics = DEFAULT_PHYSICS) {
  const { massKg, grade, crr, cda, airDensity } = { ...DEFAULT_PHYSICS, ...physics };
  if (v <= 0) return 0;
  const angle = Math.atan(grade);
  const gravity = massKg * G * Math.sin(angle);
  const rolling = massKg * G * crr * Math.cos(angle);
  const aero = 0.5 * airDensity * cda * v * v;
  return Math.max(0, (gravity + rolling + aero) * v);
}

// Inverse of powerForSpeed (m/s), by bisection.
export function speedForPower(watts, physics = DEFAULT_PHYSICS) {
  if (!watts || watts <= 0) return 0;
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (powerForSpeed(mid, physics) < watts) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export function gearTargetPower(cadenceRpm, gearIndex, physics = DEFAULT_PHYSICS) {
  const v = virtualSpeed(cadenceRpm, GEAR_RATIOS[clampGear(gearIndex)]);
  return Math.round(powerForSpeed(v, physics));
}
