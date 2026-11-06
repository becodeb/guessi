// Bridges the hidden <input> and the typing engine while an on-screen keyboard
// (Gboard and friends) is composing a word.
//
// Outside composition the field is a plain mirror: the UI calls
// `game.setBuffer(input.value)` and writes `game.buffer()` back. During a
// composition, writing `input.value` makes the keyboard duplicate or resurrect
// text, so the field is never written. Instead this feed remembers how much of
// the field's value the engine has already taken (`consumed`) and only hands
// over what comes after it. After every engine call `settle` moves the offset
// so the text past it equals the engine's own buffer again.

import { sanitizeTyped } from "./lyrics-typing.js";

/**
 * Smallest offset into `value` whose remainder, once sanitized, is exactly
 * what the engine holds in its buffer.
 */
export function offsetFor(value, buffer) {
  const v = String(value ?? "");
  for (let c = 0; c <= v.length; c++) {
    if (sanitizeTyped(v.slice(c)) === buffer) return c;
  }
  return Math.max(0, v.length - buffer.length);
}

export function createInputFeed() {
  let consumed = 0;
  return {
    offset: () => consumed,
    reset() {
      consumed = 0;
    },
    /**
     * The new text past the offset, and how many already-consumed characters
     * the keyboard erased (the value became shorter than the offset).
     */
    read(value) {
      const v = String(value ?? "");
      let deleted = 0;
      if (v.length < consumed) {
        deleted = consumed - v.length;
        consumed = v.length;
      }
      return { text: v.slice(consumed), deleted };
    },
    /** Call after every engine call made during a composition. */
    settle(value, buffer) {
      consumed = offsetFor(value, buffer);
    },
  };
}

/**
 * Feeds one `input` event to the engine. Returns the engine events, and
 * whether the field still needs `input.value = game.buffer()` (only when no
 * composition is running).
 * @param {{value: string}} field
 * @param {ReturnType<typeof createInputFeed>} feed
 * @param {ReturnType<import("./lyrics-typing.js").createTypingGame>} game
 * @param {boolean} composing
 */
export function feedInput(field, feed, game, composing) {
  if (!composing) {
    feed.reset();
    return { events: game.setBuffer(field.value), write: true };
  }
  const { text, deleted } = feed.read(field.value);
  if (deleted > 0) game.dropTail(deleted);
  const events = game.setBuffer(text);
  feed.settle(field.value, game.buffer());
  return { events, write: false };
}
