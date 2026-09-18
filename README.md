# de oído

Juegos de reconocimiento musical contra tu propia biblioteca de Spotify.
Vanilla HTML/CSS/JS (ES modules), cero dependencias, sin build. Se sirve con un
servidor estático local y se juega en el navegador.

Un modo principal y tres de práctica suelta:

- **Ronda completa** (modo principal) — se sortea *una* canción al azar y los
  **cuatro desafíos viven en la misma pantalla a la vez**, en cualquier orden
  (sin etapas ni ronda secuencial). Arriba hay **una sola portada del álbum**
  compartida, oculta con tres modos conmutables — **Difusa** (desenfoque
  fuerte, arranca ~72px), **Pixeles** (pixelado real por canvas, bloques
  grandes) y **Color** (borrón enorme + saturación, casi un color plano) — y se
  revela a clics, manteniendo el progreso al cambiar de modo. Debajo, una sola
  **barra de audio** (Reproducir/Detener + un botón que suma el doble en cada
  toque: 0,1 → 0,2 → 0,4 → … → 3,2 s, con «Reiniciar») alimenta a la vez los
  desafíos de **canción** y **año**. Cuatro tarjetas independientes:
  **La canción** (título y artistas por separado), **El álbum y los artistas**
  (adivinás el álbum y sus artistas, y además cada canción del álbum con su
  artista en una grilla siempre visible; los nombres repetidos se completan
  solos —si un tema se llama igual que el álbum, resolver uno resuelve el otro,
  y los títulos duplicados llenan todas sus filas—; un artista que resolviste
  se completa solo en todas las filas del álbum y cada fila tiene (con Premium)
  botones «Inicio»/«Final» con su propio «+0,1 s» acumulable (0,1 → 0,2 →
  0,4…, como la barra de clip) para oír el principio o el final del tema; al
  resolver revela la portada),
  **¿De qué año?** (pistas de más nuevo/viejo, sin spoilers de artista o álbum)
  y **La letra** (palabra por palabra). Cada tarjeta tiene su chip de estado y
  las resueltas se marcan con un borde verde. El álbum y la letra funcionan
  **sin Premium**; la canción, el año y el audio se degradan solos (marcados
  «Requiere Premium») cuando no tenés Premium. La barra «Ver respuestas» lo
  revela todo en el lugar; «Otra canción» sortea de nuevo.
- **Práctica suelta** (los tres juegos originales, por separado):
  - **La primera décima** — instante de sonido (0,1 s, acumulable) y adivinás
    título, artistas y álbum. Requiere **Spotify Premium** (Web Playback SDK).
  - **Portada borrosa** — portada desenfocada, un clic por paso; al resolver se
    revela la lista de temas. Funciona **sin Premium**.
  - **¿De qué año?** — el mismo clip y adivinás el año con pistas de más
    nuevo/más viejo y cercanía. Requiere Premium.

## Requisitos

- Una cuenta de Spotify con **Premium** para los juegos de audio (1 y 3).
- Navegador de escritorio (Chrome recomendado; el SDK de reproducción no se
  activa automáticamente en iOS después de transferir el dispositivo).
- Python 3 (para el servidor local).

## Setup paso a paso

1. **Crear la app en el Spotify Dashboard**:
   https://developer.spotify.com/dashboard → *Create app*.
   - En *API settings* marcá **Web API** y **Web Playback SDK**.
   - **Redirect URIs**: agregá exactamente cada origen desde el que servís la
     app, con barra final incluida: `http://127.0.0.1:8080/` para desarrollo
     (`localhost` no se acepta) y `https://guessi.becode.com.ar/` para
     producción.
2. **Client ID**: ya está cargado en `src/config.js`. Si usás otra app de
   Spotify, reemplazalo por el tuyo (p. ej. `CLIENT_ID = "a1b2c3..."`).
3. **Servir el proyecto** desde la raíz del repo:

   ```bash
   python3 -m http.server 8080
   ```

4. Abrí **http://127.0.0.1:8080/** e iniciá sesión con Spotify.
5. En **Biblioteca**, buscá canciones, artistas, álbumes o playlists (incluidas
   tus playlists privadas, que aparecen al abrir la vista), o pegá un enlace de
   Spotify. «Importar» abre una ventana con la lista completa, ya tildada:
   destildá lo que no quieras, confirmá y esas canciones entran derecho a
   **«Lo que sé»**, que es lo que suena en los juegos. Importar un **artista**
   barre toda su discografía (un pedido por disco) y deja una sola copia de
   cada tema, aunque salga en el álbum y en el single.

6. Los dos atajos debajo del buscador traen **«Me gusta»** (tus canciones
   guardadas) y **«Tus más escuchadas»** (`/me/top/tracks`, con el periodo a
   elección). Ese segundo es el reemplazo de la «Top canciones 20XX» que arma
   Spotify.

> **Lo que Spotify no deja importar.** Desde febrero de 2026, una playlist que
> no sea tuya devuelve solo nombre y portada — y «no tuya» incluye las que
> Spotify arma *para vos*: «This Is…», Descubrimiento semanal, «Top canciones
> 20XX», radios. Ninguna se puede traer. La app lo dice en lugar de fallar, y
> ofrece las dos salidas: copiá esas canciones a una playlist tuya en Spotify
> e importá esa, o usá «Tus más escuchadas», que sale del mismo cálculo de
> Spotify por un endpoint que sí está abierto. Tampoco existe ya
> `/artists/{id}/top-tracks`, por eso el artista se importa disco por disco.

## Deploy en Coolify

El repo trae `Dockerfile` (Nginx sirviendo el sitio estático en el puerto 80) y
`docker-compose.yml`. El compose **no publica puertos**: el proxy de Coolify
enruta el dominio al puerto interno 80. La app no tiene build ni variables de
entorno — el Client ID es público (PKCE) y el redirect se calcula con
`window.location.origin`.

1. En Coolify: **+ New → Public Repository** → `https://github.com/becodeb/guessi`.
2. Build Pack: **Docker Compose** (dejá el `docker-compose.yml` de la raíz).
3. En el servicio `web`, cargá el dominio `https://guessi.becode.com.ar`
   (sin sufijo de puerto: el interno es 80) y activá HTTPS.
4. **Deploy**.
5. En el Spotify Dashboard agregá `https://guessi.becode.com.ar/` como
   Redirect URI (ver *Setup paso a paso*).

Para probar la imagen localmente:

```bash
docker build -t guessi .
docker run --rm -p 8080:80 guessi
```

## Notas de plataforma

- **Premium**: los juegos de audio usan el Spotify Web Playback SDK
  (`sdk.scdn.co/spotify-player.js`, inyectado bajo demanda). Sin Premium se
  muestra un aviso y la biblioteca + el juego de portadas siguen disponibles.
- **Modo Dev de Spotify**: las apps en Dev Mode funcionan solo para hasta
  5 usuarios en la allowlist (el dueño de la app) y tienen cuota de 30 s
  (respuestas `429` / `QUOTA_EXCEEDED`). La app frena, espera el `Retry-After`
  y avisa «Spotify va lento ahora mismo». Para uso compartido hay que enviar
  la app a *Extended Quota Mode* desde el Dashboard.
- **iOS**: el SDK de reproducción no arranca la reproducción automáticamente
  después de una transferencia de dispositivo; si no escuchás nada, tocá
  Reproducir de nuevo.
- **Sesión**: el token de refresco expira a los ~6 meses; en ese caso la app
  pide volver a iniciar sesión.

## Estructura

```
index.html            Shell: fuentes, sprite SVG, #app (SDK se inyecta lazy)
styles.css            Tokens y componentes (tema oscuro único)
Dockerfile            Imagen Nginx con el sitio estático (puerto 80)
nginx.conf            Server block: SPA fallback, gzip, no-cache
docker-compose.yml    Servicio `web` para Coolify (sin ports, expose 80)
src/config.js         Client ID, redirect, scopes, endpoints
src/main.js           Router por hash, estado, navegación, banners
src/auth.js           PKCE + refresco silencioso
src/spotify-api.js    Wrapper fetch (401→refresh, 429→backoff) + endpoints
src/player.js         Motor Web Playback SDK (clip 0,1 s, prime, volumen)
src/library.js        Importación, «Lo que sé», dedupe, cache de tracklists
src/storage.js        localStorage versionado (deoido.v1.*)
src/match.js          Normalización + alias + Levenshtein (puro)
src/clip-steps.js     Escalera pura del clip (0,1 s que duplica por toque)
src/spotify-link.js   Parser puro de enlaces/URIs de Spotify (biblioteca)
src/ui.js             Helpers DOM (el, toast, skeleton, iconos)
src/lyrics-engine.js  Motor puro de la letra (tokenizer + máquina de estados)
src/lyrics.js         Fuente de letras (LRCLIB) + cache local + pegado manual
src/games/round-game.js  Ronda completa (los cuatro desafíos en uno)
src/games/*.js        Los tres juegos de práctica suelta
tests/match.test.mjs  Harness sin framework: node tests/match.test.mjs
tests/lyrics.test.mjs Harness sin framework de la letra: node tests/lyrics.test.mjs
tests/spotify-link.test.mjs  Harness sin framework del parser de enlaces
tests/clip-steps.test.mjs    Harness sin framework de la escalera del clip
tests/storage.test.mjs       Harness sin framework del esquema de biblioteca
docs/smoke-checklist.md  Chequeo manual de humo
```

## Tests

```bash
npm test
```

Corre los cinco harness sin framework: `tests/match.test.mjs` (matching),
`tests/lyrics.test.mjs` (motor de la letra), `tests/spotify-link.test.mjs`
(parser de enlaces de Spotify), `tests/clip-steps.test.mjs` (escalera del
clip) y `tests/storage.test.mjs` (esquema de la biblioteca: ida y vuelta,
compactación, cuota y migración v1→v2). Exit 0 = ok.

## Biblioteca guardada

«Lo que sé» vive en `deoido.v1.library` (esquema `version: 2`): cada álbum se
guarda una sola vez (`albums`) y los temas lo referencian por `albumId`, así
una biblioteca grande de miles de temas entra en el localStorage del
navegador. Si el
navegador se queda sin espacio, la app reintenta sin las listas de temas
(re-fetchables) y, si aun así no entra, avisa con un banner persistente.
El botón «Vaciar», junto a «Lo que sé» en la Biblioteca, vacía el pool entero
(primer clic arma, segundo confirma).

## Letras (LRCLIB)

La letra del desafío de la ronda se busca en **LRCLIB** (`lrclib.net`), un
servicio público, sin clave y con CORS habilitado (verificado 2026-09-17). Se
cachea en localStorage (`deoido.v1.lyrics`): 30 días para aciertos, 7 días para
«no encontrada»/«instrumental». Los errores de red no se cachean. Si LRCLIB no
tiene la letra, podés **pegarla manualmente** (`deoido.v1.manualLyrics`): esa
copia gana sobre la red y no expira.

## Verificación manual

Seguí `docs/smoke-checklist.md` después del setup.