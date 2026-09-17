# Smoke Checklist — de oído

Chequeo manual de humo después del setup (README). Servir con
`python3 -m http.server 8080` y abrir `http://127.0.0.1:8080/`.
Navegador de escritorio, cuenta Premium en la allowlist del Dev Mode.

Marcar cada ítem al verificarlo. Cualquier fallo → reportar con la consola
abierta (DevTools) y los pasos exactos.

## 1. Autenticación

- [ ] `src/config.js` tiene el Client ID real (no `REPLACE_ME`) y el login
      muestra el botón «Iniciar sesión con Spotify».
- [ ] Primer login: redirige a accounts.spotify.com con `response_type=code`,
      `code_challenge_method=S256`, `state` y los **8 scopes** exactos
      (verificar en la URL de authorize o en la consola de la app).
- [ ] Vuelve a `http://127.0.0.1:8080/` con `code` + `state`; la app cambia el
      hash a `#/library`, la URL queda limpia (sin `code`/`state`) y aparece el
      toast «Sesión iniciada».
- [ ] Estado corrupto: con `deoido.v1.auth_state` borrado de localStorage,
      recargar con un `?code=...&state=...` falso → no se intercambia nada,
      queda en login con el banner de sesión.
- [ ] `localStorage.deoido.v1.tokens` contiene access/refresh/expires_at/scopes
      y no aparece ningún token en la URL, la consola ni el DOM.
- [ ] Refresco silencioso: forzar `expires_at` al pasado en localStorage y
      disparar una importación → la llamada se refresca sola (ver red en
      DevTools: POST /api/token con grant_type=refresh_token, luego el GET).
- [ ] `invalid_grant`: reemplazar `refresh_token` por uno inválido y disparar
      una llamada → tokens borrados, banner «Vuelve a iniciar sesión» y vista
      de login. (Con un token real esto tarda ~6 meses; simularlo.)
- [ ] Cerrar sesión desde el nav → vuelve a login y borra tokens.

## 2. Importación y dedupe

- [ ] Playlists: enfocar el select «Elige una playlist…» → se cargan; elegir
      una y «Importar» → aparecen como pendientes con su portada.
- [ ] Playlist > 50 temas: importar una playlist larga y verificar que se
      pagan (`limit=50` + `offset`) y que llegan todos (comparar con la
      playlist en Spotify). No debe llamarse `/playlists/{id}/tracks`.
- [ ] «Me gusta»: importar → aparecen como pendientes.
- [ ] Búsqueda: buscar una canción y verificar resultados en pendientes.
- [ ] «Añadir» de a una y «Añadir todo» → los temas pasan a «Lo que sé» y los
      contadores «Pendientes N · Lo que sé M» se actualizan.
- [ ] Dedupe: importar la misma playlist dos veces → sin duplicados en
      pendientes; el pool tampoco duplica ids (verificar localStorage:
      `deoido.v1.library` con `tracks` y `pool` sin repetidos).
- [ ] «Quitar» un tema de «Lo que sé» → desaparece del pool y de los juegos.
- [ ] Persistencia: recargar la página → biblioteca y pool siguen cargados.
- [ ] Versionado: cambiar `version` a `2` en `deoido.v1.library` y recargar →
      la biblioteca se descarta, los tokens se conservan, y los juegos muestran
      la guía de importación.

## 3. Rate limit (429 / QUOTA_EXCEEDED)

- [ ] En Dev Mode, disparar más de la cuota de 30 s → aparece el banner
      «Spotify va lento ahora mismo. Esperando…», la petición espera el
      `Retry-After` y reintenta; el banner desaparece solo.
- [ ] La app no crashea y los botones de importar vuelven a funcionar después.

## 4. Degradación Premium

- [ ] Con cuenta Free (o `account_error` forzado desde la consola del SDK):
      banner persistente «Necesitas Spotify Premium…».
- [ ] Juegos 1 y 3 muestran el aviso y no reproducen; la **Biblioteca** y el
      **juego de portadas** siguen funcionando completo.
- [ ] Con Premium: los juegos de audio funcionan (ver sección 5).

## 5. Juegos — E2E

### Juego 1 (clip)

- [ ] Hub → «La primera décima»: se elige un tema del pool y el dispositivo
      «de oído» aparece en el selector de dispositivos de Spotify.
- [ ] «Reproducir» → suena el inicio del tema y la barra de clip se llena;
      la reproducción se corta sola (≈ targetMs + latencia del SDK aceptada).
- [ ] «+0,1 s» (2–3 veces) → la etiqueta crece (0,2 s / 0,3 s) y el clip
      reproducido es más largo.
- [ ] «Siguiente» → otro tema (sin repetir el inmediato anterior si el pool lo
      permite) y el clip vuelve a 0,1 s.
- [ ] No hay botón «Comprobar»: cada campo se autoevalúa al escribir (sin
      enviar).
- [ ] Respuesta correcta se marca sola: al instante si coincide exacto
      (normalizado), ~0,6 s tras una coincidencia tolerante a errores tipográficos;
      Enter o salir del campo comprueba de inmediato.
- [ ] Título con acento/typo («Bichote» para «Bichota») → ✓ correcto y el
      campo se bloquea.
- [ ] Texto incorrecto muestra rojo pero queda editable (no se bloquea).
- [ ] Artistas: llenar los slots en cualquier orden; un artista escrito en el
      campo que no le corresponde se reubica a su campo propio sin ser
      reemplazado por otro nombre; una respuesta equivocada marca ✗ rojo pero
      queda editable; resolver todos → «Todos los artistas correctos»; con un
      solo artista resuelto el tema NO está resuelto.
- [ ] Álbum: al resolverlo → la portada se revela (animación 300 ms).
- [ ] Todo correcto → «¡Correcto! Resuelta.»
- [ ] Salir del juego (navegar a Biblioteca) → el audio se corta y no queda
      poll activo (ver consola / que no suena nada).

### Juego 2 (portadas)

- [ ] Hub → «Portada borrosa»: portada aleatoria con blur 30 px.
- [ ] «Clic para enfocar» ×6 → el blur baja 30/24/18/12/6/0 px.
- [ ] No hay botón «Comprobar»: cada campo se autoevalúa al escribir (sin
      enviar).
- [ ] Respuesta correcta se marca sola: al instante si coincide exacto
      (normalizado), ~0,6 s tras una coincidencia tolerante a errores tipográficos;
      Enter o salir del campo comprueba de inmediato.
- [ ] Texto incorrecto muestra rojo pero queda editable (no se bloquea).
- [ ] Escribir un artista en el campo que no le corresponde lo reubica al campo
      propio de ese artista sin ser reemplazado por otro nombre.
- [ ] Álbum sin artistas acreditados: no muestra el bloque «Adivina el artista»
      y la portada + reveal funcionan igual.
- [ ] Álbum + artista(s) correctos → se desenfoca del todo y se revela la
      lista de temas.
- [ ] La lista muestra número de pista, nombre y «feat. …» solo cuando hay
      artistas invitados (track.artists − album.artists por id).
- [ ] Marcas de membresía: «en tu biblioteca» (verde) para temas del pool,
      «no está» (atenuado) para los que no.
- [ ] Álbum de un solo tema: se revela sin errores.
- [ ] Álbum > 50 temas (p. ej. una compilación): se pagan y se revelan todos.
- [ ] «Siguiente álbum» → otro álbum sin repetir el inmediato anterior si hay
      más de uno.
- [ ] Sin Premium: este juego funciona igual.

### Juego 3 (año)

- [ ] Hub → «¿De qué año?»: clip igual que el Juego 1.
- [ ] No hay botón «Comprobar»: el año se autoevalúa al escribir (sin enviar);
      se resuelve al instante al escribir el año exacto de 4 cifras, ~0,6 s tras
      una coincidencia, y Enter o salir del campo comprueba de inmediato.
- [ ] Año parcial (1–3 cifras) → no muestra ninguna pista (no se evalúa a medias).
- [ ] Al volver a escribir, la pista anterior se oculta mientras se edita.
- [ ] Año incorrecto (4 cifras) → «Más nuevo» / «Más viejo» + «Muy cerca» /
      «Cerca» / «Lejos» según la distancia.
- [ ] Año correcto (4 cifras) → «¡Correcto!» y se muestra el tema con su portada.
- [ ] «Siguiente» → otro tema y el clip resetea a 0,1 s.

## 6. Casos borde

- [ ] Pool vacío: entrar a cualquiera de los tres juegos → guía de importación
      con enlace a Biblioteca; ningún juego arranca una ronda.
- [ ] Portada rota/vencida: forzar una URL vieja en `deoido.v1.library`
      (albums[].images[].url) y entrar al juego → se re-fetchea el álbum y se
      actualiza (ver red en DevTools: GET /albums/{id}).
- [ ] Repetidos en «Siguiente»: con 2+ temas en el pool, no se repite el tema
      inmediato anterior en juegos 1 y 3, ni el álbum anterior en el juego 2.
- [ ] Limpieza: terminar una partida y salir → sin audio residual, sin
      intervalos colgados (revisar en la pestaña Performance/Consola).
- [ ] Reducir movimiento (SO: *reduce motion*) → las animaciones colapsan a
      instantáneo y los juegos siguen funcionando.
- [ ] Teclado: Tab + Enter para jugar todo el flujo (focus visible en accent).

## 7. Ronda completa (una pantalla, todos los desafíos a la vez)

- [ ] Hub → «Ronda completa» (tarjeta principal, arriba) → se sortea una canción
      y se muestra **una sola pantalla** con los cuatro desafíos vivos a la vez
      (sin etapas, sin «Siguiente», sin orden forzado). Cabecera: «Ronda» + chip
      de progreso «N/M resueltos» + botón «Ver respuestas».
- [ ] Hay **exactamente una imagen de álbum** en toda la vista: el bloque de
      portada compartido (canvas). No hay una segunda portada en el año ni en
      ningún lado.
- [ ] Portada compartida con tres modos conmutables: **Difusa** (desenfoque,
      arranca ~150px: casi un color plano), **Pixeles** (pixelado real por
      canvas, bloques de ~64px al inicio) y **Color** (borrón de ~190px +
      saturación). Cambiar de modo **mantiene el paso de revelado** actual.
- [ ] Clic en la portada (o Enter/Espacio con foco) avanza un paso de revelado;
      6 pasos hasta revelar del todo. Hay pista opcional «Clics restantes».
- [ ] «Otra canción»: la portada nueva aparece **ya tapada de una**, sin fundido
      de entrada que deje ver la foto nítida (el primer pintado va sin
      transición; recién después se animan los clics).
- [ ] Pixeles es pixelado **real** (canvas pequeño escalado con
      `image-rendering: pixelated`), no solo desenfoque; Difusa/Color usan
      filtro CSS. No se llama `getImageData` (la portada es cross-origin).
- [ ] Resolver el reto del **álbum** (álbum + artistas) revela la portada de
      golpe (salta al paso final) y muestra la lista de temas dentro de su
      tarjeta.
- [ ] **Álbum: tracklist** (juego de adivinar la tracklist dentro de la tarjeta
      del álbum, siempre visible):
  - [ ] Al entrar carga la tracklist con skeletons; si falla la red muestra el
        banner de error con «Reintentar» (reintenta la carga).
  - [ ] Cada canción del álbum tiene su fila en orden de disco (número + input de
        canción); adivinar la canción la bloquea (verde) y conserva el nombre real.
  - [ ] El orden importa: la fila N se evalúa contra la canción N; una canción
        puesta en la fila equivocada no cuenta.
  - [ ] Cada fila muestra los artistas acreditados como inputs; los artistas del
        álbum aparecen como chip automático (sin input) **solo si ya resolviste
        los slots del artista del álbum**; si no, siguen como inputs para adivinar.
  - [ ] Input «sin orden» arriba de la grilla: escribir cualquier tema del álbum
        (sin importar el orden) lo llena y bloquea en su fila correcta y limpia el
        input; si no coincide con ninguna fila sin resolver no hace nada (sin error).
  - [ ] El chip de la cabecera de la tarjeta marca «Temas: N/M» (M = temas, N =
        filas con canción bloqueada); al completar canción + artistas de todas las
        filas pasa a «Tracklist completa» (verde).
  - [ ] **Sin spoilers**: el nombre de ninguna canción ni artista aparece en el
        DOM antes de adivinarse o revelarse («Ver respuestas»).
  - [ ] «Ver respuestas» (footer) rellena todas las canciones con su nombre real
        (bloqueadas) y todos los artistas con los acreditados (bloqueados),
        re-renderiza la grilla y actualiza el chip.
- [ ] Barra de audio única (Reproducir + «+0,1 s») alimenta a la vez los retos de
      **canción** y **año**; no hay dos reproductores. Sin Premium: la barra se
      reemplaza por «El audio necesita Spotify Premium».
- [ ] Tarjetas independientes, cada una con su chip de estado (Adivinado /
      Con pistas / Revelado / Requiere Premium): «La canción» (solo título,
      Premium), «El álbum y los artistas» (álbum + artistas, sin Premium),
      «¿De qué año?» (Premium, con pistas más nuevo/viejo + cercanía) y
      «La letra».
- [ ] Sin Premium: las tarjetas de canción y año muestran «Requiere Spotify
      Premium» en lugar de inputs y no cuentan en el denominador del progreso
      (queda «N/2 resueltos»); álbum y letra siguen jugables.
- [ ] Footer: «Otra canción» sortea de nuevo (reset completo: timers, abort,
      audio), «Ver respuestas» revela todo en el lugar (portada al final, todas
      las respuestas, letra completa) y el link fantasma «Volver a Juegos».
- [ ] Letra — regla de palabra repetida: escribir la primera aparición de una
      palabra del coro la revela; luego, con el cursor sobre otra aparición,
      **Espacio con el input vacío** la revela (la palabra ya está en el conjunto
      descubierto). Con una palabra no descubierta, Espacio vacío no hace nada.
- [ ] Letra — **Enter** busca esa palabra en toda la letra y revela la
      *ocurrencia* correcta (no siempre la primera); si ya está toda revelada
      avisa «Esa palabra ya está descubierta», si no aparece «No encontré esa
      palabra acá».
- [ ] Letra — clic en una palabra oculta mueve el cursor ahí (el cursor es una
      pastilla verde; si la palabra del cursor ya se descubrió antes, se marca
      distinto para avisar que Espacio vacío funciona).
- [ ] Letra — «Pista» revela una letra más de la palabra del cursor (progresivo,
      acumulativo) y muestra «Pistas: N»; al completar la palabra cuenta como
      revelada y avanza el cursor.
- [ ] Letra — «Revelar todo» resuelve la etapa como revelada.
- [ ] Letra — camino no encontrada / manual: si LRCLIB no tiene la letra, hay un
      estado vacío con un textarea «Guardar letra»; pegarla y guardarla reinicia
      la etapa con esa letra (y queda en `deoido.v1.manualLyrics`).
- [ ] Letra — instrumental: avisa «Es instrumental» y la etapa se autoresuelve.
- [ ] Letra — error de red: mensaje + botón «Reintentar» (no es un callejón sin
      salida).
- [ ] Salir de la ronda (navegar a Biblioteca) → el audio se corta y no queda
      ningún fetch de letra colgado.

### Ancho de pantalla

- [ ] A ~1000px: el contenedor de la ronda ocupa más ancho que antes (no un
      columna fija de 980px con márgenes muertos grandes); la portada ya está
      en un costado (≥900px) y es claramente más grande que en móvil.
- [ ] A ~1440px: la portada grande queda en un costado, las tres tarjetas de
      desafío (canción / álbum / año) se acomodan en 2–3 columnas y la letra
      queda debajo en la columna derecha.
- [ ] A ~1800px: el contenedor llega cerca de 1720px, la columna de portada
      crece (hasta ~560px) y las tarjetas de desafío llegan a 3 columnas.
- [ ] Con una ventana alta (≥760px) en pantalla ancha (≥1100px): la portada +
      barra de audio quedan fijas (sticky) mientras se hace scroll en la letra.
- [ ] Móvil (<900px): todo sigue apilado en una sola columna (portada, audio,
      tarjetas, letra), sin dos columnas.