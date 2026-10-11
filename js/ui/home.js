// Home: the evening's front page. Masthead, a greeting, the three devices,
// tonight's pick, and the contents — routes, workouts and your runs.

import { html, useEffect, useState } from './h.js';
import { useStore } from '../app/store.js';
import { Icon } from './icons.js';
import { Scene, Sparkline, WorkoutProfile } from './charts.js';
import { U } from './format.js';
import { sparkline } from '../core/routeLibrary.js';
import { regionFor, timeOfDayNow } from '../world/themes.js';
import { allWorkouts, autopilotPlan, dateline, greeting, tonightsPick, workoutPlan } from '../app/plans.js';
import { totalDuration } from '../workouts.js';
import { APP, isFlux, storeKey } from '../variant.js';

const pad = (n) => String(n).padStart(2, '0');

function tod(prefs) {
  return prefs.timeOfDay === 'auto' ? timeOfDayNow() : prefs.timeOfDay;
}

// ---------------------------------------------------------------- device tiles

function Tile({ icon, name, state, line, hint, onClick, label }) {
  const words = { ready: 'Ready', connecting: 'Waking…', off: 'Off' };
  return html`<button class=${`tile ${state === 'ready' ? 'ready' : state === 'connecting' ? 'connecting' : ''}`} onClick=${onClick} aria-label=${label}>
    <span class="ic">${icon()}</span>
    <span class="name">${name}</span>
    <span class="state"><i></i>${line ?? words[state] ?? 'Off'}</span>
    <span class="hint">${hint}</span>
  </button>`;
}

function Tiles({ c, s }) {
  const { trainer, click, hr } = s.devices;
  const noBle = !s.bluetooth;
  const trainerHint =
    trainer.state === 'ready'
      ? trainer.sim
        ? 'Simulator'
        : trainer.path === 'zwift'
          ? 'Virtual shifting'
          : trainer.path === 'ftms'
            ? 'Smart trainer (FTMS)'
            : trainer.path === 'fec'
              ? 'Tacx · FE-C'
              : trainer.name
      : trainer.state === 'connecting'
        ? 'Pedal to wake it'
        : noBle
          ? 'Open in Bluefy'
          : isFlux
            ? 'Flux S · tap'
            : 'KICKR Core · tap';
  const clickLine = click.state === 'ready' ? (click.count === 2 ? 'Both pucks' : 'Ready') : null;
  const clickHint =
    click.state === 'ready'
      ? click.v2 && click.count === 1
        ? 'Tap to add the other'
        : click.battery != null
          ? `Battery ${click.battery}%`
          : click.name
      : click.state === 'connecting'
        ? 'Press any button'
        : noBle
          ? 'Open in Bluefy'
          : 'Tap, then press +';
  const hrHint = hr.state === 'ready' ? hr.name || 'Heart rate' : hr.state === 'connecting' ? 'Listening…' : 'Pace 3 · HR broadcast on';
  return html`<div class=${`tiles ${APP.controllers ? '' : 'two'}`}>
    <${Tile}
      icon=${Icon.trainer}
      name="Trainer"
      state=${trainer.state}
      hint=${trainerHint}
      label="Trainer"
      onClick=${() => (trainer.state === 'off' ? c.connectTrainer() : c.openSheet({ type: 'device', which: 'trainer' }))}
    />
    ${APP.controllers &&
    html`<${Tile}
      icon=${Icon.click}
      name="Click"
      state=${click.state}
      line=${clickLine}
      hint=${clickHint}
      label="Zwift Click"
      onClick=${() => (click.state === 'off' || (click.v2 && click.count === 1) ? c.connectClick() : c.openSheet({ type: 'device', which: 'click' }))}
    />`}
    <${Tile}
      icon=${Icon.heart}
      name="Heart"
      state=${hr.state}
      hint=${hrHint}
      label="Heart rate"
      onClick=${() => (hr.state === 'off' ? c.connectHeart() : c.openSheet({ type: 'device', which: 'hr' }))}
    />
  </div>`;
}

// ---------------------------------------------------------------- rows

function routeMeta(def, units) {
  const len = U.distance(def.lengthM, units);
  const gain = U.elevation(def.gainM, units);
  if (def.loop) return `${len.value} ${len.unit} loop · +${gain.value} ${gain.unit}`;
  return `${len.value} ${len.unit} · +${gain.value} ${gain.unit} · ${def.avgGradientPct} %`;
}

function RouteRow({ c, def, i, prefs }) {
  const spark = sparkline(def, 40);
  return html`<button class="crow" onClick=${() => c.openSheet({ type: 'plan', plan: { kind: 'route', id: def.id, routeId: def.id, title: def.name, def } })}>
    <span class="folio">${pad(i + 1)}</span>
    <span class="thumb"><${Scene} region=${regionFor(def)} tod=${tod(prefs)} seed=${def.id} w=${52} h=${44} profile=${spark} /></span>
    <span><span class="title">${def.name.replace(/\s*\(.*\)$/, '')}</span><span class="meta">${routeMeta(def, prefs.units)}</span></span>
    <span class="spark"><${Sparkline} values=${spark} /></span>
  </button>`;
}

export function estimateTss(workout) {
  let sum = 0;
  for (const s of workout.steps) {
    let f2;
    if (s.type === 'steady') f2 = s.power * s.power;
    else if (s.type === 'ramp') f2 = (s.from * s.from + s.from * s.to + s.to * s.to) / 3;
    else f2 = 0.25;
    sum += s.duration * f2;
  }
  return Math.round((sum / 3600) * 100);
}

function WorkoutRow({ c, w, i }) {
  const mins = Math.round(totalDuration(w) / 60);
  return html`<button class="crow" onClick=${() => c.openSheet({ type: 'plan', plan: workoutPlan(w) })}>
    <span class="folio">${pad(i + 1)}</span>
    <span class="thumb wthumb"><${WorkoutProfile} workout=${w} clock=${0} className="" showPlayhead=${false} /></span>
    <span><span class="title">${w.name}</span><span class="meta">${mins} min · TSS ~${estimateTss(w)}${w.builtIn ? '' : ' · yours'}</span></span>
    <span class="chip">ERG</span>
  </button>`;
}

function AutopilotRow({ c, prefs, i }) {
  const z = prefs.hrZones[1];
  return html`<button class="crow" onClick=${() => c.openSheet({ type: 'plan', plan: autopilotPlan(60) })}>
    <span class="folio">${pad(i + 1)}</span>
    <span class="thumb z2thumb"><svg viewBox="0 0 52 44" aria-hidden="true"><rect x="0" y="16" width="52" height="12" fill="var(--pz2)" opacity=".18" /><path d="M0 34 C8 30 12 22 18 21 S30 23 36 22 46 21 52 22" fill="none" stroke="#e8735f" stroke-width="1.6" /></svg></span>
    <span><span class="title">Zone 2 autopilot</span><span class="meta">45–90 min · holds ${z.min}–${z.max} bpm</span></span>
    <span class="chip">Z2</span>
  </button>`;
}

function RunRow({ c, run, i, prefs }) {
  const d = U.distance(run.distanceM, prefs.units);
  const g = U.elevation(run.elevationGainM, prefs.units);
  const date = new Date(run.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return html`<button class="crow" onClick=${() => c.rideRun(run)}>
    <span class="folio">${pad(i + 1)}</span>
    <span class="thumb"><${Scene} region="bayarea" tod=${tod(prefs)} seed=${run.id} w=${52} h=${44} /></span>
    <span><span class="title">${run.name}</span><span class="meta">${date} · ${d.value} ${d.unit} · +${g.value} ${g.unit}</span></span>
    <span class="chip">${run.sportType === 'Hike' ? 'Hike' : 'Run'}</span>
  </button>`;
}

function SegmentRow({ c, seg, i, prefs }) {
  const d = U.distance(seg.distanceM, prefs.units);
  const g = U.elevation(seg.elevM, prefs.units);
  return html`<button class="crow" onClick=${() => c.rideSegment(seg.id, seg.name)}>
    <span class="folio">${pad(i + 1)}</span>
    <span class="thumb"><${Scene} region="bayarea" tod=${tod(prefs)} seed=${`seg${seg.id}`} w=${52} h=${44} /></span>
    <span><span class="title">${seg.name}</span><span class="meta">${d.value} ${d.unit} · +${g.value} ${g.unit} · ${seg.averageGrade?.toFixed?.(1) ?? '--'} %</span></span>
    <span class="chip">Seg</span>
  </button>`;
}

// Starred segments, a box to paste any segment link, and recent runs.
function StravaContents({ c, s }) {
  const [link, setLink] = useState('');
  const { prefs } = s;
  const segs = s.segments || [];
  const runs = s.runs || [];
  return html`
    <div class="segpaste">
      <label class="field"><input class="wide" inputmode="url" placeholder="Paste a Strava segment link" value=${link} onInput=${(e) => setLink(e.target.value)} /></label>
      <button class="btn sec small" disabled=${!link.trim()} onClick=${() => c.rideSegment(link)}>Ride it</button>
    </div>
    <div class="k subhead">Starred segments</div>
    ${s.segmentsState === 'loading'
      ? html`<div class="empty">Fetching your segments…</div>`
      : s.segmentsState === 'error'
        ? html`<div class="empty">Couldn’t reach Strava. <button class="linkish" onClick=${() => c.loadSegments()}>Try again</button></div>`
        : segs.length
          ? segs.slice(0, 40).map((seg, i) => html`<${SegmentRow} c=${c} seg=${seg} i=${i} prefs=${prefs} />`)
          : html`<div class="empty">Star a climb on Strava and it shows up here.</div>`}
    <div class="k subhead">Your runs, as rides</div>
    ${s.runsState === 'loading'
      ? html`<div class="empty">Fetching your runs…</div>`
      : s.runsState === 'error'
        ? html`<div class="empty">Couldn’t reach Strava (${s.runsError}). <button class="linkish" onClick=${() => c.loadRuns()}>Try again</button></div>`
        : runs.length
          ? runs.slice(0, 30).map((run, i) => html`<${RunRow} c=${c} run=${run} i=${i} prefs=${prefs} />`)
          : html`<div class="empty">No recent runs with real climbing yet.</div>`}`;
}

// This week's climbing, runs and rides together, with the weekly goal.
function Week({ c, s }) {
  const w = s.week;
  const p = s.prefs;
  if (!p.weeklyGoalM && (!w || (!w.elevM && !w.rideS && !w.runDistanceM))) return null;
  const units = p.units;
  const elev = U.elevation(w?.elevM ?? 0, units);
  const run = U.distance(w?.runDistanceM ?? 0, units);
  const h = Math.floor((w?.rideS ?? 0) / 3600);
  const m = Math.round(((w?.rideS ?? 0) % 3600) / 60);
  const goal = p.weeklyGoalM ? U.elevation(p.weeklyGoalM, units) : null;
  const frac = p.weeklyGoalM ? Math.min(1, (w?.elevM ?? 0) / p.weeklyGoalM) : 0;
  return html`<button class="week" onClick=${() => c.openSheet({ type: 'settings', focus: 'goals' })}>
    <div class="k">This week${w?.localOnly ? ' · rides here' : ''}</div>
    <div class="weekline">
      <span class="num">+${elev.value}<span class="u">${elev.unit}</span></span>
      ${goal && html`<span class="of">of ${goal.value} ${goal.unit}</span>`}
      <span class="bits">${!w?.localOnly && w?.runDistanceM ? `${run.value} ${run.unit} run · ` : ''}${h ? `${h} h ` : ''}${m} min riding</span>
    </div>
    ${goal && html`<div class="ivbar"><i style=${{ width: `${frac * 100}%`, background: frac >= 1 ? 'var(--pz3)' : 'var(--paper-2)' }}></i></div>`}
  </button>`;
}

function Contents({ c, s }) {
  const [tab, setTab] = useState(() => {
    try {
      return sessionStorage.getItem(storeKey('tab')) || 'routes';
    } catch {
      return 'routes';
    }
  });
  const choose = (t) => {
    setTab(t);
    try {
      sessionStorage.setItem(storeKey('tab'), t);
    } catch {
      // ignore
    }
    if (t === 'runs' && s.strava.connected) loadStrava();
  };
  const loadStrava = () => {
    if (!s.runs && s.runsState !== 'loading') c.loadRuns();
    if (!s.segments && s.segmentsState !== 'loading') c.loadSegments();
  };
  useEffect(() => {
    if (tab === 'runs' && s.strava.connected) loadStrava();
  }, []);
  const { prefs } = s;
  let rows;
  if (tab === 'routes') {
    const climbs = s.catalog.filter((d) => !d.loop);
    const loops = s.catalog.filter((d) => d.loop);
    rows = s.catalog.length ? [...climbs, ...loops].map((def, i) => html`<${RouteRow} c=${c} def=${def} i=${i} prefs=${prefs} />`) : html`<div class="empty">Unfolding the maps…</div>`;
  } else if (tab === 'workouts') {
    const list = allWorkouts(s.customWorkouts);
    rows = [html`<${AutopilotRow} c=${c} prefs=${prefs} i=${0} />`, ...list.map((w, i) => html`<${WorkoutRow} c=${c} w=${w} i=${i + 1} />`)];
  } else if (!s.strava.connected) {
    rows = html`<div class="empty">Connect Strava and your starred segments and recent runs show up here, ready to ride on their real roads.
      <div><button class="btn sec small" onClick=${() => c.openSheet({ type: 'settings', focus: 'strava' })}>Connect Strava</button></div></div>`;
  } else {
    rows = html`<${StravaContents} c=${c} s=${s} />`;
  }
  return html`
    <div class="contents-head">
      <span class="k">Contents</span>
      <div class="tabs" role="tablist">
        ${['routes', 'workouts', 'runs'].map((t) => html`<button role="tab" aria-selected=${tab === t} class=${tab === t ? 'on' : ''} onClick=${() => choose(t)}>${t === 'runs' ? 'Strava' : t}</button>`)}
      </div>
    </div>
    <div class="contents">${rows}</div>`;
}

// ---------------------------------------------------------------- the page

function Feature({ c, s, pick }) {
  return html`<div class="feature">
    <div class="art"><${Scene} region="bayarea" tod=${tod(s.prefs)} seed="tonight" w=${366} h=${176} /></div>
    <div class="k lt">${pick.kicker}</div>
    <h3>${pick.title[0]} <em>${pick.title[1]}</em></h3>
    <div class="meta">${pick.meta}</div>
    <button class="btn pri" onClick=${() => c.ride(pick.plan)}>Start ride ${Icon.chevron()}</button>
  </div>`;
}

function Recovery({ c, cp }) {
  const at = new Date(cp.savedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return html`<div class="note-card recover">
    <b>Unfinished ride</b>
    ${cp.meta?.plan?.title || cp.meta?.routeName || 'A ride'} · ${cp.minutes} min, last saved ${at}. Save it (and send it to Strava), or let it go.
    <div class="btnrow"><button class="btn pri small" onClick=${() => c.recoverCheckpoint()}>Save ride</button><button class="btn ghost small" onClick=${() => c.dropCheckpoint()}>Discard</button></div>
  </div>`;
}

export function Home({ c }) {
  const s = useStore(c.store);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  const { prefs } = s;
  const pick = tonightsPick({ recent: s.recent, lastRide: s.lastRide, units: prefs.units });
  const initials = (prefs.name || '').slice(0, 1).toUpperCase();
  const fileInput = (accept, onText) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => {
      const f = input.files?.[0];
      if (f) onText(await f.text(), f.name);
    };
    input.click();
  };
  return html`<div class="screen">
    <div class="scroll">
      <div class="home">
        <header class="masthead">
          <span class="logo">${APP.name}</span>
          <span class="right">
            ${s.strava.connected && (s.strava.needsReconnect || !s.strava.canUpload)
              ? html`<button class="chip warn" onClick=${() => c.openSheet({ type: 'settings', focus: 'strava' })}>Strava · sign in</button>`
              : s.strava.connected
              ? html`<span class="chip">✓ Strava${s.strava.pending ? ` · ${s.strava.pending} waiting` : ''}</span>`
              : html`<button class="chip" onClick=${() => c.openSheet({ type: 'settings', focus: 'strava' })}>Strava</button>`}
            <button class="avatar" aria-label="Settings" onClick=${() => c.openSheet({ type: 'settings' })}>${initials || '⋯'}</button>
          </span>
        </header>
        <div class="k dateline">${dateline(now)}</div>
        <h1 class="greeting">${greeting(now, prefs.name)}</h1>
        <p class="dek">${pick.dek}</p>
        <${Week} c=${c} s=${s} />
        ${s.checkpoint && html`<${Recovery} c=${c} cp=${s.checkpoint} />`}
        <${Tiles} c=${c} s=${s} />
        <${Feature} c=${c} s=${s} pick=${pick} />
        <${Contents} c=${c} s=${s} />
        <div class="chips">
          <button class="chip" onClick=${() => c.openSheet({ type: 'plan', plan: { kind: 'free', id: 'free', title: 'Free ride' } })}>Free ride</button>
          <button class="chip" onClick=${() => c.openSheet({ type: 'plan', plan: { kind: 'vert', id: 'vert', title: 'Climb goal' } })}>Climb goal</button>
          <button class="chip" onClick=${() => c.openSheet({ type: 'plan', plan: c.rampTest() })}>FTP ramp test</button>
          <button class="chip" onClick=${() => fileInput('.gpx,application/gpx+xml', (t, n) => c.importGpx(t, n))}>Import GPX</button>
          <button class="chip" onClick=${() => c.openSheet({ type: 'editor' })}>Write a workout</button>
        </div>
        <p class="colophon">Built for ${APP.setup}, in Bluefy on iPhone. ${s.update ? html`<button class="linkish" onClick=${() => c.applyUpdate?.()}>Update ready — tap to load it.</button>` : ''}</p>
      </div>
    </div>
  </div>`;
}
