// Zone 2 fitness check: aerobic decoupling (Pa:HR). Compare watts per
// heartbeat in the first and second halves of a steady ride, after a
// warm-up. Under ~5 % drift means the aerobic base held up; efficiency
// (W per bpm) creeping up over weeks means it's growing.

export function aerobicCheck(samples, { warmupS = 600, minS = 1200 } = {}) {
  const s = samples.filter((x) => x.heartRate > 0 && x.power != null).slice(warmupS);
  if (s.length < minS) return null;
  const half = Math.floor(s.length / 2);
  const avg = (arr, k) => arr.reduce((a, x) => a + x[k], 0) / arr.length;
  const a = s.slice(0, half);
  const b = s.slice(half);
  const ef1 = avg(a, 'power') / avg(a, 'heartRate');
  const ef2 = avg(b, 'power') / avg(b, 'heartRate');
  const ef = avg(s, 'power') / avg(s, 'heartRate');
  return {
    ef: Math.round(ef * 100) / 100,
    decoupling: Math.round(((ef1 - ef2) / ef1) * 1000) / 10,
    minutes: Math.round(s.length / 60),
  };
}

// How steady the power was (coefficient of variation of 30 s averages).
// Pa:HR only means something on a steady effort; a climb with a long
// coasting descent would read as huge "drift".
export function powerVariability(samples, { warmupS = 600 } = {}) {
  const p = samples.slice(warmupS).map((x) => x.power ?? 0);
  if (p.length < 60) return null;
  const blocks = [];
  for (let i = 0; i + 30 <= p.length; i += 30) blocks.push(p.slice(i, i + 30).reduce((a, b) => a + b, 0) / 30);
  const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  if (!mean) return null;
  const sd = Math.sqrt(blocks.reduce((a, b) => a + (b - mean) ** 2, 0) / blocks.length);
  return sd / mean;
}

export function decouplingVerdict(pct) {
  if (pct == null) return null;
  if (pct < 3) return 'rock steady';
  if (pct < 5) return 'steady';
  if (pct < 8) return 'some drift';
  return 'big drift';
}
