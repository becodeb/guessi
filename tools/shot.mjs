#!/usr/bin/env node
// Screenshot harness runner for de oído (guessi). Boots harness-app.html (the
// real app, fake Spotify) behind a tiny static server and captures every
// route at desktop + mobile, plus a few interesting states (empty library,
// non-Premium, a wrong-guess mid-game state per game).
//
// Run with: NODE_PATH=/tmp/pw/node_modules node tools/shot.mjs [flags]
//   --out <dir>     output directory (default /tmp/guessi-shots/<label>)
//   --label <name>  used in the default --out path (default "run")
//   --only <text>   only run targets whose name includes this substring
//
// Zero npm dependencies, as required by the app itself — the only external
// package used is Playwright, which lives outside this repo (installed at
// /tmp/pw) and is never added to package.json.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// NODE_PATH is a CommonJS-only resolution mechanism; ESM's static `import`
// ignores it, so a plain `import "playwright"` fails even with NODE_PATH set
// (verified: Node throws ERR_MODULE_NOT_FOUND). createRequire's require()
// still honors NODE_PATH, so that is the loading path here.
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- CLI args ----------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: null, label: "run", only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") out.out = argv[++i];
    else if (a === "--label") out.label = argv[++i];
    else if (a === "--only") out.only = argv[++i];
  }
  if (!out.out) out.out = `/tmp/guessi-shots/${out.label}`;
  return out;
}

const args = parseArgs(process.argv.slice(2));

// --- tiny static file server --------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function startServer(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath;
      try {
        urlPath = decodeURIComponent(req.url.split("?")[0]);
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      if (urlPath === "/") urlPath = "/index.html";
      const filePath = path.normalize(path.join(root, urlPath));
      if (filePath !== root && !filePath.startsWith(root + path.sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found: " + urlPath);
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// --- route table ---------------------------------------------------------------

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

// The app percent-encodes non-ASCII hash segments ("#/juegos/año") and
// decodes them on the way in (see main.js's route()) — build hashes the same
// way a browser would rather than hand-typing the escape.
function hashFor(routePath) {
  return "#" + routePath.split("/").map(encodeURIComponent).join("/");
}

// A wrong-guess-then-Enter interaction: createAutoGuess() always evaluates
// synchronously on Enter (no debounce to wait out), so this is a robust,
// non-flaky way to reach an "incorrect" visual state.
function wrongGuess(selector, text) {
  return async (page) => {
    const input = page.locator(selector).first();
    await input.fill(text);
    await input.press("Enter");
  };
}

// clip-game.js's combobox: type a query, wait for the listbox, click one of
// the resulting suggestions. Paired with target.stubRandom so the drawn
// answer (and therefore whether the pick is right or wrong) is deterministic.
function pickSuggestion(query, { index = 0 } = {}) {
  return async (page) => {
    const input = page.locator(".combobox__input").first();
    await input.fill(query);
    await page.waitForSelector(".combobox__option", { timeout: 3000 });
    await page.locator(".combobox__option").nth(index).click();
    await page.waitForTimeout(600);
  };
}

const TARGETS = [
  { name: "login", query: { authed: "0" }, hash: hashFor("/login"), wait: ".login__hero" },

  { name: "library", query: {}, hash: hashFor("/library"), wait: ".media-grid .media-card" },

  { name: "hub", query: {}, hash: hashFor("/juegos"), wait: ".hub-posters" },
  // renderHub() (T2) adds an empty-library panel above the poster wall when
  // the pool is 0; the posters themselves still render underneath it, so
  // ".hub-posters" is the right wait selector for this target too.
  { name: "hub-empty", query: { empty: "1" }, hash: hashFor("/juegos"), wait: ".hub-posters" },
  // Bonus: the actually-informative empty state lives in each GAME view, not
  // the hub. round-game.js is the clearest example of it.
  { name: "ronda-empty", query: { empty: "1" }, hash: hashFor("/juegos/ronda"), wait: ".import-guide" },

  // clip-game.js ("La primera décima"): the combobox input is the precise,
  // always-present signal that the new guess UI mounted.
  { name: "clip", query: {}, hash: hashFor("/juegos/clip"), wait: ".combobox__input" },
  // stubRandom pins the drawn answer to the first pool track ("De Música
  // Ligera", Soda Stereo — see harness-app.html's ALBUM_SOURCE), so picking
  // "Bocanada" (a different song entirely) is reliably a wrong guess.
  { name: "clip-mid", query: {}, hash: hashFor("/juegos/clip"), wait: ".combobox__input",
    stubRandom: true, interaction: pickSuggestion("bocanada"), settleWait: ".clip-quiz__attempt--wrong" },
  // Same stub; "musica" resolves to the stubbed answer itself, so the pick
  // is correct and the round transitions to the reveal poster.
  { name: "clip-win", query: {}, hash: hashFor("/juegos/clip"), wait: ".combobox__input",
    stubRandom: true, interaction: pickSuggestion("musica"), settleWait: ".reveal-poster" },
  // clip-game.js reacts live to onPremiumError (instead of a one-shot
  // isPremium() read at mount) and swaps the whole panels area to one flat
  // gate — ".game__gate" is the stable end state, not the combobox.
  { name: "clip-nonpremium", query: { premium: "0" }, hash: hashFor("/juegos/clip"), wait: ".game__gate" },

  { name: "album", query: {}, hash: hashFor("/juegos/album"), wait: ".guess-panel" },
  { name: "album-mid", query: {}, hash: hashFor("/juegos/album"), wait: ".guess-panel",
    interaction: wrongGuess(".guess-panel .guess__input", "un álbum incorrecto") },

  { name: "year", query: {}, hash: hashFor("/juegos/año"), wait: ".guess-panel" },
  { name: "year-mid", query: {}, hash: hashFor("/juegos/año"), wait: ".guess-panel",
    interaction: wrongGuess(".guess-panel .guess__input", "1900") },

  { name: "ronda", query: {}, hash: hashFor("/juegos/ronda"), wait: ".round__grid" },
  { name: "ronda-mid", query: {}, hash: hashFor("/juegos/ronda"), wait: ".round-sec--song .guess__input",
    interaction: wrongGuess(".round-sec--song .guess__input", "un título incorrecto") },
];

// --- capture ---------------------------------------------------------------------

function buildUrl(port, target) {
  const qs = new URLSearchParams(target.query).toString();
  return `http://127.0.0.1:${port}/harness-app.html${qs ? "?" + qs : ""}${target.hash}`;
}

async function captureOne(browser, port, target, viewport, outDir, consoleLog) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  try {
    return await captureInContext(context, target, viewport, outDir, consoleLog, port);
  } finally {
    await context.close();
  }
}

async function captureInContext(context, target, viewport, outDir, consoleLog, port) {
  const page = await context.newPage();
  const pageLabel = `${target.name}--${viewport.name}`;

  page.on("console", (msg) => {
    consoleLog.push({ page: pageLabel, kind: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    consoleLog.push({ page: pageLabel, kind: "pageerror", text: String((err && err.stack) || err) });
  });

  // Pins clip-game.js's/library.js's Math.random()-based draws to index 0,
  // so a target can interact with a known song instead of a random one.
  if (target.stubRandom) {
    await page.addInitScript(() => { Math.random = () => 0; });
  }

  const url = buildUrl(port, target);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector(target.wait, { timeout: 8000 });
  } catch {
    consoleLog.push({ page: pageLabel, kind: "harness-warn", text: `wait selector "${target.wait}" never appeared — screenshot will still be taken` });
    process.exitCode = 1;
  }

  // Real readiness for cover art: picsum.photos takes ~0.5-1s per image
  // (redirect to its CDN, then the actual JPEG), which a short fixed settle
  // caught mid-load (flat placeholder color, no photo). networkidle waits for
  // actual network quiescence rather than guessing a sleep duration, and
  // — unlike polling document.images — it also covers round-game.js's cover,
  // which loads into a plain `new Image()` that is never attached to the DOM
  // (only fed to <canvas> drawImage()): that request is still real network
  // traffic Playwright observes at the connection level, just not at the DOM
  // level. Bounded and non-fatal: a page with genuinely continuous background
  // activity would otherwise eat the whole timeout every time.
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {
    consoleLog.push({ page: pageLabel, kind: "harness-warn", text: "networkidle timed out — screenshot will still be taken" });
  });

  // Small settle buffer for synchronous paint/layout after the last network
  // response lands (e.g. round-game's drawCover() running off img.onload).
  await page.waitForTimeout(200);

  if (target.interaction) {
    try {
      await target.interaction(page);
      await page.waitForTimeout(80);
    } catch (err) {
      consoleLog.push({ page: pageLabel, kind: "harness-warn", text: `interaction failed: ${err && err.message}` });
    }
  }

  if (target.settleWait) {
    try {
      await page.waitForSelector(target.settleWait, { timeout: 2000 });
    } catch {
      consoleLog.push({ page: pageLabel, kind: "harness-warn", text: `optional settle selector "${target.settleWait}" never appeared` });
    }
  }

  // An interaction can reveal new images after the page's own initial
  // networkidle wait already passed (e.g. clip-game.js's reveal poster cover,
  // only created once a guess resolves) — wait for the network again, then
  // for that exact <img> to finish loading, so it never gets captured blank.
  if (target.interaction) {
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {
      consoleLog.push({ page: pageLabel, kind: "harness-warn", text: "post-interaction networkidle timed out" });
    });
    await page.waitForFunction(() => {
      const img = document.querySelector(".reveal-poster__cover");
      return !img || img.complete;
    }, { timeout: 4000 }).catch(() => {
      consoleLog.push({ page: pageLabel, kind: "harness-warn", text: "reveal-poster cover never finished loading" });
    });
  }

  const actualWidth = await page.evaluate(() => document.documentElement.clientWidth);
  if (Math.abs(actualWidth - viewport.width) > 5) {
    consoleLog.push({ page: pageLabel, kind: "harness-warn", text: `viewport mismatch: asked for ${viewport.width}px, clientWidth is ${actualWidth}px` });
  }

  const outPath = path.join(outDir, `${pageLabel}.png`);
  await page.screenshot({ path: outPath, fullPage: true });
  return outPath;
}

// --- console message triage ------------------------------------------------------

function categorize(text) {
  if (/^\[harness\]/.test(text)) return "stub gap (unmapped endpoint — see message for which)";
  if (/spotify-player-sdk|onSpotifyWebPlaybackSDKReady|sdk\.scdn\.co/.test(text)) return "stub gap (Web Playback SDK)";
  if (/net::ERR_|Failed to load resource/.test(text)) return "network/resource load failure (font or cover image most likely — check the URL in the message)";
  return "likely a real app issue (not from harness stub code)";
}

// --- main -----------------------------------------------------------------------

async function main() {
  fs.mkdirSync(args.out, { recursive: true });

  const targets = args.only ? TARGETS.filter((t) => t.name.includes(args.only)) : TARGETS;
  if (targets.length === 0) {
    console.error(`No targets match --only "${args.only}". Known targets: ${TARGETS.map((t) => t.name).join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const server = await startServer(REPO_ROOT);
  const port = server.address().port;
  console.log(`Static server on http://127.0.0.1:${port} (root: ${REPO_ROOT})`);

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-gpu"],
      headless: true,
    });
  } catch (err) {
    server.close();
    throw err;
  }

  const consoleLog = [];
  const saved = [];

  try {
    for (const viewport of VIEWPORTS) {
      for (const target of targets) {
        try {
          const outPath = await captureOne(browser, port, target, viewport, args.out, consoleLog);
          saved.push(outPath);
          console.log(`saved: ${outPath}`);
        } catch (err) {
          console.error(`FAILED ${target.name}--${viewport.name}: ${err && err.stack}`);
          process.exitCode = 1;
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${saved.length} screenshot(s) saved:`);
  for (const p of saved) console.log(`  ${p}`);

  const noisy = consoleLog.filter((e) => e.kind === "error" || e.kind === "pageerror" || e.kind === "warning" || e.kind === "harness-warn");
  if (noisy.length === 0) {
    console.log("\nNo console errors/warnings on any page.");
  } else {
    console.log(`\n${noisy.length} console message(s) worth a look:`);
    const byPage = new Map();
    for (const e of noisy) {
      if (!byPage.has(e.page)) byPage.set(e.page, []);
      byPage.get(e.page).push(e);
    }
    for (const [pageLabel, entries] of byPage) {
      console.log(`\n  ${pageLabel}:`);
      for (const e of entries) {
        console.log(`    [${e.kind}] ${e.text}`);
        console.log(`      -> ${categorize(e.text)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
