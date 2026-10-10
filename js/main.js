// Boot: build the controller, draw the app, check for a Strava sign-in
// coming back, and keep an offline copy fresh (switching only between rides).

import { html, render } from './ui/h.js';
import { Controller } from './app/controller.js';
import { App } from './ui/app.js';

const params = new URLSearchParams(location.search);
const c = new Controller({ params });
globalThis.cogride = c; // handy from the console

render(html`<${App} c=${c} />`, document.getElementById('app'));
c.boot();

if (params.has('demo')) import('./app/demo.js').then((m) => m.runDemo(c, params));

const build = globalThis.COGRIDE_BUILD;
if ('serviceWorker' in navigator && build && !build.startsWith('__')) {
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      const ready = () => c.set({ update: true });
      if (reg.waiting && navigator.serviceWorker.controller) ready();
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => w.state === 'installed' && navigator.serviceWorker.controller && ready());
      });
      let updating = false;
      c.applyUpdate = () => {
        updating = true;
        reg.waiting?.postMessage('skip-waiting');
      };
      // Reload only for an update he asked for (from Home, between rides) —
      // not when the first install takes control.
      navigator.serviceWorker.addEventListener('controllerchange', () => updating && location.reload());
    })
    .catch(() => {});
}
