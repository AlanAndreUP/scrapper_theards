# Instagram -> Gemini -> Facebook Pipeline (Node.js + TypeScript)

Pipeline listo para producción (sin login a Instagram) que:

1. Vigila un perfil público de Instagram.
2. (Opcional) Usa Threads como fuente/fallback si Instagram bloquea.
3. Detecta el post más reciente (imagen/carrusel/reel).
4. Extrae caption + permalink + media URL(s).
5. Deduplica por `permalink + hash(caption)`.
6. Descarga imagen principal.
7. Sube imagen original a Cloudflare R2 (S3 compatible).
8. Usa Gemini para generar copy viral + imagen viral.
9. Sube imagen viral a R2.
10. Publica en Facebook Page con estrategia robusta de 2 pasos:
   - `POST /{page-id}/photos` con `published=false`
   - `POST /{page-id}/feed` con `attached_media`
11. Guarda estado y logs persistentes en `data/state.json` y `data/logs/app.log`.

## Disclaimer (cumplimiento)

- El scraping de Instagram puede romperse si cambian el HTML/selectores.
- Debes respetar los [TOS de Instagram](https://help.instagram.com/581066165581870) y leyes aplicables.
- Este sistema está diseñado para extraer únicamente información pública sin login.

## Requisitos

- Node.js 20+
- NPM 10+
- Acceso a:
  - Cloudflare R2
  - Gemini API
  - Meta Graph API (Page access token con permisos de publicación)

## Instalación

1. Instala dependencias:

```bash
npm install
```

2. Instala navegador para Playwright (Chromium):

```bash
npx playwright install chromium
```

3. Crea `.env` desde ejemplo:

```bash
cp .env.example .env
```

4. Completa credenciales en `.env`.

## Variables de entorno

Variables obligatorias (ver `.env.example`):

- `IG_PROFILE_URL` (ej. `https://www.instagram.com/somostitanes/`)
- `THREADS_PROFILE_URL` (opcional, ej. `https://www.threads.net/@somostitanes`)
- `ENABLE_THREADS_FALLBACK` (default `true`)
- `POLL_MINUTES`
- `DATA_DIR`
- `R2_ACCOUNT_ID`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `R2_PUBLIC_BASE_URL`
- `R2_REGION`
- `GEMINI_API_KEY`
- `GEMINI_MODEL_TEXT`
- `GEMINI_MODEL_IMAGE`
- `FB_PAGE_ID`
- `FB_PAGE_ACCESS_TOKEN`
- `FB_GRAPH_VERSION`

Opcionales:

- `MAX_RETRIES` (default `3`)
- `RETRY_BASE_DELAY_MS` (default `1000`)
- `RETRY_MAX_DELAY_MS` (default `15000`)
- `REQUEST_TIMEOUT_MS` (default `30000`)
- `PLAYWRIGHT_HEADLESS` (default `true`)
- `LOG_LEVEL` (default `info`)

## Scripts

- `npm run dev`: corre watcher en modo desarrollo.
- `npm run build`: compila a `dist/`.
- `npm run start`: corre build de producción.
- `npm run lint`: lint con ESLint.
- `npm run test`: pruebas unitarias mínimas (`retry`, `state`).

## Estructura

```text
src/
  index.ts
  config/env.ts
  scheduler/poller.ts
  scraper/instagramScraper.ts
  scraper/threadsScraper.ts
  storage/r2.ts
  ai/gemini.ts
  publisher/facebook.ts
  db/state.ts
  utils/logger.ts
  utils/retry.ts
  utils/errors.ts
  utils/hash.ts
```

## Comportamiento del pipeline

Cada ciclo (`node-cron`):

1. `getLatestPost(profileUrl)` con Playwright.
2. Si IG falla y configuraste `THREADS_PROFILE_URL`, intenta Threads como fallback.
3. Deduplicación por `permalink + sha256(caption)`.
4. Descarga media principal (reel -> thumbnail).
5. Sube original a R2:
   - `ig/somostitanes/{shortcode}/original.jpg`
   - o `threads/somostitanes/{shortcode}/original.jpg` si la fuente fue Threads
6. Gemini:
   - `generateViralCopy(captionOriginal, permalink)`
   - `generateViralImage(inputImageBuffer, captionOriginal)`
7. Sube viral a R2:
   - `ig/somostitanes/{shortcode}/viral.jpg`
   - o `threads/somostitanes/{shortcode}/viral.jpg`
8. Publica a Facebook Page (2 pasos):
   - `POST /{page-id}/photos` con `url` y `published=false`
   - `POST /{page-id}/feed` con `message` + `attached_media=[{\"media_fbid\":\"<photoId>\"}]`
9. Persistencia de estado y logs.

## Seguridad

- No hay credenciales hardcodeadas.
- Todo por `.env`.
- Logger aplica sanitización para no imprimir tokens/secretos.

## Resiliencia

- Reintentos con backoff exponencial + jitter para IG/red/Gemini/Meta/R2.
- Timeouts explícitos en HTTP y operaciones críticas.
- Si falla extracción de IG (cambio de HTML), se registra error y el siguiente ciclo vuelve a intentar.

## Gemini image generation (nota)

El cliente intenta obtener imagen binaria desde respuestas de `generateContent`. Dependiendo del modelo (`GEMINI_MODEL_IMAGE`), Google puede exigir modalidades/capacidades específicas. Si no regresa `inlineData`/`generatedImages`, se lanza error controlado con mensaje de ajuste.

## Troubleshooting

1. **`No se pudo encontrar el último post`**
   - Instagram cambió DOM/selectores o hay bloqueo temporal.
   - Revisa logs en `data/logs/app.log` y ajusta extractores de `instagramScraper.ts`.

2. **Facebook devuelve 400/403**
   - Verifica `FB_PAGE_ACCESS_TOKEN`, permisos de Page publish y `FB_PAGE_ID`.
   - Si aparece `publish_actions are not available`, ese permiso está deprecado: genera un Page token con permisos modernos de Pages (por ejemplo `pages_manage_posts`, `pages_read_engagement`, `pages_show_list`) y con app en modo Live.
   - Confirma que la URL de R2 sea públicamente accesible por Meta.

3. **Gemini no devuelve imagen**
   - Cambia `GEMINI_MODEL_IMAGE` por uno con capacidad image generation/edit.
   - Revisa mensaje TODO en logs para endpoint/modalidad exacta.

4. **Playwright falla en servidor**
   - Ejecuta `npx playwright install chromium` en el host.
   - Si tu entorno requiere libs de sistema, instala dependencias de Playwright para Linux.

## Ejecución

Desarrollo:

```bash
npm run dev
```

Producción:

```bash
npm run build
npm run start
```
# scrapper_theards
