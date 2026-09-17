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
  library: { pendingCount: 0, poolCount: 0, loading: false, slowDown: false, saveError: false },
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

  // Let the round view use the full wide layout; other views keep the 980px cap.
  const wide = def.view === "ronda";

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

function importMessage(label, { fetched = 0, added = 0 } = {}) {
  if (fetched === 0) return `${label}: no se encontraron canciones`;
  if (added === 0) return `${label}: ya estaban en pendientes o en «Lo que sé»`;
  if (added === 1) return fetched > 1 ? `${label}: 1 nueva de ${fetched}` : `${label}: 1 canción añadida`;
  if (added < fetched) return `${label}: ${added} nuevas de ${fetched}`;
  return `${label}: ${added} canciones añadidas`;
}

function renderLibrary(view) {
  view.innerHTML = "";
  view.append(
    ui.el("h1", { class: "display display--md", text: "Tu biblioteca" }),
    ui.el("p", { class: "muted-note", text: "Busca canciones, álbumes o playlists y súmalas a «Lo que sé» para que entren en los juegos." })
  );

  const counts = ui.el("p", { class: "lib-counts" });
  const pendingHost = ui.el("div");
  const poolHost = ui.el("div");
  const errorHost = ui.el("div");

  // --- local search state ----------------------------------------------------
  let query = lastQuery;
  let filter = "all";
  let results = null; // {kind:"catalog",…} | {kind:"link",…} | {kind:"badlink"} | null
  let loading = false;
  let browseFailed = false;
  let seq = 0;
  let searchAbort = null;
  const imported = new Set();

  const refresh = () => {
    counts.textContent = `Pendientes ${library.getPending().length} · Lo que sé ${library.getPoolCount()}`;
  };

  const renderPending = () => {
    pendingHost.innerHTML = "";
    const pending = library.getPending();
    if (pending.length === 0) {
      pendingHost.append(ui.el("p", { class: "muted-note", text: "Sin pendientes. Importa una playlist o un álbum, o busca canciones." }));
      return;
    }
    const list = ui.el("ul", { class: "pending-list" });
    for (const t of pending) {
      const row = ui.el("li", { class: "pending-row" },
        thumb(t),
        ui.el("div", { class: "stack", style: "gap:2px" },
          ui.el("span", { class: "pending-row__title", text: t.name }),
          ui.el("span", { class: "pending-row__artists", text: t.artists.map((a) => a.name).join(", ") }),
        ),
        ui.el("button", {
          class: "btn btn--sm",
          text: "Añadir",
          on: {
            click: () => {
              library.addToPool([t.id]);
              refresh();
              renderPending();
              renderPool();
            },
          },
        }),
      );
      list.append(row);
    }
    pendingHost.append(
      ui.el("div", { class: "row row--between" },
        ui.el("p", { class: "guess-panel__title", text: "Pendientes de importación" }),
        ui.el("button", {
          class: "btn btn--sm btn--ghost",
          text: "Añadir todo",
          on: {
            click: () => {
              library.addAllPendingToPool();
              refresh();
              renderPending();
              renderPool();
            },
          },
        }),
      ),
      list,
    );
  };

  const renderPool = () => {
    poolHost.innerHTML = "";
    const tracks = library.getPoolTracks();
    if (tracks.length === 0) {
      poolHost.append(ui.el("p", { class: "muted-note", text: "Tu biblioteca está vacía. Importa canciones para empezar a jugar." }));
      return;
    }
    const list = ui.el("ul", { class: "pool-list" });
    for (const t of tracks) {
      const row = ui.el("li", { class: "pool-row" },
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
              refresh();
              renderPending();
              renderPool();
            },
          },
        }, ui.icon("trash")),
      );
      list.append(row);
    }

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
      library.clearPool();
      refresh();
      renderPending();
      renderPool();
      ui.toast("«Lo que sé» quedó vacío.", "success");
    });

    poolHost.append(
      ui.el("div", { class: "row row--between" },
        ui.el("p", { class: "guess-panel__title", text: "Lo que sé" }),
        clearPoolBtn,
      ),
      list,
    );
  };

  // --- search panel ----------------------------------------------------------
  const searchInput = ui.el("input", {
    class: "search-field__input",
    type: "search",
    placeholder: "Busca canciones, álbumes o playlists…",
    "aria-label": "Buscar canciones, álbumes o playlists",
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

  function showError(msg, err) {
    errorHost.innerHTML = "";
    const banner = ui.el("div", { class: "banner banner--error" },
      ui.icon("warn"),
      ui.el("div", { class: "banner__body" },
        ui.el("span", { text: err?.message === "Sesión expirada" ? "Vuelve a iniciar sesión." : msg }),
        ui.el("button", {
          class: "btn btn--sm",
          text: "Reintentar",
          on: { click: () => route() },
        }),
      ),
    );
    errorHost.append(banner);
  }

  async function runImport(action, label, { skeleton = true } = {}) {
    errorHost.innerHTML = "";
    if (skeleton) pendingHost.replaceChildren(ui.skeleton(3));
    try {
      const res = await action();
      refresh();
      renderPending();
      renderPool();
      ui.toast(importMessage(label, res), "success");
      return res;
    } catch (err) {
      renderPending();
      showError("No se pudo importar. ", err);
      return null;
    }
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

  async function runMediaImport(kind, item, btn) {
    btn.disabled = true;
    btn.textContent = "Importando…";
    const res = await runImport(() => library.importRef({ type: kind, id: item.id }), `«${item.name}»`);
    if (res) {
      imported.add(`${kind}:${item.id}`);
      renderResults();
    } else {
      btn.disabled = false;
      btn.textContent = "Importar";
    }
  }

  function mediaCard(kind, item, { owned = false } = {}) {
    const done = imported.has(`${kind}:${item.id}`);
    const meta = [];
    if (owned) meta.push("Tuya");
    if (kind === "album") {
      const year = yearOf(item);
      if (year) meta.push(year);
      if (item.total_tracks) meta.push(`${item.total_tracks} temas`);
    } else if (item.tracks?.total != null) {
      meta.push(`${item.tracks.total} canciones`);
    }
    return ui.el("article", { class: "media-card" },
      ui.el("div", { class: "media-card__cover" },
        coverEl(coverUrl(item, kind), "media-card__cover-img", kind === "album" ? "album" : "list")
      ),
      ui.el("div", { class: "media-card__body" },
        ui.el("span", { class: "media-card__title", text: item.name ?? "" }),
        ui.el("span", { class: "media-card__sub", text: kind === "album" ? artistsText(item) : (item.owner?.display_name ?? "Spotify") }),
        ui.el("span", { class: "media-card__meta", text: meta.join(" · ") }),
      ),
      ui.el("div", { class: "media-card__actions" },
        ui.el("button", {
          class: `btn btn--sm${done ? " btn--ghost" : " btn--primary"}`,
          type: "button",
          disabled: done,
          text: done ? "Importado" : "Importar",
          on: { click: (e) => runMediaImport(kind, item, e.currentTarget) },
        })
      ),
    );
  }

  async function addTrack(t, btn) {
    btn.disabled = true;
    btn.textContent = "Añadiendo…";
    const res = await runImport(async () => {
      const added = library.addTracks([t]);
      return { fetched: 1, added };
    }, `«${t.name}»`, { skeleton: false });
    if (res) renderResults();
    else {
      btn.disabled = false;
      btn.textContent = "Añadir";
    }
  }

  function trackList(tracks) {
    const list = ui.el("ul", { class: "result-list" });
    for (const t of tracks) {
      const inPool = library.isInPool(t.id);
      const pending = !inPool && library.isPending(t.id);
      let action;
      if (inPool) {
        action = ui.el("span", { class: "chip chip--ok" }, ui.el("span", { class: "dot" }), ui.el("span", { text: "Ya lo sé" }));
      } else if (pending) {
        action = ui.el("span", { class: "chip chip--muted" }, ui.el("span", { class: "dot" }), ui.el("span", { text: "En pendientes" }));
      } else {
        action = ui.el("button", {
          class: "btn btn--sm",
          type: "button",
          text: "Añadir",
          on: { click: (e) => addTrack(t, e.currentTarget) },
        }, ui.icon("plus"));
      }
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

  function linkCard({ ref, item }) {
    const kind = ref.type;
    const supported = kind !== "artist";
    const done = imported.has(`${kind}:${item.id}`);
    let sub = "";
    if (kind === "track") sub = `${artistsText(item)} · ${item.album?.name ?? ""}`;
    else if (kind === "album") sub = [artistsText(item), yearOf(item), item.total_tracks ? `${item.total_tracks} temas` : ""].filter(Boolean).join(" · ");
    else if (kind === "playlist") sub = `${item.owner?.display_name ?? "Spotify"} · ${item.tracks?.total ?? 0} canciones`;

    const action = supported
      ? ui.el("button", {
          class: `btn${done ? " btn--ghost" : " btn--primary"}`,
          type: "button",
          disabled: done,
          text: done ? "Importado" : "Importar",
          on: { click: (e) => runMediaImport(kind, item, e.currentTarget) },
        })
      : ui.el("button", { class: "btn", type: "button", disabled: true, text: "No disponible" });

    return ui.el("div", { class: "link-result" },
      coverEl(coverUrl(item, kind), "link-result__cover", kind === "playlist" ? "list" : "album"),
      ui.el("div", { class: "link-result__body" },
        ui.el("span", { class: "chip chip--ok" },
          ui.icon("link"),
          ui.el("span", { text: `Enlace de ${KIND_LABEL[kind]} detectado` })
        ),
        ui.el("h3", { class: "link-result__title", text: item.name ?? "" }),
        ui.el("p", { class: "muted-note", text: sub }),
        supported
          ? null
          : ui.el("p", { class: "muted-note", text: "Spotify ya no permite traer las canciones de un artista: importa un álbum o una playlist." }),
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
      ui.el("p", { class: "muted-note", text: "Prueba con otro nombre o pega un enlace de Spotify (canción, álbum o playlist)." }),
    );
  }

  function renderBrowse() {
    if (ownPlaylists) {
      if (ownPlaylists.length === 0) {
        resultsHost.replaceChildren(ui.el("p", { class: "muted-note", text: "Todavía no tienes playlists en Spotify." }));
        return;
      }
      const shown = ownPlaylists.slice(0, 18);
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
    const showPlaylists = filter === "all" || filter === "playlists";
    const tracks = showTracks ? data.tracks : [];
    const albums = showAlbums ? data.albums : [];
    const own = showPlaylists ? data.own : [];
    const lists = showPlaylists ? data.playlists : [];
    if (tracks.length + albums.length + own.length + lists.length === 0) {
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
    const total = data ? data.tracks.length + data.albums.length + data.playlists.length + data.own.length : 0;
    if (!data || total === 0) {
      chipsHost.hidden = true;
      chipsHost.replaceChildren();
      return;
    }
    const chipCounts = {
      all: total,
      tracks: data.tracks.length,
      albums: data.albums.length,
      playlists: data.playlists.length + data.own.length,
    };
    const defs = [["all", "Todo"], ["tracks", "Canciones"], ["albums", "Álbumes"], ["playlists", "Playlists"]];
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
        const resolved = await library.resolveRef(link);
        if (mine !== seq) return;
        results = resolved?.item ? { kind: "link", ref: link, item: resolved.item } : { kind: "badlink" };
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

  view.append(
    ui.el("div", { class: "card stack" },
      searchField,
      ui.el("p", { class: "search-hint", text: "Busca por nombre o pega un enlace de Spotify (canción, álbum o playlist)." }),
      errorHost,
      chipsHost,
      resultsHost,
    ),
    ui.el("div", { class: "card lib-toolbar lib-toolbar--between" },
      ui.el("button", {
        class: "btn",
        type: "button",
        on: { click: () => runImport(() => library.importLiked(), "«Me gusta»") },
      }, ui.icon("plus"), "Importar «Me gusta»"),
      counts,
    ),
    ui.el("div", { class: "section stack--lg" },
      pendingHost,
      poolHost,
    ),
  );

  refresh();
  renderPending();
  renderPool();
  renderChips();
  renderResults();

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