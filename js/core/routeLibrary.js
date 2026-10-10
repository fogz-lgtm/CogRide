// The built-in route library: real climbs (with their real road shape) and
// calm fictional loops. Geometry is loaded lazily, one route at a time.

import { buildRoute } from './route.js';

const BASE = new URL('../../data/routes/', import.meta.url);
let catalogPromise = null;
const built = new Map();

export function loadCatalog(fetchImpl = globalThis.fetch) {
  catalogPromise ??= fetchImpl(new URL('catalog.json', BASE)).then((r) => {
    if (!r.ok) throw new Error(`Couldn't load routes (${r.status})`);
    return r.json().then((d) => d.routes);
  });
  return catalogPromise;
}

export async function loadRoute(id, fetchImpl = globalThis.fetch) {
  if (built.has(id)) return built.get(id);
  const catalog = await loadCatalog(fetchImpl);
  const def = catalog.find((r) => r.id === id);
  if (!def) throw new Error(`Unknown route ${id}`);
  let geometry = null;
  if (!def.loop) {
    const res = await fetchImpl(new URL(`geometry/${id}.json`, BASE)).catch(() => null);
    if (res?.ok) geometry = await res.json();
  }
  const route = buildRoute(def, geometry);
  built.set(id, route);
  return route;
}

// Tiny elevation sparkline data straight from the gradient table (no build).
export function sparkline(def, points = 40) {
  const elev = [def.startElevationM];
  for (const g of def.gradientsPct) elev.push(elev.at(-1) + (g / 100) * def.resolutionM);
  if (points >= elev.length) return elev;
  return Array.from({ length: points }, (_, i) => elev[Math.round((i * (elev.length - 1)) / (points - 1))]);
}
