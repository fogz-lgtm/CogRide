// After the ride: a picture, a headline written from the ride, climbing
// first, small charts, time in zones, and the Strava status.

import { html } from './h.js';
import { useStore } from '../app/store.js';
import { Icon } from './icons.js';
import { MiniChart, Scene, Sparkline } from './charts.js';
import { windowLabel, POWER_WINDOWS } from '../core/bests.js';
import { decouplingVerdict } from '../core/aerobic.js';
import { clock, POWER_ZONES, HR_ZONES, U } from './format.js';
import { zone2 } from '../app/prefs.js';
import { activityUrl } from '../services/strava.js';
import { timeOfDayNow } from '../world/themes.js';

function share(result) {
  const name = `${result.id}.fit`;
  const blob = new Blob([result.fit], { type: 'application/vnd.ant.fit' });
  const file = typeof File === 'function' ? new File([blob], name, { type: 'application/vnd.ant.fit' }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file], title: result.name }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function StravaRow({ c, s, up }) {
  if (up.status === 'ok') {
    const at = new Date(up.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return html`<div class="strava"><span class="disc ok">${Icon.check()}</span><div><b>${up.duplicate ? 'Already on Strava' : 'Uploaded to Strava'}</b><span>${at} · <a href=${activityUrl(up.activityId)} target="_blank" rel="noopener">View activity →</a></span></div></div>`;
  }
  if (up.status === 'busy') return html`<div class="strava"><span class="disc busy"></span><div><b>Sending to Strava…</b><span>As a virtual ride, marked trainer</span></div></div>`;
  if (up.status === 'err') {
    return html`<div class="strava"><span class="disc err">!</span><div><b>Couldn’t reach Strava</b><span>Saved on this phone · we’ll keep trying</span></div><button class="btn pri" onClick=${() => c.upload()}>Retry</button></div>`;
  }
  if (up.status === 'idle') return html`<div class="strava"><span class="disc off"></span><div><b>Not uploaded</b><span>Auto-upload is off</span></div><button class="btn pri" onClick=${() => c.upload()}>Upload</button></div>`;
  return html`<div class="strava"><span class="disc off"></span><div><b>Strava isn’t connected</b><span>Connect it once and rides go up by themselves</span></div><button class="btn sec" onClick=${() => c.openSheet({ type: 'settings', focus: 'strava' })}>Connect</button></div>`;
}

// Racing your best: the attempt(s) on this ride.
function Attempts({ r }) {
  const list = r.attempts || [];
  if (!list.length) return null;
  // Your fastest today, against the best you had before this ride.
  const fastest = Math.min(...list.map((a) => a.timeS));
  const before = list[0].prevTimeS;
  const name = (r.routeName || 'this road').replace(/\s*\(.*\)$/, '');
  const isNew = before != null && fastest < before;
  let body;
  if (before == null) body = 'Your first time here — next time, its ghost rides with you.';
  else if (isNew) body = `${clock(before - fastest)} faster than your old best of ${clock(before)}.`;
  else body = `${clock(fastest - before)} off your best of ${clock(before)}.`;
  return html`<div class="note-card racecard">
    <b>${isNew ? 'New best' : list.length > 1 ? 'Fastest today' : 'Your time'} · ${name} · ${clock(fastest)}</b>
    ${body}${list.length > 1 ? ` ${list.length} times up today.` : ''}
  </div>`;
}

// Zone 2 check: how much heart rate drifted against power, and the trend.
function AerobicCard({ r }) {
  const a = r.aerobic;
  if (!a) return null;
  const trend = r.efTrend || [];
  const first = trend.length > 1 ? trend[0] : null;
  const change = first ? Math.round(((a.ef - first.ef) / first.ef) * 100) : null;
  return html`<div class="note-card aerocard">
    <b>Zone 2 check · drift ${a.decoupling.toFixed(1)} % · ${decouplingVerdict(a.decoupling)}</b>
    <div class="aerorow">
      <div>
        ${a.decoupling < 5 ? 'Heart rate held steady against your watts — the aerobic base held up.' : 'Heart rate crept up against your watts in the second half. Easier, longer Zone 2 rides fix this.'}
        ${' '}Efficiency ${a.ef.toFixed(2)} W per beat${first ? (Math.abs(change) < 1 ? `, the same as on ${new Date(first.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : `, ${change > 0 ? 'up' : 'down'} ${Math.abs(change)} % since ${new Date(first.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`) : ''}.
      </div>
      ${trend.length > 1 && html`<span class="aerospark"><${Sparkline} values=${trend.map((t) => t.ef)} w=${80} h=${28} stroke="var(--pz2)" /></span>`}
    </div>
  </div>`;
}

// Best power over the classic durations, this ride and all time.
function PowerBests({ r }) {
  const curve = r.powerCurve || {};
  const wins = POWER_WINDOWS.filter((w) => curve[w] != null);
  if (!wins.length) return null;
  return html`<div class="k zonek">Best power</div>
    <div class="sgrid4 pbests">${wins.map((w) => {
      const best = r.powerBests?.[w]?.watts;
      const isNew = r.powerImproved?.includes(w);
      return html`<div>
        <div class="k">${windowLabel(w)}${isNew ? html` <span class="pb">best</span>` : ''}</div>
        <div class="num">${curve[w]}<span class="u">W</span></div>
        <div class="pball">${best && best !== curve[w] ? `best ${best}` : isNew ? 'all-time' : ''}</div>
      </div>`;
    })}</div>`;
}

function ZoneStrip({ counts, zones }) {
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  return html`<div class="zonestrip">${counts.map((n, i) => (n ? html`<i style=${{ flexGrow: n / total, background: zones[i].color }} title=${`Z${i + 1} ${Math.round((n / total) * 100)} %`}></i>` : null))}</div>`;
}

export function Summary({ c }) {
  const s = useStore(c.store);
  const r = s.result;
  if (!r) return null;
  const { prefs } = s;
  const units = prefs.units;
  const sum = r.summary;
  const climb = U.elevation(r.climbedM, units);
  const dist = U.distance(sum.distanceM, units);
  const speed = U.speed(r.movingTimeS ? sum.distanceM / r.movingTimeS : 0, units);
  const z = zone2(prefs);
  const samples = r.samples;
  const hasHr = samples.some((x) => x.heartRate);
  const date = new Date(samples[0].time);
  const when = `${date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  const pzTotal = r.powerZones.reduce((a, b) => a + b, 0) || 1;
  const topZone = r.powerZones.indexOf(Math.max(...r.powerZones));
  return html`<div class="screen summary">
    <div class="scroll">
      <div class="figure">
        ${r.photo ? html`<img src=${r.photo} alt="" />` : html`<${Scene} region="bayarea" tod=${timeOfDayNow()} seed=${r.id} w=${366} h=${210} profile=${samples.filter((_, i) => i % 20 === 0).map((x) => x.altitude ?? 0)} />`}
        <span class="k lt">${r.routeName ?? r.name}</span>
      </div>
      <div class="body">
        <div class="k">${when}</div>
        <h1>${r.headline[0]} <em>${r.headline[1]}</em></h1>
        <div class="sgrid">
          <div class="lead"><div class="k">Climbed</div><div class="num">${climb.value}<span class="u">${climb.unit}</span></div></div>
          <div><div class="k">Time</div><div class="num">${clock(r.movingTimeS)}</div></div>
          <div><div class="k">Distance</div><div class="num">${dist.value}<span class="u">${dist.unit}</span></div></div>
        </div>
        <div class="sgrid4">
          <div><div class="k">Avg power</div><div class="num">${sum.avgPower}<span class="u">W</span></div></div>
          <div><div class="k">NP</div><div class="num">${sum.normalizedPower}<span class="u">W</span></div></div>
          <div><div class="k">Avg HR</div><div class="num">${sum.avgHeartRate ?? '--'}<span class="u">bpm</span></div></div>
          <div><div class="k">TSS</div><div class="num">${sum.tss}</div></div>
        </div>
        <${Attempts} r=${r} />
        ${r.goal && html`<div class="note-card goalcard"><b>Climb goal · ${U.elevation(r.goal.goalM, units).value} ${U.elevation(r.goal.goalM, units).unit}</b>${r.goal.reached ? 'Done.' : `${U.elevation(r.goal.goalM - r.climbedM, units).value} ${U.elevation(1, units).unit} short this time.`}</div>`}
        <${AerobicCard} r=${r} />
        ${r.rampFtp &&
        html`<div class="note-card ftpcard"><b>New FTP estimate · ${r.rampFtp} W</b>75 % of your best minute on the ramp. ${r.rampFtp !== prefs.ftp ? html`<div class="btnrow"><button class="btn pri small" onClick=${() => c.useRampFtp(r.rampFtp)}>Use ${r.rampFtp} W</button><span></span></div>` : 'It’s already your FTP.'}</div>`}
        <div class="charts">
          ${samples.some((x) => x.altitude != null) && html`<div class="c"><div><div class="k">Elevation</div><b>${climb.value} ${climb.unit}</b></div><${MiniChart} values=${samples.map((x) => x.altitude)} /></div>`}
          <div class="c"><div><div class="k">Power</div><b>${sum.avgPower} W avg</b></div><${MiniChart} values=${samples.map((x) => x.power)} stroke="var(--paper-2)" min=${0} /></div>
          ${hasHr &&
          html`<div class="c"><div><div class="k">Heart</div><b>${sum.avgHeartRate} bpm</b></div><${MiniChart} values=${samples.map((x) => x.heartRate)} stroke="#e8735f" fill="rgba(232,115,95,.10)" band=${{ ...z, color: 'var(--pz2)' }} min=${Math.min(z.min - 25, ...samples.map((x) => x.heartRate || 999))} /></div>`}
        </div>
        <${PowerBests} r=${r} />
        <div class="k zonek">Time in power zones · mostly Z${topZone + 1} ${POWER_ZONES[topZone].name} (${Math.round((r.powerZones[topZone] / pzTotal) * 100)} %)</div>
        <${ZoneStrip} counts=${r.powerZones} zones=${POWER_ZONES} />
        ${hasHr &&
        html`<div class="k zonek">Heart-rate zones${r.plan?.kind === 'autopilot' ? ` · ${Math.round(r.zoneShare * 100)} % in Zone 2` : ''}</div><${ZoneStrip} counts=${r.hrZones} zones=${HR_ZONES} />`}
        <${StravaRow} c=${c} s=${s} up=${r.upload} />
        <div class="endrow">
          <button class="btn pri" onClick=${() => c.closeSummary()}>Done</button>
          <button class="btn sec" onClick=${() => share(r)}>${Icon.share()} FIT</button>
        </div>
        <p class="colophon">${speed.value} ${speed.unit} average · ${sum.kilojoules} kJ · ${sum.avgCadence ?? '--'} rpm</p>
      </div>
    </div>
  </div>`;
}
