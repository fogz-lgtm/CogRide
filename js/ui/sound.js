// Synthesised UI sounds (no audio files): shift clicks, interval cues.
// iOS only allows audio after a user gesture, so call unlock() from a tap.

let ctx = null;
let master = null;
let enabled = true;

export function setSoundEnabled(on) {
  enabled = on;
}

export function soundEnabled() {
  return enabled;
}

export function unlockAudio() {
  try {
    // 'ambient' mixes with other audio instead of taking over the audio
    // session, so a shift click never pauses Netflix playing in PiP.
    if (navigator.audioSession) navigator.audioSession.type = 'ambient';
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.7;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    // A silent blip fully unlocks iOS WebKit's audio session.
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(master);
    s.start(0);
  } catch {
    // audio is optional
  }
}

function ready() {
  return enabled && ctx && ctx.state === 'running';
}

let noiseBuffer = null;
function noise() {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  return src;
}

function envGain(t, attack, decay, peak) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  return g;
}

function tone(t, { freq, type = 'sine', attack = 0.004, decay = 0.12, peak = 0.3, glideTo }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + attack + decay);
  const g = envGain(t, attack, decay, peak);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + attack + decay + 0.02);
}

function click(t, { freq = 3200, q = 6, decay = 0.03, peak = 0.5 }) {
  const n = noise();
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = envGain(t, 0.001, decay, peak);
  n.connect(f).connect(g).connect(master);
  n.start(t);
  n.stop(t + decay + 0.02);
}

// Mechanical detent: a crisp click plus a small pitched "tock" whose pitch
// rises with the gear, so you can hear where you are in the cassette.
export function playShift(direction, gear = 12, gearCount = 24) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  const pos = (gear - 1) / (gearCount - 1);
  click(t, { freq: direction > 0 ? 3400 : 2600, decay: 0.025, peak: 0.55 });
  tone(t + 0.008, { freq: 420 + pos * 380, type: 'triangle', decay: 0.07, peak: 0.22, glideTo: direction > 0 ? 470 + pos * 380 : 380 + pos * 380 });
}

export function playLimit() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  click(t, { freq: 900, q: 2, decay: 0.05, peak: 0.4 });
  tone(t, { freq: 160, type: 'square', decay: 0.08, peak: 0.08 });
}

export function playErgNudge(direction) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  tone(t, { freq: direction > 0 ? 660 : 520, decay: 0.08, peak: 0.18 });
}

// Countdown pips into a new interval: three short, one long (like a race start).
export function playCountdown(secondsLeft) {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  if (secondsLeft > 0) tone(t, { freq: 880, decay: 0.1, peak: 0.25 });
  else {
    tone(t, { freq: 1320, decay: 0.35, peak: 0.3 });
    tone(t, { freq: 660, decay: 0.35, peak: 0.12 });
  }
}

export function playChime() {
  if (!ready()) return;
  const t = ctx.currentTime + 0.005;
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(t + i * 0.09, { freq: f, decay: 0.5, peak: 0.16 }));
}
