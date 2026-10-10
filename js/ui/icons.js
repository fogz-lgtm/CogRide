// Line icons, drawn for this app (1.6 px strokes on a 24 grid).
import { html } from './h.js';

const S = (d) => html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export const Icon = {
  trainer: () => S(html`<circle cx="7" cy="16" r="4.2" /><path d="M7 16h9l3-8M11.5 16 9 8h7M5 8h5" /><circle cx="19" cy="16" r="1.4" />`),
  click: () => S(html`<rect x="4" y="6" width="7" height="12" rx="3.5" /><rect x="13" y="6" width="7" height="12" rx="3.5" /><path d="M7.5 10.5v3M15 12h3M16.5 10.5v3" />`),
  heart: () => S(html`<path d="M12 19s-7-4.3-7-9.4A3.9 3.9 0 0 1 12 7.4a3.9 3.9 0 0 1 7 2.2C19 14.7 12 19 12 19Z" /><path d="M5.6 12h3l1.4-2.2 2 4 1.4-1.8h4.8" />`),
  tv: () => S(html`<rect x="3" y="5" width="18" height="13" rx="2.5" /><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor" stroke="none" opacity=".9" />`),
  pause: () => S(html`<path d="M9 6v12M15 6v12" stroke-width="2.4" />`),
  play: () => S(html`<path d="M8 5.5v13l10.5-6.5Z" fill="currentColor" stroke="none" />`),
  close: () => S(html`<path d="M6 6l12 12M18 6 6 18" />`),
  back: () => S(html`<path d="M14.5 5.5 8 12l6.5 6.5" />`),
  chevron: () => S(html`<path d="M9.5 6 15.5 12l-6 6" />`),
  check: () => S(html`<path d="m5.5 12.5 4 4 9-9.5" stroke-width="2.2" />`),
  share: () => S(html`<path d="M12 3.5v11M7.5 8 12 3.5 16.5 8M5 12.5v6a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-6" />`),
  fuel: () => S(html`<circle cx="12" cy="12" r="8" /><path d="M12 12V4a8 8 0 0 1 7.5 5.3Z" fill="currentColor" stroke="none" opacity=".85" />`),
  plus: () => S(html`<path d="M12 5v14M5 12h14" />`),
  minus: () => S(html`<path d="M5 12h14" />`),
  pip: () => S(html`<rect x="2.5" y="4.5" width="19" height="15" rx="2.5" /><rect x="11.5" y="11" width="7.5" height="6" rx="1.2" fill="currentColor" stroke="none" />`),
  climb: () => html`<svg viewBox="0 0 14 12" aria-hidden="true"><path d="M7 1 13.5 11.5H.5Z" fill="currentColor" /></svg>`,
  upload: () => S(html`<path d="M12 16V5M7.5 9.5 12 5l4.5 4.5M5 19h14" />`),
};

// Slope wedge whose angle tracks the gradient.
export function Wedge({ grade = 0 }) {
  const g = Math.max(-20, Math.min(20, grade));
  const y = 14 - Math.max(0, g) * 1.1;
  const yd = 14 - Math.max(0, -g) * 1.1;
  const d = g >= 0 ? `M1 15 L23 15 L23 ${y} Z` : `M1 15 L23 15 L1 ${yd} Z`;
  return html`<svg viewBox="0 0 24 16" aria-hidden="true"><path d=${d} fill="currentColor" opacity=".9" /></svg>`;
}
