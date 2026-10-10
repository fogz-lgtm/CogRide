// Ride recording, summary stats and TCX export (uploads to Strava, TrainingPeaks, etc.).

// Each sample: { time (epoch ms), power, cadence, heartRate, speed (m/s), distance (m) }
export function normalizedPower(powers) {
  if (!powers.length) return 0;
  if (powers.length < 30) return powers.reduce((a, b) => a + b, 0) / powers.length;
  let windowSum = 0;
  let sumFourth = 0;
  let count = 0;
  for (let i = 0; i < powers.length; i++) {
    windowSum += powers[i];
    if (i >= 30) windowSum -= powers[i - 30];
    if (i >= 29) {
      sumFourth += (windowSum / 30) ** 4;
      count++;
    }
  }
  return (sumFourth / count) ** 0.25;
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function summarize(samples, ftp) {
  const powers = samples.map((s) => s.power ?? 0);
  const hrs = samples.map((s) => s.heartRate).filter((v) => v > 0);
  const cadences = samples.map((s) => s.cadence).filter((v) => v > 0);
  const durationS = samples.length;
  const np = normalizedPower(powers);
  const intensity = ftp ? np / ftp : 0;
  return {
    durationS,
    distanceM: samples.at(-1)?.distance ?? 0,
    avgPower: Math.round(mean(powers) ?? 0),
    maxPower: Math.max(0, ...powers),
    normalizedPower: Math.round(np),
    intensityFactor: Math.round(intensity * 100) / 100,
    tss: Math.round(((durationS * np * intensity) / ((ftp || 1) * 3600)) * 100),
    kilojoules: Math.round(powers.reduce((a, b) => a + b, 0) / 1000),
    avgHeartRate: hrs.length ? Math.round(mean(hrs)) : null,
    maxHeartRate: hrs.length ? Math.max(...hrs) : null,
    avgCadence: cadences.length ? Math.round(mean(cadences)) : null,
  };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function toTcx(samples, ftp) {
  if (!samples.length) throw new Error('Nothing recorded');
  const summary = summarize(samples, ftp);
  const start = iso(samples[0].time);
  const points = samples
    .map((s) => {
      const parts = [`<Time>${iso(s.time)}</Time>`, `<DistanceMeters>${s.distance.toFixed(1)}</DistanceMeters>`];
      if (s.heartRate > 0) parts.push(`<HeartRateBpm><Value>${Math.round(s.heartRate)}</Value></HeartRateBpm>`);
      if (s.cadence != null) parts.push(`<Cadence>${Math.min(254, Math.round(s.cadence))}</Cadence>`);
      parts.push(
        `<Extensions><ns3:TPX><ns3:Speed>${s.speed.toFixed(2)}</ns3:Speed><ns3:Watts>${Math.round(s.power ?? 0)}</ns3:Watts></ns3:TPX></Extensions>`,
      );
      return `        <Trackpoint>${parts.join('')}</Trackpoint>`;
    })
    .join('\n');
  const hrSummary =
    summary.avgHeartRate != null
      ? `      <AverageHeartRateBpm><Value>${summary.avgHeartRate}</Value></AverageHeartRateBpm>
      <MaximumHeartRateBpm><Value>${summary.maxHeartRate}</Value></MaximumHeartRateBpm>\n`
      : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2" xmlns:ns3="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
  <Activities>
    <Activity Sport="Biking">
      <Id>${start}</Id>
      <Lap StartTime="${start}">
      <TotalTimeSeconds>${summary.durationS}</TotalTimeSeconds>
      <DistanceMeters>${summary.distanceM.toFixed(1)}</DistanceMeters>
      <Calories>${summary.kilojoules}</Calories>
${hrSummary}      <Intensity>Active</Intensity>
      <TriggerMethod>Manual</TriggerMethod>
      <Track>
${points}
      </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>
`;
}
