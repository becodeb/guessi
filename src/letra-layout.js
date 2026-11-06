// Pure helpers for the phone layout of the lyrics game. No DOM.

/** The on-screen keyboard is up when the visual viewport lost this much height. */
export const KEYBOARD_RATIO = 0.75;

/**
 * @param {number} height  current visual viewport height
 * @param {number} tallest the tallest height seen at the current width
 */
export function isKeyboardOpen(height, tallest) {
  return tallest > 0 && height > 0 && height < tallest * KEYBOARD_RATIO;
}

/**
 * Remembers the tallest viewport seen, per width (a rotation starts over), and
 * says whether the keyboard is open for each new measurement.
 */
export function createViewportTracker() {
  let tallest = 0;
  let width = 0;
  return {
    update(w, h) {
      if (w !== width) {
        width = w;
        tallest = 0;
      }
      if (h > tallest) tallest = h;
      return isKeyboardOpen(h, tallest);
    },
    tallest: () => tallest,
  };
}

/**
 * Where to scroll so the middle of a line sits `anchor` (0..1) of the way down
 * the view; never negative, never past the end.
 */
export function scrollTarget({ lineTop, lineHeight, viewHeight, anchor, scrollHeight = Infinity }) {
  const want = lineTop + lineHeight / 2 - viewHeight * anchor;
  const max = Math.max(0, scrollHeight - viewHeight);
  return Math.min(max, Math.max(0, Math.round(want)));
}

/** Where the cursor line is held: 38 % down on a wide screen, 30 % on a phone. */
export function anchorFor(phone) {
  return phone ? 0.3 : 0.38;
}

/**
 * Padding that lets the first and the last line reach the anchor, in px.
 * @returns {{top: number, bottom: number}}
 */
export function scrollPadding(viewHeight, anchor) {
  return {
    top: Math.round(viewHeight * anchor),
    bottom: Math.round(viewHeight * (1 - anchor)),
  };
}
