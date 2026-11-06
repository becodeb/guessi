// Song picker for the lyrics game: a big search field (title, artist or a
// pasted Spotify link), then the user's own sources as plain tiles. No network
// call happens before the user types or taps something.

import * as ui from "../ui.js";
import { artistNames } from "../clip-guess.js";
import { parseSpotifyRef, looksLikeSpotifyLink } from "../spotify-link.js";
import { UnreadablePlaylistError } from "../library.js";
import { playableTracks } from "../lyrics-queue.js";

const SEARCH_DEBOUNCE_MS = 320;

/** The cover whose width is closest to (and at least) `want` px. */
export function pickImage(images, want = 160) {
  const list = (images ?? []).filter((i) => i?.url);
  if (list.length === 0) return null;
  const big = list.filter((i) => (i.width ?? want) >= want).sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return (big[0] ?? list[0]).url;
}

function cover(url, className, fallbackIcon = "note") {
  const box = ui.el("span", { class: className });
  if (url) {
    const img = ui.el("img", { src: url, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => { img.remove(); box.append(ui.icon(fallbackIcon)); }, { once: true });
    box.append(img);
  } else {
    box.append(ui.icon(fallbackIcon));
  }
  return box;
}

function mosaic(urls, className) {
  const box = ui.el("span", { class: `${className} letra-tile__cover--mosaic` });
  const unique = [...new Set(urls)].slice(0, 4);
  if (unique.length < 4) return cover(unique[0] ?? null, className, "note");
  for (const url of unique) {
    const img = ui.el("img", { src: url, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => img.remove(), { once: true });
    box.append(img);
  }
  return box;
}

function songWord(n) {
  return n === 1 ? "canción" : "canciones";
}

/**
 * @param {HTMLElement} host
 * @param {{ctx: object, onStart: (tracks: object[], startIndex: number) => void, onTimed: () => void}} deps
 * @returns {{destroy: () => void, focus: () => void}}
 */
export function mountPicker(host, { ctx, onStart }) {
  let alive = true;
  let busy = false;
  let searchTimer = null;
  let searchAbort = null;
  let searchSeq = 0;

  const input = ui.el("input", {
    class: "letra-pick__input",
    type: "search",
    autocomplete: "off",
    autocapitalize: "off",
    spellcheck: "false",
    enterkeyhint: "search",
    placeholder: "Busca una canción o pega un enlace de Spotify",
    "aria-label": "Busca una canción o pega un enlace de Spotify",
  });
  const message = ui.el("p", { class: "letra-pick__msg", role: "status", "aria-live": "polite" });
  const results = ui.el("div", { class: "letra-pick__results", hidden: true });
  const sources = ui.el("section", { class: "letra-pick__sources", "aria-label": "Tus listas" });
  const tiles = ui.el("div", { class: "letra-tiles" });
  sources.append(ui.el("h2", { class: "letra-pick__h", text: "Tus listas" }), tiles);

  const root = ui.el("div", { class: "letra-pick" },
    ui.el("a", { class: "letra-pick__back", href: "#/juegos" }, ui.icon("back"), ui.el("span", { text: "Juegos" })),
    ui.el("h1", { class: "letra-pick__title", text: "Completa la letra" }),
    ui.el("label", { class: "letra-pick__search" }, ui.icon("search"), input),
    message,
    results,
    sources,
    ui.el("a", { class: "letra-pick__quiet", href: "#/juegos/letra/contrarreloj", text: "Jugar contrarreloj" }),
  );
  host.replaceChildren(root);

  function say(text) {
    message.textContent = text ?? "";
    message.hidden = !text;
  }
  say("");

  // --- starting a queue ----------------------------------------------------------

  async function start(load, label) {
    if (busy) return;
    busy = true;
    root.classList.add("is-busy");
    say(label ? `Cargando ${label}…` : "Cargando…");
    try {
      const out = await load();
      if (!alive) return;
      const tracks = playableTracks(out?.tracks ?? out);
      if (tracks.length === 0) {
        say("No encontré canciones ahí. Prueba con otra lista o busca una canción.");
        return;
      }
      say("");
      onStart(tracks, 0);
    } catch (err) {
      if (!alive) return;
      say(errorText(err));
    } finally {
      busy = false;
      root.classList.remove("is-busy");
    }
  }

  function errorText(err) {
    if (err instanceof UnreadablePlaylistError) {
      return "Spotify no deja leer las canciones de esa playlist, porque no es tuya. Prueba con una de las tuyas o pega el enlace de una canción.";
    }
    if (err?.name === "SessionError") return "Tu sesión de Spotify expiró. Vuelve a iniciar sesión.";
    if (err?.status === 0) return "No pude conectar con Spotify. Revisa tu conexión y vuelve a intentarlo.";
    return "No pude cargar eso desde Spotify. Vuelve a intentarlo en un momento.";
  }

  // --- search --------------------------------------------------------------------

  function showResults(show) {
    results.hidden = !show;
    sources.hidden = show;
    if (!show) results.replaceChildren();
  }

  function row(track) {
    const img = pickImage(track.album?.images, 64);
    return ui.el("button", {
      class: "letra-row", type: "button",
      on: { click: () => start(async () => [track], `«${track.name}»`) },
    },
      cover(img, "letra-row__cover"),
      ui.el("span", { class: "letra-row__text" },
        ui.el("span", { class: "letra-row__title", text: track.name }),
        ui.el("span", { class: "letra-row__meta", text: artistNames(track).join(", ") }),
      ),
    );
  }

  function albumTile(album) {
    return ui.el("button", {
      class: "letra-tile", type: "button",
      on: { click: () => start(() => ctx.library.previewRef({ type: "album", id: album.id }), `«${album.name}»`) },
    },
      cover(pickImage(album.images, 300), "letra-tile__cover"),
      ui.el("span", { class: "letra-tile__name", text: album.name }),
      ui.el("span", { class: "letra-tile__meta", text: (album.artists ?? []).map((a) => a.name).join(", ") }),
    );
  }

  function renderResults(found) {
    results.replaceChildren();
    if (found.tracks.length > 0) {
      results.append(
        ui.el("h2", { class: "letra-pick__h", text: "Canciones" }),
        ui.el("div", { class: "letra-rows" }, ...found.tracks.map(row)),
      );
    }
    if (found.albums.length > 0) {
      results.append(
        ui.el("h2", { class: "letra-pick__h", text: "Álbumes" }),
        ui.el("div", { class: "letra-tiles" }, ...found.albums.map(albumTile)),
      );
    }
    if (found.tracks.length === 0 && found.albums.length === 0) {
      say("No encontré nada con eso. Prueba con el título y el artista.");
    }
  }

  async function runSearch(query) {
    const seq = ++searchSeq;
    searchAbort?.abort();
    const controller = new AbortController();
    searchAbort = controller;
    say("Buscando…");
    try {
      const found = await ctx.api.searchCatalog(query, controller.signal);
      if (!alive || seq !== searchSeq) return;
      say("");
      showResults(true);
      renderResults(found);
    } catch (err) {
      if (!alive || seq !== searchSeq || err?.name === "AbortError") return;
      say(errorText(err));
    }
  }

  function onInput() {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) {
      searchSeq++;
      searchAbort?.abort();
      say("");
      showResults(false);
      return;
    }
    const ref = parseSpotifyRef(q);
    if (ref) {
      searchSeq++;
      searchAbort?.abort();
      showResults(false);
      if (ref.type === "artist") {
        say("Pega el enlace de una canción, un álbum o una playlist. Los artistas no se pueden jugar enteros.");
        return;
      }
      start(() => ctx.library.previewRef(ref), ref.type === "track" ? "la canción" : ref.type === "album" ? "el álbum" : "la playlist");
      return;
    }
    if (looksLikeSpotifyLink(q)) {
      showResults(false);
      say("No pude leer ese enlace. Copia el enlace completo de una canción, un álbum o una playlist.");
      return;
    }
    if (q.length < 2) return;
    searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  }
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (q.length >= 2 && !parseSpotifyRef(q) && !looksLikeSpotifyLink(q)) runSearch(q);
    }
  });

  // --- sources -------------------------------------------------------------------

  function tile({ name, meta, art, onClick }) {
    return ui.el("button", { class: "letra-tile", type: "button", on: { click: onClick } },
      art,
      ui.el("span", { class: "letra-tile__name", text: name }),
      meta ? ui.el("span", { class: "letra-tile__meta", text: meta }) : null,
    );
  }

  const pool = ctx.library.getPoolTracks();
  if (pool.length > 0) {
    tiles.append(tile({
      name: "Lo que sé",
      meta: `${pool.length} ${songWord(pool.length)}`,
      art: mosaic(pool.map((t) => pickImage(t.album?.images, 160)).filter(Boolean), "letra-tile__cover"),
      onClick: () => start(async () => ctx.library.getPoolTracks(), "«Lo que sé»"),
    }));
  }
  tiles.append(
    tile({
      name: "Canciones que te gustan",
      meta: "Tu biblioteca de Spotify",
      art: cover(null, "letra-tile__cover letra-tile__cover--glyph", "heart"),
      onClick: () => start(() => ctx.library.previewLiked(), "tus canciones"),
    }),
    tile({
      name: "Tus más escuchadas",
      meta: "De siempre",
      art: cover(null, "letra-tile__cover letra-tile__cover--glyph", "trend"),
      onClick: () => start(() => ctx.library.previewTopTracks("long_term"), "tus más escuchadas"),
    }),
  );

  (async () => {
    try {
      const [me, playlists] = await Promise.all([ctx.api.getMe().catch(() => null), ctx.api.getPlaylists()]);
      if (!alive) return;
      const mine = playlists.filter((p) => !me?.id || p.owner?.id === me.id || p.collaborative);
      for (const p of mine) {
        const total = ctx.api.playlistTrackTotal(p);
        tiles.append(tile({
          name: p.name,
          meta: total != null ? `${total} ${songWord(total)}` : "",
          art: cover(pickImage(p.images, 300), "letra-tile__cover"),
          onClick: () => start(() => ctx.library.previewRef({ type: "playlist", id: p.id }), `«${p.name}»`),
        }));
      }
    } catch {
      // The quick sources above still work; playlists are a convenience.
    }
  })();

  return {
    say,
    focus: () => input.focus({ preventScroll: true }),
    destroy() {
      alive = false;
      clearTimeout(searchTimer);
      searchAbort?.abort();
    },
  };
}
