# Delta Connect + a Delta agent, one always-on Fly machine.
#
# Two shapes, both staged by deploy.sh (see it for which and why):
#   default        - `package.json` pins the PUBLISHED packages; bun installs them here.
#   --from-source  - the worktree is staged instead, and the install is a no-op (zero deps).
# The entrypoint detects which one it got, so this file needs no conditionals.
FROM oven/bun:1.3

WORKDIR /app

# Separate layer: the install is cached until a pinned version actually changes.
COPY package.json ./
RUN bun install --production

# The rest of the staged context: bundle seed, entrypoint, and on a --from-source
# deploy the engine and connector sources too.
COPY . .
RUN chmod +x ./entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
