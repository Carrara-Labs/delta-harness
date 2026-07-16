# Delta website — React Router rebuild

This directory is the isolated replacement for the currently deployed static site in `../website`.
It is intentionally self-contained so it can be built, container-tested, and reviewed without changing
the live Railway service.

## Stack

- React Router 8 framework mode with server-side rendering
- React 19
- Tailwind CSS 4 through the first-party Vite plugin
- shadcn/ui source-owned components
- TypeScript
- Bun for installs and builds; Node 24 for the production server

The landing page is split into semantic section components. The large Cockpit demo is kept as an
isolated parity island: React owns its lifecycle and interactions, while its approved markup stays
byte-for-byte compatible with the current site. The documentation remains pre-generated static HTML
from the canonical Markdown guide, which avoids shipping a large hydration payload to every docs reader.

## Local development

```sh
bun install
bun run dev
```

Production-mode verification:

```sh
bun run check
PORT=8080 HOST=0.0.0.0 bun run start
```

`bun run check` verifies the copied documentation, runs Biome, generates React Router route types,
checks TypeScript, and creates the production build.

## Container verification

The final image uses Node 24, runs as the unprivileged `node` user, and probes `/healthz` on `$PORT`:

```sh
docker build -t delta-website-react-router .
docker run --rm -d --name delta-website-react-router -p 18080:8080 delta-website-react-router
curl --fail http://127.0.0.1:18080/healthz
docker stop delta-website-react-router
```

## Documentation source

`public/guide.md` is the canonical guide. The crawlable `public/docs/index.html` and
`public/llms-full.txt` are rendered from it (with canonical, Open Graph, and Twitter metadata).
Edit the guide, then keep the rendered copies in step.

## Public route contract

- `/` — server-rendered React landing page
- `/index.html` — permanent compatibility redirect to `/`
- `/docs/` and `/docs/index.html` — generated technical documentation
- `/guide.md` — canonical raw guide
- `/robots.txt`, `/sitemap.xml`, `/site.webmanifest` — discovery metadata
- `/healthz` — no-cache service health response

## Deploy

The site ships as a container (`Dockerfile` in this directory) and is served at
[deltaharness.dev](https://deltaharness.dev). Any container host works — `railway.json`
pins the Dockerfile builder and a `/healthz` deployment gate for reproducible builds.

Do not deploy until visual, responsive, accessibility, and container checks are green. The
container binds `0.0.0.0:$PORT` (default 8080). Prefer your host's deployment-history rollback
for an exact restore.
