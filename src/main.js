// App shell: hash router, app state, nav, banners/toasts, and the
// login / library / hub views. Game views live in src/games/*.

import { CLIENT_ID } from "./config.js";
import * as auth from "./auth.js";
import * as api from "./spotify-api.js";
import * as player from "./player.js";
import * as library from "./library.js";
import * as ui from "./ui.js";
import * as match from "./match.js";
import { parseSpotifyRef, looksLikeSpotifyLink } from "./spotify-link.js";
import * as clipGame from "./games/clip-game.js";
import * as albumGame from "./games/album-game.js";
import * as yearGame from "./games/year-game.js";
import * as roundGame from "./games/round-game.js";

// --- app state (single source of truth) -------------------------------------

const appState = {
  view: "login",
  auth: { status: "anon", scopes: [] },
  library: { poolCount: 0, loading: false, slowDown: false, saveError: false },
  player: {
    status: "off",
    volume: 80,
    initializing: false,
  },
};

// --- router -------------------------------------------------------------------

const ROUTES = {
  "/login": { view: "login", render: renderLogin },
  "/library": { view: "library", render: renderLibrary },
  "/juegos": { view: "hub", render: renderHub },
  "/juegos/clip": { view: "clip", render: renderClip, game: clipGame },
  "/juegos/album": { view: "album", render: renderAlbum, game: albumGame },
  "/juegos/año": { view: "year", render: renderYear, game: yearGame },
  "/juegos/ronda": { view: "ronda", render: renderRonda, game: roundGame },
};

const app = document.getElementById("app");
let navHost = null;
let bannerHost = null;
let viewHost = null;
let current = null;

function route() {
  // The browser percent-encodes non-ASCII hash fragments ("#/juegos/año").
  const raw = location.hash.replace(/^#/, "") || "/";
  let hash = raw;
  try {
    hash = decodeURIComponent(raw);
  } catch {
    // Keep the raw fragment if decoding fails.
  }
  const def = ROUTES[hash] ?? ROUTES["/juegos"];
  const authed = auth.isAuthenticated();
  appState.auth.status = authed ? "ok" : "anon";

  if (!authed && def.view !== "login") {
    location.hash = "#/login";
    return;
  }
  if (authed && def.view === "login") {
    location.hash = "#/juegos";
    return;
  }

  if (current?.unmount) {
    try {
      current.unmount();
    } catch {
      // Ignore unmount errors.
    }
  }
  current = null;
  appState.view = def.view;

  // The round and the library both lay out in columns: give them the full
  // wide container instead of the 980px reading cap.
  const wide = def.view === "ronda" || def.view === "library";

  navHost = renderNav();
  if (wide) navHost.classList.add("container--wide");
  bannerHost = ui.el("div", { class: wide ? "container container--wide" : "container" });
  viewHost = ui.el("main", { class: wide ? "container container--wide" : "container" });
  app.replaceChildren(navHost, bannerHost, viewHost);
  updateBanners();
  def.render(viewHost);
  // Wire the view lifecycle so mounted views clean up (audio/poll) on route change.
  current = def.game ?? null;
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// --- nav -----------------------------------------------------------------------

function renderNav() {
  const authed = auth.isAuthenticated();
  const active = appState.view;
  const nav = ui.el("header", { class: "container" },
    ui.el("nav", { class: "nav", "aria-label": "Principal" },
      ui.el("a", {
        class: "nav__logo",
        href: "#/juegos",
      },
        ui.el("span", { class: "dot", "aria-hidden": "true" }),
        "de oído",
      ),
      authed
        ? ui.el("div", { class: "nav__links" },
            navLink("#/library", "Biblioteca", active === "library"),
            navLink("#/juegos", "Juegos", active === "hub" || active === "clip" || active === "album" || active === "year" || active === "ronda"),
          )
        : null,
      ui.el("span", { class: "nav__spacer" }),
      authed
        ? ui.el("button", {
            class: "nav__logout",
            text: "Cerrar sesión",
            on: {
              click: () => {
                player.stop();
                auth.logout();
                navigate("#/login");
              },
            },
          }, ui.icon("logout"))
        : null,
    ),
  );
  return nav;
}

function navLink(hash, label, isActive) {
  return ui.el("a", {
    class: `nav__link${isActive ? " nav__link--active" : ""}`,
    href: hash,
    text: label,
    "aria-current": isActive ? "page" : undefined,
  });
}

// --- banners ---------------------------------------------------------------------

function updateBanners() {
  if (!bannerHost) return;
  bannerHost.innerHTML = "";
  const banners = [];

  if (appState.auth.status === "expired") {
    banners.push(ui.el("div", { class: "banner banner--session" },
      ui.icon("warn"),
      ui.el("div", { class: "banner__body" },
        ui.el("span", { text: "Vuelve a iniciar sesión: tu sesión de Spotify expiró." }),
        ui.el("button", {
          class: "btn btn--sm",
          text: "Iniciar sesión",
          on: { click: () => auth.authorize() },
        }),
      ),
    ));
  }

  if (appState.player.status === "premium-denied") {
    banners.push(ui.el("div", { class: "banner banner--premium" },
      ui.icon("warn"),
      ui.el("span", {
        text: "Necesitas Spotify Premium para los juegos de audio. Tu biblioteca y el juego de portadas siguen disponibles.",
      }),
    ));
  }

  if (appState.player.status === "error") {
    banners.push(ui.el("div", { class: "banner banner--error" },
      ui.icon("warn"),
      ui.el("span", { text: "No se pudo conectar el reproductor de Spotify." }),
    ));
  }

  if (appState.library.slowDown) {
    banners.push(ui.el("div", { class: "banner banner--rate" },
      ui.icon("warn"),
      ui.el("span", { text: "Spotify va lento ahora mismo. Esperando…" }),
    ));
  }

  if (appState.library.saveError) {
    banners.push(ui.el("div", { class: "banner banner--error" },
      ui.icon("warn"),
      ui.el("div", { class: "banner__body" },
        ui.el("span", { text: "No se pudo guardar tu biblioteca: el almacenamiento del navegador está lleno. Vacía «Lo que sé» y vuelve a importar." }),
        ui.el("button", {
          class: "btn btn--sm",
          text: "Ir a la biblioteca",
          on: { click: () => navigate("#/library") },
        }),
      ),
    ));
  }

  for (const b of banners) bannerHost.append(b);
}

// --- boot -------------------------------------------------------------------------

async function boot() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("code")) {
    const ok = await auth.handleCallback();
    if (ok) {
      ui.toast("Sesión iniciada", "success");
      location.hash = "#/library";
    } else {
      appState.auth.status = "expired";
      ui.toast("Vuelve a iniciar sesión", "error");
      location.hash = "#/login";
    }
  }

  window.addEventListener("hashchange", route);

  // Global signals.
  auth.onSessionExpired(() => {
    appState.auth.status = "expired";
    updateBanners();
    ui.toast("Vuelve a iniciar sesión", "error");
    navigate("#/login");
  });

  api.onRateLimited((waitMs) => {
    appState.library.slowDown = true;
    updateBanners();
    setTimeout(() => {
      appState.library.slowDown = false;
      updateBanners();
    }, Math.max(waitMs, 5000));
  });

  library.onSaveResult(({ ok }) => {
    if (appState.library.saveError === !ok) return;
    appState.library.saveError = !ok;
    updateBanners();
  });

  player.onPremiumError(() => {
    appState.player.status = "premium-denied";
    updateBanners();
  });

  player.onPlayerError((detail) => {
    if (detail === "prime-failed") {
      // Transient: the next draw/prime may recover — never a persistent banner.
      ui.toast("No se pudo preparar la canción. Probá de nuevo.", "error");
      return;
    }
    if (appState.player.status !== "premium-denied") {
      appState.player.status = "error";
      updateBanners();
    }
  });

  player.onReady(() => {
    // Device (re)connected: self-heal the banner unless Premium is denied.
    if (appState.player.status !== "premium-denied") {
      appState.player.status = "ready";
      updateBanners();
    }
  });

  route();
}

// --- player helper ----------------------------------------------------------------

async function ensurePlayer() {
  if (appState.player.initializing || appState.player.status === "ready") return;
  appState.player.initializing = true;
  try {
    await player.initPlayer(() => auth.getAccessToken());
    if (player.isReady()) appState.player.status = "ready";
  } catch {
    appState.player.status = "error";
  }
  appState.player.initializing = false;
  updateBanners();
}

const ctx = {
  library,
  player,
  api,
  auth,
  navigate,
  state: appState,
};

// --- login view ---------------------------------------------------------------------

function renderLogin(view) {
  view.innerHTML = "";
  const inner = ui.el("div", { class: "login" },
    ui.el("div", { class: "login__inner stack--lg" },
      ui.el("h1", { class: "display login__hero", text: "Juega de oído" }),
      ui.el("p", {
        class: "login__sub",
        text: "Reconoce canciones de tu biblioteca por un instante de sonido.",
      }),
      ui.el("div", { class: "login__actions" },
        CLIENT_ID === "REPLACE_ME"
          ? ui.el("div", { class: "banner banner--error" },
              ui.icon("warn"),
              ui.el("span", { text: "Falta configurar: copia tu Client ID en src/config.js (ver README)." }),
            )
          : null,
        ui.el("button", {
          class: "btn btn--primary btn--lg",
          text: "Iniciar sesión con Spotify",
          on: {
            click: () => {
              if (CLIENT_ID === "REPLACE_ME") {
                ui.toast("Configura tu Client ID en src/config.js", "error");
                return;
              }
              auth.authorize();
            },
          },
        }, ui.icon("play")),
        ui.el("p", {
          class: "muted-note",
          text: "Necesitas Spotify Premium para los juegos de audio.",
        }),
      ),
    ),
  );
  view.append(inner);
}

// --- hub view ---------------------------------------------------------------------------

function renderHub(view) {
  view.innerHTML = "";
  ensurePlayer();
  view.append(ui.el("h1", { class: "display display--md", text: "Juegos" }));

  // Volume control (design component inventory; disabled when player off).
  const volumeInput = ui.el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: String(appState.player.volume),
    "aria-label": "Volumen",
    disabled: !player.isReady(),
    on: {
      input: (e) => {
        const v = Number(e.target.value) / 100;
        player.setVolume(v);
        appState.player.volume = Number(e.target.value);
      },
    },
  });
  const volumeRow = ui.el("div", { class: "volume" },
    ui.icon("volume"),
    volumeInput,
    ui.el("span", { class: "small dim", text: `${appState.player.volume}%` }),
  );

  const grid = ui.el("div", { class: "hub-grid" },
    hubCard({
      href: "#/juegos/ronda",
      feature: true,
      title: "Ronda completa",
      num: "00",
      desc: "Una canción al azar y todos los desafíos: portada, instante, año y letra.",
      cta: "Jugar",
      visual: roundVisual(),
    }),
  );

  const practiceGrid = ui.el("div", { class: "hub-grid" },
    hubCard({
      href: "#/juegos/clip",
      title: "La primera décima",
      num: "01",
      desc: "Reconoce la canción por un instante de sonido. Cada +0,1 s te acerca a la respuesta.",
      cta: "Jugar",
      visual: barsVisual(),
    }),
    hubCard({
      href: "#/juegos/album",
      title: "Portada borrosa",
      num: "02",
      desc: "Identifica el álbum detrás del desenfoque y descubre su lista de temas.",
      cta: "Jugar",
      visual: ui.el("div", { class: "hub-blur-tile", "aria-hidden": "true" }),
    }),
    hubCard({
      href: "#/juegos/año",
      title: "¿De qué año?",
      num: "03",
      desc: "Adivina el año de lanzamiento con pistas de más nuevo o más viejo.",
      cta: "Jugar",
      visual: ui.el("span", { class: "hub-year", "aria-hidden": "true", text: "'19" }),
    }),
  );

  view.append(
    volumeRow,
    ui.el("div", { class: "section" }, grid),
    ui.el("p", { class: "hub-section-label", text: "Práctica suelta" }),
    ui.el("div", { class: "section" }, practiceGrid),
  );
}

function hubCard({ href, feature = false, title, num, desc, cta, visual }) {
  return ui.el("a", {
    class: `hub-card${feature ? " hub-card--feature" : " hub-card--stack"}`,
    href,
  },
    ui.el("div", { class: "stack" },
      ui.el("div", { class: "hub-card__title" },
        ui.el("span", { class: "hub-card__num", text: num }),
        ui.el("span", { text: title }),
      ),
      ui.el("p", { class: "hub-card__desc", text: desc }),
    ),
    visual,
    ui.el("span", { class: "btn btn--primary btn--sm", text: cta }),
  );
}

function barsVisual() {
  const bars = ui.el("div", { class: "hub-visual", "aria-hidden": "true" });
  for (let i = 0; i < 6; i++) bars.append(ui.el("span", { class: "hub-visual__bar" }));
  return bars;
}

function roundVisual() {
  const wrap = ui.el("div", { class: "hub-round", "aria-hidden": "true" });
  wrap.append(ui.el("span", { class: "hub-round__dot" }));
  wrap.append(ui.el("span", { class: "hub-round__dot" }));
  wrap.append(ui.el("span", { class: "hub-round__dot" }));
  wrap.append(ui.el("span", { class: "hub-round__dot" }));
  return wrap;
}

// --- library view ------------------------------------------------------------------------

let lastQuery = "";

// Own playlists are fetched once per session and reused by the browse grid,
// the live search filter and the import cards.
let ownPlaylists = null;
let ownPlaylistsPromise = null;

// The signed-in user, fetched once. The only way to answer "is this list
// mine?" — Spotify's personalised lists (Top canciones, Descubrimiento
// semanal) feel like yours but are owned by `spotify`.
let me = null;

function loadMe() {
  if (me) return Promise.resolve(me);
  return api.getMe().then((user) => {
    me = user;
    return user;
  }).catch(() => null);
}

function loadOwnPlaylists() {
  if (ownPlaylists) return Promise.resolve(ownPlaylists);
  if (!ownPlaylistsPromise) {
    ownPlaylistsPromise = api
      .getPlaylists()
      .then((list) => {
        ownPlaylists = list;
        return list;
      })
      .finally(() => {
        ownPlaylistsPromise = null;
      });
  }
  return ownPlaylistsPromise;
}

/** Trailing-edge debounce with a cancel hook. */
function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

const KIND_LABEL = { track: "canción", album: "álbum", playlist: "playlist", artist: "artista" };
const COVER_FALLBACK = { track: "note", album: "album", artist: "note", playlist: "list" };

function artistsText(item) {
  return (item?.artists ?? []).map((a) => a?.name).filter(Boolean).join(", ");
}

function yearOf(item) {
  return String(item?.release_date ?? "").slice(0, 4);
}

/** Cover <img> with an icon fallback for missing or broken URLs. */
function coverEl(url, className, iconName = "note", alt = "") {
  if (!url) {
    return ui.el("div", { class: `${className} ${className}--fallback`, "aria-hidden": "true" }, ui.icon(iconName));
  }
  const img = ui.el("img", { class: className, alt, loading: "lazy", src: url });
  img.addEventListener("error", () =>
    img.replaceWith(
      ui.el("div", { class: `${className} ${className}--fallback`, "aria-hidden": "true" }, ui.icon(iconName))
    )
  );
  return img;
}

function coverUrl(item, kind) {
  if (kind === "track") return item?.album?.images?.[0]?.url;
  return item?.images?.[0]?.url;
}

function songWord(n) {
  return n === 1 ? "canción" : "canciones";
}

/** "71 canciones" for a playlist whose count Spotify may not expose at all. */
function playlistCountText(item) {
  const total = api.playlistTrackTotal(item);
  return total == null ? "" : `${total} ${songWord(total)}`;
}

// --- import dialog -----------------------------------------------------------------------
// Importing IS adding: the dialog is where the user says what enters «Lo que
// sé», and closing it without confirming leaves the library untouched.

/**
 * Show every track a source holds and let the user confirm the ones to keep.
 * @param {{title: string, subtitle: string, coverUrl?: string, kind: string,
 *          tracks: object[], total: number, skipped: number}} source
 * @returns {Promise<{added: number, already: number} | null>} null when dismissed
 */
function openImportDialog(source) {
  const { title, subtitle, kind, tracks, total, skipped } = source;
  const known = new Set(tracks.filter((t) => library.isInPool(t.id)).map((t) => t.id));
  const fresh = tracks.filter((t) => !known.has(t.id));
  const selected = new Set(fresh.map((t) => t.id));
  const nothingToDo = fresh.length === 0;

  const summary = [`${total} ${songWord(total)}`];
  if (known.size > 0) summary.push(`${known.size} ya ${known.size === 1 ? "la sabes" : "las sabes"}`);
  if (skipped > 0) summary.push(`${skipped} sin sonido en Spotify`);

  const countLabel = ui.el("p", { class: "sheet__selection", "aria-live": "polite" });
  const confirmBtn = ui.el("button", { class: "btn btn--primary", type: "button" });

  const syncFooter = () => {
    const n = selected.size;
    countLabel.textContent = n === 0 ? "Ninguna elegida" : `${n} ${n === 1 ? "elegida" : "elegidas"}`;
    confirmBtn.textContent = n === 0 ? "Elige al menos una" : `Añadir ${n} ${songWord(n)}`;
    confirmBtn.disabled = n === 0;
  };

  const rows = [];
  const list = ui.el("ul", { class: "pick-list" });
  for (const track of tracks) {
    const isKnown = known.has(track.id);
    const sub = `${artistsText(track)}${track.album?.name ? ` · ${track.album.name}` : ""}`;
    let control;
    if (isKnown) {
      control = ui.el("span", { class: "pick-row__mark" }, ui.icon("check"));
    } else {
      control = ui.el("input", { class: "pick-row__check", type: "checkbox", checked: true });
      control.addEventListener("change", () => {
        if (control.checked) selected.add(track.id);
        else selected.delete(track.id);
        syncFooter();
      });
    }
    const row = ui.el("li", { class: `pick-row${isKnown ? " pick-row--known" : ""}` },
      ui.el("label", { class: "pick-row__label" },
        control,
        coverEl(track.album?.images?.[0]?.url, "pick-row__thumb", "note"),
        ui.el("span", { class: "pick-row__body" },
          ui.el("span", { class: "pick-row__title", text: track.name ?? "" }),
          ui.el("span", { class: "pick-row__sub", text: sub }),
        ),
        isKnown ? ui.el("span", { class: "pick-row__tag", text: "Ya la sabes" }) : null,
      ),
    );
    rows.push({ row, control, isKnown, haystack: match.normalize(`${track.name ?? ""} ${sub}`) });
    list.append(row);
  }

  const setAll = (on) => {
    for (const entry of rows) {
      if (entry.isKnown || entry.row.hidden) continue;
      entry.control.checked = on;
      entry.control.dispatchEvent(new Event("change"));
    }
  };

  const filterInput = ui.el("input", {
    class: "sheet__filter",
    type: "search",
    placeholder: "Filtra esta lista…",
    "aria-label": "Filtrar las canciones de esta lista",
    autocomplete: "off",
  });
  filterInput.addEventListener("input", () => {
    const needle = match.normalize(filterInput.value);
    for (const entry of rows) entry.row.hidden = needle.length > 0 && !entry.haystack.includes(needle);
  });

  const body = nothingToDo
    ? ui.el("div", { class: "sheet__done" },
        ui.el("p", { class: "sheet__done-title", text: `Ya sabes ${known.size === 1 ? "la única canción" : `las ${known.size} canciones`} de aquí.` }),
        ui.el("p", { class: "muted-note", text: "Busca otra playlist o pega un enlace de Spotify para sumar canciones nuevas." }),
      )
    : list;

  const head = ui.el("header", { class: "sheet__head" },
    coverEl(source.coverUrl, "sheet__cover", kind === "playlist" ? "list" : "album"),
    ui.el("div", { class: "sheet__heading" },
      ui.el("p", { class: "sheet__source", text: subtitle }),
      ui.el("h2", { class: "sheet__title", text: title }),
      ui.el("p", { class: "sheet__stat", text: summary.join(" · ") }),
    ),
  );
  if (source.coverUrl) head.style.setProperty("--sheet-art", `url("${source.coverUrl}")`);

  const handle = ui.openDialog({ label: `Importar ${title}`, class: "sheet" },
    head,
    nothingToDo
      ? null
      : ui.el("div", { class: "sheet__tools" },
          filterInput,
          ui.el("div", { class: "sheet__toggles" },
            ui.el("button", { class: "btn btn--sm btn--ghost", type: "button", text: "Todas", on: { click: () => setAll(true) } }),
            ui.el("button", { class: "btn btn--sm btn--ghost", type: "button", text: "Ninguna", on: { click: () => setAll(false) } }),
          ),
        ),
    body,
    ui.el("footer", { class: "sheet__foot" },
      nothingToDo ? ui.el("span") : countLabel,
      ui.el("div", { class: "sheet__actions" },
        ui.el("button", {
          class: "btn btn--ghost",
          type: "button",
          text: nothingToDo ? "Cerrar" : "Cancelar",
          on: { click: () => handle.close("dismiss") },
        }),
        nothingToDo ? null : confirmBtn,
      ),
    ),
  );

  confirmBtn.addEventListener("click", () => handle.close("confirm"));
  syncFooter();
  if (!nothingToDo) filterInput.focus();

  return handle.closed.then((outcome) =>
    outcome === "confirm" ? library.commitTracks(tracks, selected) : null
  );
}

function renderLibrary(view) {
  view.innerHTML = "";

  const counts = ui.el("p", { class: "lib-counts" });
  const poolHost = ui.el("div", { class: "pool-panel__list" });
  const errorHost = ui.el("div");

  // --- local search state ----------------------------------------------------
  let query = lastQuery;
  let filter = "all";
  let results = null; // {kind:"catalog",…} | {kind:"link",…} | {kind:"badlink"} | null
  let loading = false;
  let browseFailed = false;
  let seq = 0;
  let searchAbort = null;
  let poolFilter = "";
  let importing = false;

  const refresh = () => {
    const n = library.getPoolCount();
    counts.textContent = n === 0 ? "Todavía ninguna" : `${n} ${songWord(n)}`;
  };

  const renderPool = () => {
    poolHost.innerHTML = "";
    const all = library.getPoolTracks();
    if (all.length === 0) {
      poolHost.append(ui.el("p", { class: "muted-note", text: "Importa un artista, una playlist o un álbum y sus canciones aparecerán aquí." }));
      return;
    }
    const needle = match.normalize(poolFilter);
    const tracks = needle.length === 0
      ? all
      : all.filter((t) => match.normalize(`${t.name} ${t.artists.map((a) => a.name).join(" ")} ${t.album?.name ?? ""}`).includes(needle));
    if (tracks.length === 0) {
      poolHost.append(ui.el("p", { class: "muted-note", text: `Ninguna coincide con «${poolFilter.trim()}».` }));
      return;
    }
    const list = ui.el("ul", { class: "pool-list" });
    for (const t of tracks) {
      list.append(ui.el("li", { class: "pool-row" },
        thumb(t),
        ui.el("div", { class: "stack", style: "gap:2px" },
          ui.el("span", { class: "pending-row__title", text: t.name }),
          ui.el("span", { class: "pending-row__artists", text: `${t.artists.map((a) => a.name).join(", ")} · ${t.album.name}` }),
        ),
        ui.el("button", {
          class: "btn btn--sm btn--ghost",
          "aria-label": `Quitar ${t.name}`,
          on: {
            click: () => {
              library.removeFromPool(t.id);
              afterChange();
            },
          },
        }, ui.icon("trash")),
      ));
    }
    poolHost.append(list);
  };

  const afterChange = () => {
    refresh();
    renderPool();
    renderResults();
  };

  // --- search panel ----------------------------------------------------------
  const searchInput = ui.el("input", {
    class: "search-field__input",
    type: "search",
    placeholder: "Busca canciones, artistas, álbumes o playlists…",
    "aria-label": "Buscar canciones, artistas, álbumes o playlists",
    autocomplete: "off",
    value: query,
  });
  const clearBtn = ui.el("button", {
    class: "search-field__clear",
    type: "button",
    "aria-label": "Limpiar búsqueda",
    hidden: !query,
  }, ui.icon("x"));
  const searchField = ui.el("div", { class: "search-field" },
    ui.icon("search"),
    searchInput,
    clearBtn,
  );
  const chipsHost = ui.el("div", { class: "search-chips", hidden: true });
  const resultsHost = ui.el("div", { class: "search-results" });

  /**
   * @param {string} msg
   * @param {Error} [err]
   * @param {{retry?: boolean}} [opts] retry is off when trying again cannot
   *   possibly help — a missing scope needs a new session, not another go.
   */
  function showError(msg, err, { retry = true } = {}) {
    errorHost.innerHTML = "";
    errorHost.append(ui.el("div", { class: "banner banner--error" },
      ui.icon("warn"),
      ui.el("div", { class: "banner__body" },
        ui.el("span", { text: err?.message === "Sesión expirada" ? "Vuelve a iniciar sesión." : msg }),
        retry
          ? ui.el("button", { class: "btn btn--sm", text: "Reintentar", on: { click: () => route() } })
          : null,
      ),
    ));
  }

  /**
   * Fetch a source, hand it to the dialog, and report what the library gained.
   * The button stays in its loading state until the dialog closes.
   */
  async function stageImport({ kind, id, title, subtitle, coverUrl, load }, btn) {
    // One sheet at a time: a second source would stack a second modal over
    // the choice the user has not made yet.
    if (importing) return;
    importing = true;
    const original = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Abriendo…";
    }
    // A discography is one request per release, so it needs to count out loud.
    const progress = ({ done, total }) => {
      if (btn && total > 1) btn.textContent = `Disco ${Math.min(done + 1, total)} de ${total}…`;
    };
    errorHost.innerHTML = "";
    try {
      const preview = await load(progress);
      if (preview.tracks.length === 0) {
        ui.toast(`«${title}» no tiene canciones que se puedan importar.`, "info");
        return;
      }
      const result = await openImportDialog({
        title,
        subtitle: preview.albumCount
          ? `${subtitle} · ${preview.albumCount} ${preview.albumCount === 1 ? "disco" : "discos"}`
          : subtitle,
        coverUrl,
        kind,
        tracks: preview.tracks,
        total: preview.total || preview.tracks.length,
        skipped: preview.skipped ?? 0,
      });
      if (!result) return;
      if (kind === "album" && preview.rawTracks) library.cacheAlbumTracklist(id, preview.rawTracks);
      afterChange();
      if (result.added > 0) {
        ui.toast(`${result.added} ${songWord(result.added)} en «Lo que sé».`, "success");
      }
    } catch (err) {
      if (err?.name === "UnreadablePlaylistError") showBlockedPlaylist(err.playlist ?? { name: title }, { id });
      else showError("No se pudo abrir esa lista. ", err);
    } finally {
      importing = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = original;
      }
    }
  }

  function sourceSubtitle(kind, item) {
    if (kind === "album") return [artistsText(item), yearOf(item)].filter(Boolean).join(" · ");
    if (kind === "artist") return "Toda su discografía";
    return `Playlist de ${item.owner?.display_name ?? "Spotify"}`;
  }

  function importSource(kind, item, btn) {
    return stageImport({
      kind,
      id: item.id,
      title: item.name ?? "",
      subtitle: sourceSubtitle(kind, item),
      coverUrl: coverUrl(item, kind),
      load: (onProgress) => library.previewRef({ type: kind, id: item.id }, onProgress),
    }, btn);
  }

  /**
   * What to show when Spotify hands over a playlist's name but not its songs.
   * Naming the cause matters here: the app looks broken otherwise, and the
   * way out is a thing the user does in Spotify, not in this app.
   */
  /**
   * Whether a playlist belongs to someone other than the signed-in user —
   * which, since February 2026, is the same as "its songs are off limits".
   * With no identity to compare against, fall back to the prefix Spotify
   * uses for its own algorithmic lists.
   */
  function isForeignPlaylist(playlist, ref) {
    const owner = playlist?.owner?.id;
    if (owner && me?.id) return owner !== me.id;
    if (owner) return owner === "spotify";
    return String(ref?.id ?? "").startsWith("37i9dQZ");
  }

  /**
   * What to show when Spotify hands over a playlist's name but not its songs.
   * It states who actually owns the list, because the personalised ones
   * («Top canciones 20XX», Descubrimiento semanal) feel like the user's and
   * are not — that mismatch is the whole confusion.
   */
  function blockedPlaylistCard(playlist, ref) {
    const ownerName = playlist?.owner?.display_name;
    const spotifyMade = (playlist?.owner?.id ?? "") === "spotify"
      || String(ref?.id ?? playlist?.id ?? "").startsWith("37i9dQZ");

    const ownerLine = playlist?.owner?.id
      ? `La creó ${ownerName || playlist.owner.id}, no tu usuario. Spotify solo comparte las canciones de las listas que creaste tú.`
      : "Spotify no devolvió ni siquiera los datos de esta lista, que es lo que hace con las suyas.";

    const kids = [
      ui.el("h3", { class: "blocked-card__title", text: "Spotify no comparte las canciones de esta lista" }),
      playlist?.name ? ui.el("p", { class: "muted-note", text: `«${playlist.name}»` }) : null,
      ui.el("p", { text: ownerLine }),
      ui.el("p", { text: "Desde febrero de 2026 la API entrega solo el nombre y la portada de cualquier playlist ajena, y eso incluye las que Spotify arma para ti: «Top canciones 20XX», Descubrimiento semanal, «This Is…», las radios." }),
    ];

    if (spotifyMade) {
      const topBtn = ui.el("button", { class: "btn btn--primary", type: "button" },
        ui.icon("plus"), "Traer tus más escuchadas");
      topBtn.addEventListener("click", (e) => importTopTracks("long_term", e.currentTarget));
      kids.push(
        ui.el("div", { class: "blocked-card__how" },
          ui.el("p", { text: "Tu «Top canciones» sale de lo que más escuchaste, y ese cálculo sí está abierto. Es la misma música, por la puerta que Spotify deja:" }),
          topBtn,
        ),
      );
    }

    kids.push(ui.el("p", { class: "muted-note", text: "La otra salida, si quieres esa lista exacta: ábrela en Spotify, selecciona todas las canciones, botón derecho → «Añadir a otra lista» → una playlist tuya. Esa pasa a ser tuya y se importa entera desde aquí." }));

    // This verdict is read off the owner, not off a failed request: if
    // Spotify turns out to hand the songs over anyway, let the user find out.
    if (playlist?.id) {
      kids.push(ui.el("button", {
        class: "btn btn--sm btn--ghost blocked-card__anyway",
        type: "button",
        text: "Intentar igual",
        on: { click: (e) => importSource("playlist", playlist, e.currentTarget) },
      }));
    }

    return ui.el("div", { class: "blocked-card" },
      coverEl(playlist?.images?.[0]?.url, "blocked-card__cover", "list"),
      ui.el("div", { class: "blocked-card__body" }, ...kids),
    );
  }

  function showBlockedPlaylist(playlist, ref) {
    errorHost.replaceChildren(blockedPlaylistCard(playlist, ref));
  }

  // --- results rendering -----------------------------------------------------
  function sectionHead(title, count) {
    return ui.el("div", { class: "results__head" },
      ui.el("h3", { class: "results__title", text: title }),
      ui.el("span", { class: "results__count", text: String(count) }),
    );
  }

  function mediaGrid(cards) {
    return ui.el("div", { class: "media-grid" }, ...cards);
  }

  function cardSubtitle(kind, item) {
    if (kind === "album") return artistsText(item);
    if (kind === "artist") return (item.genres ?? []).slice(0, 2).join(" · ") || "Artista";
    return item.owner?.display_name ?? "Spotify";
  }

  function mediaCard(kind, item, { owned = false } = {}) {
    const meta = [];
    if (owned) meta.push("Tuya");
    if (kind === "album") {
      const year = yearOf(item);
      if (year) meta.push(year);
      if (item.total_tracks) meta.push(`${item.total_tracks} temas`);
    } else if (kind === "artist") {
      meta.push("Toda su discografía");
    } else {
      const count = playlistCountText(item);
      if (count) meta.push(count);
    }
    return ui.el("article", { class: "media-card" },
      ui.el("div", { class: "media-card__cover" },
        coverEl(coverUrl(item, kind), "media-card__cover-img", COVER_FALLBACK[kind] ?? "list")
      ),
      ui.el("div", { class: "media-card__body" },
        ui.el("span", { class: "media-card__title", text: item.name ?? "" }),
        ui.el("span", { class: "media-card__sub", text: cardSubtitle(kind, item) }),
        ui.el("span", { class: "media-card__meta", text: meta.join(" · ") }),
      ),
      ui.el("div", { class: "media-card__actions" },
        ui.el("button", {
          class: "btn btn--sm btn--primary",
          type: "button",
          text: "Importar",
          on: { click: (e) => importSource(kind, item, e.currentTarget) },
        })
      ),
    );
  }

  function addTrack(track, btn) {
    btn.disabled = true;
    const { added } = library.commitTracks([track], [track.id]);
    if (added > 0) ui.toast(`«${track.name}» en «Lo que sé».`, "success");
    afterChange();
  }

  function trackList(tracks) {
    const list = ui.el("ul", { class: "result-list" });
    for (const t of tracks) {
      const action = library.isInPool(t.id)
        ? ui.el("span", { class: "chip chip--ok" }, ui.el("span", { class: "dot" }), ui.el("span", { text: "Ya la sabes" }))
        : ui.el("button", {
            class: "btn btn--sm",
            type: "button",
            text: "Añadir",
            on: { click: (e) => addTrack(t, e.currentTarget) },
          }, ui.icon("plus"));
      list.append(ui.el("li", { class: "result-row" },
        coverEl(t.album?.images?.[0]?.url, "result-row__thumb", "note"),
        ui.el("div", { class: "result-row__body" },
          ui.el("span", { class: "result-row__title", text: t.name }),
          ui.el("span", { class: "result-row__sub", text: `${artistsText(t)} · ${t.album?.name ?? ""}` }),
        ),
        action,
      ));
    }
    return list;
  }

  function linkCard({ ref, item, blocked }) {
    const kind = ref.type;
    if (kind === "playlist" && blocked) return blockedPlaylistCard(item, ref);

    let sub = "";
    if (kind === "track") sub = `${artistsText(item)} · ${item.album?.name ?? ""}`;
    else if (kind === "album") sub = [artistsText(item), yearOf(item), item.total_tracks ? `${item.total_tracks} temas` : ""].filter(Boolean).join(" · ");
    else if (kind === "artist") sub = [(item.genres ?? []).slice(0, 2).join(" · "), "toda su discografía"].filter(Boolean).join(" · ");
    else if (kind === "playlist") sub = [item.owner?.display_name ?? "Spotify", playlistCountText(item)].filter(Boolean).join(" · ");

    let action;
    if (kind === "track" && library.isInPool(item.id)) {
      action = ui.el("span", { class: "chip chip--ok" }, ui.el("span", { class: "dot" }), ui.el("span", { text: "Ya la sabes" }));
    } else if (kind === "track") {
      action = ui.el("button", {
        class: "btn btn--primary",
        type: "button",
        text: "Añadir",
        on: { click: (e) => addTrack(item, e.currentTarget) },
      });
    } else {
      action = ui.el("button", {
        class: "btn btn--primary",
        type: "button",
        text: "Importar",
        on: { click: (e) => importSource(kind, item, e.currentTarget) },
      });
    }

    return ui.el("div", { class: "link-result" },
      coverEl(coverUrl(item, kind), "link-result__cover", COVER_FALLBACK[kind] ?? "album"),
      ui.el("div", { class: "link-result__body" },
        ui.el("span", { class: "chip chip--ok" },
          ui.icon("link"),
          ui.el("span", { text: `Enlace de ${KIND_LABEL[kind]} detectado` })
        ),
        ui.el("h3", { class: "link-result__title", text: item.name ?? "" }),
        ui.el("p", { class: "muted-note", text: sub }),
      ),
      action,
    );
  }

  function emptyState() {
    if (results?.kind === "badlink") {
      return ui.el("div", { class: "results__empty" },
        ui.el("p", { text: "No pudimos leer ese enlace." }),
        ui.el("p", { class: "muted-note", text: "Copia el enlace completo desde Spotify (Compartir → Copiar enlace) o busca por nombre." }),
      );
    }
    return ui.el("div", { class: "results__empty" },
      ui.el("p", { text: `Sin resultados para «${query.trim()}».` }),
      ui.el("p", { class: "muted-note", text: "Prueba con otro nombre o pega un enlace de Spotify (canción, artista, álbum o playlist)." }),
    );
  }

  function renderBrowse() {
    if (ownPlaylists) {
      if (ownPlaylists.length === 0) {
        resultsHost.replaceChildren(ui.el("p", { class: "muted-note", text: "Todavía no tienes playlists en Spotify." }));
        return;
      }
      const shown = ownPlaylists.slice(0, 24);
      const kids = [
        sectionHead("Tus playlists", ownPlaylists.length),
        mediaGrid(shown.map((p) => mediaCard("playlist", p, { owned: true }))),
      ];
      const hiddenCount = ownPlaylists.length - shown.length;
      if (hiddenCount > 0) {
        kids.push(ui.el("p", { class: "muted-note", text: `+${hiddenCount} más. Escribe para filtrarlas.` }));
      }
      resultsHost.replaceChildren(...kids);
      return;
    }
    if (browseFailed) {
      resultsHost.replaceChildren(ui.el("p", { class: "muted-note", text: "No se pudieron cargar tus playlists. Busca por nombre para reintentar." }));
      return;
    }
    resultsHost.replaceChildren(ui.skeleton(4));
  }

  function renderCatalog(data) {
    const showTracks = filter === "all" || filter === "tracks";
    const showAlbums = filter === "all" || filter === "albums";
    const showArtists = filter === "all" || filter === "artists";
    const showPlaylists = filter === "all" || filter === "playlists";
    const tracks = showTracks ? data.tracks : [];
    const albums = showAlbums ? data.albums : [];
    const artists = showArtists ? data.artists : [];
    const own = showPlaylists ? data.own : [];
    const lists = showPlaylists ? data.playlists : [];
    if (tracks.length + albums.length + artists.length + own.length + lists.length === 0) {
      resultsHost.replaceChildren(emptyState());
      return;
    }
    const kids = [];
    if (own.length > 0) {
      kids.push(sectionHead("Tus playlists", own.length));
      kids.push(mediaGrid(own.map((p) => mediaCard("playlist", p, { owned: true }))));
    }
    if (tracks.length > 0) {
      kids.push(sectionHead("Canciones", tracks.length));
      kids.push(trackList(tracks));
    }
    if (artists.length > 0) {
      kids.push(sectionHead("Artistas", artists.length));
      kids.push(mediaGrid(artists.map((a) => mediaCard("artist", a))));
    }
    if (albums.length > 0) {
      kids.push(sectionHead("Álbumes", albums.length));
      kids.push(mediaGrid(albums.map((a) => mediaCard("album", a))));
    }
    if (lists.length > 0) {
      kids.push(sectionHead("Playlists de Spotify", lists.length));
      kids.push(mediaGrid(lists.map((p) => mediaCard("playlist", p))));
    }
    resultsHost.replaceChildren(...kids);
  }

  function renderChips() {
    const data = results?.kind === "catalog" ? results : null;
    const total = data
      ? data.tracks.length + data.albums.length + data.artists.length + data.playlists.length + data.own.length
      : 0;
    if (!data || total === 0) {
      chipsHost.hidden = true;
      chipsHost.replaceChildren();
      return;
    }
    const chipCounts = {
      all: total,
      tracks: data.tracks.length,
      artists: data.artists.length,
      albums: data.albums.length,
      playlists: data.playlists.length + data.own.length,
    };
    const defs = [
      ["all", "Todo"],
      ["tracks", "Canciones"],
      ["artists", "Artistas"],
      ["albums", "Álbumes"],
      ["playlists", "Playlists"],
    ];
    chipsHost.hidden = false;
    chipsHost.replaceChildren(
      ...defs.map(([value, label]) =>
        ui.el("button", {
          class: `search-chip${filter === value ? " search-chip--active" : ""}`,
          type: "button",
          "aria-pressed": filter === value ? "true" : "false",
          disabled: chipCounts[value] === 0,
          text: `${label} · ${chipCounts[value]}`,
          on: {
            click: () => {
              filter = value;
              renderChips();
              renderResults();
            },
          },
        })
      )
    );
  }

  function renderResults() {
    resultsHost.setAttribute("aria-busy", loading ? "true" : "false");
    if (loading) {
      resultsHost.replaceChildren(ui.skeleton(4));
      return;
    }
    if (query.trim().length < 2) {
      renderBrowse();
      return;
    }
    if (results?.kind === "link") {
      resultsHost.replaceChildren(linkCard(results));
      return;
    }
    if (results?.kind === "catalog") {
      renderCatalog(results);
      return;
    }
    if (results?.kind === "badlink") {
      resultsHost.replaceChildren(emptyState());
      return;
    }
    resultsHost.replaceChildren();
  }

  async function doSearch(raw) {
    const term = String(raw ?? "").trim();
    searchAbort?.abort();
    searchAbort = null;

    if (term.length < 2) {
      seq++;
      loading = false;
      results = null;
      renderChips();
      renderResults();
      return;
    }

    const mine = ++seq;
    const link = parseSpotifyRef(term);
    const badLink = !link && looksLikeSpotifyLink(term);

    loading = true;
    results = null;
    errorHost.innerHTML = "";
    renderChips();
    renderResults();

    try {
      if (link) {
        // Knowing who we are is what turns "Spotify · 100 canciones" into
        // "this list is not yours", before the user clicks Importar.
        const [resolved] = await Promise.all([library.resolveRef(link), loadMe()]);
        if (mine !== seq) return;
        const foreign = link.type === "playlist"
          && (resolved?.blocked || isForeignPlaylist(resolved?.item, link));
        if (foreign) results = { kind: "link", ref: link, item: resolved?.item, blocked: true };
        else results = resolved?.item ? { kind: "link", ref: link, item: resolved.item } : { kind: "badlink" };
      } else if (badLink) {
        results = { kind: "badlink" };
      } else {
        const controller = new AbortController();
        searchAbort = controller;
        const [catalog, mineList] = await Promise.all([
          api.searchCatalog(term, controller.signal),
          loadOwnPlaylists().catch(() => []),
        ]);
        if (mine !== seq) return;
        const needle = match.normalize(term);
        const own = (mineList ?? []).filter((p) => {
          const hay = `${match.normalize(p.name)} ${match.normalize(p.owner?.display_name ?? "")}`;
          return hay.includes(needle);
        });
        results = { kind: "catalog", ...catalog, own };
      }
    } catch (err) {
      if (err?.name === "AbortError" || mine !== seq) return;
      results = null;
      showError(link ? "No se pudo abrir el enlace. " : "No se pudo buscar. ", err);
    } finally {
      if (mine === seq) {
        loading = false;
        renderChips();
        renderResults();
      }
    }
  }

  function clearSearch() {
    runSearch.cancel();
    searchAbort?.abort();
    searchAbort = null;
    seq++;
    searchInput.value = "";
    query = "";
    lastQuery = "";
    clearBtn.hidden = true;
    loading = false;
    results = null;
    errorHost.innerHTML = "";
    renderChips();
    renderResults();
    searchInput.focus();
  }

  // --- wiring ----------------------------------------------------------------
  const runSearch = debounce((term) => doSearch(term), 280);

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    lastQuery = query;
    clearBtn.hidden = !query;
    runSearch(query);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      clearSearch();
    }
  });
  clearBtn.addEventListener("click", clearSearch);

  /**
   * Most-played songs. Reached from the shortcut row and from the card that
   * explains a withheld «Top canciones», which is the same music.
   */
  function importTopTracks(range, btn) {
    if (!auth.hasScope("user-top-read")) {
      showError("Para traer tus más escuchadas hace falta un permiso nuevo. Cierra sesión y vuelve a entrar: Spotify te lo pedirá una sola vez.", null, { retry: false });
      return;
    }
    const label = TOP_RANGES.find(([value]) => value === range)?.[1] ?? "";
    stageImport({
      kind: "top",
      id: `top:${range}`,
      title: "Tus más escuchadas",
      subtitle: `Lo que más sonó ${label}`,
      load: () => library.previewTopTracks(range),
    }, btn);
  }

  const TOP_RANGES = [
    ["long_term", "de siempre"],
    ["medium_term", "de los últimos 6 meses"],
    ["short_term", "de las últimas 4 semanas"],
  ];

  /**
   * The two sources that are not a search: saved songs and most-played.
   * Most-played is here because Spotify's own «Top canciones 20XX» playlist
   * is owned by Spotify and hands over no tracks — this is the same music by
   * the only route the API still allows.
   */
  function shortcutsRow() {
    const rangeSelect = ui.el("select", { class: "select select--sm", "aria-label": "Periodo de tus más escuchadas" },
      ...TOP_RANGES.map(([value, label]) => ui.el("option", { value, text: label })),
    );

    const topBtn = ui.el("button", { class: "btn", type: "button" }, ui.icon("plus"), "Tus más escuchadas");
    topBtn.addEventListener("click", (e) => importTopTracks(rangeSelect.value, e.currentTarget));

    return ui.el("div", { class: "lib-shortcuts" },
      ui.el("button", {
        class: "btn",
        type: "button",
        on: {
          click: (e) => stageImport({
            kind: "liked",
            id: "liked",
            title: "Me gusta",
            subtitle: "Tus canciones guardadas en Spotify",
            load: () => library.previewLiked(),
          }, e.currentTarget),
        },
      }, ui.icon("plus"), "Me gusta"),
      ui.el("div", { class: "lib-shortcuts__group" }, topBtn, rangeSelect),
    );
  }

  const poolFilterInput = ui.el("input", {
    class: "pool-panel__filter",
    type: "search",
    placeholder: "Busca en lo que sabes…",
    "aria-label": "Buscar dentro de «Lo que sé»",
    autocomplete: "off",
  });
  poolFilterInput.addEventListener("input", () => {
    poolFilter = poolFilterInput.value;
    renderPool();
  });

  // Two-step «Vaciar»: the first click arms it, the second empties the pool.
  let armed = false;
  let disarmTimer = null;
  const clearPoolBtn = ui.el("button", {
    class: "btn btn--sm btn--ghost",
    type: "button",
    text: "Vaciar",
  });
  clearPoolBtn.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      clearPoolBtn.textContent = "¿Vaciar todo?";
      clearPoolBtn.className = "btn btn--sm btn--danger";
      disarmTimer = setTimeout(() => {
        armed = false;
        clearPoolBtn.textContent = "Vaciar";
        clearPoolBtn.className = "btn btn--sm btn--ghost";
      }, 4000);
      return;
    }
    clearTimeout(disarmTimer);
    armed = false;
    clearPoolBtn.textContent = "Vaciar";
    clearPoolBtn.className = "btn btn--sm btn--ghost";
    library.clearPool();
    afterChange();
    ui.toast("«Lo que sé» quedó vacío.", "success");
  });

  view.append(
    ui.el("div", { class: "lib-intro" },
      ui.el("h1", { class: "display display--md", text: "Tu biblioteca" }),
      ui.el("p", { class: "muted-note", text: "Lo que añadas aquí es lo que suena en los juegos." }),
    ),
    ui.el("div", { class: "lib-layout" },
      ui.el("div", { class: "card stack lib-find" },
        searchField,
        ui.el("p", { class: "search-hint", text: "Busca por nombre o pega un enlace de Spotify. Un artista entero trae toda su discografía." }),
        shortcutsRow(),
        errorHost,
        chipsHost,
        resultsHost,
      ),
      ui.el("aside", { class: "card pool-panel", "aria-label": "Lo que sé" },
        ui.el("div", { class: "pool-panel__head" },
          ui.el("h2", { class: "pool-panel__title", text: "Lo que sé" }),
          counts,
          clearPoolBtn,
        ),
        poolFilterInput,
        poolHost,
      ),
    ),
  );

  refresh();
  renderPool();
  renderChips();
  renderResults();

  loadMe();
  loadOwnPlaylists()
    .then(() => {
      if (query.trim().length < 2 && !loading) renderResults();
    })
    .catch(() => {
      browseFailed = true;
      if (query.trim().length < 2 && !loading) renderResults();
    });

  if (query.trim().length >= 2) doSearch(query);
}

function thumb(t) {
  return coverEl(t.album?.images?.[0]?.url, "pending-row__thumb", "note");
}

// --- game views ---------------------------------------------------------------------

function renderClip(view) {
  view.innerHTML = "";
  ensurePlayer();
  clipGame.mount(view, ctx);
}

function renderAlbum(view) {
  view.innerHTML = "";
  albumGame.mount(view, ctx);
}

function renderYear(view) {
  view.innerHTML = "";
  ensurePlayer();
  yearGame.mount(view, ctx);
}

function renderRonda(view) {
  view.innerHTML = "";
  ensurePlayer();
  roundGame.mount(view, ctx);
}

boot();