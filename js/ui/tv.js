// TV mode: a show plays from any streaming app in iOS Picture in Picture,
// floating over CogRide, which stays in front so the trainer stays
// connected. No 3D world here (saves battery and heat): just the numbers
// below a marked dock where the show sits, and an interval change you can't
// miss — the dock floods with the next zone's colour around the show.

import { html, useEffect, useRef, useState } from './h.js';
import { Icon } from './icons.js';
import { clock, countdown, stepZone, stepFraction, U, shortName } from './format.js';
import { zone2 } from '../app/prefs.js';
import { workPosition } from '../app/plans.js';
import { ElevationStrip, WorkoutProfile, Trace } from './charts.js';
import { ambientAudioSupported } from './sound.js';

// T0 flood (1.6 s) → rim (to T+10 s) → off.
function useFlood(c) {
  const [state, setState] = useState({ phase: null, color: null, step: null, index: null, tick: 0 });
  const timers = useRef([]);
  useEffect(() => {
    const clear = () => timers.current.forEach(clearTimeout);
    const onInterval = (e) => {
      if (e.detail.index === 0) return;
      const z = stepZone(e.detail.step);
      const color = z ? z.hex : '#cdc1af';
      clear();
      setState((s) => ({ ...s, phase: 'flood', color, step: e.detail.step, index: e.detail.index }));
      timers.current = [setTimeout(() => setState((s) => ({ ...s, phase: 'rim' })), 1600), setTimeout(() => setState((s) => ({ ...s, phase: null })), 10000)];
    };
    const onCountdown = () => setState((s) => ({ ...s, tick: s.tick + 1 }));
    c.addEventListener('interval', onInterval);
    c.addEventListener('countdown', onCountdown);
    return () => {
      clear();
      c.removeEventListener('interval', onInterval);
      c.removeEventListener('countdown', onCountdown);
    };
  }, [c]);
  return state;
}

function Pulse({ tick, children }) {
  const ref = useRef(null);
  const last = useRef(tick);
  useEffect(() => {
    if (tick !== last.current && ref.current) ref.current.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.04)' }, { transform: 'scale(1)' }], { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' });
    last.current = tick;
  }, [tick]);
  return html`<div ref=${ref} style=${{ transformOrigin: 'left bottom' }}>${children}</div>`;
}

// Where heart rate sits in the Zone 2 band, at a glance from across the room.
function Z2Mini({ snap, prefs }) {
  const z = zone2(prefs);
  const lo = 100;
  const hi = 175;
  const pos = (v) => `${((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100}%`;
  const ap = snap.autopilot;
  return html`<div class="z2band">
    <div class="zone" style=${{ left: pos(z.min), width: `calc(${pos(z.max)} - ${pos(z.min)})` }}></div>
    ${ap && html`<div class="target" style=${{ left: pos(ap.targetHr) }}></div>`}
    ${snap.heartRate && html`<div class="me" style=${{ left: pos(snap.heartRate) }}></div>`}
  </div>`;
}

// On a road: the gradient and where you are on the climb.
function RoadLine({ route, snap, units }) {
  const a = route.stateAt(snap.distance);
  const b = route.stateAt(snap.distance + 50);
  const grade = ((b.elevation - a.elevation) / 50) * 100;
  return html`<div class="tvroad">
    <div><div class="k">Grade</div><div class="num">${grade.toFixed(1)}<span class="u">%</span></div></div>
    <${ElevationStrip} route=${route} distance=${snap.distance} units=${units} />
  </div>`;
}

const N = ({ k, v, u, cls = 'num', style, kstyle }) => html`<div><div class="k" style=${kstyle}>${k}</div><div class=${cls} style=${style}>${v}${u && html`<span class="u">${u}</span>`}</div></div>`;

export function TvMode({ c, s, snap, mode, race = null }) {
  const flood = useFlood(c);
  const { prefs, plan, route } = s;
  const units = prefs.units;
  const intro = !prefs.tvIntroSeen;
  const w = snap.workout;
  const nextZone = stepZone(w?.next);
  const late = w?.next && w.stepRemaining <= 10;
  const cdColor = late && nextZone ? nextZone.hex : null;

  let row1;
  let row2;
  let ctx;
  let progress = 0;
  if (mode === 'erg') {
    const zone = stepZone(w?.step);
    row1 = [
      html`<${Pulse} tick=${flood.tick}><${N} k=${w?.step ? `Time left${zone ? ` · Z${zone.n} ${zone.name}` : ''}` : 'Time'} v=${w?.step ? countdown(w.stepRemaining) : clock(snap.movingTime)} cls="num countdown" style=${cdColor ? { '--cd': cdColor } : null} kstyle=${zone ? { color: zone.color } : null} /><//>`,
    ];
    row2 = [
      snap.mode === 'erg' ? html`<${N} k="Target" v=${snap.ergTarget ?? '--'} u="W" />` : html`<${N} k="Gear" v=${snap.gear} cls="snum" />`,
      html`<${N} k="Power" v=${snap.power} u="W" />`,
      html`<${N} k="Heart" v=${snap.heartRate ?? '--'} u="bpm" />`,
    ];
    const nf = stepFraction(w?.next);
    ctx = [w?.name ?? plan.title, w?.next ? `Next: ${w.next.label || nextZone?.name || 'free ride'} · ${clock(w.next.duration)}${nf != null ? ` at ${Math.round(nf * prefs.ftp)} W` : ''}` : 'Last interval'];
    progress = w?.step ? 1 - w.stepRemaining / w.step.duration : 0;
  } else if (mode === 'z2') {
    const z = zone2(prefs);
    const ap = snap.autopilot;
    const inZ = snap.heartRate >= z.min && snap.heartRate <= z.max;
    row1 = [html`<${N} k=${`Heart${snap.heartRate ? (inZ ? ' · in Zone 2' : snap.heartRate > z.max ? ' · above Zone 2' : ' · below Zone 2') : ''}`} v=${snap.heartRate ?? '--'} u="bpm" kstyle=${inZ ? { color: 'var(--pz2)' } : null} />`];
    row2 = [html`<${N} k="Target" v=${ap?.targetHr ?? '--'} u="bpm" />`, html`<${N} k="Trainer" v=${ap?.watts ?? snap.power} u="W" />`, html`<${N} k="Cadence" v=${snap.cadence || '--'} u="rpm" />`];
    ctx = [`Zone 2 · ${z.min}–${z.max} bpm`, `${clock(snap.movingTime)} of ${plan.minutes}:00`];
    progress = snap.movingTime / (plan.minutes * 60);
  } else {
    row1 = [html`<${N} k="Gear" v=${snap.gear} cls="snum" />`, html`<${N} k="Power" v=${snap.power} u="W" />`];
    row2 = [html`<${N} k="Heart" v=${snap.heartRate ?? '--'} u="bpm" />`, html`<${N} k="Cadence" v=${snap.cadence || '--'} u="rpm" />`];
    const d = U.distance(snap.distance, units);
    const climb = U.elevation(snap.climbed, units);
    const vs = race?.delta != null ? `${clock(Math.round(Math.abs(race.delta)))} ${race.delta >= 0 ? 'ahead' : 'behind'} · ` : '';
    const goal = plan.goalM ? ` of ${U.elevation(plan.goalM, units).value}` : '';
    ctx = [shortName(route?.name ?? plan.title), `${vs}${d.value} ${d.unit} · ▲ ${climb.value}${goal} ${climb.unit}`];
    const r = snap.route;
    progress = route && r ? (route.loop ? r.d / route.length : r.direction > 0 ? r.d / route.length : 1 - r.d / route.length) : 0;
  }

  const pos = w && flood.index != null ? workPosition(c.engine.workout ?? plan.workout ?? { steps: [] }, flood.index) : null;
  const fz = stepZone(flood.step);
  const dockClass = `dock ${flood.phase === 'flood' ? 'flood' : flood.phase === 'rim' ? 'rim' : ''}`;
  return html`<div class="screen tv">
    <div class=${dockClass} style=${{ '--flood': flood.color || 'transparent' }}>
      <div class="frame">
        <span class="crop tl"></span><span class="crop tr"></span><span class="crop bl"></span><span class="crop br"></span>
        ${intro
          ? html`<div>
              <div class="steps">
                <div><i>1</i><b>Play a show</b><span>in any app with Picture in Picture</span></div>
                <div><i>2</i><b>Swipe home</b><span>it shrinks to a floating window</span></div>
                <div><i>3</i><b>Come back</b><span>drag it here — CogRide keeps your trainer talking</span></div>
              </div>
              <button class="btn sec small gotit" onClick=${() => c.setPrefs({ tvIntroSeen: true })}>Got it</button>
            </div>`
          : html`<div class="label">${Icon.pip()}<br />Your show<span class="k">Picture in Picture</span></div>`}
      </div>
      <div class="hint">${intro ? 'Ring switch on to hear interval cues.' : 'Park your show here — CogRide keeps the trainer talking.'}</div>
      ${flood.phase === 'flood' &&
      html`<div class="go"><em>Go.</em><span>${pos?.workIndex ? `Interval ${pos.workIndex} of ${pos.workCount}` : flood.step?.label || 'Next'}<br />${fz ? `${fz.name} · Z${fz.n}` : ''}</span></div>`}
    </div>
    <div class="exit">
      <button class="gbtn" aria-label="Leave TV mode" onClick=${() => c.setTv(false)}>${Icon.close()}</button>
      <button class="gbtn" aria-label="Pause" onClick=${() => c.pause()}>${Icon.pause()}</button>
    </div>
    <div class="data">
      <div class=${`row1 ${row1.length === 1 ? 'solo' : ''}`}>${row1}</div>
      ${mode === 'z2' && html`<${Z2Mini} snap=${snap} prefs=${prefs} /><div class="tvprofile"><${Trace} samples=${c.engine.samples} zone=${zone2(prefs)} className="" /></div>`}
      ${mode === 'erg' && (c.engine.workout ?? plan.workout) && html`<div class="tvprofile"><${WorkoutProfile} workout=${c.engine.workout ?? plan.workout} clock=${w?.clock ?? 0} className="" /></div>`}
      ${mode === 'route' && route && html`<${RoadLine} route=${route} snap=${snap} units=${units} />`}
      <div class=${`row2 ${row2.length === 3 ? 'three' : ''}`}>${row2}</div>
      <div class="row3">
        <div class="ctx"><span>${ctx[0]}</span><span>${ctx[1]}</span></div>
        <div class="progress"><i style=${{ width: `${Math.max(0, Math.min(1, progress || 0)) * 100}%`, background: cdColor || undefined }}></i></div>
        ${!ambientAudioSupported() && prefs.tvSound !== 'off' && html`<div class="tvnote">Cues may pause your show in this browser — turn TV sounds off in Settings if they do.</div>`}
      </div>
    </div>
  </div>`;
}
