import { ZwiftClick } from './devices/zwiftClick.js';
import { FtmsTrainer } from './devices/ftmsTrainer.js';
import { HeartRateMonitor } from './devices/heartRate.js';
import { SimulatedTrainer } from './devices/simulator.js';
import { bluetoothAvailable } from './devices/bleDevice.js';
import { GEAR_RATIOS, DEFAULT_GEAR_INDEX, clampGear, gearTargetPower, virtualSpeed, speedForPower } from './gears.js';
import {
  BUILT_IN_WORKOUTS,
  parseWorkoutText,
  parseZwo,
  totalDuration,
  stepAt,
  targetFraction,
  describeStep,
  zoneFor,
  formatDuration,
} from './workouts.js';
import { summarize, toTcx } from './recorder.js';
import { loadSettings, saveSettings, loadCustomWorkouts, saveCustomWorkouts } from './storage.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: loadSettings(),
  customWorkouts: loadCustomWorkouts(),
  trainer: null,
  click: new ZwiftClick(),
  hrm: new HeartRateMonitor(),
  live: { power: null, cadence: null, heartRate: null, trainerHeartRate: null },
  gear: DEFAULT_GEAR_INDEX,
  grade: 0,
  mode: 'erg', // 'erg' follows the workout target; 'gears' always uses virtual shifting
  bias: 0, // ERG target adjustment from the Click, fraction of FTP
  workout: null,
  ride: 'idle', // 'idle' | 'riding' | 'paused'
  elapsed: 0, // workout clock in seconds (skips jump it forward); ride time is samples.length
  distance: 0,
  speed: 0,
  target: null,
  samples: [],
  wakeLock: null,
};

// ---------------------------------------------------------------- control loop

function physics() {
  const { riderKg, bikeKg } = state.settings;
  return { massKg: riderKg + bikeKg, grade: state.grade / 100 };
}

function currentStep() {
  if (!state.workout) return null;
  return stepAt(state.workout, state.elapsed);
}

function workoutTarget() {
  const current = currentStep();
  if (!current) return null;
  const fraction = targetFraction(current.step, current.stepElapsed);
  if (fraction == null) return null;
  return Math.max(0, Math.round(state.settings.ftp * (fraction + state.bias)));
}

function ergActive() {
  return state.ride === 'riding' && state.mode === 'erg' && workoutTarget() != null;
}

// Work out what the trainer should be doing right now and tell it.
function applyResistance() {
  const ergTarget = workoutTarget();
  const resistance = ergActive() ? ergTarget : gearTargetPower(state.live.cadence ?? 0, state.gear, physics());
  state.target = ergTarget;
  if (state.trainer?.connected) state.trainer.setTargetPower(resistance);
}

function tick() {
  const riding = state.ride === 'riding';
  applyResistance();
  state.speed = ergActive()
    ? speedForPower(state.live.power ?? 0, { ...physics(), grade: 0 })
    : virtualSpeed(state.live.cadence ?? 0, GEAR_RATIOS[state.gear]);

  if (riding) {
    state.elapsed += 1;
    state.distance += state.speed;
    state.samples.push({
      time: Date.now(),
      power: state.live.power ?? 0,
      cadence: state.live.cadence ?? null,
      heartRate: heartRate(),
      speed: state.speed,
      distance: state.distance,
    });
    const total = state.workout ? totalDuration(state.workout) : 0;
    if (state.workout && state.elapsed === total) showBanner('Workout complete! Keep riding in gears, or press Finish to save.');
  }
  render();
}

function heartRate() {
  return state.live.heartRate ?? state.live.trainerHeartRate ?? null;
}

// ---------------------------------------------------------------- shifting

function shift(direction) {
  if (ergActive()) {
    const step = state.settings.ergShiftStep;
    state.bias = Math.max(-0.5, Math.min(0.5, Math.round((state.bias + direction * step) * 100) / 100));
  } else {
    state.gear = clampGear(state.gear + direction);
  }
  applyResistance();
  flashGear();
  render();
}

let flashTimer = null;
function flashGear() {
  const el = $('gear-display');
  el.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('flash'), 350);
}

// ---------------------------------------------------------------- ride lifecycle

async function requestWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // not supported or not allowed; screen may sleep
  }
}

function startOrPause() {
  if (state.ride === 'riding') {
    state.ride = 'paused';
  } else {
    if (!state.trainer?.connected) showBanner('No trainer connected — recording anyway. Connect one from the top bar.');
    state.ride = 'riding';
    requestWakeLock();
  }
  applyResistance();
  render();
}

function skipStep() {
  const current = currentStep();
  if (!current) return;
  // Jump the clock to the next step; the skipped time isn't recorded.
  state.elapsed = current.start + current.step.duration;
  state.bias = 0;
  applyResistance();
  render();
}

function finish() {
  state.ride = 'paused';
  state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
  applyResistance();
  render();
  if (!state.samples.length) {
    resetRide();
    return;
  }
  const s = summarize(state.samples, state.settings.ftp);
  const rows = [
    ['Time', formatDuration(s.durationS)],
    ['Distance', `${(s.distanceM / 1000).toFixed(1)} km`],
    ['Avg power', `${s.avgPower} W`],
    ['Normalized power', `${s.normalizedPower} W`],
    ['TSS', s.tss],
    ['Intensity factor', s.intensityFactor.toFixed(2)],
    ['Energy', `${s.kilojoules} kJ`],
    ['Avg cadence', s.avgCadence != null ? `${s.avgCadence} rpm` : '—'],
    ['Avg HR', s.avgHeartRate != null ? `${s.avgHeartRate} bpm` : '—'],
    ['Max HR', s.maxHeartRate != null ? `${s.maxHeartRate} bpm` : '—'],
  ];
  $('summary').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  $('summary-dialog').showModal();
}

function resetRide() {
  state.ride = 'idle';
  state.elapsed = 0;
  state.distance = 0;
  state.samples = [];
  state.bias = 0;
  hideBanner();
  applyResistance();
  render();
}

function downloadTcx() {
  const xml = toTcx(state.samples, state.settings.ftp);
  const stamp = new Date(state.samples[0].time).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const name = (state.workout?.name ?? 'Free ride').replace(/[^\w-]+/g, '_');
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/vnd.garmin.tcx+xml' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `CogRide_${stamp}_${name}.tcx` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- devices

function bindDevice(device, chipId, onData) {
  const update = () => renderChip(chipId, device);
  device.addEventListener('status', (e) => {
    update();
    if (e.detail.state === 'disconnected' && e.detail.message) showBanner(`${device.label}: ${e.detail.message}`, true);
    if (e.detail.state === 'connected') hideBanner();
  });
  if (onData) device.addEventListener('data', (e) => onData(e.detail));
  device.addEventListener('warning', (e) => showBanner(`${device.label}: ${e.detail.message}`, true));
  update();
}

function onTrainerData(data) {
  if (data.power != null) state.live.power = data.power;
  if (data.cadence != null) state.live.cadence = data.cadence;
  if (data.heartRate) state.live.trainerHeartRate = data.heartRate;
  renderMetrics();
}

async function connectDevice(device) {
  try {
    await device.connect();
  } catch (err) {
    if (err.name === 'NotFoundError') return; // user closed the chooser
    showBanner(`${device.label}: ${err.message}`, true);
  }
}

function toggleDevice(device, connect) {
  if (device?.connected || device?.state === 'connecting') {
    if (confirm(`Disconnect ${device.name}?`)) device.disconnect();
  } else {
    connect();
  }
}

async function chooseTrainer(kind) {
  state.trainer?.disconnect();
  state.trainer = kind === 'sim' ? new SimulatedTrainer() : new FtmsTrainer();
  state.live.power = state.live.cadence = null;
  bindDevice(state.trainer, 'chip-trainer', onTrainerData);
  await connectDevice(state.trainer);
  applyResistance();
}

state.click.addEventListener('shift', (e) => shift(e.detail.direction));
state.click.addEventListener('battery', () => renderChip('chip-click', state.click));
bindDevice(state.click, 'chip-click');
bindDevice(state.hrm, 'chip-hr', (d) => {
  state.live.heartRate = d.heartRate;
  renderMetrics();
});

// ---------------------------------------------------------------- workouts

function allWorkouts() {
  return [...BUILT_IN_WORKOUTS, ...state.customWorkouts];
}

function selectWorkout(workout) {
  if (state.ride !== 'idle' && !confirm('Switch workout? The workout clock restarts but your ride keeps recording.')) return;
  state.workout = workout;
  state.bias = 0;
  state.elapsed = 0; // the recording carries on; only the workout clock restarts
  renderWorkout();
  applyResistance();
  render();
}

function profileSvg(svg, workout, ftp) {
  const total = totalDuration(workout);
  const maxFraction = Math.max(1.3, ...workout.steps.map((s) => (s.type === 'steady' ? s.power : s.type === 'ramp' ? Math.max(s.from, s.to) : 0.5)) ) * 1.08;
  const y = (f) => 120 - (f / maxFraction) * 120;
  let x = 0;
  const shapes = [];
  for (const step of workout.steps) {
    const w = (step.duration / total) * 1000;
    if (step.type === 'steady') {
      shapes.push(`<rect x="${x}" y="${y(step.power)}" width="${w}" height="${120 - y(step.power)}" fill="${zoneFor(step.power).color}"><title>${describeStep(step, ftp)}</title></rect>`);
    } else if (step.type === 'ramp') {
      const color = zoneFor((step.from + step.to) / 2).color;
      shapes.push(`<polygon points="${x},120 ${x},${y(step.from)} ${x + w},${y(step.to)} ${x + w},120" fill="${color}"><title>${describeStep(step, ftp)}</title></polygon>`);
    } else {
      shapes.push(`<rect x="${x}" y="${y(0.5)}" width="${w}" height="${120 - y(0.5)}" fill="#8a94a6" opacity="0.35"><title>Free ride</title></rect>`);
    }
    x += w;
  }
  // FTP reference line
  shapes.push(`<line x1="0" x2="1000" y1="${y(1)}" y2="${y(1)}" stroke="#fff" stroke-opacity="0.25" stroke-dasharray="6 6" vector-effect="non-scaling-stroke"/>`);
  svg.innerHTML = shapes.join('') + '<line class="cursor" x1="0" x2="0" y1="0" y2="120" stroke="#fff" stroke-width="2" vector-effect="non-scaling-stroke"/>';
  svg.dataset.total = total;
}

function renderWorkout() {
  const svg = $('profile');
  if (state.workout) {
    $('workout-name').textContent = state.workout.name;
    $('workout-desc').textContent = state.workout.description || `${formatDuration(totalDuration(state.workout))} · ${state.workout.steps.length} steps`;
    profileSvg(svg, state.workout, state.settings.ftp);
    svg.hidden = false;
  } else {
    $('workout-name').textContent = 'Free ride';
    $('workout-desc').textContent = 'Pick a workout, or just ride and shift.';
    svg.innerHTML = '';
    svg.hidden = true;
  }
}

function renderLibrary() {
  const list = $('workout-list');
  list.innerHTML = '';
  for (const workout of allWorkouts()) {
    const item = document.createElement('div');
    item.className = 'workout-item' + (state.workout?.id === workout.id ? ' selected' : '');
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    const meta = `${formatDuration(totalDuration(workout))}${workout.description ? ' · ' + workout.description : ''}`;
    item.innerHTML = `<div><strong></strong><div class="meta"></div></div><div class="item-actions"></div><svg viewBox="0 0 1000 120" preserveAspectRatio="none"></svg>`;
    item.querySelector('strong').textContent = workout.name;
    item.querySelector('.meta').textContent = meta;
    profileSvg(item.querySelector('svg'), workout, state.settings.ftp);
    if (!workout.builtIn) {
      const actions = item.querySelector('.item-actions');
      const edit = Object.assign(document.createElement('button'), { textContent: 'Edit' });
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditor(workout);
      });
      const del = Object.assign(document.createElement('button'), { textContent: 'Delete' });
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${workout.name}"?`)) return;
        state.customWorkouts = state.customWorkouts.filter((w) => w.id !== workout.id);
        saveCustomWorkouts(state.customWorkouts);
        renderLibrary();
      });
      actions.append(edit, del);
    }
    const choose = () => {
      selectWorkout(workout);
      $('library-dialog').close();
    };
    item.addEventListener('click', choose);
    item.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), choose()));
    list.append(item);
  }
}

let editingId = null;

function openEditor(workout) {
  editingId = workout?.id ?? null;
  $('editor-name').value = workout?.name ?? '';
  $('editor-text').value = workout?.text ?? '';
  $('editor').hidden = false;
  previewEditor();
  $('editor-name').focus();
}

function previewEditor() {
  const svg = $('editor-preview');
  const error = $('editor-error');
  try {
    const steps = parseWorkoutText($('editor-text').value);
    profileSvg(svg, { steps }, state.settings.ftp);
    error.hidden = true;
    return steps;
  } catch (err) {
    svg.innerHTML = '';
    error.textContent = $('editor-text').value.trim() ? err.message : '';
    error.hidden = !$('editor-text').value.trim();
    return null;
  }
}

function saveEditor(e) {
  e.preventDefault();
  const steps = previewEditor();
  if (!steps) {
    $('editor-error').hidden = false;
    $('editor-error').textContent ||= 'Add at least one step.';
    return;
  }
  const workout = {
    id: editingId ?? `custom-${Date.now()}`,
    name: $('editor-name').value.trim(),
    description: '',
    text: $('editor-text').value,
    steps,
  };
  state.customWorkouts = editingId
    ? state.customWorkouts.map((w) => (w.id === editingId ? workout : w))
    : [...state.customWorkouts, workout];
  saveCustomWorkouts(state.customWorkouts);
  if (state.workout?.id === workout.id) {
    state.workout = workout;
    renderWorkout();
  }
  $('editor').hidden = true;
  renderLibrary();
}

async function importZwo(files) {
  const errors = [];
  for (const file of files) {
    try {
      const parsed = parseZwo(await file.text());
      // Store the imported steps as editable text so they behave like any custom workout.
      const text = parsed.steps
        .map((s) => {
          const d = `${s.duration}s`;
          const intensity =
            s.type === 'steady' ? `${Math.round(s.power * 100)}%` : s.type === 'ramp' ? `${Math.round(s.from * 100)}-${Math.round(s.to * 100)}%` : 'free';
          return [d, intensity, s.label].filter(Boolean).join(' ');
        })
        .join('\n');
      state.customWorkouts.push({ id: `custom-${Date.now()}-${state.customWorkouts.length}`, name: parsed.name, description: parsed.description, text, steps: parseWorkoutText(text) });
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  saveCustomWorkouts(state.customWorkouts);
  renderLibrary();
  if (errors.length) alert(errors.join('\n'));
}

// ---------------------------------------------------------------- rendering

function showBanner(message, isError = false) {
  const el = $('banner');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

function renderChip(id, device) {
  const chip = $(id);
  chip.dataset.state = device?.state ?? 'disconnected';
  const label = chip.querySelector('.chip-label');
  const base = { 'chip-trainer': 'Trainer', 'chip-click': 'Click', 'chip-hr': 'HR' }[id];
  let text = device?.connected ? device.name : base;
  if (device?.state === 'connecting') text = device.message || 'Connecting…';
  if (id === 'chip-click' && device?.connected && device.battery != null) text += ` · ${device.battery}%`;
  label.textContent = text;
  chip.title = device?.connected ? `${device.name} connected — click to disconnect` : `Connect ${base}`;
}

const fmt = (v, digits = 0) => (v == null || Number.isNaN(v) ? '--' : v.toFixed(digits));

function renderMetrics() {
  $('m-power').textContent = fmt(state.live.power);
  $('m-cadence').textContent = fmt(state.live.cadence);
  $('m-hr').textContent = fmt(heartRate());
  const power = $('m-power').closest('.metric');
  if (state.live.power != null && state.settings.ftp) {
    power.dataset.zone = '';
    power.style.setProperty('--zone', zoneFor(state.live.power / state.settings.ftp).color);
  }
}

function render() {
  renderMetrics();
  const erg = ergActive();
  const current = currentStep();
  const total = state.workout ? totalDuration(state.workout) : 0;

  $('m-target').textContent = state.target != null ? state.target : '--';
  $('m-speed').textContent = fmt(state.speed * 3.6, 1);
  $('m-distance').textContent = (state.distance / 1000).toFixed(1);

  // Gear / ERG display
  if (erg) {
    $('gear-label').textContent = 'ERG adjust';
    $('gear-value').textContent = `${state.bias >= 0 ? '+' : ''}${Math.round(state.bias * 100)}%`;
    $('gear-sub').textContent = `Gear ${state.gear + 1} ready for free ride`;
  } else {
    $('gear-label').textContent = 'Gear';
    $('gear-value').textContent = state.gear + 1;
    $('gear-sub').textContent = `${GEAR_RATIOS[state.gear].toFixed(2)} ratio · ${state.grade}% grade`;
  }

  // Mode toggle only matters with a workout loaded
  $('mode-toggle').hidden = !state.workout;
  for (const btn of $('mode-toggle').querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
  $('grade-control').classList.toggle('disabled', erg);
  $('grade').disabled = erg;

  // Interval panel
  $('interval').hidden = !state.workout;
  if (state.workout) {
    if (current) {
      $('step-remaining').textContent = formatDuration(current.stepRemaining);
      $('step-target').textContent = state.target != null ? `${state.target} W` : 'Free ride';
      $('step-label').textContent = current.step.label ?? '';
      const next = state.workout.steps[current.index + 1];
      $('next-step').textContent = next ? `${formatDuration(next.duration)} · ${describeStep(next, state.settings.ftp)}` : 'Finish';
    } else {
      $('step-remaining').textContent = 'Done';
      $('step-target').textContent = '';
      $('step-label').textContent = 'Workout complete';
      $('next-step').textContent = '—';
    }
    const cursor = $('profile').querySelector('.cursor');
    if (cursor) {
      const x = Math.min(1000, (state.elapsed / total) * 1000);
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
    }
  }
  $('elapsed').textContent = formatDuration(state.samples.length);
  $('remaining-total').textContent = state.workout ? `${formatDuration(Math.max(0, total - state.elapsed))} left` : '';

  // Buttons
  $('start').textContent = state.ride === 'riding' ? 'Pause' : state.ride === 'paused' ? 'Resume' : 'Start';
  $('finish').disabled = state.ride === 'idle';
  $('skip').disabled = !current || state.ride === 'idle';
}

// ---------------------------------------------------------------- wiring

function wireUi() {
  $('shift-up').addEventListener('click', () => shift(1));
  $('shift-down').addEventListener('click', () => shift(-1));
  $('start').addEventListener('click', startOrPause);
  $('skip').addEventListener('click', skipStep);
  $('finish').addEventListener('click', () => {
    if (confirm('Finish this ride?')) finish();
  });

  $('mode-toggle').addEventListener('click', (e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (!mode) return;
    state.mode = mode;
    applyResistance();
    render();
  });

  $('grade').addEventListener('input', (e) => {
    state.grade = Number(e.target.value);
    $('grade-value').textContent = `${state.grade}%`;
    applyResistance();
    render();
  });

  // Devices
  $('chip-trainer').addEventListener('click', () =>
    toggleDevice(state.trainer, () => {
      $('trainer-dialog').returnValue = '';
      $('trainer-dialog').showModal();
    }),
  );
  $('trainer-dialog').addEventListener('close', () => {
    const choice = $('trainer-dialog').returnValue;
    if (choice === 'ble' || choice === 'sim') chooseTrainer(choice);
  });
  $('chip-click').addEventListener('click', () => toggleDevice(state.click, () => connectDevice(state.click)));
  $('chip-hr').addEventListener('click', () => toggleDevice(state.hrm, () => connectDevice(state.hrm)));

  // Library
  $('open-library').addEventListener('click', () => {
    renderLibrary();
    $('editor').hidden = true;
    $('library-dialog').showModal();
  });
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('new-workout').addEventListener('click', () => openEditor(null));
  $('editor-cancel').addEventListener('click', () => ($('editor').hidden = true));
  $('editor-text').addEventListener('input', previewEditor);
  $('editor').addEventListener('submit', saveEditor);
  $('import-zwo').addEventListener('change', (e) => {
    importZwo([...e.target.files]);
    e.target.value = '';
  });
  $('clear-workout').addEventListener('click', () => {
    selectWorkout(null);
    $('library-dialog').close();
  });

  // Settings
  const form = $('settings-form');
  $('open-settings').addEventListener('click', () => {
    const s = state.settings;
    form.ftp.value = s.ftp;
    form.riderKg.value = s.riderKg;
    form.bikeKg.value = s.bikeKg;
    form.ergShiftStepPct.value = Math.round(s.ergShiftStep * 100);
    $('settings-dialog').showModal();
  });
  $('settings-dialog').addEventListener('close', () => {
    if ($('settings-dialog').returnValue !== 'save') return;
    state.settings = {
      ftp: Number(form.ftp.value),
      riderKg: Number(form.riderKg.value),
      bikeKg: Number(form.bikeKg.value),
      ergShiftStep: Number(form.ergShiftStepPct.value) / 100,
    };
    saveSettings(state.settings);
    renderWorkout();
    applyResistance();
    render();
  });

  // Summary
  $('download-tcx').addEventListener('click', () => {
    downloadTcx();
    $('summary-dialog').close();
  });
  $('discard-ride').addEventListener('click', () => {
    if (confirm('Discard this ride? It will not be saved.')) $('summary-dialog').close();
  });
  $('summary-dialog').addEventListener('close', resetRide);
  $('summary-dialog').addEventListener('cancel', (e) => e.preventDefault()); // Esc shouldn't lose a ride

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ' && e.target.closest('button')) return; // the button handles its own activation
    if (['ArrowUp', '+', '='].includes(e.key)) shift(1);
    else if (['ArrowDown', '-', '_'].includes(e.key)) shift(-1);
    else if (e.key === ' ') startOrPause();
    else return;
    e.preventDefault();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.ride === 'riding') requestWakeLock();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.samples.length) e.preventDefault();
  });
}

wireUi();
renderWorkout();
render();
if (!bluetoothAvailable()) {
  showBanner('This browser has no Web Bluetooth. Use Chrome or Edge on a computer or Android, or Bluefy on iPhone/iPad. The simulator still works here.');
}
setInterval(tick, 1000);
