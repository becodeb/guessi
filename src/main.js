// App shell: hash router, app state, nav, banners/toasts, and the
// login / library / hub views. Game views live in src/games/*.

import { CLIENT_ID } from "./config.js";
import * as auth from "./auth.js";
import * as api from "./spotify-api.js";
import * as player from "./player.js";
import * as library from "./library.js";
import * as ui from "./ui.js";
import * as clipGame from "./games/clip-game.js";
import * as albumGame from "./games/album-game.js";
import * as yearGame from "./games/year-game.js";
import * as roundGame from "./games/round-game.js";

// --- app state (single source of truth) -------------------------------------

const appState = {
  view: "login",
  auth: { status: "anon", scopes: [] },
  library: { pendingCount: 0, poolCount: 0, loading: false, slowDown: false },
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

let lastPlaylistId = null;
let lastQuery = "";

function renderLibrary(view) {
  view.innerHTML = "";
  view.append(ui.el("h1", { class: "display display--md", text: "Tu biblioteca" }));
  view.append(ui.el("p", { class: "muted-note", text: "Importa canciones y añádelas a «Lo que sé» para que entren en los juegos." }));

  const counts = ui.el("p", { class: "lib-counts" });
  const pendingHost = ui.el("div");
  const poolHost = ui.el("div");
  const errorHost = ui.el("div");

  const refresh = () => {
    counts.textContent = `Pendientes ${library.getPending().length} · Lo que sé ${library.getPoolCount()}`;
  };

  const renderPending = () => {
    pendingHost.innerHTML = "";
    const pending = library.getPending();
    if (pending.length === 0) {
      pendingHost.append(ui.el("p", { class: "muted-note", text: "Sin pendientes. Importa playlists, «Me gusta» o busca canciones." }));
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
    poolHost.append(
      ui.el("p", { class: "guess-panel__title", text: "Lo que sé" }),
      list,
    );
  };

  // --- import toolbar ---
  const playlistSelect = ui.el("select", { class: "select", "aria-label": "Elegir playlist" },
    ui.el("option", { value: "", text: "Cargando playlists…", disabled: true, selected: true }),
  );
  playlistSelect.addEventListener("focus", loadPlaylistOptions, { once: true });

  async function loadPlaylistOptions() {
    try {
      const playlists = await api.getPlaylists();
      playlistSelect.innerHTML = "";
      playlistSelect.append(ui.el("option", { value: "", text: "Elige una playlist…", disabled: true, selected: true }));
      for (const p of playlists) {
        playlistSelect.append(ui.el("option", { value: p.id, text: p.name }));
      }
      if (lastPlaylistId) playlistSelect.value = lastPlaylistId;
    } catch (err) {
      showError("No se pudieron cargar tus playlists.", err);
    }
  }

  const importPlaylistBtn = ui.el("button", {
    class: "btn",
    text: "Importar",
    on: {
      click: async () => {
        if (!playlistSelect.value) return;
        lastPlaylistId = playlistSelect.value;
        await runImport(() => library.importFromPlaylist(lastPlaylistId), "Playlist importada");
      },
    },
  });

  const likedBtn = ui.el("button", {
    class: "btn",
    text: "Me gusta",
    on: {
      click: async () => {
        await runImport(() => library.importLiked(), "«Me gusta» importado");
      },
    },
  });

  const searchInput = ui.el("input", {
    class: "input",
    type: "search",
    placeholder: "Buscar canciones…",
    "aria-label": "Buscar canciones",
    value: lastQuery,
  });
  const searchBtn = ui.el("button", {
    class: "btn",
    text: "Buscar",
    on: {
      click: async () => {
        const q = searchInput.value.trim();
        if (!q) return;
        lastQuery = q;
        await runImport(() => library.search(q), "Resultados añadidos");
      },
    },
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchBtn.click();
  });

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

  async function runImport(action, successMsg) {
    errorHost.innerHTML = "";
    pendingHost.replaceChildren(ui.skeleton(3));
    try {
      const n = await action();
      refresh();
      renderPending();
      ui.toast(`${successMsg} (${n})`, "success");
    } catch (err) {
      renderPending();
      showError("Algo salió mal.", err);
    }
  }

  view.append(
    ui.el("div", { class: "card stack" },
      ui.el("div", { class: "lib-toolbar" },
        playlistSelect,
        importPlaylistBtn,
        likedBtn,
        searchInput,
        searchBtn,
      ),
      errorHost,
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
}

function thumb(t) {
  const url = t.album.images?.[0]?.url;
  if (!url) return ui.el("div", { class: "pending-row__thumb" }, ui.icon("note"));
  const img = ui.el("img", { class: "pending-row__thumb", alt: "", loading: "lazy", src: url });
  img.addEventListener("error", () => img.replaceWith(ui.el("div", { class: "pending-row__thumb" }, ui.icon("note"))));
  return img;
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