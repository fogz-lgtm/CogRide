// Chunk worker: builds quadtree leaves off the main thread (spec §6.9).
// Messages in:  { type: 'init', gen, route, theme }  { type: 'build', gen, key, level, ix, iz }
// Messages out: { type: 'ready', gen }  { type: 'leaf', gen, key, position, paint, … }  { type: 'error', … }

import { createContext, buildLeaf } from './chunks.js';

let ctx = null;
let gen = -1;

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      gen = m.gen;
      ctx = createContext(m.route, m.theme, ctx); // reuses terrain when only colours change
      self.postMessage({ type: 'ready', gen });
    } else if (m.type === 'build') {
      if (!ctx || m.gen !== gen) return;
      const out = buildLeaf(ctx, m.level, m.ix, m.iz);
      const transfer = [];
      for (const p of out.parts) transfer.push(p.position.buffer, p.paint.buffer);
      self.postMessage({ type: 'leaf', gen, key: m.key, ...out }, transfer);
    }
  } catch (err) {
    self.postMessage({ type: 'error', gen, key: m.key, message: String(err?.stack ?? err) });
  }
};
