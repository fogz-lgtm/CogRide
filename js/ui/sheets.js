// Sheets that slide up over a screen: a ride's plan, settings (with the
// Strava connection), pause, device help, and the workout editor.

import { html, useState } from './h.js';
import { useStore } from '../app/store.js';
import { Icon } from './icons.js';
import { Scene, WorkoutProfile } from './charts.js';
import { clock, U } from './format.js';
import { sparkline } from '../core/routeLibrary.js';
import { regionFor, timeOfDayNow } from '../world/themes.js';
import { AUTOPILOT_MINUTES, autopilotPlan, vertPlan } from '../app/plans.js';
import { loadBest } from '../app/history.js';
import { totalDuration } from '../workouts.js';
import { estimateTss } from './home.js';
import { parseWeight } from '../core/units.js';
import { redirectUri } from '../services/strava.js';
import { APP, isFlux } from '../variant.js';

const Seg = ({ value, options, onChange }) => html`<div class="seg">${options.map(([v, label]) => html`<button class=${v === value ? 'on' : ''} onClick=${() => onChange(v)}>${label}</button>`)}</div>`;
const Toggle = ({ on, onChange, label }) => html`<button class=${`toggle ${on ? 'on' : ''}`} role="switch" aria-checked=${on} aria-label=${label} onClick=${() => onChange(!on)}></button>`;
const Row = ({ title, sub, children }) => html`<div class="setrow"><div class="l"><b>${title}</b>${sub && html`<span>${sub}</span>`}</div>${children}</div>`;

function Sheet({ c, children, onClose, className = '' }) {
  return html`<div class="sheet-wrap" onClick=${(e) => e.target === e.currentTarget && (onClose ? onClose() : c.closeSheet())}>
    <div class=${`sheet ${className}`} role="dialog" aria-modal="true">
      <div class="grab"></div>
      ${children}
    </div>
  </div>`;
}

function CloseBar({ c, children, onClose }) {
  return html`<div class="closebar">${children}<button class="gbtn" aria-label="Close" onClick=${() => (onClose ? onClose() : c.closeSheet())}>${Icon.close()}</button></div>`;
}

// ---------------------------------------------------------------- plan

const firstSentences = (text, n = 2) => ((text || '').match(/[^.]+(\.|$)/g) || []).slice(0, n).join('').trim();

function RouteChoice({ s, value, onChange, climbsOnly = false }) {
  const loops = climbsOnly ? [] : s.catalog.filter((d) => d.loop);
  const climbs = s.catalog.filter((d) => !d.loop);
  return html`<div class="routepick">${[...loops, ...climbs].map(
    (d) => html`<button class=${`chip ${d.id === value ? 'on' : ''}`} onClick=${() => onChange(d.id)}>${d.name.replace(/\s*\(.*\)$/, '')}</button>`,
  )}</div>`;
}

export function PlanSheet({ c, s, sheet }) {
  const { prefs } = s;
  const plan = sheet.plan;
  const [minutes, setMinutes] = useState(plan?.minutes ?? 60);
  const [routeId, setRouteId] = useState(plan?.routeId ?? (plan?.kind === 'free' ? prefs.freeRouteId : plan?.kind === 'vert' ? prefs.vertRouteId || 'mount-diablo-south-gate' : prefs.workoutRouteId));
  const [goalM, setGoalM] = useState(plan?.goalM ?? prefs.vertGoalM ?? 3000 * 0.3048);
  if (sheet.loading || !plan) {
    return html`<${Sheet} c=${c}><${CloseBar} c=${c}><h2>${sheet.title || 'Loading'} <em>…</em></h2><//><p class="sub">Fetching the track from Strava.</p><//>`;
  }
  const units = prefs.units;
  const tod = prefs.timeOfDay === 'auto' ? timeOfDayNow() : prefs.timeOfDay;
  let figure = null;
  let title = [plan.title, ''];
  let sub = '';
  let stats = [];
  let extra = null;
  let go = plan;

  if (plan.kind === 'route' && plan.def) {
    const d = plan.def;
    const spark = sparkline(d, 60);
    figure = html`<${Scene} region=${regionFor(d)} tod=${tod} seed=${d.id} w=${366} h=${150} profile=${spark} />`;
    title = [d.name, d.loop ? 'a loop' : d.region?.split('(')[0].trim() || ''];
    sub = firstSentences(d.description);
    const len = U.distance(d.lengthM, units);
    const gain = U.elevation(d.gainM, units);
    stats = [
      ['Distance', len.value, len.unit],
      ['Climb', gain.value, gain.unit],
      d.loop ? ['Laps', '∞', ''] : ['Average', d.avgGradientPct, '%'],
    ];
  } else if (plan.kind === 'run' || plan.kind === 'gpx' || plan.kind === 'segment') {
    const r = plan.route;
    figure = html`<${Scene} region="bayarea" tod=${tod} seed=${r.id} w=${366} h=${150} profile=${Array.from({ length: 60 }, (_, i) => r.elevationAt((r.length * i) / 59))} />`;
    title = [r.name, plan.kind === 'run' ? 'as a ride' : plan.kind === 'segment' ? 'a Strava segment' : 'imported'];
    sub =
      plan.kind === 'run'
        ? 'Your run’s real road and real climbing. You ride up it and back down again.'
        : plan.kind === 'segment'
          ? 'The segment’s real road and gradient, start to finish, then back down to go again.'
          : 'Ridden up and back, on its real elevation.';
    const len = U.distance(r.length, units);
    const gain = U.elevation(r.ascent, units);
    stats = [
      ['Distance', len.value, len.unit],
      ['Climb', gain.value, gain.unit],
      ['Steepest', Math.round(Math.max(...Array.from({ length: 100 }, (_, i) => r.gradeAt((r.length * i) / 100)))), '%'],
    ];
  } else if (plan.kind === 'workout' || plan.kind === 'ramp') {
    const w = plan.workout;
    figure = html`<div class="planprofile"><${WorkoutProfile} workout=${w} clock=${0} className="" showPlayhead=${false} /></div>`;
    title = plan.kind === 'ramp' ? ['FTP', 'ramp test'] : [w.name, ''];
    sub = w.description || '';
    const mins = Math.round(totalDuration(w) / 60);
    stats =
      plan.kind === 'ramp'
        ? [
            ['Starts at', w.rampStartW, 'W'],
            ['Each minute', `+${w.rampStepW}`, 'W'],
            ['Your FTP', prefs.ftp, 'W'],
          ]
        : [
            ['Time', mins, 'min'],
            ['TSS', `~${estimateTss(w)}`, ''],
            ['Intervals', w.steps.length, ''],
          ];
    extra = html`<div class="section"><div class="k">Ride it on</div><${RouteChoice} s=${s} value=${routeId} onChange=${setRouteId} /></div>
      ${plan.kind === 'ramp' && html`<p class="sub">ERG holds each step. When you can’t keep the pedals turning, the test ends by itself and your new FTP is 75 % of your best minute.</p>`}
      ${plan.workout && !plan.workout.builtIn && html`<button class="btn danger small" onClick=${() => (c.deleteWorkout(plan.workout.id), c.closeSheet())}>Delete this workout</button>`}`;
    go = { ...plan, routeId };
  } else if (plan.kind === 'autopilot') {
    const z = s.prefs.hrZones[1];
    figure = html`<${Scene} region="bayarea" tod=${tod} seed="z2" w=${366} h=${150} />`;
    title = ['Zone 2', 'autopilot'];
    sub = `You pedal; ${APP.name} holds the watts and nudges them so your heart stays between ${z.min} and ${z.max} bpm — easing off as you drift. ${APP.controllers ? 'A Click moves' : 'Tapping the target moves'} the target 2 bpm.`;
    stats = [
      ['Band', `${z.min}–${z.max}`, 'bpm'],
      ['Starts', Math.round(prefs.ftp * 0.55), 'W'],
      ['Steps', '≤ 4', 'W'],
    ];
    extra = html`<div class="section"><${Row} title="How long"><${Seg} value=${minutes} options=${AUTOPILOT_MINUTES.map((m) => [m, `${m}`])} onChange=${setMinutes} /><//></div>
      <div class="section"><div class="k">Ride it on</div><${RouteChoice} s=${s} value=${routeId} onChange=${setRouteId} /></div>
      ${s.devices.hr.state !== 'ready' && html`<p class="sub">Needs heart rate: connect your Pace 3 first.</p>`}`;
    go = { ...autopilotPlan(minutes), routeId };
  } else if (plan.kind === 'vert') {
    const climbDef = s.catalog.find((d) => d.id === routeId);
    figure = html`<${Scene} region=${climbDef ? regionFor(climbDef) : 'alpine'} tod=${tod} seed=${`vert${routeId}`} w=${366} h=${150} profile=${climbDef ? sparkline(climbDef, 60) : null} />`;
    title = ['Climb', 'goal'];
    sub = 'Pick a number and a climb. Ride up, roll back down, go again — until you’ve climbed it. Descents are free.';
    const goals = units === 'metric' ? [300, 600, 1000, 1500].map((m) => [m, `${m} m`]) : [1000, 2000, 3000, 5000].map((ft) => [ft * 0.3048, `${ft / 1000}k ft`]);
    const reps = climbDef ? Math.ceil(goalM / climbDef.gainM) : null;
    extra = html`<div class="section"><${Row} title="Goal" sub=${reps ? `About ${reps} time${reps > 1 ? 's' : ''} up ${climbDef.name.replace(/\s*\(.*\)$/, '')}` : ''}><${Seg} value=${goals.find(([v]) => Math.abs(v - goalM) < 1)?.[0] ?? goalM} options=${goals} onChange=${setGoalM} /><//></div>
      <div class="section"><div class="k">On</div><${RouteChoice} s=${s} value=${routeId} onChange=${setRouteId} climbsOnly=${true} /></div>`;
    go = vertPlan(goalM, routeId);
  } else if (plan.kind === 'free') {
    figure = html`<${Scene} region="coast" tod=${tod} seed="free" w=${366} h=${150} />`;
    title = ['Free', 'ride'];
    sub = 'No plan. Pick a road, shift as you like, stop when you want.';
    extra = html`<div class="section"><div class="k">Road</div><${RouteChoice} s=${s} value=${routeId} onChange=${setRouteId} /></div>`;
    go = { ...plan, routeId };
  }

  const remember = () => {
    if (plan.kind === 'free') c.setPrefs({ freeRouteId: routeId });
    else if (plan.kind === 'vert') c.setPrefs({ vertRouteId: routeId, vertGoalM: goalM });
    else if (!['route', 'run', 'gpx', 'segment'].includes(plan.kind)) c.setPrefs({ workoutRouteId: routeId });
  };
  // The road this ride is on: its own trainer difficulty and your best time there.
  const roadKey = plan.kind === 'route' ? plan.def?.id ?? plan.id : plan.route?.id ?? (['vert', 'free'].includes(plan.kind) ? routeId : null);
  const best = roadKey && ['route', 'run', 'gpx', 'segment', 'vert', 'free'].includes(plan.kind) ? loadBest(roadKey) : null;
  const roadDiff = roadKey ? prefs.routeDifficulty?.[roadKey] ?? null : null;
  const setRoadDiff = (v) => {
    const next = { ...(prefs.routeDifficulty || {}) };
    if (v == null) delete next[roadKey];
    else next[roadKey] = v;
    c.setPrefs({ routeDifficulty: next });
  };
  const roadRows =
    roadKey && ['route', 'run', 'gpx', 'segment', 'vert', 'free'].includes(plan.kind)
      ? html`<div class="section">
          ${best && html`<${Row} title=${`Your best here: ${clock(best.timeS)}`} sub=${`${new Date(best.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${prefs.ghost !== false ? ' · its ghost rides with you' : ''}`}><span></span><//>`}
          <${Row} title="Difficulty here" sub=${roadDiff == null ? `Default · ${Math.round(prefs.difficulty * 100)} %` : 'This road only'}>
            <${Seg} value=${roadDiff} options=${[[null, 'Default'], [0.25, '25'], [0.5, '50'], [0.75, '75'], [1, '100']]} onChange=${setRoadDiff} />
          <//>
        </div>`
      : null;
  return html`<${Sheet} c=${c} className="plansheet">
    <${CloseBar} c=${c}><h2>${title[0]} ${title[1] && html`<em>${title[1]}</em>`}</h2><//>
    ${figure && html`<div class="planfig">${figure}</div>`}
    ${sub && html`<p class="sub">${sub}</p>`}
    ${stats.length > 0 && html`<div class="statline">${stats.map(([k, v, u]) => html`<div><div class="k">${k}</div><div class="num">${v}${u && html`<span class="u">${u}</span>`}</div></div>`)}</div>`}
    ${extra}
    ${roadRows}
    <button class="btn pri wide go" onClick=${() => (remember(), c.ride(go))}>Ride ${Icon.chevron()}</button>
  <//>`;
}

// ---------------------------------------------------------------- pause

export function PauseSheet({ c, s }) {
  const { snap } = useStore(c.live);
  const [confirm, setConfirm] = useState(false);
  const units = s.prefs.units;
  const d = U.distance(snap?.distance ?? 0, units);
  const climb = U.elevation(snap?.climbed ?? 0, units);
  return html`<${Sheet} c=${c} className="pause">
    <h2>Catch your <em>breath.</em></h2>
    <div class="statline">
      <div><div class="k">Time</div><div class="num">${clock(snap?.movingTime ?? 0)}</div></div>
      <div><div class="k">Distance</div><div class="num">${d.value}<span class="u">${d.unit}</span></div></div>
      <div><div class="k">Climbed</div><div class="num">${climb.value}<span class="u">${climb.unit}</span></div></div>
    </div>
    <button class="btn pri" onClick=${() => c.resume()}>${Icon.play()} Resume</button>
    ${APP.controllers && html`<p class="or">or hold + and − on the Click together</p>`}
    <div class="btnrow">
      <button class="btn sec" onClick=${() => c.finish()}>End & save</button>
      <button class="btn sec" onClick=${() => (c.resume(), c.setTv(!s.tv))}>${s.tv ? 'Leave TV mode' : 'TV mode'}</button>
    </div>
    <div class="section">
      <${Row} title="Fuel reminders" sub=${s.prefs.fuelEveryMin ? `Every ${s.prefs.fuelEveryMin} min` : 'Off'}>
        <${Toggle} label="Fuel reminders" on=${!!s.prefs.fuelEveryMin} onChange=${(on) => c.setPrefs({ fuelEveryMin: on ? 45 : 0 })} />
      <//>
      <${Row} title="Sounds" sub=${APP.virtualGears ? 'Shift ticks and interval cues' : 'Interval cues'}>
        <${Toggle} label="Sounds" on=${s.prefs.sound !== 'off'} onChange=${(on) => c.setPrefs({ sound: on ? 'normal' : 'off' })} />
      <//>
    </div>
    <button class="btn danger wide" onClick=${() => (confirm ? c.discard() : setConfirm(true))}>${confirm ? 'Tap again to throw this ride away' : 'Discard ride…'}</button>
  <//>`;
}

// ---------------------------------------------------------------- settings

function NumField({ value, unit, onCommit, width, step = 1, min, max }) {
  return html`<label class="field"><input type="number" inputmode="decimal" step=${step} min=${min} max=${max} value=${value} style=${width ? { width } : null} onChange=${(e) => onCommit(e.target.value)} />${unit && html`<span>${unit}</span>`}</label>`;
}

function StravaCard({ c, s }) {
  const st = s.strava;
  const [id, setId] = useState(st.clientId || '');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  if (st.connected) {
    const a = st.athlete;
    const trouble = st.needsReconnect || !st.canUpload;
    return html`<div>
      <${Row}
        title=${a ? `Connected as ${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() : 'Connected'}
        sub=${st.needsReconnect ? 'Strava stopped accepting this sign-in — reconnect to keep uploading.' : st.canUpload ? 'Rides upload as virtual rides, marked “trainer”.' : 'Upload permission is off — reconnect and leave every box ticked.'}
      >
        ${trouble ? html`<span class="chip warn">Needs sign-in</span>` : html`<span class="chip">✓ Strava</span>`}
      <//>
      ${trouble && html`<button class="btn pri wide" onClick=${() => c.reconnectStrava()}>Reconnect Strava</button>`}
      <${Row} title="Upload rides automatically" sub="Right after you end a ride">
        <${Toggle} label="Upload automatically" on=${s.prefs.autoUpload} onChange=${(on) => c.setPrefs({ autoUpload: on })} />
      <//>
      ${st.pending > 0 &&
      html`<${Row} title=${`${st.pending} ride${st.pending > 1 ? 's' : ''} waiting`} sub="Saved on this phone">
        <button class="btn sec small" disabled=${trouble} onClick=${() => c.sendPending()}>Send now</button>
      <//>`}
      <div class="btnrow">
        ${!trouble && html`<button class="btn ghost small" onClick=${() => c.reconnectStrava()}>Reconnect</button>`}
        <button class="btn ghost small" onClick=${() => c.disconnectStrava()}>Disconnect Strava</button>
      </div>
    </div>`;
  }
  const host = location.hostname || 'fogz-lgtm.github.io';
  return html`<div>
    <div class="note-card">
      <b>Connect Strava · two minutes</b>
      <ol>
        <li>Use the same Strava API app as Onpace (or make one at <a href="https://www.strava.com/settings/api" target="_blank" rel="noopener">strava.com/settings/api</a>).</li>
        <li>Its <i>Authorization Callback Domain</i> must be <code>${host}</code> — Onpace’s already is.</li>
        <li>Paste the Client ID and Secret here. They stay in this browser only.</li>
      </ol>
    </div>
    <div class="section">
      <${Row} title="Client ID"><label class="field"><input class="wide" inputmode="numeric" autocomplete="off" value=${id} onInput=${(e) => setId(e.target.value)} placeholder="12345" /></label><//>
      <${Row} title="Client Secret"><label class="field"><input class="wide" type="password" autocomplete="off" value=${secret} onInput=${(e) => setSecret(e.target.value)} placeholder="from the API page" /></label><//>
    </div>
    ${error && html`<p class="error">${error}</p>`}
    <button
      class="btn pri wide"
      onClick=${() => {
        try {
          c.connectStrava({ clientId: id, clientSecret: secret });
        } catch (err) {
          setError(err.message);
        }
      }}
    >
      Connect Strava
    </button>
    <p class="sub small">Strava will send you back to ${redirectUri()}.</p>
  </div>`;
}

export function SettingsSheet({ c, s }) {
  const p = s.prefs;
  const units = p.units;
  const w = U.weight(p.riderKg, units);
  const z = p.hrZones[1];
  const setZone2 = (min, max) => {
    const zones = p.hrZones.map((x) => ({ ...x }));
    zones[1] = { min, max };
    zones[0].max = min - 1;
    zones[2].min = max + 1;
    c.setPrefs({ hrZones: zones, hrZonesManual: true });
  };
  const heightIn = Math.round(p.heightCm / 2.54);
  const climbs = s.catalog;
  return html`<${Sheet} c=${c} className="settings">
    <${CloseBar} c=${c}><h2>Settings</h2><//>

    <div class="section">
      <div class="k">You</div>
      <${Row} title="Name" sub="For the greeting"><label class="field"><input class="wide short" value=${p.name} onChange=${(e) => c.setPrefs({ name: e.target.value.trim() })} placeholder="Your name" /></label><//>
      <${Row} title="Weight" sub=${p.weightSource === 'strava' ? 'From Strava' : 'Climbing speed depends on it'}>
        <${NumField} value=${w.value} unit=${w.unit} step=${units === 'metric' ? 0.1 : 1} onCommit=${(v) => {
          const kg = parseWeight(v, units);
          if (kg && kg > 30 && kg < 200) c.setPrefs({ riderKg: Math.round(kg * 10) / 10, weightSource: 'manual' });
        }} />
      <//>
      <${Row} title="Height" sub="Sets your frontal area (drag)">
        ${units === 'metric'
          ? html`<${NumField} value=${p.heightCm} unit="cm" onCommit=${(v) => Number(v) > 120 && Number(v) < 230 && c.setPrefs({ heightCm: Number(v) })} />`
          : html`<${NumField} value=${heightIn} unit="in" onCommit=${(v) => Number(v) > 48 && Number(v) < 90 && c.setPrefs({ heightCm: Math.round(Number(v) * 2.54) })} />`}
      <//>
      <${Row} title="FTP" sub=${p.ftpSource === 'strava' ? 'From Strava' : p.ftpSource === 'ramp' ? 'From your ramp test' : 'Or take the ramp test'}>
        <${NumField} value=${p.ftp} unit="W" onCommit=${(v) => Number(v) >= 50 && Number(v) <= 600 && c.setPrefs({ ftp: Math.round(Number(v)), ftpSource: 'manual' })} />
      <//>
      <${Row} title="Zone 2 heart rate" sub="Autopilot keeps you here">
        <span class="pair">
          <${NumField} value=${z.min} width="46px" onCommit=${(v) => Number(v) > 60 && Number(v) < z.max && setZone2(Number(v), z.max)} />
          <${NumField} value=${z.max} width="46px" unit="bpm" onCommit=${(v) => Number(v) > z.min && Number(v) < 220 && setZone2(z.min, Number(v))} />
        </span>
      <//>
    </div>

    <div class="section">
      <div class="k">Riding</div>
      <${Row} title="Units"><${Seg} value=${units} options=${[['imperial', 'mi · ft'], ['metric', 'km · m']]} onChange=${(v) => c.setPrefs({ units: v })} /><//>
      <${Row} title="Trainer difficulty" sub=${`How much of the road’s slope you feel. Zwift’s default is 50 %.${isFlux ? ' The Flux S tops out at 10 %.' : ''}`}>
        <${Seg} value=${p.difficulty} options=${[[0.25, '25'], [0.5, '50'], [0.75, '75'], [1, '100']]} onChange=${(v) => c.setPrefs({ difficulty: v })} />
      <//>
      ${APP.virtualGears &&
      html`<${Row} title="Gears" sub=${p.gearTable === 'climbing' ? 'Closer, easier steps for long climbs (top gear 4.2)' : 'Zwift’s 24 gears'}>
        <${Seg} value=${p.gearTable || 'zwift'} options=${[['zwift', 'Zwift'], ['climbing', 'Climbing']]} onChange=${(v) => c.setPrefs({ gearTable: v })} />
      <//>`}
      <${Row} title=${APP.controllers ? 'ERG Click step' : 'ERG step'} sub=${APP.controllers ? 'Each Click nudges the target' : 'Each tap on the target nudges it'}><${Seg} value=${p.ergStepPct} options=${[[0.01, '1 %'], [0.02, '2 %']]} onChange=${(v) => c.setPrefs({ ergStepPct: v })} /><//>
      <${Row} title="Fuel reminders"><${Seg} value=${p.fuelEveryMin} options=${[[0, 'Off'], [30, '30'], [45, '45'], [60, '60']]} onChange=${(v) => c.setPrefs({ fuelEveryMin: v })} /><//>
      <${Row} title="Sounds"><${Seg} value=${p.sound} options=${[['normal', 'Normal'], ['quiet', 'Quiet'], ['off', 'Off']]} onChange=${(v) => c.setPrefs({ sound: v })} /><//>
      <${Row} title="Cues in TV mode" sub="Mix under your show; ring switch must be on"><${Toggle} label="Cues in TV mode" on=${p.tvSound !== 'off'} onChange=${(on) => c.setPrefs({ tvSound: on ? 'on' : 'off' })} /><//>
      <${Row} title="Light" sub="Auto follows your clock"><${Seg} value=${p.timeOfDay} options=${[['auto', 'Auto'], ['day', 'Day'], ['golden', 'Gold'], ['dusk', 'Dusk'], ['night', 'Night']]} onChange=${(v) => c.setPrefs({ timeOfDay: v })} /><//>
      <${Row} title="Workouts ride on">
        <label class="field"><select class="wide" value=${p.workoutRouteId} onChange=${(e) => c.setPrefs({ workoutRouteId: e.target.value })}>${climbs.map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select></label>
      <//>
    </div>

    <div class="section" id="goals">
      <div class="k">Goals</div>
      <${Row} title="Weekly climbing" sub="Runs and rides together, from Strava">
        <${Seg}
          value=${p.weeklyGoalM || 0}
          options=${units === 'metric' ? [[0, 'Off'], [1500, '1.5k'], [3000, '3k'], [4500, '4.5k']] : [[0, 'Off'], [5000 * 0.3048, '5k'], [10000 * 0.3048, '10k'], [15000 * 0.3048, '15k']]}
          onChange=${(v) => c.setPrefs({ weeklyGoalM: v })}
        />
      <//>
      <${Row} title="Race your best" sub="A ghost of your fastest ride on each road, beside you">
        <${Toggle} label="Race your best" on=${p.ghost !== false} onChange=${(on) => c.setPrefs({ ghost: on })} />
      <//>
    </div>

    <div class="section" id="strava">
      <div class="k">Strava</div>
      <${StravaCard} c=${c} s=${s} />
    </div>

    <div class="section">
      <div class="k">Devices</div>
      ${isFlux
        ? html`<div class="note-card"><b>Tacx Flux S</b>Close the Tacx Training app and Zwift first — the trainer takes orders from one app at a time. FluxRide sets the climb and you shift with your bike’s own gears, like riding outside. The Flux S simulates up to 10 %.</div>
            <div class="note-card"><b>Gears in ERG workouts</b>ERG holds the watts whatever gear you’re in, but the Flux S needs some wheel speed to do it. Sit in a middle gear (big ring, middle of the cassette) and leave it there. If the trainer can’t hold the target, FluxRide tells you which way to shift.</div>`
        : html`<div class="note-card"><b>Wahoo KICKR Core + Zwift Cog</b>Close Zwift and the Wahoo app first — only one app can steer the trainer. CogRide shifts with the trainer’s own virtual shifting, like Zwift does; on older firmware it shifts in software instead.</div>
            <div class="note-card"><b>Zwift Click</b>Tap the Click tile, then press a button so it shows up. A Click v2 is two pucks: connect each one. If the left puck locks itself, the right puck still shifts both ways: + is harder, B is easier.</div>`}
      <div class="note-card"><b>Coros Pace 3</b>On the watch: Settings › Heart Rate Broadcast › On. It talks to one app at a time, and not while it has sensors paired. ${APP.name} records the ride, so don’t also save one on the watch (or you’ll get two on Strava).</div>
      <div class="note-card"><b>Keep the screen on</b>${APP.name} asks iOS to keep the screen awake while you ride. If it dims anyway, set Settings › Display › Auto-Lock to Never for your rides.</div>
      <div class="btnrow">
        <button class="btn sec small" onClick=${() => (c.useSimulator(), c.closeSheet())}>Use the simulator</button>
        <button class="btn sec small" onClick=${() => (c.disconnectTrainer(), c.disconnectClicks(), c.disconnectHeart())}>Disconnect all</button>
      </div>
    </div>

    <div class="section about">
      <div class="k">About</div>
      <p class="sub small">Routes follow real roads from OpenStreetMap (© OpenStreetMap contributors, ODbL) with elevation from AWS Terrain Tiles. Fonts: Archivo and Fraunces (SIL OFL). 3D: three.js (MIT). Build ${globalThis.COGRIDE_BUILD || 'dev'}.</p>
    </div>
  <//>`;
}

// ---------------------------------------------------------------- devices

// 0000180a-0000-1000-8000-00805f9b34fb → 180a; anything else → its first 8.
const shortUuid = (u) => /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(u)?.[1] ?? u.slice(0, 8);

function trainerLine(d) {
  if (d.sim) {
    return isFlux
      ? 'The simulator: a pretend Flux S and rider, for trying FluxRide without hardware. W/S changes how hard the pretend rider pushes.'
      : 'The simulator: a pretend KICKR and rider, for trying CogRide without hardware. ↑/↓ shift, W/S changes how hard the pretend rider pushes.';
  }
  if (isFlux) return `${d.name} — ${d.path === 'fec' ? 'Tacx’s own control (FE-C)' : 'standard smart-trainer control (FTMS)'}. You shift with the bike; FluxRide sets the climb.`;
  return d.path === 'zwift' ? `${d.name} — using the trainer’s own virtual shifting (Zwift protocol).` : `${d.name} — standard smart-trainer control (FTMS); gears are worked out in CogRide.`;
}

export function DeviceSheet({ c, s, which }) {
  const d = s.devices[which];
  if (which === 'trainer') {
    return html`<${Sheet} c=${c}>
      <${CloseBar} c=${c}><h2>Trainer <em>${d.state === 'ready' ? 'ready' : d.state}</em></h2><//>
      <p class="sub">${trainerLine(d)}</p>
      ${!isFlux && !d.sim && d.path === 'ftms' && html`<div class="note-card">
        <b>Why not the trainer’s own virtual shifting?</b>
        ${
          {
            'no-service': 'The trainer didn’t offer Zwift’s virtual-shifting service to CogRide.',
            'no-chars': 'The trainer offered Zwift’s service, but not the parts needed to steer it.',
            'no-handshake': 'The trainer didn’t answer Zwift’s handshake (another app may be holding it — close Zwift and the Wahoo app, then reconnect).',
            'gears-ignored': 'The trainer accepted the handshake but kept ignoring gear changes.',
            'forced-ftms': 'Standard control was chosen on purpose.',
          }[d.zpStatus] ?? 'It wasn’t available on this connection.'
        }${' '}
        Shifting still works — CogRide turns each gear into resistance itself, so it feels the same, just a moment slower to respond.
        ${d.services && html`<div class="svcs">Services: ${d.services.map(shortUuid).join(' · ')}</div>`}
      </div>`}
      <div class="btnrow">
        <button class="btn sec" onClick=${() => (c.disconnectTrainer(), c.closeSheet())}>Disconnect</button>
        <button class="btn sec" onClick=${() => (c.closeSheet(), c.connectTrainer())}>${d.sim ? 'Use real trainer' : 'Reconnect'}</button>
      </div>
    <//>`;
  }
  if (which === 'click') {
    return html`<${Sheet} c=${c}>
      <${CloseBar} c=${c}><h2>Click <em>${d.count === 2 ? 'both pucks' : d.count === 1 ? 'one puck' : 'off'}</em></h2><//>
      <p class="sub">${d.battery != null ? `Battery ${d.battery} %. ` : ''}Plus is harder, minus is easier; hold to keep shifting. Hold both together to pause.</p>
      <div class="btnrow">
        <button class="btn sec" onClick=${() => (c.closeSheet(), c.connectClick())}>Add a puck</button>
        <button class="btn sec" onClick=${() => (c.disconnectClicks(), c.closeSheet())}>Disconnect</button>
      </div>
      <button class="btn ghost small" onClick=${() => c.openSheet({ type: 'clickhelp' })}>Can’t find a puck?</button>
    <//>`;
  }
  return html`<${Sheet} c=${c}>
    <${CloseBar} c=${c}><h2>Heart rate <em>${d.state === 'ready' ? 'live' : d.state}</em></h2><//>
    <p class="sub">${d.name || 'Heart-rate strap or watch'}. On the Pace 3, keep Heart Rate Broadcast on for the whole ride.</p>
    <div class="btnrow">
      <button class="btn sec" onClick=${() => (c.disconnectHeart(), c.closeSheet())}>Disconnect</button>
      <button class="btn sec" onClick=${() => (c.closeSheet(), c.connectHeart())}>Reconnect</button>
    </div>
  <//>`;
}

// Zwift locks the Click v2's left puck to its own app.
export function ClickLockedSheet({ c, s }) {
  const right = s.devices.click.count > 0;
  return html`<${Sheet} c=${c}>
    <${CloseBar} c=${c}><h2>Zwift locked <em>the left Click.</em></h2><//>
    <p class="sub">Zwift locks the left puck (−) to its own app about a minute after another app connects. The right puck is never locked.</p>
    <div class="note-card">
      <b>Easiest: ride with the right puck</b>
      Press <b class="inl">+</b> for harder and <b class="inl">B</b> (the button below +) for easier. Hold either to keep shifting.${right ? '' : ' Connect the right puck from the Click tile.'}
    </div>
    <div class="note-card">
      <b>Or unlock the left puck for a day</b>
      <ol>
        <li>Open the Zwift app (not Companion) and pair your Click there.</li>
        <li>Leave it connected for about 30 seconds — no ride needed.</li>
        <li>Swipe Zwift fully closed, then connect the left puck here again.</li>
      </ol>
      Zwift’s unlock lasts roughly 24 hours.
    </div>
    <div class="btnrow">
      <button class="btn sec" onClick=${() => (c.closeSheet(), c.connectClick())}>Connect a puck</button>
      <button class="btn pri" onClick=${() => c.closeSheet()}>Got it</button>
    </div>
  <//>`;
}

// When the Click doesn't show up in the Bluetooth list.
export function ClickHelpSheet({ c }) {
  return html`<${Sheet} c=${c}>
    <${CloseBar} c=${c}><h2>Can’t see <em>your Click?</em></h2><//>
    <div class="note-card">
      <ol>
        <li><b class="inl">Wake it.</b> Press a button on the puck — its light blinks. Pucks fall asleep after a minute or so.</li>
        <li><b class="inl">Free it.</b> A Click talking to Zwift stays hidden. Swipe Zwift and Zwift Companion closed (and quit Zwift on any iPad, Apple TV or computer nearby).</li>
        <li><b class="inl">One at a time.</b> A Click v2 is two pucks, both called “Zwift Click”. Connect one, then tap the Click tile again for the other.</li>
      </ol>
    </div>
    <div class="btnrow">
      <button class="btn sec" onClick=${() => (c.closeSheet(), c.connectClick())}>Search again</button>
      <button class="btn pri" onClick=${() => (c.closeSheet(), c.connectClick({ showAll: true }))}>Show every device</button>
    </div>
    <p class="sub small">“Show every device” lists everything nearby — pick “Zwift Click”. Still nothing? Check Settings › Bluefy › Bluetooth is on.</p>
  <//>`;
}

// FluxRide: the trainer didn't show up in the Bluetooth list.
export function TrainerHelpSheet({ c }) {
  return html`<${Sheet} c=${c}>
    <${CloseBar} c=${c}><h2>Can’t see <em>the trainer?</em></h2><//>
    <div class="note-card">
      <ol>
        <li><b class="inl">Wake it.</b> The Flux S needs mains power: check it’s plugged in, then pedal a few strokes.</li>
        <li><b class="inl">Free it.</b> It talks to one app at a time over Bluetooth. Swipe the Tacx Training app and Zwift closed (and quit them on any iPad, Apple TV or computer nearby).</li>
        <li><b class="inl">Bluetooth on.</b> iOS Settings › Bluefy › Bluetooth must be allowed.</li>
      </ol>
    </div>
    <div class="btnrow">
      <button class="btn sec" onClick=${() => (c.closeSheet(), c.connectTrainer())}>Search again</button>
      <button class="btn pri" onClick=${() => (c.closeSheet(), c.connectTrainer({ showAll: true }))}>Show every device</button>
    </div>
    <p class="sub small">“Show every device” lists everything nearby — pick the one whose name starts with “Tacx”.</p>
  <//>`;
}

export function BluefySheet({ c }) {
  return html`<${Sheet} c=${c}>
    <${CloseBar} c=${c}><h2>Bluetooth isn’t <em>here.</em></h2><//>
    <p class="sub">This browser can’t talk to Bluetooth devices. On iPhone, open this page in <b>Bluefy</b> (free on the App Store) — it adds Web Bluetooth. In Bluefy’s settings, turn on full screen for the best view. On a computer, Chrome and Edge work too.</p>
    <div class="btnrow">
      <button class="btn sec" onClick=${() => navigator.clipboard?.writeText(location.href).then(() => c.toast({ title: 'Link copied', body: 'Paste it into Bluefy.', ms: 3000 }))}>Copy link</button>
      <button class="btn pri" onClick=${() => (c.useSimulator(), c.closeSheet())}>Try the simulator</button>
    </div>
  <//>`;
}

// ---------------------------------------------------------------- editor

const EXAMPLE = `10m 45-75% Warm up
3x 8m 90% Sweet spot, 4m 55% Easy
5m 60-40% Cool down`;

export function EditorSheet({ c }) {
  const [name, setName] = useState('');
  const [text, setText] = useState(EXAMPLE);
  const [error, setError] = useState('');
  const save = () => {
    try {
      const w = c.saveWorkout({ name, text });
      c.openSheet({ type: 'plan', plan: c.workoutPlan(w) });
    } catch (err) {
      setError(err.message);
    }
  };
  const importZwo = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zwo,.xml';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      try {
        const w = c.saveWorkout({ xml: await f.text() });
        c.openSheet({ type: 'plan', plan: c.workoutPlan(w) });
      } catch (err) {
        setError(err.message);
      }
    };
    input.click();
  };
  return html`<${Sheet} c=${c}>
    <${CloseBar} c=${c}><h2>Write a <em>workout</em></h2><//>
    <p class="sub">One block per line: a duration and a target as % of FTP. Ramps are “45-75%”, repeats “3x …, …”, and “free” lets you shift.</p>
    <div class="section"><${Row} title="Name"><label class="field"><input class="wide short" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="My workout" /></label><//></div>
    <textarea class="textarea" spellcheck="false" value=${text} onInput=${(e) => setText(e.target.value)}></textarea>
    ${error && html`<p class="error">${error}</p>`}
    <div class="btnrow">
      <button class="btn sec" onClick=${importZwo}>Import .zwo</button>
      <button class="btn pri" onClick=${save}>Save</button>
    </div>
  <//>`;
}
