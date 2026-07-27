# Delta Connect + a Delta agent, one always-on Fly machine.
# Built from a minimal staged context (see deploy.sh) so node_modules/.git/site
# never reach the builder. The engine is zero-dep; both processes run via Bun.
FROM oven/bun:1.3

WORKDIR /app

# The engine (zero runtime deps) and the connector, both run from source.
COPY package.json tsconfig.json ./
COPY src ./src
COPY assets ./assets
COPY connect ./connect

# Bundle seed (persona/policy/vocab - NO secrets; keys arrive as Fly secrets).
COPY bundle-seed ./bundle-seed
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
