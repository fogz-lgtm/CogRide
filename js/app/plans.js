// What there is to ride: workouts (built in, presets, yours), Zone 2
// autopilot, the FTP ramp test — and the words the app uses about them.

import { BUILT_IN_WORKOUTS, parseWorkoutText, totalDuration } from '../workouts.js';
import { rampTestWorkout } from '../core/rampTest.js';

const PRESET_SOURCES = [
  {
    id: 'post-lift-flush',
    name: 'Post-lift flush',
    description: 'Thirty easy minutes to move blood through heavy legs. Light gears, quick feet, nothing hard.',
    text: `5m 40-50% Easy start
3x 6m 55% Easy spin 90 rpm, 1m 58% Quick feet 105 rpm
4m 50-40% Cool down`,
  },
];

export const PRESET_WORKOUTS = PRESET_SOURCES.map((w) => ({ ...w, builtIn: true, steps: parseWorkoutText(w.text) }));

export function allWorkouts(custom = []) {
  return [...PRESET_WORKOUTS, ...BUILT_IN_WORKOUTS, ...custom];
}

export const AUTOPILOT_MINUTES = [45, 60, 75, 90];

export function autopilotPlan(minutes = 60) {
  return { kind: 'autopilot', id: `z2-${minutes}`, title: 'Zone 2 autopilot', minutes };
}

// Ride until you've climbed `goalM` (repeating the climb as needed).
export function vertPlan(goalM, routeId) {
  return { kind: 'vert', id: `vert-${Math.round(goalM)}`, title: 'Climb goal', goalM, routeId };
}

export function workoutPlan(workout) {
  return { kind: 'workout', id: workout.id, title: workout.name, workout, minutes: Math.round(totalDuration(workout) / 60) };
}

export function rampPlan(ftp) {
  const workout = rampTestWorkout(ftp);
  return { kind: 'ramp', id: 'ftp-ramp', title: 'FTP ramp test', workout, minutes: 20 };
}

// ---------------------------------------------------------------- words

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

export function numberWords(n) {
  n = Math.round(n);
  if (n < 0 || n > 99) return String(n);
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function greeting(date = new Date(), name = '') {
  const h = date.getHours();
  const part = h < 5 ? 'Evening' : h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';
  return name ? `${part}, ${name}.` : `Good ${part.toLowerCase()}.`;
}

export function dateline(date = new Date()) {
  const day = date.toLocaleDateString('en-US', { weekday: 'long' });
  const md = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${md} · ${time}`;
}

// Tonight's pick, from what the last few days look like on Strava: an easy
// flush after lifting, gentle after a long run or a hard ride, something
// with bite after a quiet few days, otherwise an hour of Zone 2.
export function tonightsPick({ recent = {}, liftedRecently = recent.liftedRecently, lastRide = null, date = new Date(), units = 'imperial' } = {}) {
  const when = date.getHours() >= 16 || date.getHours() < 4 ? "Tonight's pick" : "Today's pick";
  if (liftedRecently) {
    return {
      plan: workoutPlan(PRESET_WORKOUTS[0]),
      kicker: `${when} · after lifting`,
      title: ['Post-lift', 'flush.'],
      meta: '30 min · Z1–Z2 · light gears',
      dek: 'Heavy legs from lifting? Tonight’s an easy one.',
    };
  }
  const recovery = BUILT_IN_WORKOUTS.find((w) => w.id === 'recovery-30') ?? PRESET_WORKOUTS[0];
  if (recent.bigRun) {
    const r = recent.bigRun;
    const dist = units === 'metric' ? `${(r.distanceM / 1000).toFixed(1)} km` : `${(r.distanceM / 1609.344).toFixed(1)} mi`;
    const gain = units === 'metric' ? `${Math.round(r.elevM)} m` : `${Math.round(r.elevM / 0.3048).toLocaleString('en-US')} ft`;
    return {
      plan: workoutPlan(recovery),
      kicker: `${when} · after your long run`,
      title: ['Thirty easy', 'minutes.'],
      meta: '30 min · Z1 · spin the legs out',
      dek: `${dist} and +${gain} in your legs. Keep tonight gentle.`,
    };
  }
  const hardYesterday = recent.hardRide || (lastRide && Date.now() - lastRide.at < 36 * 3600 * 1000 && (lastRide.tss ?? 0) >= 80);
  if (hardYesterday) {
    return {
      plan: workoutPlan(recovery),
      kicker: `${when} · recovery`,
      title: ['Thirty easy', 'minutes.'],
      meta: '30 min · Z1 · spin it out',
      dek: 'Yesterday was a big one. Keep tonight gentle.',
    };
  }
  if (recent.lightWeek) {
    const hill = BUILT_IN_WORKOUTS.find((w) => w.id === 'hill-strength-6x4');
    if (hill) {
      return {
        plan: workoutPlan(hill),
        kicker: `${when} · fresh legs`,
        title: ['Fresh legs.', 'Make it count.'],
        meta: '58 min · 6 × 4 min low-cadence climbing',
        dek: 'A quiet few days. Tonight’s a good night for climbing strength — it carries straight over to steep trails.',
      };
    }
  }
  return {
    plan: autopilotPlan(60),
    kicker: `${when} · Zone 2 autopilot`,
    title: ['An hour in', 'the pocket.'],
    meta: '60 min · the trainer steers by your heart rate',
    dek: 'An easy hour in Zone 2. You pedal; CogRide holds the watts.',
  };
}

// The mode headline on the ride screen (one italic turn each).
export function ergHeadline({ step, workIndex, workCount, rampStep }) {
  if (!step) return ['Workout', 'done.'];
  if (rampStep != null) return [`Step ${rampStep}.`, rampStep < 4 ? 'Easy so far.' : 'Hold on.'];
  const label = (step.label || '').toLowerCase();
  if (/warm/.test(label)) return ['Warming', 'up.'];
  if (/cool/.test(label)) return ['Cooling', 'down.'];
  if (workIndex == null) return ['Easy', 'spin.'];
  if (workIndex === workCount) return ['Last one.', 'Make it tidy.'];
  if (workIndex === 1) return [`One of ${numberWords(workCount)}.`, 'Find the rhythm.'];
  return [`${cap(numberWords(workIndex))} of ${numberWords(workCount)}.`, 'Settle in.'];
}

export function z2Headline(status, elapsedS) {
  if (status === 'no-hr') return ['Waiting for', 'your heart.'];
  if (status === 'above') return ['Drifting —', 'easing off.'];
  if (status === 'below') return elapsedS < 600 ? ['Settling', 'in.'] : ['A touch low —', 'adding watts.'];
  return ['In the', 'pocket.'];
}

const isWork = (s) => s.type === 'steady' && s.power >= 0.8;

// Which work interval this is ("two of three"), or null for rest steps.
export function workPosition(workout, index) {
  const steps = workout.steps;
  if (!steps[index] || !isWork(steps[index])) return { workIndex: null, workCount: steps.filter(isWork).length };
  // Count blocks of consecutive work steps as one interval (over-unders).
  let count = 0;
  let mine = null;
  for (let i = 0; i < steps.length; i++) {
    if (isWork(steps[i]) && (i === 0 || !isWork(steps[i - 1]))) count++;
    if (i === index) mine = count;
  }
  return { workIndex: mine, workCount: count };
}

// Summary headline: route + context, never an exclamation mark.
export function rideHeadline({ plan, route, minutes, summited, laps, zoneShare, rampFtp, liftedBefore, workoutDone, distanceM = 0, units = 'imperial', newBest = false, goal = null }) {
  const after = liftedBefore ? 'after leg day.' : null;
  if (plan?.kind === 'ramp' && rampFtp) return ['New FTP:', `${rampFtp} W.`];
  if (goal?.reached) {
    const ft = Math.round(goal.goalM / 0.3048);
    const lead = units === 'metric' ? `${Math.round(goal.goalM).toLocaleString('en-US')} metres up,` : ft % 1000 === 0 ? `${cap(numberWords(ft / 1000))} thousand feet,` : `${ft.toLocaleString('en-US')} feet,`;
    return [lead, after ?? 'goal done.'];
  }
  if (newBest && route) return [`${route.name.replace(/\s*\(.*\)$/, '')},`, after ? 'a new best, after leg day.' : 'a new best.'];
  if (plan?.kind === 'autopilot') {
    const lead = `${cap(numberWords(minutes))} minutes`;
    if (zoneShare >= 0.8) return [lead, after ? 'in the pocket, after leg day.' : 'in the pocket.'];
    return [lead, 'of Zone 2, mostly.'];
  }
  if (plan?.kind === 'workout' || plan?.kind === 'ramp') return [`${plan.title},`, after ?? (workoutDone ? 'done.' : 'cut short.')];
  if (route) {
    const hairpins = (route.turns || []).filter((t) => t.kind === 'hairpin').length;
    if (summited && hairpins >= 6) return [`${cap(numberWords(hairpins))} hairpins,`, after ?? 'and the top.'];
    if (summited) return [`${route.name.replace(/\s*\(.*\)$/, '')},`, after ?? 'to the top.'];
    const name = route.name.replace(/\s*\(.*\)$/, '');
    if (laps >= 2) return [`${cap(numberWords(laps))} laps of ${name},`, after ?? 'nice and steady.'];
    const dist = Math.floor(distanceM / (units === 'metric' ? 1000 : 1609.344));
    const unit = units === 'metric' ? 'kilometre' : 'mile';
    if (!route.loop && dist >= 1) return [`${name},`, after ?? `${numberWords(dist)} ${unit}${dist > 1 ? 's' : ''} up.`];
    if (dist >= 1) return [`${name},`, after ?? `${numberWords(dist)} easy ${unit}${dist > 1 ? 's' : ''}.`];
    return [`${name},`, after ?? 'a first taste.'];
  }
  return [`${cap(numberWords(minutes))} minutes`, after ?? 'on the trainer.'];
}
