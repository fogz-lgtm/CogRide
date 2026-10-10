// FTP ramp test: steps up every minute until you can't hold the power.
// FTP = 75% of your best one-minute power, the usual ramp-test estimate.

export function rampTestWorkout(ftpGuess = 200) {
  const round5 = (w) => Math.max(5, Math.round(w / 5) * 5);
  const startW = round5(ftpGuess * 0.5);
  const stepW = Math.min(25, Math.max(10, round5(ftpGuess * 0.06)));
  const steps = [{ type: 'ramp', duration: 300, from: 0.35, to: 0.5, label: 'Warm up — easy spin' }];
  // Enough steps to go well past anyone's limit; the test ends when you stop.
  for (let i = 0; i < 30; i++) {
    const watts = startW + i * stepW;
    steps.push({ type: 'steady', duration: 60, power: watts / ftpGuess, label: i === 0 ? 'Ramp starts — go until you can’t' : `Step ${i + 1}` });
  }
  return {
    id: 'ftp-ramp-test',
    name: 'FTP Ramp Test',
    description: `Starts at ${startW} W and climbs ${stepW} W every minute until you can’t hold it. About 15–25 min.`,
    kind: 'ramp-test',
    builtIn: true,
    steps,
    rampStartW: startW,
    rampStepW: stepW,
  };
}

export function bestAverage(powers, windowS) {
  if (powers.length < windowS) return null;
  let sum = 0;
  let best = 0;
  for (let i = 0; i < powers.length; i++) {
    sum += powers[i] ?? 0;
    if (i >= windowS) sum -= powers[i - windowS] ?? 0;
    if (i >= windowS - 1) best = Math.max(best, sum / windowS);
  }
  return best;
}

export function ftpFromRamp(powers) {
  const best = bestAverage(powers, 60);
  return best == null ? null : Math.round(best * 0.75);
}

// The ramp is over once you can't turn the pedals over at a useful cadence.
export class RampFailureDetector {
  constructor({ cadenceFloor = 55, seconds = 8 } = {}) {
    this.cadenceFloor = cadenceFloor;
    this.seconds = seconds;
    this.low = 0;
  }

  update(cadence, rampStarted) {
    if (!rampStarted) return false;
    this.low = cadence != null && cadence < this.cadenceFloor ? this.low + 1 : 0;
    return this.low >= this.seconds;
  }
}
