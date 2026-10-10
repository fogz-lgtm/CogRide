// Display units. Everything inside the app is SI (m, m/s, kg); this is the
// only place that knows about miles and feet.

const M_PER_MI = 1609.344;
const M_PER_FT = 0.3048;
const KG_PER_LB = 0.45359237;

export function speed(mps, units) {
  if (mps == null || Number.isNaN(mps)) return { value: '--', unit: units === 'metric' ? 'km/h' : 'mph' };
  return units === 'metric' ? { value: (mps * 3.6).toFixed(1), unit: 'km/h' } : { value: ((mps * 3600) / M_PER_MI).toFixed(1), unit: 'mph' };
}

export function distance(m, units, digits = 1) {
  if (m == null) return { value: '--', unit: units === 'metric' ? 'km' : 'mi' };
  return units === 'metric' ? { value: (m / 1000).toFixed(digits), unit: 'km' } : { value: (m / M_PER_MI).toFixed(digits), unit: 'mi' };
}

export function elevation(m, units) {
  if (m == null) return { value: '--', unit: units === 'metric' ? 'm' : 'ft' };
  const v = units === 'metric' ? m : m / M_PER_FT;
  return { value: Math.round(v).toLocaleString('en-US'), unit: units === 'metric' ? 'm' : 'ft' };
}

export function weight(kg, units) {
  if (kg == null) return { value: '--', unit: units === 'metric' ? 'kg' : 'lb' };
  return units === 'metric' ? { value: kg.toFixed(1), unit: 'kg' } : { value: Math.round(kg / KG_PER_LB).toString(), unit: 'lb' };
}

export function parseWeight(value, units) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return units === 'metric' ? n : n * KG_PER_LB;
}

export const fmt = (q) => `${q.value} ${q.unit}`;

export function feetToMeters(ft) {
  return ft * M_PER_FT;
}

export function milesToMeters(mi) {
  return mi * M_PER_MI;
}
