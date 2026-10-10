// The app's root: one screen at a time, sheets over it, one toast.

import { html, useEffect } from './h.js';
import { useStore } from '../app/store.js';
import { Home } from './home.js';
import { RideScreen, Toast } from './ride.js';
import { Summary } from './summary.js';
import { PlanSheet, PauseSheet, SettingsSheet, DeviceSheet, BluefySheet, EditorSheet, ClickHelpSheet } from './sheets.js';
import { SimulatedTrainer } from '../devices/simulator.js';

const UP = new Set(['ArrowUp', 'ArrowRight', '+', '=']);
const DOWN = new Set(['ArrowDown', 'ArrowLeft', '-', '_']);

function useKeyboard(c) {
  useEffect(() => {
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName);
    const down = (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      const s = c.state;
      if (UP.has(e.key) || DOWN.has(e.key)) {
        if (e.repeat) return e.preventDefault();
        c.press(UP.has(e.key) ? 1 : -1);
        e.preventDefault();
      } else if (e.key === ' ' && s.screen === 'ride') {
        if (s.rideState === 'riding') c.pause();
        else c.resume();
        e.preventDefault();
      } else if (e.key === 't' && s.screen === 'ride') {
        c.setTv(!s.tv);
      } else if (e.key === 'Escape' && s.sheet) {
        c.closeSheet();
      } else if ((e.key === 'w' || e.key === 's') && c.trainer instanceof SimulatedTrainer) {
        c.trainer.setEffort(c.trainer.effortWatts + (e.key === 'w' ? 15 : -15));
        c.toast({ title: 'Simulator', body: `Pretend rider pushing ${c.trainer.effortWatts} W`, ms: 1500 });
      }
    };
    const up = (e) => {
      if (UP.has(e.key)) c.release(1);
      if (DOWN.has(e.key)) c.release(-1);
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    return () => {
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
    };
  }, [c]);
}

function Sheets({ c, s }) {
  const sh = s.sheet;
  if (!sh) return null;
  switch (sh.type) {
    case 'plan':
      return html`<${PlanSheet} c=${c} s=${s} sheet=${sh} key=${sh.plan?.id ?? 'loading'} />`;
    case 'pause':
      return html`<${PauseSheet} c=${c} s=${s} />`;
    case 'settings':
      return html`<${SettingsSheet} c=${c} s=${s} />`;
    case 'device':
      return html`<${DeviceSheet} c=${c} s=${s} which=${sh.which} />`;
    case 'bluefy':
      return html`<${BluefySheet} c=${c} />`;
    case 'clickhelp':
      return html`<${ClickHelpSheet} c=${c} />`;
    case 'editor':
      return html`<${EditorSheet} c=${c} />`;
    default:
      return null;
  }
}

export function App({ c }) {
  const s = useStore(c.store);
  useKeyboard(c);
  useEffect(() => {
    if (s.sheet?.type === 'settings' && s.sheet.focus) setTimeout(() => document.getElementById(s.sheet.focus)?.scrollIntoView({ block: 'start' }), 300);
  }, [s.sheet]);
  return html`
    ${s.screen === 'home' && html`<${Home} c=${c} />`}
    ${s.screen === 'ride' && html`<${RideScreen} c=${c} />`}
    ${s.screen === 'summary' && html`<${Summary} c=${c} />`}
    <${Sheets} c=${c} s=${s} />
    <${Toast} c=${c} toast=${s.toast} />
  `;
}
