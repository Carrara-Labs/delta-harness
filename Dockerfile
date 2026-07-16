# Delta — single compiled binary in a slim runtime. The Bun `--compile` output
# bundles the runtime, so the final stage carries only the binary + CA certs.
# Build: docker build -t delta . · Run: docker run -p 8080:8080 --env-file .env delta

FROM oven/bun:1.3.13 AS build
WORKDIR /app
# Deps first (cache-friendly) — exact pins, committed lockfile.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json biome.json ./
COPY src ./src
COPY assets ./assets
# One self-contained binary for the container's own (linux) arch.
RUN bun build --compile --minify src/index.ts --outfile delta

FROM litestream/litestream:0.3.13 AS litestream

FROM debian:12-slim
# TLS roots for the provider/MCP/Exa HTTPS calls + unzip for docx/xlsx text
# extraction (read_file → extractDocText — dead without it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates unzip \
  && rm -rf /var/lib/apt/lists/*
# Optional: layer a coding CLI here (e.g. `codex`) to enable the `code` tool.
# Without it, code() returns a clean tool-error (error-as-value) — the daemon runs.
WORKDIR /app
COPY --from=build /app/delta /usr/local/bin/delta
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
# Exact build provenance for the fleet: pass --build-arg DELTA_BUILD=$(git rev-parse HEAD)
# at build; the daemon reports it on /healthz alongside the SemVer version. Optional.
ARG DELTA_BUILD=""
ENV PORT=8080 \
    DELTA_BUILD=$DELTA_BUILD \
    DELTA_DB=/data/delta.db \
    DELTA_WORKSPACE=/data/workspace
VOLUME /data
EXPOSE 8080
# SQLite WAL state lives on the mounted volume; the daemon resumes in-flight runs
# from it on boot. Cold start <50ms, RSS ~30MB.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
