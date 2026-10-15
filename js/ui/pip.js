// Where iOS will put the show in TV mode. Its largest Picture in Picture
// window on an iPhone is the screen's short side less ~13 pt a side, at
// 16:9, in either orientation — iOS sets that size, not the page. Parked in
// portrait it spans the top; in landscape it sits in the top-right corner,
// measured from the edge of the screen (Bluefy's page stops short of the
// notch, so the window can overhang the page).
//
// All in CSS px (= points), in page coordinates. On a computer (where the
// page and the screen don't line up like this) it just keeps the numbers a
// fair share of the width.
export function pipBox({ screenW, screenH, innerW, innerH }) {
  const short = Math.min(screenW, screenH);
  const long = Math.max(screenW, screenH);
  const portrait = innerW <= innerH;
  const w = Math.round(Math.max(240, Math.min(short - 26, portrait ? innerW - 26 : innerW * 0.6)));
  const h = Math.round((w * 9) / 16);
  if (portrait) return { landscape: false, w, h, x: Math.round(Math.max(0, (innerW - w) / 2)) };
  const side = Math.max(0, (long - innerW) / 2); // page inset from each side of the screen
  const right = innerW + side - 24; // the window's right edge
  const x = Math.min(innerW - Math.min(w, innerW * 0.45), Math.max(innerW * 0.42, right - w));
  return { landscape: true, w, h, x: Math.round(x) };
}

export function pipBoxNow() {
  return pipBox({ screenW: screen.width, screenH: screen.height, innerW: innerWidth, innerH: innerHeight });
}
