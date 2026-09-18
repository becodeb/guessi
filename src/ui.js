// Small DOM/UI helpers. No business logic (ui.js module contract).

/**
 * Create an element.
 * @param {string} tag
 * @param {object} [attrs]  class, text, html, on:{event:fn}, dataset, aria-*, others → attributes
 * @param {...(Node|string|null|undefined)} children
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key === "on" && typeof value === "object") {
      for (const [event, fn] of Object.entries(value)) node.addEventListener(event, fn);
    } else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = String(dv);
    } else if (key === "aria") {
      for (const [ak, av] of Object.entries(value)) node.setAttribute(`aria-${ak}`, String(av));
    } else if (key === "value") {
      node.value = value;
    } else if (key === "checked") {
      node.checked = true;
    } else if (key.startsWith("data-")) {
      node.setAttribute(key, String(value));
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const TOAST_ICON = { info: "note", success: "check", error: "warn" };

/** Transient toast, auto-dismissed after 3.5s (motion spec). */
export function toast(message, kind = "info") {
  let host = document.querySelector(".toast-host");
  if (!host) {
    host = el("div", { class: "toast-host", "aria-live": "polite" });
    document.body.append(host);
  }
  const t = el("div", { class: `toast toast--${kind}`, role: "status" },
    icon(TOAST_ICON[kind] ?? "note"),
    el("span", { text: message })
  );
  host.append(t);
  setTimeout(() => t.classList.add("toast--out"), 3400);
  setTimeout(() => t.remove(), 3650);
}

/** Skeleton loader rows for loading states. */
export function skeleton(rows = 3) {
  const wrap = el("div", { class: "skeleton", "aria-hidden": "true" });
  for (let i = 0; i < rows; i++) {
    wrap.append(el("div", { class: "skeleton__row" }));
  }
  return wrap;
}

/** Milliseconds → "0,1 s" / "1,5 s" (Spanish decimal comma, copy deck style). */
export function formatMs(ms) {
  const secs = ms / 1000;
  const fixed = secs.toFixed(1).replace(".", ",");
  return `${fixed} s`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Inline SVG icon from the sprite (index.html). 24px, stroke 1.75.
 * Built with createElementNS: `document.createElement("svg")` inside an HTML
 * document produces an inert HTMLUnknownElement that never paints.
 */
export function icon(name, extraClass = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `icon${extraClass ? ` ${extraClass}` : ""}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

/**
 * Open a modal <dialog>: native focus trap, Escape and backdrop dismissal.
 * Resolves the returned `closed` promise once the dialog leaves the DOM, so
 * callers can await the outcome they stored on `dialog.returnValue`.
 * @param {{label: string, class?: string}} opts
 * @param {...Node} children
 * @returns {{dialog: HTMLDialogElement, close: (value?: string) => void, closed: Promise<string>}}
 */
export function openDialog({ label, class: extraClass = "" }, ...children) {
  const dialog = el("dialog", {
    class: `dialog${extraClass ? ` ${extraClass}` : ""}`,
    "aria-label": label,
  }, ...children);

  // Clicking the backdrop lands on the dialog element itself, never a child.
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close("dismiss");
  });

  const closed = new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue || "dismiss";
      dialog.remove();
      resolve(value);
    }, { once: true });
  });

  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close: (value = "dismiss") => dialog.close(value), closed };
}

/** Live region for guess feedback (aria-live). */
export function liveRegion() {
  return el("p", { class: "live-region", "aria-live": "polite" });
}

/** Empty-library import guide (games spec: empty state with guidance). */
export function emptyGuide({ body, actionLabel, onAction }) {
  return el("div", { class: "import-guide", role: "note" },
    el("h2", { class: "import-guide__title", text: "Tu biblioteca está vacía" }),
    el("p", { class: "muted-note", text: body ?? "Importa canciones para empezar a jugar." }),
    actionLabel
      ? el("button", { class: "btn btn--primary", on: { click: onAction }, text: actionLabel })
      : null
  );
}

/** Premium gate for audio games (playback spec: premium degradation). */
export function premiumGate({ onBack }) {
  return el("div", { class: "premium-gate", role: "note" },
    el("div", { class: "banner banner--premium" },
      icon("warn"),
      el("span", {
        text: "Necesitas Spotify Premium para los juegos de audio. Tu biblioteca y el juego de portadas siguen disponibles.",
      })
    ),
    onBack
      ? el("button", { class: "btn", on: { click: onBack }, text: "Volver a Juegos" })
      : null
  );
}
/**
 * Spotify volume slider, shared by the hub and the round.
 *
 * Both call sites read and write the SAME `ctx.state.player.volume` (0-100), so
 * the value follows the player across views with no syncing of its own: the
 * next view to render simply reads the number that is already there.
 *
 * `ctx.player.setVolume` takes 0-1 and clamps; `isReady()` is false until the
 * Web Playback SDK has a device, which is what disables the control.
 */
export function volumeControl(ctx) {
  const playerState = ctx.state.player;
  const readout = el("span", { class: "small dim", text: `${playerState.volume}%` });
  const input = el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: String(playerState.volume),
    "aria-label": "Volumen",
    disabled: !ctx.player.isReady(),
    on: {
      input: (e) => {
        const v = Number(e.target.value);
        playerState.volume = v;
        ctx.player.setVolume(v / 100);
        // The hub's original copy never did this, so the readout sat at its
        // initial value while the slider moved.
        readout.textContent = `${v}%`;
      },
    },
  });

  // The SDK connects asynchronously, so a view rendered before the device
  // exists was born disabled and stayed that way for good. Re-enable on the
  // ready signal instead. The control has no unmount hook, so the listener
  // retires itself once its input leaves the document (every redraw, and
  // every "Otra canción", builds a fresh one).
  if (input.disabled) {
    const off = ctx.player.onReady(() => {
      if (!input.isConnected) {
        off();
        return;
      }
      input.disabled = !ctx.player.isReady();
    });
  }

  return el("div", { class: "volume" }, icon("volume"), input, readout);
}
