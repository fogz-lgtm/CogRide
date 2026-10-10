// Synthesised cues (no audio files), quiet enough to sit under a show's
// dialogue. Everything runs through a compressor and a 6 kHz low-pass so
// nothing is shrill at night.
//
// iPhone notes: only Web Audio is used (an <audio>/<video> element would
// take over the audio session and pause the show in Picture in Picture), the
// session is set to 'ambient' so cues mix with other apps, and the context
// must be created inside a tap — call unlockAudio() from one.

let ctx = null;
let out = null;
let level = 'normal'; // 'normal' | 'quiet' | 'off'
let lastTick = 0;

const LEVEL_GAIN = { normal: 1, quiet: 0.5, off: 0 };
const db = (v) => Math.pow(10, v / 20);

export function setSoundLevel(value) {
  level = LEVEL_GAIN[value] != null ? value : 'normal';
  if (out) out.gain.value = LEVEL_GAIN[level];
}

export function soundLevel() {
  return level;
}

// True when the page can promise its cues won't interrupt other apps' audio.
export function ambientAudioSupported() {
  return typeof navigator !== 'undefined' && !!navigator.audioSession;
}

export function unlockAudio() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.12;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6000;
      out = ctx.createGain();
      out.gain.value = LEVEL_GAIN[level];
      lp.connect(comp).connect(out).connect(ctx.destination);
      out.input = lp;
    }
    if (ctx.state !== 'running') ctx.resume();
    // A silent blip fully unlocks iOS WebKit's audio.
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(out.input);
    s.start(0);
  } catch {
    // sound is optional
  }
}

// iOS can suspend or 'interrupt' the context (calls, other apps); wake it.
export function resumeAudio() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}

function ready() {
  if (!ctx || level === 'off') return false;
  if (ctx.state !== 'running') {
    ctx.resume().catch(() => {});
    return false;
  }
  return true;
}

// One enveloped oscillator. peak in dBFS.
function tone({ type = 'sine', freq, glideFrom, glideTo, glideMs = 25, at = 0, attack = 0.002, decay = 0.05, stop, peak = -22 }) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(glideFrom ?? freq, t);
  if (glideFrom != null || glideTo != null) osc.frequency.exponentialRampToValueAtTime(glideTo ?? freq, t + glideMs / 1000);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(db(peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay * 4.6);
  osc.connect(g).connect(out.input);
  osc.start(t);
  osc.stop(t + (stop ?? attack + decay * 5));
}

let noiseBuffer = null;
function noise({ at = 0, ms = 4, band = 3200, q = 1.2, type = 'bandpass', peak = -24, decay = 0.006 }) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.05, ctx.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = band;
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(db(peak), t + 0.0005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(ms / 1000, decay * 4.6));
  src.connect(f).connect(g).connect(out.input);
  src.start(t);
  src.stop(t + 0.05);
}

// 9.1 Shift: a paper click plus a small wooden body whose pitch climbs about
// half a semitone per gear, so a run of shifts plays a little scale.
export function playShift(direction, gear = 12, body = 520) {
  if (!ready()) return;
  const now = performance.now();
  if (now - lastTick < 45) return;
  lastTick = now;
  const f0 = body * Math.pow(2, (gear - 12) / 24);
  noise({ ms: 4, band: 3200, q: 1.2, peak: -26 });
  if (direction > 0) tone({ type: 'triangle', freq: f0, glideFrom: 0.97 * f0, glideTo: f0, at: 0.002, attack: 0.001, decay: 0.022, stop: 0.072, peak: -22 });
  else tone({ type: 'triangle', freq: f0, glideFrom: 1.03 * f0, glideTo: 0.94 * f0, at: 0.002, attack: 0.001, decay: 0.022, stop: 0.072, peak: -22 });
}

// 9.3 Limit thunk at gear 1 or 24 (and at the ERG bias limit).
export function playLimit() {
  if (!ready()) return;
  tone({ freq: 180, attack: 0.002, decay: 0.02, stop: 0.12, peak: -20 });
  tone({ freq: 360, attack: 0.002, decay: 0.02, stop: 0.12, peak: -32 });
  noise({ ms: 10, band: 600, type: 'lowpass', q: 0.7, peak: -28, decay: 0.004 });
}

// 9.3b ERG nudge: the shift voice a fifth up.
export function playErgNudge(direction) {
  playShift(direction, 12, 780);
}

// 9.3c Autopilot nudge.
export function playAutopilotNudge() {
  if (!ready()) return;
  tone({ freq: 440, attack: 0.003, decay: 0.009, peak: -24 });
}

// 9.4 Countdown pips at T−3, −2, −1.
export function playCountdown() {
  if (!ready()) return;
  tone({ freq: 660, attack: 0.005, decay: 0.018, stop: 0.09, peak: -22 });
}

// 9.5 Go: a bright dyad for work, a descending pair for recovery.
export function playGo({ recovery = false, hard = false } = {}) {
  if (!ready()) return;
  if (recovery) {
    tone({ freq: 660, attack: 0.01, decay: 0.05, stop: 0.3, peak: -22 });
    tone({ freq: 440, at: 0.12, attack: 0.01, decay: 0.06, stop: 0.35, peak: -22 });
    return;
  }
  tone({ freq: 880, attack: 0.01, decay: 0.057, stop: 0.32, peak: -21 });
  tone({ freq: 1320, attack: 0.01, decay: 0.057, stop: 0.32, peak: -23 });
  tone({ freq: 1760, attack: 0.01, decay: 0.04, stop: 0.25, peak: hard ? -33 : -42 });
}

// 9.6 Fuel reminder: three marimba-ish notes.
export function playFuel() {
  if (!ready()) return;
  [784, 1047, 1319].forEach((f, i) => {
    tone({ freq: f, at: i * 0.12, attack: 0.003, decay: 0.05, stop: 0.3, peak: -24 });
    tone({ freq: f * 4, at: i * 0.12, attack: 0.002, decay: 0.013, stop: 0.08, peak: -42 });
  });
}

// 9.7 Zone 2 drift-out bell.
export function playBell() {
  if (!ready()) return;
  tone({ freq: 587, attack: 0.004, decay: 0.087, stop: 0.6, peak: -24 });
  tone({ freq: 1174, attack: 0.004, decay: 0.06, stop: 0.5, peak: -39 });
}

// 9.8 Pause / resume.
export function playPause(resume = false) {
  if (!ready()) return;
  const [a, b] = resume ? [392, 523] : [523, 392];
  tone({ freq: a, attack: 0.005, decay: 0.016, stop: 0.08, peak: -24 });
  tone({ freq: b, at: 0.08, attack: 0.005, decay: 0.016, stop: 0.08, peak: -24 });
}

// A soft chime (summit, workout done).
export function playChime() {
  if (!ready()) return;
  [523, 659, 784].forEach((f, i) => tone({ freq: f, at: i * 0.09, attack: 0.006, decay: 0.08, stop: 0.5, peak: -24 }));
}
