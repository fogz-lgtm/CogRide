// A tiny observable store. Components subscribe with useStore().

import { useEffect, useReducer } from '../ui/h.js';

export class Store {
  constructor(state) {
    this.state = state;
    this.subs = new Set();
  }

  get() {
    return this.state;
  }

  set(patch) {
    const next = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const fn of this.subs) fn(this.state);
  }

  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

export function useStore(store) {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => store.subscribe(() => force()), [store]);
  return store.state;
}
