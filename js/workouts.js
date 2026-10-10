// Workout model, text format, Zwift .zwo import, and built-in library.
//
// A workout is { id, name, description, steps } where each step is one of:
//   { type: 'steady', duration, power }        power = fraction of FTP
//   { type: 'ramp', duration, from, to }       linear ramp between fractions
//   { type: 'free', duration }                 no target: ride in gears
// Steps may carry an optional `label`. Durations are seconds.
//
// Text format, one block per line ('#' starts a comment):
//   10m 45-75% Warm up          ramp from 45% to 75% FTP over 10 minutes
//   20m 88%                     steady
//   5m free                     free ride (gears)
//   4x 3m 115% VO2, 3m 50%      repeat a comma-separated set of segments

export function parseDuration(text) {
  const s = text.trim().toLowerCase();
  let match = s.match(/^(\d+):(\d{1,2})$/);
  if (match) return Number(match[1]) * 60 + Number(match[2]);
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60);
  match = s.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?:in)?)?(?:(\d+(?:\.\d+)?)s(?:ec)?)?$/);
  if (!match || (!match[1] && !match[2] && !match[3])) throw new Error(`Can't read duration "${text}"`);
  return Math.round(Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0));
}

function parseSegment(text) {
  const [durationText, intensity, ...rest] = text.trim().split(/\s+/);
  if (!durationText || !intensity) throw new Error(`Expected "<duration> <intensity>" but got "${text.trim()}"`);
  const duration = parseDuration(durationText);
  if (duration <= 0) throw new Error(`Duration must be positive in "${text.trim()}"`);
  const label = rest.join(' ') || undefined;
  if (/^free$/i.test(intensity)) return { type: 'free', duration, label };
  const ramp = intensity.match(/^(\d+(?:\.\d+)?)%?-(\d+(?:\.\d+)?)%$/);
  if (ramp) return { type: 'ramp', duration, from: Number(ramp[1]) / 100, to: Number(ramp[2]) / 100, label };
  const steady = intensity.match(/^(\d+(?:\.\d+)?)%$/);
  if (steady) return { type: 'steady', duration, power: Number(steady[1]) / 100, label };
  throw new Error(`Can't read intensity "${intensity}" (use 75%, 50-75% or free)`);
}

export function parseWorkoutText(text) {
  const steps = [];
  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) return;
    try {
      const repeat = line.match(/^(\d+)\s*x\s+(.+)$/i);
      const segments = (repeat ? repeat[2] : line).split(',').map(parseSegment);
      const times = repeat ? Number(repeat[1]) : 1;
      for (let r = 0; r < times; r++) steps.push(...segments.map((s) => ({ ...s })));
    } catch (err) {
      throw new Error(`Line ${i + 1}: ${err.message}`);
    }
  });
  if (!steps.length) throw new Error('Workout has no steps');
  return steps;
}

function readAttributes(text) {
  const attrs = {};
  for (const [, key, value] of text.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) attrs[key.toLowerCase()] = value;
  return attrs;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Zwift workout files (.zwo). Power values there are already fractions of FTP.
export function parseZwo(xml) {
  const tag = (name) => {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decodeEntities(m[1].trim()) : '';
  };
  const steps = [];
  const blocks = /<(Warmup|Cooldown|SteadyState|SolidState|Ramp|IntervalsT|FreeRide|MaxEffort)\b([^>]*?)\/?>/gi;
  for (const [, element, attrText] of xml.matchAll(blocks)) {
    const a = readAttributes(attrText);
    const num = (...keys) => {
      for (const k of keys) if (a[k] !== undefined && a[k] !== '') return Number(a[k]);
      return undefined;
    };
    const duration = Math.round(num('duration') ?? 0);
    switch (element.toLowerCase()) {
      case 'warmup':
      case 'cooldown':
      case 'ramp':
        steps.push({ type: 'ramp', duration, from: num('powerlow', 'power'), to: num('powerhigh', 'power') });
        break;
      case 'steadystate':
      case 'solidstate':
        steps.push({ type: 'steady', duration, power: num('power', 'powerhigh', 'powerlow') });
        break;
      case 'intervalst': {
        const repeat = Math.max(1, Math.round(num('repeat') ?? 1));
        const on = { type: 'steady', duration: Math.round(num('onduration') ?? 0), power: num('onpower', 'poweronhigh', 'poweronlow') };
        const off = { type: 'steady', duration: Math.round(num('offduration') ?? 0), power: num('offpower', 'poweroffhigh', 'powerofflow') };
        for (let i = 0; i < repeat; i++) steps.push({ ...on }, { ...off });
        break;
      }
      case 'freeride':
      case 'maxeffort':
        steps.push({ type: 'free', duration, label: element.toLowerCase() === 'maxeffort' ? 'Max effort' : undefined });
        break;
    }
  }
  const valid = steps.filter(
    (s) => s.duration > 0 && (s.type === 'free' || (s.type === 'steady' ? Number.isFinite(s.power) : Number.isFinite(s.from) && Number.isFinite(s.to))),
  );
  if (!valid.length) throw new Error('No workout steps found in this .zwo file');
  return { name: tag('name') || 'Imported workout', description: tag('description'), steps: valid };
}

export function totalDuration(workout) {
  return workout.steps.reduce((sum, s) => sum + s.duration, 0);
}

// Locate the step active at `elapsed` seconds. Returns null once the workout is over.
export function stepAt(workout, elapsed) {
  let start = 0;
  for (let index = 0; index < workout.steps.length; index++) {
    const step = workout.steps[index];
    if (elapsed < start + step.duration) {
      return { index, step, start, stepElapsed: elapsed - start, stepRemaining: start + step.duration - elapsed };
    }
    start += step.duration;
  }
  return null;
}

// Target as a fraction of FTP, or null for free-ride steps.
export function targetFraction(step, stepElapsed) {
  if (step.type === 'steady') return step.power;
  if (step.type === 'ramp') {
    const t = Math.min(1, Math.max(0, stepElapsed / step.duration));
    return step.from + (step.to - step.from) * t;
  }
  return null;
}

export function describeStep(step, ftp) {
  const w = (f) => `${Math.round(f * ftp)}W`;
  const pct = (f) => `${Math.round(f * 100)}%`;
  if (step.type === 'steady') return `${w(step.power)} · ${pct(step.power)}`;
  if (step.type === 'ramp') return `${w(step.from)} → ${w(step.to)}`;
  return 'Free ride';
}

const ZONES = [
  { max: 0.55, name: 'Z1', color: '#8a94a6' },
  { max: 0.75, name: 'Z2', color: '#3b82f6' },
  { max: 0.9, name: 'Z3', color: '#22c55e' },
  { max: 1.05, name: 'Z4', color: '#eab308' },
  { max: 1.2, name: 'Z5', color: '#f97316' },
  { max: Infinity, name: 'Z6', color: '#ef4444' },
];

export function zoneFor(fraction) {
  return ZONES.find((z) => fraction < z.max);
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

const BUILT_IN_SOURCES = [
  {
    id: 'recovery-30',
    name: 'Recovery Spin',
    description: 'Easy 30 minutes to flush the legs after a long run.',
    text: `5m 40-55% Easy start
20m 55% Spin 90+ rpm
5m 55-40% Cool down`,
  },
  {
    id: 'endurance-60',
    name: 'Endurance Hour',
    description: 'Steady aerobic cross-training without the pounding.',
    text: `10m 45-68% Warm up
45m 70% Steady endurance
5m 65-45% Cool down`,
  },
  {
    id: 'sweet-spot-3x10',
    name: 'Sweet Spot 3×10',
    description: 'Three 10-minute blocks just under threshold.',
    text: `10m 45-75% Warm up
3x 10m 90% Sweet spot, 5m 55% Recover
5m 60-40% Cool down`,
  },
  {
    id: 'hill-strength-6x4',
    name: 'Hill Strength 6×4',
    description: 'Low-cadence climbing efforts to build strength for steep trails.',
    text: `10m 45-70% Warm up
6x 4m 88% Low cadence 60-70 rpm, 3m 55% Spin easy
6m 60-40% Cool down`,
  },
  {
    id: 'over-unders',
    name: 'Threshold Over-Unders',
    description: 'Surges above threshold, recover just below it.',
    text: `12m 45-75% Warm up
3x 2m 95% Under, 1m 108% Over, 2m 95% Under, 1m 108% Over, 2m 95% Under, 5m 50% Recover
8m 60-40% Cool down`,
  },
  {
    id: 'vo2-5x3',
    name: 'VO2 Max 5×3',
    description: 'Hard 3-minute efforts to raise your aerobic ceiling.',
    text: `12m 45-75% Warm up
2x 30s 110% Opener, 90s 50%
5x 3m 118% VO2, 3m 50% Recover
8m 55-40% Cool down`,
  },
];

export const BUILT_IN_WORKOUTS = BUILT_IN_SOURCES.map((w) => ({
  ...w,
  builtIn: true,
  steps: parseWorkoutText(w.text),
}));
