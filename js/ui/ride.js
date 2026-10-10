// The ride screen. One hero (the number you live by) and one helm (the number
// the Click steers), the world framed as a photograph above them.
//
//   Route / free ride   hero: power          helm: gear 1–24
//   Workout (ERG)       hero: interval left  helm: ERG target (+ Click bias)
//   Zone 2 autopilot    hero: heart rate     helm: HR target

import { html, useEffect, useLayoutEffect, useMemo, useRef, useState } from './h.js';
import { useStore } from '../app/store.js';
import { Icon, Wedge } from './icons.js';
import { ElevationStrip, WorkoutProfile, Trace } from './charts.js';
import { clock, countdown, POWER_ZONES, powerZone, stepZone, stepFraction, ZoneLatch, U, shortName } from './format.js';
import { zone2 } from '../app/prefs.js';
import { ergHeadline, z2Headline, workPosition } from '../app/plans.js';
import { TvMode } from './tv.js';

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function designScale() {
  const w = innerWidth;
  const h = innerHeight;
  return w > h ? Math.min(w / 844, h / 390) : Math.min(w / 390, h / 844);
}

// Spring (stiffness 520, damping 30) baked into keyframes for WAAPI.
function springFrames(fromPx, { k = 520, c = 30, ms = 420 } = {}) {
  const frames = [];
  let x = 1;
  let v = 0;
  const steps = Math.round(ms / (1000 / 60));
  const dt = ms / 1000 / steps;
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const bump = 1 + 0.06 * Math.exp(-(((t - 0.2) / 0.08) ** 2));
    frames.push({ transform: `translateY(${(x * fromPx).toFixed(2)}px) scale(${bump.toFixed(3)})`, opacity: Math.min(1, t / 0.08), offset: i / steps });
    // semi-implicit Euler
    v += (-k * x - c * v) * dt;
    x += v * dt;
  }
  frames[frames.length - 1].transform = 'translateY(0px) scale(1)';
  return frames;
}

// A number that rolls like an odometer when it changes by a Click.
function RollNumber({ value, unit = null, cls = 'num', rollKey = value, boxClass = 'roll', shakeKey = 0, style = null }) {
  const box = useRef(null);
  const cur = useRef(null);
  const prev = useRef({ value, rollKey, shakeKey });
  useLayoutEffect(() => {
    const p = prev.current;
    prev.current = { value, rollKey, shakeKey };
    const el = cur.current;
    if (!el || !box.current) return;
    if (shakeKey !== p.shakeKey && !reduceMotion()) {
      const s = 3 * designScale();
      el.animate([0, s, -s, s, -s, 0].map((x) => ({ transform: `translateX(${x}px)` })), { duration: 180 });
    }
    if (rollKey === p.rollKey || value === p.value) return;
    const dir = Number(rollKey) > Number(p.rollKey) ? 1 : -1;
    const ghost = el.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.style.left = `${el.offsetLeft}px`;
    ghost.style.top = `${el.offsetTop}px`;
    if (ghost.firstChild?.nodeType === 3) ghost.firstChild.nodeValue = String(p.value);
    box.current.appendChild(ghost);
    if (reduceMotion()) {
      ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).onfinish = () => ghost.remove();
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    const dist = Math.max(20, el.offsetHeight * 0.62);
    const up = dir > 0 ? -1 : 1; // harder: the old number leaves upward
    const s = designScale();
    ghost.animate(
      [
        { transform: 'translateY(0) scale(1)', opacity: 1, filter: 'blur(0)' },
        { transform: `translateY(${-up * 4 * s}px) scale(.94)`, opacity: 1, filter: 'blur(0)', offset: 0.43 },
        { transform: `translateY(${up * dist}px) scale(.94)`, opacity: 0, filter: 'blur(2px)' },
      ],
      { duration: 140, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' },
    ).onfinish = () => ghost.remove();
    el.animate(springFrames(-up * dist), { duration: 420, delay: 60, fill: 'backwards' });
    const halo = box.current.parentElement?.querySelector('.halo');
    halo?.animate(
      [
        { transform: 'scale(1)', opacity: 0.3 },
        { transform: 'scale(1.5)', opacity: 0 },
      ],
      { duration: 380, delay: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  });
  return html`<div class=${boxClass} ref=${box}><span class=${cls} ref=${cur} style=${style}>${value}${unit && html`<span class="u">${unit}</span>`}</span></div>`;
}

// Live numbers never animate: digits just swap.
const Num = ({ v, u, cls = 'num', style }) => html`<div class=${cls} style=${style}>${v}${u && html`<span class="u">${u}</span>`}</div>`;

// ---------------------------------------------------------------- helms

function useRail(c) {
  const [rail, setRail] = useState({ show: false, net: 0, cost: 0, cadence: 0, ratio: 0, limit: 0, key: 0 });
  const timer = useRef(null);
  useEffect(() => {
    const hideLater = () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setRail((r) => ({ ...r, show: false, net: 0 })), 1200);
    };
    const onShift = (e) => {
      if (e.detail.quiet) return;
      const d = e.detail;
      setRail((r) => ({ ...r, show: true, net: (r.show ? r.net : 0) + d.direction, cost: d.cost, cadence: d.cadence, ratio: d.ratio, key: r.key + 1 }));
      hideLater();
    };
    const onLimit = () => {
      setRail((r) => ({ ...r, show: true, limit: r.limit + 1 }));
      hideLater();
    };
    c.addEventListener('shift', onShift);
    c.addEventListener('limit', onLimit);
    return () => {
      c.removeEventListener('shift', onShift);
      c.removeEventListener('limit', onLimit);
      clearTimeout(timer.current);
    };
  }, [c]);
  return rail;
}

// Tap the upper half of the helm for harder, the lower half for easier.
function helmPointer(c) {
  let held = 0;
  const up = () => {
    if (held) c.release(held);
    held = 0;
  };
  return {
    onPointerDown: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      held = e.clientY < r.top + r.height / 2 ? 1 : -1;
      c.press(held);
    },
    onPointerUp: up,
    onPointerCancel: up,
    onPointerLeave: up,
  };
}

function GearHelm({ c, snap, rail }) {
  const notches = Array.from({ length: snap.gearCount }, (_, i) => i + 1);
  return html`<div class="helm" ...${helmPointer(c)}>
    <div class="k">Gear</div>
    <${RollNumber} value=${snap.gear} cls="snum" boxClass="gear" shakeKey=${rail.limit} />
    <div class="halo"></div>
    <div class="tag" style=${{ opacity: rail.show && rail.net ? 1 : 0 }}>${rail.net > 0 ? `+${rail.net}` : rail.net}</div>
    <div class="minirail">${notches.map((n) => html`<i class=${`${n % 4 === 0 ? 'q' : ''} ${n < snap.gear ? 'below' : ''} ${n === snap.gear ? 'on' : ''}`}></i>`)}</div>
    <div class="ratio">of ${snap.gearCount} · ${snap.ratio.toFixed(2)}</div>
  </div>`;
}

function RailPanel({ snap, rail }) {
  const notches = Array.from({ length: snap.gearCount }, (_, i) => i + 1);
  const atLimit = snap.gear === 1 || snap.gear === snap.gearCount;
  const cost = rail.cost;
  return html`<div class=${`railpanel ${rail.show ? 'show' : ''}`} aria-hidden="true">
    <span class="cost">${cost > 0 ? '+' : cost < 0 ? '−' : '±'}${Math.abs(cost)} W</span>
    <span class="cap">at ${rail.cadence || snap.cadence} rpm<br />ratio ${snap.ratio.toFixed(2)}</span>
    <span class="rail">${notches.map(
      (n) => html`<i class=${`${n < snap.gear ? 'below' : ''} ${n === snap.gear ? 'on' : ''} ${atLimit && rail.limit && n === snap.gear ? 'limit' : ''}`}></i>`,
    )}</span>
  </div>`;
}

function ErgHelm({ c, snap, ftp }) {
  const baseW = snap.ergTarget != null ? Math.round(snap.ergTarget - snap.bias * ftp) : null;
  const pct = baseW != null ? Math.round((baseW / ftp) * 100) : null;
  const biasPct = Math.round((snap.bias || 0) * 100);
  const z = snap.ergTarget != null ? POWER_ZONES[powerZone(snap.ergTarget / ftp)] : null;
  return html`<div class="helm" ...${helmPointer(c)}>
    <div class="k">ERG target</div>
    <div class="erg"><${RollNumber} value=${snap.ergTarget ?? '--'} rollKey=${snap.bias} /><span class="eu">W</span></div>
    <div class="halo"></div>
    <div class="bias"><span class="chip" style=${biasPct && z ? { borderColor: z.color, color: 'var(--paper)' } : null}>${biasPct > 0 ? '+' : biasPct < 0 ? '−' : '±'}${Math.abs(biasPct)} % · Click</span></div>
    <div class="base">base ${baseW ?? '--'} W · ${pct ?? '--'} %</div>
  </div>`;
}

function HrHelm({ c, snap }) {
  const ap = snap.autopilot;
  return html`<div class="helm" ...${helmPointer(c)}>
    <div class="k">Target bpm</div>
    <div class="erg"><${RollNumber} value=${ap?.targetHr ?? '--'} /></div>
    <div class="halo"></div>
    <div class="ztitle">±2 per Click</div>
  </div>`;
}

// ---------------------------------------------------------------- hero bits

function ZoneBar({ fraction, dim }) {
  // Six segments spanning 30–150 % FTP.
  const lo = 0.3;
  const hi = 1.5;
  const edges = [lo, 0.56, 0.76, 0.91, 1.06, 1.21, hi];
  const zi = fraction != null ? powerZone(fraction) : -1;
  const mark = fraction != null ? Math.max(0, Math.min(1, (fraction - lo) / (hi - lo))) : null;
  return html`<div class=${`zonebar ${dim ? 'dim' : ''}`}>
    ${POWER_ZONES.map((z, i) => html`<i class=${i === zi ? 'on' : ''} style=${{ background: z.color, flexGrow: edges[i + 1] - edges[i] }}></i>`)}
    ${mark != null && html`<span class="mark" style=${{ left: `${mark * 100}%` }}></span>`}
  </div>`;
}

function useZoneLatch() {
  const latch = useRef(null);
  latch.current ??= new ZoneLatch();
  return latch.current;
}

function PowerHero({ snap, ftp, dimBar }) {
  const latch = useZoneLatch();
  const f = snap.power / ftp;
  const zi = snap.power > 0 ? latch.update(f) : null;
  const z = zi != null ? POWER_ZONES[zi] : null;
  return html`<div class="hero">
    <div class="k"><span>Power</span>${z && html`<span style=${{ color: z.color }}>Z${z.n} · ${z.name} · ${Math.round(f * 100)} %</span>`}</div>
    <${Num} v=${snap.power} u="W" />
    <${ZoneBar} fraction=${snap.power > 0 ? f : null} dim=${dimBar} />
  </div>`;
}

// Gradient over the next 50 m, in riding order.
function gradeAhead(route, distance) {
  if (!route) return 0;
  const a = route.stateAt(distance);
  const b = route.stateAt(distance + 50);
  const dz = b.elevation - a.elevation;
  return (dz / 50) * 100;
}

function useClimbFacts(route) {
  return useMemo(() => {
    if (!route) return null;
    const e = route.elevation;
    const cum = new Float64Array(e.length);
    for (let i = 1; i < e.length; i++) cum[i] = cum[i - 1] + Math.max(0, e[i] - e[i - 1]);
    const named = (route.turns || []).filter((t) => t.label).map((t) => ({ d: t.atKm * 1000, label: t.label }));
    return { cum, step: route.length / (e.length - 1), named };
  }, [route]);
}

// "in 0.3 mi", or "in 450 ft" when it's close.
function near(m, units) {
  if (m < 160) {
    if (units === 'metric') return `${Math.max(10, Math.round(m / 10) * 10)} m`;
    return `${Math.max(50, Math.round(m / 0.3048 / 50) * 50)} ft`;
  }
  const q = U.distance(m, units, 1);
  return `${q.value} ${q.unit}`;
}

function caption(route, snap, facts, units) {
  if (!route || !snap.route) return { kicker: shortName(route?.name ?? ''), title: null };
  const r = snap.route;
  const kicker = shortName(route.name);
  if (route.loop) {
    const left = route.length - r.d;
    return { kicker, title: html`Lap ${r.lap + 1} <em>· ${U.distance(left, units).value} ${U.distance(left, units).unit} to go</em>` };
  }
  if (r.direction < 0) return { kicker, title: html`Heading <em>back down</em>` };
  const next = facts?.named.find((t) => t.d > r.d && t.d - r.d < 600);
  if (next) return { kicker, title: html`${next.label} <em>in ${near(next.d - r.d, units)}</em>` };
  return { kicker, title: route.kind === 'run' ? html`Your run, <em>as a ride</em>` : html`Summit <em>in ${near(route.length - r.d, units)}</em>` };
}

function ProfileRow({ route, snap, facts, units }) {
  if (!route || !snap.route) return html`<div class="profile"><div class="row"><span class="k">&nbsp;</span></div><svg></svg></div>`;
  const r = snap.route;
  const ridden = U.distance(snap.distance, units);
  let right = '';
  if (route.loop) right = shortName(route.name);
  else if (r.direction > 0) {
    const i = Math.min(facts.cum.length - 1, Math.round(r.d / facts.step));
    const gain = U.elevation(facts.cum.at(-1) - facts.cum[i], units);
    const left = U.distance(route.length - r.d, units);
    right = `Summit ${left.value} ${left.unit} · +${gain.value} ${gain.unit}`;
  } else {
    const left = U.distance(r.d, units);
    right = `${left.value} ${left.unit} to the bottom`;
  }
  return html`<div class="profile">
    <div class="row"><span class="k">${ridden.value} ${ridden.unit} ridden</span><span class="k">${right}</span></div>
    <${ElevationStrip} route=${route} distance=${snap.distance} units=${units} />
  </div>`;
}

function Trio({ items }) {
  return html`<div class="trio">${items.map(
    (it) => html`<div><div class="k" style=${it.kstyle}>${it.k}</div><${Num} v=${it.v} u=${it.u} style=${it.style} /></div>`,
  )}</div>`;
}

function Footer({ snap, units }) {
  const d = U.distance(snap.distance, units, snap.distance < 16000 ? 2 : 1);
  const climb = U.elevation(snap.climbed, units);
  return html`<div class="footer">
    <span class="num">${clock(snap.movingTime)}</span>
    <span class="num">${d.value}<span class="u">${d.unit}</span></span>
    <span class="num climb">${Icon.climb()}${climb.value}<span class="u">${climb.unit} climbed</span></span>
  </div>`;
}

const hrItem = (snap) => ({ k: 'Heart', v: snap.heartRate ?? '--', u: 'bpm' });

// ---------------------------------------------------------------- panels per mode

function RoutePanel({ c, snap, route, prefs, facts, rail }) {
  const units = prefs.units;
  const sp = U.speed(snap.speed, units);
  return html`<div class="panel">
    <${ProfileRow} route=${route} snap=${snap} facts=${facts} units=${units} />
    <div class="duo">
      <${PowerHero} snap=${snap} ftp=${prefs.ftp} dimBar=${rail.show} />
      ${snap.mode === 'erg' ? html`<${ErgHelm} c=${c} snap=${snap} ftp=${prefs.ftp} />` : html`<${GearHelm} c=${c} snap=${snap} rail=${rail} />`}
      <${RailPanel} snap=${snap} rail=${rail} />
    </div>
    <${Trio} items=${[hrItem(snap), { k: 'Cadence', v: snap.cadence || '--', u: 'rpm' }, { k: 'Speed', v: sp.value, u: sp.unit }]} />
    <${Footer} snap=${snap} units=${units} />
  </div>`;
}

function ErgPanel({ c, snap, plan, prefs, rail }) {
  const w = snap.workout;
  const workout = plan.workout && w?.name === plan.workout.name ? plan.workout : c.engine.workout;
  const step = w?.step ?? null;
  const zone = stepZone(step);
  const nextZone = stepZone(w?.next);
  const pos = workout && w?.index != null ? workPosition(workout, w.index) : { workIndex: null, workCount: 0 };
  const rampStep = plan.kind === 'ramp' && w?.index > 0 && workout?.id === plan.workout?.id ? w.index : null;
  const [lead, turn] = w?.done ? ['Workout', 'done.'] : ergHeadline({ step, ...pos, rampStep });
  const left = w?.stepRemaining ?? 0;
  const late = left <= 10 && w?.next;
  const elapsed = step ? step.duration - left : 0;
  const nextF = stepFraction(w?.next);
  const kick = workout ? `${workout.name}${pos.workIndex ? ` · interval ${pos.workIndex} of ${pos.workCount}` : ''}` : '';
  const erg = snap.mode === 'erg';
  return html`<div class="panel">
    <div class="modehead"><div class="k">${kick}</div><div class="headline">${lead} <em>${turn}</em></div></div>
    <div class="duo">
      <div class="hero">
        <div class="k"><span>${step ? 'Time left' : 'Time'}</span>${zone && html`<span style=${{ color: zone.color }}>Z${zone.n} · ${zone.name}</span>`}</div>
        <${Num} v=${step ? countdown(left) : clock(snap.movingTime)} cls=${`num countdown ${(step ? countdown(left) : clock(snap.movingTime)).length >= 5 ? 'long' : ''}`} style=${late && nextZone ? { '--cd': nextZone.color } : null} />
        <div class="ivbar"><i style=${{ width: `${step ? Math.min(100, (elapsed / step.duration) * 100) : 0}%`, background: zone?.color ?? 'var(--paper-3)' }}></i></div>
        <div class="ivkick"><span class="k">${clock(elapsed)} done</span><span class="k">${step ? clock(step.duration) : ''}</span></div>
      </div>
      ${erg ? html`<${ErgHelm} c=${c} snap=${snap} ftp=${prefs.ftp} />` : html`<${GearHelm} c=${c} snap=${snap} rail=${rail} />`}
      ${!erg && html`<${RailPanel} snap=${snap} rail=${rail} />`}
    </div>
    <div class="nextline">
      <span class="k">Next</span>
      <span class="serif">${w?.next ? `${w.next.label || nextZone?.name || 'Free ride'} · ${clock(w.next.duration)}${nextF != null ? ` at ${Math.round(nextF * prefs.ftp)} W` : ''}` : 'Finish'}</span>
    </div>
    <${WorkoutProfile} workout=${workout} clock=${w?.clock ?? 0} />
    <${Trio} items=${[{ k: 'Power', v: snap.power, u: 'W' }, hrItem(snap), { k: 'Cadence', v: snap.cadence || '--', u: 'rpm' }]} />
    <${Footer} snap=${snap} units=${prefs.units} />
  </div>`;
}

function Z2Panel({ c, snap, plan, prefs }) {
  const z = zone2(prefs);
  const ap = snap.autopilot;
  const status = snap.state === 'riding' ? ap?.status ?? 'no-hr' : snap.heartRate ? 'below' : 'no-hr';
  const [lead, turn] = z2Headline(status, snap.movingTime);
  const lo = 100;
  const hi = 175;
  const pos = (v) => `${((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100}%`;
  const last = useRef({ watts: null, delta: 0 });
  if (ap && last.current.watts != null && ap.watts !== last.current.watts) last.current.delta = ap.watts - last.current.watts;
  if (ap) last.current.watts = ap.watts;
  const delta = last.current.delta;
  const why = status === 'above' ? 'HR drifting up' : status === 'below' ? 'HR settling low' : status === 'in-zone' ? 'steady' : 'no heart rate yet';
  const samples = c.engine.samples;
  const inZone = samples.length ? Math.round((samples.filter((s) => s.heartRate >= z.min && s.heartRate <= z.max).length / samples.length) * 100) : null;
  return html`<div class="panel">
    <div class="modehead"><div class="k">Zone 2 autopilot · ${plan.minutes} min${inZone != null ? ` · ${inZone} % in zone` : ''}</div><div class="headline">${lead} <em>${turn}</em></div></div>
    <div class="duo">
      <div class="hero big">
        <div class="k"><span>Heart rate</span>${snap.heartRate && html`<span style=${{ color: snap.heartRate >= z.min && snap.heartRate <= z.max ? 'var(--pz2)' : 'var(--paper-3)' }}>${snap.heartRate >= z.min && snap.heartRate <= z.max ? 'Z2 · Endurance' : snap.heartRate > z.max ? 'Above Z2' : 'Below Z2'}</span>`}</div>
        <${Num} v=${snap.heartRate ?? '--'} />
      </div>
      <${HrHelm} c=${c} snap=${snap} />
    </div>
    <div class="z2band">
      <div class="zone" style=${{ left: pos(z.min), width: `calc(${pos(z.max)} - ${pos(z.min)})` }}></div>
      ${ap && html`<div class="target" style=${{ left: pos(ap.targetHr) }}></div>`}
      ${snap.heartRate && html`<div class="me" style=${{ left: pos(snap.heartRate) }}></div>`}
    </div>
    <div class="z2labels"><span style=${{ left: pos(z.min) }}>${z.min}</span><span style=${{ left: pos(z.max) }}>${z.max}</span></div>
    <div class="holding">
      <div><div class="k">Trainer holding</div><${Num} v=${ap?.watts ?? snap.power} u="W" /></div>
      <div class="serif">${snap.state !== 'riding' ? 'Starts when you pedal' : delta < 0 ? `↓ easing ${-delta} W — ${why}` : delta > 0 ? `↑ adding ${delta} W — ${why}` : `Holding — ${why}`}</div>
    </div>
    <${Trace} samples=${samples} zone=${z} />
    <${Footer} snap=${snap} units=${prefs.units} />
  </div>`;
}

// ---------------------------------------------------------------- the photo (3D world)

function Photo({ c, route, active, prefs, snap, flash, children }) {
  const box = useRef(null);
  const canvas = useRef(null);
  const world = useRef(null);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  readyRef.current = ready;
  const [failed, setFailed] = useState(null);
  const [mods, setMods] = useState(null);

  useEffect(() => {
    let alive = true;
    Promise.all([import('../world/world.js'), import('../world/themes.js')])
      .then(([w, t]) => {
        if (!alive) return;
        try {
          world.current = new w.World(canvas.current, { maxPixelRatio: 2 });
          setMods(t);
        } catch (err) {
          setFailed(err.message);
        }
      })
      .catch((err) => alive && setFailed(err.message));
    c.capturePhoto = () => {
      try {
        if (!world.current || !readyRef.current) return null;
        world.current.render();
        return canvas.current.toDataURL('image/jpeg', 0.82);
      } catch {
        return null;
      }
    };
    return () => {
      alive = false;
      c.capturePhoto = null;
      world.current?.dispose();
      world.current = null;
    };
  }, []);

  // Build the road and the first chunks in small slices so the UI stays live.
  useEffect(() => {
    const w = world.current;
    if (!w || !route || !mods) return undefined;
    setReady(false);
    let cancelled = false;
    const tod = prefs.timeOfDay === 'auto' ? mods.timeOfDayNow() : prefs.timeOfDay;
    w.setRoute(route, mods.themeFor(route, tod));
    const at = c.live.state.snap?.distance ?? 0;
    w.display.distance = at;
    const s0 = route.stateAt(at);
    const r = box.current.getBoundingClientRect();
    w.resize(r.width, r.height);
    const step = () => {
      if (cancelled) return;
      const t0 = performance.now();
      let more = true;
      while (more && performance.now() - t0 < 24) more = w.streamChunks(s0.x, s0.z, 2);
      if (more) setTimeout(step, 0);
      else setReady(true);
    };
    setTimeout(step, 30);
    return () => {
      cancelled = true;
    };
  }, [route, mods, prefs.timeOfDay]);

  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      world.current?.resize(r.width, r.height);
      if (world.current && ready) world.current.render();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  // Render only while the photo is on screen (not in TV mode, pause or summary).
  useEffect(() => {
    if (!active || !ready || !world.current) return undefined;
    let raf = 0;
    let last = performance.now();
    const frame = (now) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = c.live.state.snap;
      if (s && world.current) {
        world.current.update({ distance: s.distance, speed: s.state === 'riding' ? s.speed : 0, cadence: s.cadence, tucked: s.tucked, power: s.power }, dt);
        world.current.render();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [active, ready]);

  return html`<div class="photo" ref=${box}>
    <canvas ref=${canvas}></canvas>
    <div class="vignette"></div><div class="scrim-t"></div><div class="scrim-b"></div>
    ${children}
    <div class="border" style=${{ '--flash': flash || 'transparent' }}></div>
    <div class="loading" style=${{ opacity: ready ? 0 : 1, pointerEvents: ready ? 'none' : 'auto' }}>${failed ? 'The world view isn’t available on this device.' : route ? 'Drawing the road…' : 'Finding the road…'}</div>
  </div>`;
}

// ---------------------------------------------------------------- toast

export function Toast({ c, toast }) {
  if (!toast) return null;
  return html`<div class="toast" key=${toast.id} role="status" onClick=${() => c.dismissToast()}>
    ${toast.kind === 'fuel' && html`<span class="tic">${Icon.fuel()}</span>`}
    <div><b>${toast.title}</b>${toast.body && html`<em>${toast.body}</em>`}</div>
    ${toast.action && html`<button onClick=${(e) => (e.stopPropagation(), c.dismissToast())}>${toast.action}</button>`}
  </div>`;
}

// ---------------------------------------------------------------- screen

function useFlash(c) {
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    let t1;
    const onInterval = (e) => {
      if (e.detail.index === 0) return;
      const z = stepZone(e.detail.step);
      setFlash(z ? z.color : 'var(--paper-2)');
      clearTimeout(t1);
      t1 = setTimeout(() => setFlash(null), 1600);
    };
    c.addEventListener('interval', onInterval);
    return () => {
      c.removeEventListener('interval', onInterval);
      clearTimeout(t1);
    };
  }, [c]);
  return flash;
}

export function RideScreen({ c }) {
  const s = useStore(c.store);
  const { snap } = useStore(c.live);
  const rail = useRail(c);
  const flash = useFlash(c);
  const facts = useClimbFacts(s.route);
  const { plan, route, prefs } = s;
  if (!snap || !plan) return null;
  const mode = plan.kind === 'autopilot' ? 'z2' : plan.workout ? 'erg' : 'route';
  const letterbox = mode !== 'route';
  const photoActive = !s.tv && !s.sheet && s.screen === 'ride';
  const cap = caption(route, snap, facts, prefs.units);
  const grade = route ? gradeAhead(route, snap.distance) : 0;
  const elev = U.elevation(snap.elevation, prefs.units);
  return html`<div class=${`screen ride ${letterbox ? 'letterbox' : ''} mode-${mode}`}>
    <${Photo} c=${c} route=${route} active=${photoActive} prefs=${prefs} snap=${snap} flash=${flash}>
      <div class="caption"><div class="k lt">${cap.kicker}</div>${cap.title && html`<div class="title">${cap.title}</div>`}</div>
      <div class="actions">
        <button class="gbtn" aria-label="TV mode" onClick=${() => c.setTv(true)}>${Icon.tv()}</button>
        <button class="gbtn" aria-label="Pause" onClick=${() => (s.rideState === 'ready' ? c.leave() : c.pause())}>${s.rideState === 'ready' ? Icon.close() : Icon.pause()}</button>
      </div>
      <div class="grade num">${(Math.round(grade * 10) / 10).toFixed(1)}<span class="u">%</span><${Wedge} grade=${grade} /></div>
      <div class="elev"><div class="k lt">Elevation</div><div class="num">${elev.value}<span class="u">${elev.unit}</span></div></div>
    <//>
    <div class="lprofile">${route && html`<${ElevationStrip} route=${route} distance=${snap.distance} units=${prefs.units} />`}</div>
    ${mode === 'route' && html`<${RoutePanel} c=${c} snap=${snap} route=${route} prefs=${prefs} facts=${facts} rail=${rail} />`}
    ${mode === 'erg' && html`<${ErgPanel} c=${c} snap=${snap} plan=${plan} prefs=${prefs} rail=${rail} />`}
    ${mode === 'z2' && html`<${Z2Panel} c=${c} snap=${snap} plan=${plan} prefs=${prefs} />`}
    ${s.rideState === 'ready' && !s.tv && html`<${StartBar} c=${c} s=${s} />`}
    ${s.tv && html`<${TvMode} c=${c} s=${s} snap=${snap} mode=${mode} />`}
  </div>`;
}

function StartBar({ c, s }) {
  const t = s.devices.trainer;
  if (t.state !== 'ready') {
    return html`<div class="startbar">
      <button class="btn sec" onClick=${() => c.leave()}>Back</button>
      <div class="startcol">
        <button class="btn pri" onClick=${() => c.connectTrainer()}>${t.state === 'connecting' ? 'Waking the trainer…' : 'Connect trainer'}</button>
        <button class="btn ghost small" onClick=${() => c.useSimulator()}>or ride the simulator</button>
      </div>
    </div>`;
  }
  return html`<div class="startbar">
    <button class="btn sec" onClick=${() => c.leave()}>Back</button>
    <button class="btn pri" disabled=${!s.route} onClick=${() => c.start()}>${s.route ? 'Start — or just pedal' : s.routeError ? 'Road didn’t load' : 'Loading the road…'}</button>
  </div>`;
}
