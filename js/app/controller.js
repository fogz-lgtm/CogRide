// The app's brain: owns the devices, the ride engine and the ride's
// lifecycle, talks to Strava, and publishes state for the screens.
//
// Two stores: `store` (screens, devices, preferences — changes rarely) and
// `live` (the ride snapshot, 4×/s), so the home screen never re-renders at
// ride rate. Moment-to-moment cues (a shift, an interval change) are DOM
// events on the controller itself, so the helm can animate in the same frame
// the Click press arrives.

import { Store } from './store.js';
import { loadPrefs, savePrefs, engineSettings, zone2, hrZoneIndex } from './prefs.js';
import * as history from './history.js';
import { rideHeadline, rampPlan, workoutPlan } from './plans.js';
import { RideEngine } from '../engine/rideEngine.js';
import { SmartTrainer } from '../devices/smartTrainer.js';
import { SimulatedTrainer } from '../devices/simulator.js';
import { ZwiftClick } from '../devices/zwiftClick.js';
import { HeartRateMonitor } from '../devices/heartRate.js';
import { bluetoothAvailable } from '../devices/bleDevice.js';
import { Shifter } from '../core/shifter.js';
import { ratioFor, setGearTable } from '../core/gearing.js';
import { AttemptTracker, powerCurve, mergePowerBests } from '../core/bests.js';
import { aerobicCheck, powerVariability } from '../core/aerobic.js';
import { weekSummary, readiness, weekStart } from '../core/load.js';
import { loadCatalog, loadRoute } from '../core/routeLibrary.js';
import { routeFromGpx, routeFromPoints, hashString } from '../core/route.js';
import { autopilotDefaults } from '../core/autopilot.js';
import { RampFailureDetector, ftpFromRamp } from '../core/rampTest.js';
import { encodeActivity } from '../core/fit.js';
import { summarize } from '../recorder.js';
import { parseWorkoutText, parseZwo } from '../workouts.js';
import * as strava from '../services/strava.js';
import * as sound from '../ui/sound.js';

const TICK_MS = 250;
const CHECKPOINT_S = 30;

// Forwards targets to whichever trainer is connected (KICKR or simulator)
// and its data back to the engine, so devices can come and go mid-ride.
class TrainerHub extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.target = null;
    this.masses = null;
    this.onData = (e) => this.dispatchEvent(new CustomEvent('data', { detail: e.detail }));
  }

  attach(device) {
    this.device?.removeEventListener('data', this.onData);
    this.device = device;
    if (!device) return;
    device.addEventListener('data', this.onData);
    if (this.masses) device.setMasses?.(...this.masses);
    if (this.target) device.setTarget(this.target);
  }

  setTarget(target) {
    this.target = target;
    this.device?.setTarget(target);
  }

  setMasses(riderKg, bikeKg) {
    this.masses = [riderKg, bikeKg];
    this.device?.setMasses?.(riderKg, bikeKg);
  }
}

const OFF = { state: 'off', name: '', message: '' };

export class Controller extends EventTarget {
  constructor({ params = new URLSearchParams() } = {}) {
    super();
    this.params = params;
    const prefs = loadPrefs();
    sound.setSoundLevel(prefs.sound);
    this.store = new Store({
      screen: 'home',
      sheet: null,
      tv: false,
      prefs,
      bluetooth: bluetoothAvailable(),
      devices: { trainer: { ...OFF }, click: { ...OFF, count: 0, battery: null }, hr: { ...OFF } },
      strava: this.stravaState(),
      catalog: [],
      runs: null,
      runsState: 'idle',
      customWorkouts: history.loadCustomWorkouts(),
      recent: { liftedRecently: false, liftAt: null, bigRun: null, hardRide: false, lightWeek: false },
      week: null,
      segments: null,
      segmentsState: 'idle',
      lastRide: history.loadHistory()[0] ?? null,
      checkpoint: null,
      plan: null,
      route: null,
      routeError: null,
      rideState: 'idle',
      toast: null,
      result: null,
      update: false,
    });
    this.live = new Store({ snap: null });

    setGearTable(prefs.gearTable);
    this.difficultyOverride = null;
    this.engine = new RideEngine({ settings: engineSettings(prefs) });
    this.hub = new TrainerHub();
    this.hrHub = new EventTarget();
    this.engine.setTrainer(this.hub);
    this.engine.setHeartRateMonitor(this.hrHub);
    this.wireEngine();

    this.trainer = null;
    this.clicks = [];
    this.hrm = null;
    this.held = new Set();
    this.shifter = new Shifter((dir) => this.engine.shift(dir));

    this.lastTick = performance.now();
    this.startAcc = 0;
    this.secondAcc = 0;
    this.checkpointAcc = 0;
    this.toastTimer = null;
    this.wakeLock = null;
    this.capturePhoto = null; // set by the ride screen
    this.timer = setInterval(() => this.tick(), TICK_MS);
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  get state() {
    return this.store.state;
  }

  set(patch) {
    this.store.set(patch);
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ---------------------------------------------------------------- boot

  async boot() {
    loadCatalog()
      .then((catalog) => this.set({ catalog }))
      .catch((err) => this.toast({ title: 'Routes didn’t load', body: err.message }));
    this.set({ week: this.weekWithLocal(null) });
    const cp = history.loadCheckpoint();
    if (cp) this.set({ checkpoint: { meta: cp.meta, savedAt: cp.savedAt, minutes: Math.round(cp.samples.length / 60) } });

    const auth = await strava.completeAuthorization();
    if (auth) {
      this.set({ strava: this.stravaState() });
      this.toast({ title: auth.ok ? 'Strava' : 'Strava didn’t connect', body: auth.message, ms: 7000 });
      if (auth.ok) this.refreshAthlete(true);
    } else if (strava.isConnected()) {
      this.refreshAthlete(false);
    }
    if (strava.isConnected()) {
      this.checkRecent();
      strava
        .flushUploadQueue()
        .then((done) => this.afterFlush(done))
        .catch(() => {})
        .finally(() => this.set({ strava: this.stravaState() }));
    }
    if (this.params.has('sim')) this.useSimulator();
  }

  stravaState() {
    const s = strava.loadStrava();
    return {
      connected: strava.isConnected(s),
      canUpload: strava.canUpload(s),
      athlete: s?.athlete ?? null,
      hasApp: !!(s?.clientId && s?.clientSecret),
      clientId: s?.clientId ?? '',
      pending: strava.pendingUploads(),
    };
  }

  // Weight, FTP, units and HR zones from Strava (at most once a day).
  async refreshAthlete(force) {
    const KEY = 'cogride.athleteAt';
    try {
      if (!force && Date.now() - Number(localStorage.getItem(KEY) || 0) < 20 * 3600 * 1000) return;
    } catch {
      // ignore
    }
    try {
      const a = await strava.fetchAthleteProfile();
      const p = this.state.prefs;
      const patch = {};
      if (a.firstName && !p.name) patch.name = a.firstName;
      if (a.weightKg && p.weightSource !== 'manual') Object.assign(patch, { riderKg: a.weightKg, weightSource: 'strava' });
      if (a.ftp && !['manual', 'ramp'].includes(p.ftpSource)) Object.assign(patch, { ftp: a.ftp, ftpSource: 'strava' });
      if (force) patch.units = a.units;
      if (a.hrZones && !p.hrZonesManual) patch.hrZones = a.hrZones.map((z, i, all) => ({ min: z.min, max: z.max > 0 ? z.max : (all[i - 1]?.max ?? 190) + 30 }));
      this.setPrefs(patch);
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      // offline or token trouble: keep what we have
    }
  }

  // The last week or so from Strava — runs, rides, lifting — shapes
  // tonight's pick, the climbing tally and the summary headline.
  async checkRecent() {
    try {
      const afterMs = Math.min(weekStart(), Date.now() - 10 * 86400000);
      const list = await strava.fetchRecentActivities({ afterS: afterMs / 1000, perPage: 100 });
      this.activities = list;
      const r = readiness(list, { lastRide: this.state.lastRide });
      this.set({ recent: r, week: this.weekWithLocal(weekSummary(list)) });
    } catch {
      // offline: keep what we have
    }
  }

  // Rides that reached Strava from the queue: remember their activity ids.
  afterFlush(done = []) {
    for (const d of done) if (d.externalId && d.activityId) history.updateHistory(d.externalId, { stravaId: d.activityId });
    this.set({ strava: this.stravaState() });
  }

  // Rides saved here but not (yet) on Strava still count toward the week.
  // (Matched by Strava id, or by start time for uploads we never heard back from.)
  weekWithLocal(week) {
    const since = weekStart();
    const onStrava = (e) => e.stravaId || (this.activities || []).some((a) => Math.abs(a.start - e.at) < 3 * 60000);
    const local = history.loadHistory().filter((e) => e.at >= since && (!week || !onStrava(e)));
    const base = week ?? { since, runDistanceM: 0, runElevM: 0, rideS: 0, rideElevM: 0, elevM: 0, lifts: 0, count: 0, localOnly: true };
    const rideS = local.reduce((s, e) => s + (e.minutes || 0) * 60, 0);
    const climb = local.reduce((s, e) => s + (e.climbedM || 0), 0);
    return { ...base, rideS: base.rideS + rideS, rideElevM: base.rideElevM + climb, elevM: base.elevM + climb };
  }

  // ---------------------------------------------------------------- prefs

  setPrefs(patch) {
    const prefs = { ...this.state.prefs, ...patch };
    savePrefs(prefs);
    this.set({ prefs });
    this.engine.updateSettings(this.engineSettingsNow());
    if ('gearTable' in patch) {
      setGearTable(prefs.gearTable);
      this.engine.control(0);
      this.live.set({ snap: this.engine.snapshot() });
    }
    if ('weeklyGoalM' in patch && !this.state.week) this.set({ week: this.weekWithLocal(null) });
    this.applySound();
  }

  // Preferences as the engine needs them, with this road's own trainer difficulty.
  engineSettingsNow() {
    const s = engineSettings(this.state.prefs);
    return this.difficultyOverride != null ? { ...s, difficulty: this.difficultyOverride } : s;
  }

  applySound() {
    const { prefs, tv } = this.state;
    const tvOff = tv && prefs.tvSound === 'off';
    sound.setSoundLevel(tvOff ? 'off' : prefs.sound);
  }

  // ---------------------------------------------------------------- devices

  setDevice(which, patch) {
    this.set((s) => ({ devices: { ...s.devices, [which]: { ...s.devices[which], ...patch } } }));
  }

  explainBleError(err) {
    if (!err || err.name === 'NotFoundError' || /cancel/i.test(err.message)) {
      // Cancelled picker (Bluefy also says NotFound when Bluetooth permission is off).
      return null;
    }
    return err.message;
  }

  async connectTrainer() {
    if (!bluetoothAvailable()) return this.openSheet({ type: 'bluefy' });
    const t = new SmartTrainer();
    // Keep a working trainer until the new one is actually connected
    // (a cancelled picker shouldn't drop it).
    const waking = (e) => e.detail.state === 'connecting' && this.setDevice('trainer', { state: 'connecting' });
    t.addEventListener('status', waking);
    try {
      await t.connect();
      t.removeEventListener('status', waking);
      this.attachTrainer(t);
    } catch (err) {
      t.removeEventListener('status', waking);
      const msg = this.explainBleError(err);
      if (this.trainer?.connected) this.attachTrainer(this.trainer, { refresh: true });
      else this.setDevice('trainer', { state: 'off', message: msg || '' });
      if (msg) this.toast({ title: 'Trainer didn’t connect', body: msg });
    }
  }

  useSimulator() {
    const sim = new SimulatedTrainer({ effortWatts: Math.round(this.state.prefs.ftp * 0.72) });
    this.attachTrainer(sim);
    sim.connect();
  }

  attachTrainer(t, { refresh = false } = {}) {
    const sim = t instanceof SimulatedTrainer;
    if (refresh) {
      this.setDevice('trainer', { state: t.connected ? 'ready' : 'off', name: sim ? 'Simulator' : t.name, path: t.path, sim, message: '' });
      return;
    }
    if (this.trainer && this.trainer !== t) {
      this.trainer.disconnect();
    }
    this.trainer = t;
    this.hub.attach(t);
    const update = () =>
      this.setDevice('trainer', {
        state: t.state === 'connected' ? 'ready' : t.state === 'connecting' ? 'connecting' : 'off',
        name: sim ? 'Simulator' : t.name,
        path: t.path,
        sim,
        zpStatus: t.zpStatus ?? null,
        services: t.services ?? null,
        message: t.message || '',
      });
    t.addEventListener('status', update);
    t.addEventListener('path', update);
    t.addEventListener('warning', (e) => this.toast({ title: 'Trainer', body: e.detail.message, ms: 8000 }));
    update();
  }

  disconnectTrainer() {
    this.trainer?.disconnect();
    this.hub.attach(null);
    this.trainer = null;
    this.setDevice('trainer', { ...OFF });
  }

  // showAll: list every Bluetooth device (for when the Click doesn't show up).
  async connectClick({ showAll = false } = {}) {
    if (!bluetoothAvailable()) return this.openSheet({ type: 'bluefy' });
    const c = new ZwiftClick({ showAll });
    const update = () => this.updateClicks();
    c.addEventListener('status', update);
    c.addEventListener('battery', update);
    c.addEventListener('press', (e) => this.press(e.detail.shift));
    c.addEventListener('release', (e) => this.release(e.detail.shift));
    c.addEventListener('locked', () => {
      // Zwift locked the left puck: let it go and explain once.
      this.clicks = this.clicks.filter((o) => o !== c);
      this.updateClicks();
      if (!this.lockExplained) {
        this.lockExplained = true;
        this.openSheet({ type: 'clicklocked' });
      }
    });
    c.addEventListener('warning', (e) => this.toast({ title: 'Click', body: e.detail.message, ms: 9000 }));
    this.setDevice('click', { state: 'connecting' });
    try {
      await c.connect();
      if (this.clicks.some((o) => o.device === c.device)) {
        // Same puck picked twice.
        return update();
      }
      this.clicks.push(c);
    } catch (err) {
      const msg = this.explainBleError(err);
      if (msg) this.toast({ title: 'Click didn’t connect', body: msg });
      // Nothing picked (or nothing found): help find it.
      else if (!this.clicks.some((o) => o.connected)) this.openSheet({ type: 'clickhelp' });
    }
    update();
  }

  updateClicks() {
    const live = this.clicks.filter((c) => c.state !== 'disconnected' || c.reconnecting);
    const ready = this.clicks.filter((c) => c.connected);
    const connecting = this.clicks.some((c) => c.state === 'connecting');
    const batteries = ready.map((c) => c.battery).filter((b) => b != null);
    const v2 = ready.some((c) => c.model === 'click-v2');
    this.setDevice('click', {
      state: ready.length ? 'ready' : connecting ? 'connecting' : 'off',
      count: ready.length,
      v2,
      battery: batteries.length ? Math.min(...batteries) : null,
      name: ready.length === 2 ? 'Both pucks' : ready[0]?.displayName || '',
      message: '',
      known: live.length,
    });
  }

  disconnectClicks() {
    for (const c of this.clicks) c.disconnect();
    this.clicks = [];
    this.updateClicks();
  }

  async connectHeart() {
    if (!bluetoothAvailable()) return this.openSheet({ type: 'bluefy' });
    const m = new HeartRateMonitor();
    m.addEventListener('data', (e) => this.hrHub.dispatchEvent(new CustomEvent('data', { detail: e.detail })));
    const update = () =>
      this.setDevice('hr', { state: m.state === 'connected' ? 'ready' : m.state === 'connecting' ? 'connecting' : 'off', name: m.name, message: m.message || '' });
    const waking = (e) => e.detail.state === 'connecting' && this.setDevice('hr', { state: 'connecting' });
    m.addEventListener('status', waking);
    try {
      await m.connect();
      m.removeEventListener('status', waking);
      if (this.hrm && this.hrm !== m) this.hrm.disconnect();
      this.hrm = m;
      m.addEventListener('status', update);
      update();
    } catch (err) {
      m.removeEventListener('status', waking);
      const msg = this.explainBleError(err);
      if (this.hrm?.connected) this.setDevice('hr', { state: 'ready', name: this.hrm.name, message: '' });
      else this.setDevice('hr', { state: 'off', message: msg || '' });
      if (msg) this.toast({ title: 'Heart rate didn’t connect', body: msg });
    }
  }

  disconnectHeart() {
    this.hrm?.disconnect();
    this.hrm = null;
    this.setDevice('hr', { ...OFF });
  }

  // ---------------------------------------------------------------- input

  // +1 harder / −1 easier, from a Click, the keyboard or the screen.
  // Both together (held 0.35 s) = pause/resume, or dismiss a toast.
  press(dir) {
    if (!dir) return;
    const now = performance.now();
    this.held.add(dir);
    if (this.held.has(1) && this.held.has(-1)) {
      this.shifter.releaseAll();
      // The first button of the chord already shifted; take it back quietly.
      if (this.lastPress?.changed && now - this.lastPress.at < 400) {
        this.quiet = true;
        this.engine.shift(-this.lastPress.dir);
        this.quiet = false;
      }
      clearTimeout(this.chordTimer);
      this.chordTimer = setTimeout(() => this.chord(), 350);
      return;
    }
    const before = this.helmMark();
    this.shifter.press(dir);
    this.lastPress = { dir, at: now, changed: this.helmMark() !== before };
  }

  // What a Click changes: gear, ERG bias or the autopilot's HR target.
  helmMark() {
    const e = this.engine;
    return `${e.gear}|${e.bias}|${e.autopilot?.targetHr ?? ''}`;
  }

  release(dir) {
    if (!dir) return;
    this.held.delete(dir);
    this.shifter.release(dir);
    clearTimeout(this.chordTimer);
  }

  chord() {
    if (this.state.toast) return this.dismissToast();
    if (this.state.rideState === 'riding') this.pause();
    else if (this.state.rideState === 'paused') this.resume();
  }

  // ---------------------------------------------------------------- engine events

  wireEngine() {
    const on = (type, fn) => this.engine.addEventListener(type, (e) => fn(e.detail));
    on('shift', (d) => {
      const snap = this.engine.snapshot();
      const before = ratioFor(d.gear - d.direction);
      const cost = Math.round(snap.power * (d.ratio / before - 1));
      if (!this.quiet) sound.playShift(d.direction, d.gear);
      this.emit('shift', { ...d, cost, cadence: snap.cadence, quiet: this.quiet });
      this.live.set({ snap });
    });
    on('limit', (d) => {
      sound.playLimit();
      this.emit('limit', d);
    });
    on('bias', (d) => {
      if (d.limited) sound.playLimit();
      else if (!this.quiet) sound.playErgNudge(d.direction);
      this.emit('bias', d);
      this.publishSoon();
    });
    on('autopilot-target', (d) => {
      if (!this.quiet) sound.playAutopilotNudge();
      this.emit('autopilot-target', d);
      this.publishSoon();
    });
    on('interval', (d) => {
      if (d.index > 0) {
        const f = d.step.type === 'steady' ? d.step.power : d.step.type === 'ramp' ? d.step.from : null;
        const prev = this.engine.workout?.steps[d.index - 1];
        const pf = prev?.type === 'steady' ? prev.power : prev?.type === 'ramp' ? prev.to : 0;
        const recovery = f == null || f < pf;
        sound.playGo({ recovery, hard: (f ?? 0) >= 0.91 });
      }
      this.emit('interval', d);
    });
    on('countdown', (d) => {
      sound.playCountdown();
      this.emit('countdown', d);
    });
    on('workout-complete', () => {
      if (this.state.plan?.kind === 'ramp') return;
      sound.playChime();
      this.toast({ title: 'Workout done.', body: 'Keep riding, or pause to end and save.', ms: 9000 });
    });
    on('bailout', (d) =>
      this.toast(d.active ? { title: 'ERG paused', body: 'Pedal back up to the target and it picks up again.' } : { title: 'ERG back on', body: 'Holding your target again.', ms: 3000 }),
    );
    on('summit', (d) => {
      this.summited = true;
      sound.playChime();
      const r = this.state.route;
      this.toast({ title: 'Summit.', body: `${r?.name ?? ''} — the rest is downhill.`, ms: 7000 });
      this.emit('summit', d);
    });
    on('lap', (d) => {
      this.laps = d.lap;
      // The lap's time (just announced by the attempt) matters more than "Lap N".
      if (performance.now() - (this.lastAttemptAt ?? -Infinity) < 4000) return;
      this.toast({ title: `Lap ${d.lap + 1}`, body: this.state.route?.name ?? '', ms: 4000 });
    });
    on('fuel', (d) => {
      sound.playFuel();
      this.toast({ kind: 'fuel', title: 'Fuel up', body: `${d.minutes} min in. A bite and a sip.`, action: 'Done', ms: 90000 });
    });
  }

  // Bias and HR-target changes land before the engine has re-targeted the
  // trainer; publish on the next microtask so the snapshot includes both.
  publishSoon() {
    queueMicrotask(() => this.live.set({ snap: this.engine.snapshot() }));
  }

  // ---------------------------------------------------------------- ride lifecycle

  // Called from a tap: unlocks audio and the wake lock in the same gesture.
  ride(plan) {
    sound.unlockAudio();
    this.requestWakeLock();
    // A ride left behind by a crash would be overwritten by this one's
    // checkpoints: save it first.
    this.salvageCheckpoint();
    const prefs = this.state.prefs;
    const e = this.engine;
    const roadKey = plan.routeId ?? plan.route?.id ?? (plan.kind === 'route' ? plan.id : null);
    this.difficultyOverride = roadKey ? prefs.routeDifficulty?.[roadKey] ?? null : null;
    e.updateSettings(this.engineSettingsNow());
    e.setAutopilot(null);
    e.setWorkout(null);
    e.setRoute(null);
    e.setErgEnabled(true);
    e.reset();
    if (plan.workout) e.setWorkout(plan.workout);
    if (plan.kind === 'autopilot') {
      const z = zone2(prefs);
      const cfg = autopilotDefaults({ ftp: prefs.ftp, zoneMin: z.min, zoneMax: z.max });
      e.setAutopilot(cfg);
    }
    this.rampDetector = plan.kind === 'ramp' ? new RampFailureDetector() : null;
    this.rampFtp = null;
    this.summited = false;
    this.laps = 0;
    this.planDoneSaid = false;
    this.startAcc = 0;
    this.drift = { out: 0, lastBell: -Infinity };
    this.attempt = null;
    this.attemptLog = [];
    this.pendingBest = null;
    this.goalDone = false;
    this.awayAt = null;
    if (this.trainer instanceof SimulatedTrainer) this.trainer.setEffort(Math.round(prefs.ftp * 0.72));
    this.set({ screen: 'ride', plan, route: null, routeError: null, rideState: 'ready', tv: false, sheet: null, result: null, toast: null });
    this.loadPlanRoute(plan);
  }

  async loadPlanRoute(plan) {
    const prefs = this.state.prefs;
    try {
      let route = plan.route ?? null;
      if (!route) {
        const id = plan.routeId ?? (plan.kind === 'route' ? plan.id : plan.kind === 'free' ? prefs.freeRouteId : prefs.workoutRouteId);
        route = await loadRoute(id);
      }
      if (this.state.plan !== plan) return;
      this.engine.setRoute(route);
      // Race your best over this road (one attempt per climb or per lap).
      this.attempt = new AttemptTracker(route, history.loadBest(route.id));
      // A road's own difficulty may only be known now (runs, segments, GPX).
      if (this.difficultyOverride == null && prefs.routeDifficulty?.[route.id] != null) {
        this.difficultyOverride = prefs.routeDifficulty[route.id];
        this.engine.updateSettings(this.engineSettingsNow());
      }
      this.set({ route });
    } catch (err) {
      this.set({ routeError: err.message });
    }
  }

  start() {
    if (this.state.rideState !== 'ready') return;
    this.engine.start();
    this.set({ rideState: 'riding' });
  }

  pause() {
    if (this.state.rideState !== 'riding') return;
    this.engine.pause();
    sound.playPause(false);
    this.saveCheckpoint();
    this.set({ rideState: 'paused', sheet: { type: 'pause' } });
  }

  resume() {
    if (this.state.rideState === 'ready') return this.start();
    if (this.state.rideState !== 'paused') return;
    sound.unlockAudio();
    this.requestWakeLock();
    this.engine.resume();
    sound.playPause(true);
    this.set({ rideState: 'riding', sheet: null });
  }

  // Back to a flat road in the current gear (nothing left steering the trainer).
  idleEngine() {
    const e = this.engine;
    e.setWorkout(null);
    e.setAutopilot(null);
    e.setRoute(null);
    e.reset();
    this.attempt = null;
    this.difficultyOverride = null;
    e.updateSettings(this.engineSettingsNow());
  }

  // Leave a ride that never started.
  leave() {
    this.idleEngine();
    this.releaseWakeLock();
    this.set({ screen: 'home', plan: null, route: null, rideState: 'idle', tv: false, sheet: null });
    this.applySound();
  }

  discard() {
    this.engine.finish();
    history.clearCheckpoint();
    this.leave();
    this.set({ checkpoint: null });
  }

  finish() {
    const { plan, route, prefs, recent } = this.state;
    const photo = this.capturePhoto?.() ?? null;
    const ride = this.engine.finish();
    const workoutDone = this.engine.workoutDone;
    if (this.pendingBest && ride.samples.length >= 60) history.saveBest(this.pendingBest.routeId, this.pendingBest.best);
    this.pendingBest = null;
    this.idleEngine();
    this.releaseWakeLock();
    if (ride.samples.length < 60) {
      history.clearCheckpoint();
      this.set({ screen: 'home', plan: null, route: null, rideState: 'idle', tv: false, sheet: null, checkpoint: null });
      this.toast({ title: 'Not saved', body: 'That ride was under a minute.' });
      this.applySound();
      return;
    }
    const liftedBefore = !!(recent.liftAt && ride.startedAt - recent.liftAt < 6 * 3600 * 1000 && ride.startedAt > recent.liftAt);
    const result = this.buildResult({
      samples: ride.samples,
      startedAt: ride.startedAt,
      plan,
      route,
      prefs,
      photo,
      climbedM: ride.climbedM,
      movingTimeS: ride.movingTimeS,
      summited: this.summited,
      laps: this.laps,
      rampFtp: plan?.kind === 'ramp' ? this.rampFtp ?? ftpFromRamp(ride.samples.map((s) => s.power ?? 0)) : null,
      liftedBefore,
      workoutDone,
      attempts: this.attemptLog,
      goal: plan?.goalM ? { goalM: plan.goalM, reached: ride.climbedM >= plan.goalM } : null,
    });
    this.keepForStrava(result);
    if (this.state.week) this.set({ week: this.weekWithLocal(this.activities ? weekSummary(this.activities) : null) });
    history.clearCheckpoint();
    this.set({ screen: 'summary', result, rideState: 'done', tv: false, sheet: null, checkpoint: null, lastRide: result.entry, toast: null });
    this.applySound();
    if (result.upload.status === 'busy') this.upload();
  }

  buildResult({ samples, startedAt, plan, route, prefs, photo, climbedM, movingTimeS, summited, laps, rampFtp, liftedBefore, workoutDone, attempts = [], goal = null }) {
    const summary = summarize(samples, prefs.ftp);
    const minutes = Math.round(movingTimeS / 60);
    const z = zone2(prefs);
    const hrs = samples.filter((s) => s.heartRate > 0);
    const zoneShare = hrs.length ? hrs.filter((s) => s.heartRate >= z.min && s.heartRate <= z.max).length / hrs.length : 0;
    const powerZones = [0, 0, 0, 0, 0, 0];
    const bounds = [0.56, 0.76, 0.91, 1.06, 1.21];
    for (const s of samples) {
      const f = (s.power ?? 0) / prefs.ftp;
      powerZones[bounds.findIndex((b) => f < b) === -1 ? 5 : bounds.findIndex((b) => f < b)]++;
    }
    const hrZones = [0, 0, 0, 0, 0];
    for (const s of hrs) hrZones[hrZoneIndex(s.heartRate, prefs.hrZones) ?? 0]++;
    const prevBefore = attempts[0]?.prevTimeS ?? null;
    const fastest = attempts.length ? Math.min(...attempts.map((a) => a.timeS)) : null;
    const newBest = prevBefore != null && fastest < prevBefore;
    const headline = rideHeadline({ plan, route, minutes, summited, laps, zoneShare, rampFtp, liftedBefore, workoutDone, distanceM: summary.distanceM, units: prefs.units, newBest, goal });
    // Zone 2 fitness check: on autopilot rides and other steady, mostly-Z2 rides.
    const steady = plan?.kind === 'autopilot' || (!plan?.workout && zoneShare >= 0.6 && (powerVariability(samples) ?? 1) < 0.2);
    const aerobic = steady ? aerobicCheck(samples) : null;
    const efTrend = aerobic
      ? history
          .loadHistory()
          .filter((e) => e.ef && e.at > startedAt - 90 * 86400000 && e.at < startedAt)
          .slice(0, 9)
          .reverse()
          .map((e) => ({ at: e.at, ef: e.ef }))
          .concat([{ at: startedAt, ef: aerobic.ef }])
      : null;
    // Best power over 5 s, 1, 5 and 20 min — this ride and all time.
    const curve = powerCurve(samples.map((s) => s.power ?? 0));
    const merged = mergePowerBests(history.loadPowerBests(), curve, startedAt);
    history.savePowerBests(merged.next);
    const fit = encodeActivity(samples, { summary, ftp: prefs.ftp });
    const id = `cogride-${startedAt}`;
    const name = activityName(plan, route, minutes);
    const description = activityDescription({ plan, route, climbedM, zoneShare, rampFtp, prefs });
    const entry = {
      id,
      at: startedAt,
      name,
      kind: plan?.kind ?? 'route',
      minutes,
      distanceM: summary.distanceM,
      climbedM,
      tss: summary.tss,
      avgPower: summary.avgPower,
      avgHr: summary.avgHeartRate,
      ef: aerobic?.ef ?? null,
      decoupling: aerobic?.decoupling ?? null,
    };
    history.addHistory(entry);
    const canUpload = strava.canUpload();
    return {
      id,
      entry,
      samples,
      summary,
      fit,
      photo,
      headline,
      name,
      description,
      climbedM,
      movingTimeS,
      zoneShare,
      powerZones,
      hrZones,
      rampFtp,
      plan,
      aerobic,
      efTrend,
      powerCurve: curve,
      powerBests: merged.next,
      powerImproved: merged.improved,
      attempts,
      goal,
      routeName: route?.name ?? null,
      routeKind: route?.kind ?? null,
      upload: { status: canUpload && prefs.autoUpload ? 'busy' : canUpload ? 'idle' : 'off', attempt: 0 },
    };
  }

  // Park the FIT in the upload queue before trying, so a closed app or a
  // later Strava connection still gets it there. Removed once uploaded.
  keepForStrava(result) {
    if (result.upload.status === 'busy' || result.upload.status === 'off') {
      strava.queueUpload(result.fit, { name: result.name, description: result.description, externalId: result.id });
      this.set({ strava: this.stravaState() });
    }
  }

  // Quietly save a crashed ride's checkpoint (history + Strava queue).
  salvageCheckpoint() {
    const cp = history.loadCheckpoint();
    if (!cp) return false;
    const result = this.resultFromCheckpoint(cp);
    this.keepForStrava(result);
    history.clearCheckpoint();
    this.set({ checkpoint: null, lastRide: result.entry });
    if (strava.canUpload()) {
      strava
        .flushUploadQueue()
        .then((done) => this.afterFlush(done))
        .catch(() => {})
        .finally(() => this.set({ strava: this.stravaState() }));
    }
    return true;
  }

  resultFromCheckpoint(cp) {
    const samples = cp.samples;
    let climbed = 0;
    for (let i = 1; i < samples.length; i++) {
      const d = (samples[i].altitude ?? 0) - (samples[i - 1].altitude ?? 0);
      if (d > 0) climbed += d;
    }
    return this.buildResult({
      samples,
      startedAt: cp.meta?.startedAt ?? samples[0].time,
      plan: cp.meta?.plan ?? null,
      route: cp.meta?.routeName ? { name: cp.meta.routeName, kind: cp.meta.routeKind } : null,
      prefs: this.state.prefs,
      photo: null,
      climbedM: climbed,
      movingTimeS: samples.length,
      summited: false,
      laps: 0,
      rampFtp: null,
      liftedBefore: false,
      workoutDone: false,
    });
  }

  setUpload(patch) {
    const result = this.state.result;
    if (!result) return;
    this.set({ result: { ...result, upload: { ...result.upload, ...patch } } });
  }

  async upload() {
    const result = this.state.result;
    if (!result || !strava.canUpload()) return;
    clearTimeout(this.retryTimer);
    const attempt = (result.upload.attempt ?? 0) + 1;
    this.setUpload({ status: 'busy', attempt, message: '' });
    const meta = { name: result.name, description: result.description, externalId: result.id };
    try {
      const r = await strava.uploadFit(result.fit, meta);
      strava.removeQueued(result.id);
      history.updateHistory(result.id, { stravaId: r.activityId });
      this.setUpload({ status: 'ok', activityId: r.activityId, duplicate: r.duplicate, at: Date.now() });
      this.set({ strava: this.stravaState() });
    } catch (err) {
      strava.queueUpload(result.fit, meta);
      this.setUpload({ status: 'err', message: err.message });
      this.set({ strava: this.stravaState() });
      // Back off: 30 s, 2 min, 10 min; after that, the next app open retries.
      const wait = [30, 120, 600][attempt - 1];
      if (wait) this.retryTimer = setTimeout(() => this.state.result?.id === result.id && this.upload(), wait * 1000);
    }
  }

  // An unfinished ride left by a reload or crash: save it now.
  recoverCheckpoint() {
    const cp = history.loadCheckpoint();
    if (!cp) return this.set({ checkpoint: null });
    const result = this.resultFromCheckpoint(cp);
    this.keepForStrava(result);
    history.clearCheckpoint();
    this.set({ screen: 'summary', result, checkpoint: null, lastRide: result.entry });
    if (result.upload.status === 'busy') this.upload();
  }

  dropCheckpoint() {
    history.clearCheckpoint();
    this.set({ checkpoint: null });
  }

  saveCheckpoint() {
    const { plan, route } = this.state;
    if (!this.engine.samples.length) return;
    history.saveCheckpoint(
      {
        startedAt: this.engine.startedAt,
        plan: plan ? { kind: plan.kind, id: plan.id, title: plan.title, minutes: plan.minutes } : null,
        routeName: route?.name ?? null,
        routeKind: route?.kind ?? null,
      },
      this.engine.samples,
    );
  }

  closeSummary() {
    clearTimeout(this.retryTimer);
    this.set({ screen: 'home', result: null, plan: null, route: null, rideState: 'idle' });
  }

  useRampFtp(ftp) {
    this.setPrefs({ ftp, ftpSource: 'ramp' });
    this.toast({ title: `FTP set to ${ftp} W`, body: 'Workouts and zones now use it.', ms: 4000 });
  }

  // ---------------------------------------------------------------- the loop

  tick() {
    const now = performance.now();
    // A suspended page (backgrounded) must not integrate a huge step.
    const dt = Math.min(1, (now - this.lastTick) / 1000);
    this.lastTick = now;
    const e = this.engine;
    e.tick(dt);
    const snap = e.snapshot();
    const s = this.state;

    if (s.screen === 'ride') {
      // Start rolling when he starts pedalling, like getting on a real bike.
      if (s.rideState === 'ready' && s.route) {
        this.startAcc = snap.powerInstant > 35 ? this.startAcc + dt : 0;
        if (this.startAcc >= 1.5) this.start();
      }
      if (s.rideState === 'riding') {
        this.secondAcc += dt;
        if (this.secondAcc >= 1) {
          this.secondAcc -= 1;
          this.everySecond(snap);
        }
        this.checkpointAcc += dt;
        if (this.checkpointAcc >= CHECKPOINT_S) {
          this.checkpointAcc = 0;
          this.saveCheckpoint();
        }
      }
    }
    this.live.set({ snap, race: this.race(snap) });
  }

  // Racing your best over this road: attempts, ahead/behind, the ghost.
  race(snap) {
    const a = this.attempt;
    const s = this.state;
    if (!a || !snap.route || s.screen !== 'ride') return null;
    if (s.rideState === 'riding') {
      const ev = a.update(snap.route, snap.movingTime);
      if (ev?.kind === 'finish') this.attemptFinished(ev);
    }
    const delta = a.delta(snap.route, snap.movingTime);
    const ghost = s.prefs.ghost !== false ? a.ghostTotal(snap.movingTime) : null;
    return { delta, ghost, bestS: a.best?.timeS ?? null, active: !!a.current };
  }

  attemptFinished(ev) {
    const route = this.state.route;
    const name = route?.name?.replace(/\s*\(.*\)$/, '') ?? 'this road';
    const prevTimeS = ev.best?.timeS ?? null;
    this.attemptLog.push({ timeS: ev.timeS, isBest: ev.isBest, prevTimeS });
    this.lastAttemptAt = performance.now();
    if (ev.isBest) {
      // Kept until the ride is saved — a discarded ride sets no best.
      this.pendingBest = { routeId: route.id, best: { timeS: ev.timeS, splits: ev.splits, lengthM: ev.lengthM, at: Date.now() } };
      sound.playChime();
      if (prevTimeS != null) this.toast({ title: `New best: ${mmss(ev.timeS)}`, body: `${name}, ${mmss(prevTimeS - ev.timeS)} faster than before.`, ms: 9000 });
      else this.toast({ title: `${name}: ${mmss(ev.timeS)}`, body: 'Your first time here. Next time you’ll race this ride.', ms: 9000 });
    } else {
      this.toast({ title: `${name}: ${mmss(ev.timeS)}`, body: `${mmss(ev.timeS - prevTimeS)} off your best of ${mmss(prevTimeS)}.`, ms: 9000 });
    }
  }

  everySecond(snap) {
    const plan = this.state.plan;
    // Ramp test: over when the cadence collapses after the ramp has begun.
    if (this.rampDetector && this.rampFtp == null && snap.workout) {
      const rampStarted = snap.workout.clock > 300;
      if (this.rampDetector.update(snap.cadence, rampStarted)) {
        this.rampFtp = ftpFromRamp(this.engine.samples.map((x) => x.power ?? 0));
        const ftp = this.state.prefs.ftp;
        this.engine.setWorkout({ id: 'cool', name: 'Cool down', steps: [{ type: 'steady', duration: 600, power: Math.min(0.5, 100 / ftp), label: 'Cool down' }] });
        sound.playChime();
        this.toast({ title: `Test over. FTP ≈ ${this.rampFtp} W`, body: 'Spin easy for a few minutes, then end the ride to save it.', ms: 15000 });
      }
    }
    // Zone 2 autopilot: one soft bell if HR stays out of the band for 20 s.
    if (plan?.kind === 'autopilot' && snap.heartRate) {
      const z = zone2(this.state.prefs);
      const out = snap.heartRate < z.min || snap.heartRate > z.max;
      this.drift.out = out ? this.drift.out + 1 : 0;
      if (this.drift.out >= 20 && snap.movingTime - this.drift.lastBell > 120 && snap.movingTime > 300) {
        this.drift.lastBell = snap.movingTime;
        sound.playBell();
      }
    }
    // Climb goal reached.
    if (plan?.goalM && !this.goalDone && snap.climbed >= plan.goalM) {
      this.goalDone = true;
      sound.playChime();
      const ft = this.state.prefs.units === 'metric' ? `${Math.round(plan.goalM)} m` : `${Math.round(plan.goalM / 0.3048).toLocaleString('en-US')} ft`;
      this.toast({ title: `${ft} climbed.`, body: 'Goal done. Ride on, or pause to end.', ms: 10000 });
    }
    // Autopilot plan length reached: say so once, keep riding.
    if (plan?.minutes && plan.kind === 'autopilot' && !this.planDoneSaid && snap.movingTime >= plan.minutes * 60) {
      this.planDoneSaid = true;
      sound.playChime();
      this.toast({ title: `${plan.minutes} minutes.`, body: 'That’s the plan done. Ride on, or pause to end.', ms: 10000 });
    }
  }

  // ---------------------------------------------------------------- sheets, toasts, TV

  openSheet(sheet) {
    this.set({ sheet });
  }

  closeSheet() {
    if (this.state.sheet?.type === 'pause') return this.resume();
    this.set({ sheet: null });
  }

  toast({ kind = 'info', title, body = '', action = null, ms = 6000 }) {
    clearTimeout(this.toastTimer);
    const toast = { id: Date.now(), kind, title, body, action };
    this.set({ toast });
    this.toastTimer = setTimeout(() => this.state.toast?.id === toast.id && this.set({ toast: null }), ms);
  }

  dismissToast() {
    clearTimeout(this.toastTimer);
    this.set({ toast: null });
  }

  setTv(on) {
    this.set({ tv: on });
    this.applySound();
  }

  // ---------------------------------------------------------------- library

  async loadRuns() {
    if (!strava.isConnected()) return;
    this.set({ runsState: 'loading' });
    try {
      const runs = await strava.fetchRideableRuns();
      this.set({ runs, runsState: 'idle' });
    } catch (err) {
      this.set({ runsState: 'error', runsError: err.message });
    }
  }

  async loadSegments() {
    if (!strava.isConnected()) return;
    this.set({ segmentsState: 'loading' });
    try {
      const segments = await strava.fetchStarredSegments();
      this.set({ segments, segmentsState: 'idle' });
    } catch (err) {
      this.set({ segmentsState: 'error', segmentsError: err.message });
    }
  }

  // Any Strava segment — starred, or a pasted link — as a road to ride.
  async rideSegment(idOrLink, name = '') {
    const id = strava.parseSegmentId(idOrLink);
    if (!id) {
      const effort = /activities\/\d+\/segments/.test(String(idOrLink));
      this.toast({
        title: effort ? 'That’s one effort, not the segment' : 'That’s not a segment link',
        body: effort ? 'Open the segment itself (tap its name on Strava) and copy that link.' : 'Paste a link like strava.com/segments/229781.',
        ms: 8000,
      });
      return;
    }
    if (!strava.isConnected()) {
      this.openSheet({ type: 'settings', focus: 'strava' });
      return;
    }
    this.set({ sheet: { type: 'plan', loading: true, title: name || 'Strava segment' } });
    try {
      const track = await strava.fetchSegmentTrack(id);
      const route = routeFromPoints({ name: track.name, points: track.points, id: `seg-${id}`, kind: 'segment', source: 'strava' });
      this.set({ sheet: { type: 'plan', plan: { kind: 'segment', id: route.id, title: route.name, route } } });
    } catch (err) {
      this.set({ sheet: null });
      this.toast({ title: 'Couldn’t load that segment', body: err.message });
    }
  }

  async rideRun(run) {
    // Fetch first (async), then ask for a tap to start: audio and wake lock
    // need the gesture.
    this.set({ sheet: { type: 'plan', loading: true, title: run.name } });
    try {
      const track = await strava.fetchActivityTrack(run.id);
      const route = routeFromPoints({ name: track.name, points: track.points, id: `strava-${run.id}`, kind: 'run', source: 'strava' });
      this.set({ sheet: { type: 'plan', plan: { kind: 'run', id: route.id, title: route.name, route } } });
    } catch (err) {
      this.set({ sheet: null });
      this.toast({ title: 'Couldn’t load that run', body: err.message });
    }
  }

  importGpx(text, filename = '') {
    try {
      const route = routeFromGpx(text, { id: `gpx-${hashString(text.slice(0, 5000))}` });
      if (!route.name || route.name === 'Imported route') route.name = filename.replace(/\.gpx$/i, '') || 'Imported route';
      this.set({ sheet: { type: 'plan', plan: { kind: 'gpx', id: route.id, title: route.name, route } } });
    } catch (err) {
      this.toast({ title: 'Couldn’t read that GPX', body: err.message });
    }
  }

  saveWorkout({ id, name, text, xml }) {
    let workout;
    if (xml) {
      const parsed = parseZwo(xml);
      workout = { id: `zwo-${hashString(xml.slice(0, 4000))}`, name: parsed.name || 'Imported workout', description: parsed.description || '', steps: parsed.steps, text: null };
    } else {
      const steps = parseWorkoutText(text);
      workout = { id: id || `custom-${Date.now()}`, name: name?.trim() || 'My workout', description: '', steps, text };
    }
    const list = this.state.customWorkouts.filter((w) => w.id !== workout.id);
    list.unshift(workout);
    history.saveCustomWorkouts(list);
    this.set({ customWorkouts: list });
    return workout;
  }

  deleteWorkout(id) {
    const list = this.state.customWorkouts.filter((w) => w.id !== id);
    history.saveCustomWorkouts(list);
    this.set({ customWorkouts: list });
  }

  rampTest() {
    return rampPlan(this.state.prefs.ftp);
  }

  workoutPlan(w) {
    return workoutPlan(w);
  }

  // ---------------------------------------------------------------- Strava

  connectStrava({ clientId, clientSecret }) {
    const url = strava.authorizeUrl({ clientId, clientSecret });
    location.href = url;
  }

  disconnectStrava() {
    strava.disconnect();
    this.set({ strava: this.stravaState() });
  }

  // ---------------------------------------------------------------- platform

  async requestWakeLock() {
    try {
      navigator.bluetooth?.setScreenDimEnabled?.(false);
    } catch {
      // Bluefy-only
    }
    try {
      if (navigator.wakeLock && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        this.wakeLock.addEventListener?.('release', () => (this.wakeLock = null));
      }
    } catch {
      // Not allowed without a tap; Auto-Lock › Never is the fallback.
    }
  }

  releaseWakeLock() {
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
    try {
      navigator.bluetooth?.setScreenDimEnabled?.(true);
    } catch {
      // ignore
    }
  }

  onVisibility() {
    const riding = this.state.rideState === 'riding' || this.state.rideState === 'paused';
    if (document.visibilityState === 'hidden') {
      if (riding) {
        this.saveCheckpoint();
        this.awayAt = Date.now();
      }
      return;
    }
    sound.resumeAudio();
    if (this.state.screen === 'ride') this.requestWakeLock();
    this.lastTick = performance.now();
    const away = this.awayAt ? (Date.now() - this.awayAt) / 1000 : 0;
    this.awayAt = null;
    // Say what happened while he was in another app (after reconnects settle).
    if (riding && away >= 5) setTimeout(() => this.welcomeBack(away), 2500);
  }

  welcomeBack(away) {
    if (this.state.screen !== 'ride') return;
    const t = this.state.devices.trainer.state;
    const devices =
      t === 'ready'
        ? 'Trainer’s connected.'
        : t === 'connecting'
          ? 'Reconnecting the trainer…'
          : 'The trainer dropped — pause, then tap Connect trainer.';
    const counted = this.state.rideState === 'paused' ? '' : ' That time wasn’t recorded.';
    this.toast({ title: `Welcome back — away ${mmss(away)}`, body: `${devices}${counted}`, ms: 7000 });
  }
}

function mmss(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function activityName(plan, route, minutes) {
  if (!plan) return route ? `${route.name} · CogRide` : 'CogRide ride';
  if (plan.kind === 'autopilot') return `Zone 2 autopilot · ${minutes} min`;
  if (plan.kind === 'ramp') return 'FTP ramp test';
  if (plan.kind === 'workout') return `${plan.title}${route ? ` · ${route.name}` : ''}`;
  if (plan.kind === 'run') return `${route?.name ?? plan.title} (ridden)`;
  if (plan.kind === 'segment') return `${route?.name ?? plan.title} (segment, ridden)`;
  if (plan.kind === 'vert') return `Climb goal · ${route?.name ?? ''}`.trim();
  return route?.name ?? plan.title ?? 'CogRide ride';
}

export function activityDescription({ plan, route, climbedM, zoneShare, rampFtp, prefs }) {
  const parts = [];
  if (plan?.kind === 'autopilot' && zoneShare) parts.push(`${Math.round(zoneShare * 100)}% of the ride in Zone 2.`);
  if (rampFtp) parts.push(`Ramp test FTP estimate: ${rampFtp} W.`);
  if (climbedM > 30) {
    const ft = Math.round(climbedM / 0.3048).toLocaleString('en-US');
    parts.push(prefs.units === 'metric' ? `${Math.round(climbedM)} m climbed.` : `${ft} ft climbed.`);
  }
  if (route && !['route', 'run', 'gpx', 'segment', 'vert'].includes(plan?.kind)) parts.push(`Virtual road: ${route.name}.`);
  parts.push('Ridden indoors with CogRide (virtual shifting, Zwift Cog + Click).');
  return parts.join(' ');
}
