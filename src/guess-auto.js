// Shared auto-evaluation binder for guess fields (Games 1–3).
// Replaces the removed "Comprobar" buttons: a field marks itself correct while
// the user types — instantly on an exact (normalized) match, otherwise after a
// short typing pause; Enter and blur evaluate immediately.

export const CHECK_DELAY_MS = 600;

export function createAutoGuess() {
  const timers = new Map(); // HTMLInputElement → timeout id

  function clearTimer(input) {
    const id = timers.get(input);
    if (id !== undefined) {
      clearTimeout(id);
      timers.delete(input);
    }
  }

  return {
    /**
     * Wire an auto-evaluating guess field (no check button):
     *  - input: clears verdict, cancels pending timer; runs instantly when the
     *    typed text is an exact (normalized) match, otherwise debounces
     *    CHECK_DELAY_MS;
     *  - Enter: evaluates immediately (full keyboard play);
     *  - blur with a non-empty value: evaluates immediately.
     * Every scheduled timer is tracked and cleared before firing.
     */
    bind(group, input, shouldInstant, evaluate) {
      input.addEventListener("input", () => {
        group.classList.remove("guess--correct", "guess--incorrect");
        clearTimer(input);
        if (!input.value.trim()) return; // neutral, no timer, no announcement
        if (shouldInstant()) {
          evaluate();
        } else {
          const id = setTimeout(() => {
            timers.delete(input);
            evaluate();
          }, CHECK_DELAY_MS);
          timers.set(input, id);
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          clearTimer(input);
          evaluate();
        }
      });
      input.addEventListener("blur", () => {
        if (!input.value.trim()) return;
        clearTimer(input);
        evaluate();
      });
    },

    clearAll() {
      for (const id of timers.values()) clearTimeout(id);
      timers.clear();
    },
  };
}
