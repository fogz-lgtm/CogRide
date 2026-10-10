// Zwift-style virtual drivetrain: 24 gears, start in gear 8, and the rules
// Zwift uses to turn the road under you into what the trainer feels.

import { ZWIFT_GEAR_VALUES } from '../devices/zwiftProtocol.js';

export const GEAR_COUNT = 24;
export const START_GEAR = 8; // Zwift starts virtual shifting in gear 8 (1.68)
export const GEAR_RATIOS = ZWIFT_GEAR_VALUES.map((v) => Math.round(v / 100) / 100);

export const clampGear = (gear) => Math.min(GEAR_COUNT, Math.max(1, Math.round(gear)));
export const ratioFor = (gear) => GEAR_RATIOS[clampGear(gear) - 1];

// What the rider feels: Zwift halves descents, then applies Trainer
// Difficulty (default 50%) to everything; a KICKR CORE tops out at 16%.
export function feltGrade(gradePct, difficulty = 0.5) {
  const g = gradePct >= 0 ? gradePct * difficulty : gradePct * 0.5 * difficulty;
  return Math.min(16, Math.max(-10, g));
}

// Change the felt grade at most `ratePctPerS` per second, like a motorised
// brake ramping rather than jumping.
export function slew(current, target, dt, ratePctPerS = 1) {
  const max = ratePctPerS * dt;
  return current + Math.max(-max, Math.min(max, target - current));
}

// Constants Zwift sends with its road model.
export const ZWIFT_CW = 0.51; // kg/m
export const ZWIFT_CRR = 0.004;

const FTMS_MAX_CW = 2.55;
const FTMS_MAX_CRR = 0.0255;

// Gears on a plain FTMS trainer: present the road "at the current gear".
// With k = virtual / physical ratio the trainer then resists with
// F'(v) = k·F(k·v), i.e. exactly the road at the virtual gear's speed:
//   sinθ' = k·sinθ,  Crr'·cosθ' = k·Crr·cosθ,  Cw' = k³·Cw
// Aero beyond the FTMS field limit is folded into grade at the trainer's
// current speed.
export function gearedSimulation({ gradePct, gearRatio, physicalRatio, crr = ZWIFT_CRR, cw = ZWIFT_CW, trainerSpeedMps = 8, massKg = 85 }) {
  const k = gearRatio / physicalRatio;
  const theta = Math.atan(gradePct / 100);
  let sinP = k * Math.sin(theta);
  let cwP = k ** 3 * cw;
  if (cwP > FTMS_MAX_CW) {
    sinP += (0.5 * (cwP - FTMS_MAX_CW) * trainerSpeedMps ** 2) / (massKg * 9.81);
    cwP = FTMS_MAX_CW;
  }
  sinP = Math.min(0.99, Math.max(-0.99, sinP));
  const cosP = Math.sqrt(1 - sinP * sinP);
  const crrP = Math.min(FTMS_MAX_CRR, (k * crr * Math.cos(theta)) / cosP);
  const grade = Math.min(16, Math.max(-10, Math.tan(Math.asin(sinP)) * 100));
  return { gradePct: grade, crr: crrP, cw: cwP, k };
}

// Estimate the real chainring/cog ratio from trainer speed and cadence
// (trainers report a "wheel" speed for a ~2.096 m circumference).
export function estimatePhysicalRatio(trainerSpeedMps, cadenceRpm, circumferenceM = 2.096) {
  if (!(trainerSpeedMps > 1) || !(cadenceRpm > 40)) return null;
  return trainerSpeedMps / ((cadenceRpm / 60) * circumferenceM);
}
