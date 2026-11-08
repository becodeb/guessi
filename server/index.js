// Entry point: real database, real Spotify, real port.

import { createApp } from "./app.js";
import { fetchMeFromSpotify } from "./auth.js";
import { openDb } from "./db.js";

const port = Number(process.env.PORT) || 3000;
const dbPath = process.env.DB_PATH || "./data/guessi.db";

const db = openDb(dbPath);
const app = createApp({ db, fetchMe: fetchMeFromSpotify });
const server = app.listen(port, () => console.log(`stats server listening on :${port} (db: ${dbPath})`));

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
