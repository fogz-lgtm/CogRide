// What the past week looks like, from Strava: runs, rides, lifting. Used to
// pick tonight's ride and to keep a running tally of climbing.

const RUNS = ['Run', 'TrailRun', 'Hike', 'Walk', 'VirtualRun'];
const RIDES = ['Ride', 'VirtualRide', 'GravelRide', 'MountainBikeRide', 'EBikeRide'];
const LIFTS = ['WeightTraining', 'Workout', 'Crossfit', 'HighIntensityIntervalTraining'];

export const isRun = (a) => RUNS.includes(a.sportType);
export const isRide = (a) => RIDES.includes(a.sportType);
export const isLift = (a) => LIFTS.includes(a.sportType);

// Monday 00:00 local of the week containing `now`.
export function weekStart(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// acts: [{ sportType, start (ms), movingS, distanceM, elevM }]
export function weekSummary(acts, now = new Date()) {
  const since = weekStart(now);
  const week = acts.filter((a) => a.start >= since);
  const sum = (list, k) => list.reduce((s, a) => s + (a[k] || 0), 0);
  const runs = week.filter(isRun);
  const rides = week.filter(isRide);
  return {
    since,
    runDistanceM: sum(runs, 'distanceM'),
    runElevM: sum(runs, 'elevM'),
    rideS: sum(rides, 'movingS'),
    rideElevM: sum(rides, 'elevM'),
    elevM: sum(runs, 'elevM') + sum(rides, 'elevM'),
    lifts: week.filter(isLift).length,
    count: week.length,
  };
}

// How fresh are the legs tonight?
export function readiness(acts, { now = Date.now(), lastRide = null } = {}) {
  const h = (ms) => (now - ms) / 3600000;
  const end = (a) => a.start + (a.elapsedS || a.movingS || 0) * 1000;
  const lift = acts.filter(isLift).sort((a, b) => b.start - a.start)[0];
  const liftedRecently = !!lift && h(end(lift)) < 8 && h(end(lift)) >= 0;
  const recent = (hours) => acts.filter((a) => h(a.start) <= hours && h(a.start) >= 0);
  const bigRun = recent(36).find(
    (a) => isRun(a) && ((a.movingS || 0) >= 90 * 60 || (a.distanceM || 0) >= 19000 || (a.elevM || 0) >= 760 || (a.sufferScore || 0) >= 120),
  );
  const hardRide =
    recent(36).some((a) => isRide(a) && (a.sufferScore || 0) >= 100) || (!!lastRide && h(lastRide.at) < 36 && (lastRide.tss ?? 0) >= 80);
  const busy = recent(96).filter((a) => (a.movingS || 0) >= 30 * 60).length;
  const lightWeek = acts.length > 0 && busy <= 1 && !bigRun && !hardRide && !liftedRecently;
  return { liftedRecently, liftAt: lift ? end(lift) : null, bigRun: bigRun ?? null, hardRide, lightWeek };
}
