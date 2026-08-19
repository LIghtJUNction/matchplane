FROM oven/bun:latest

WORKDIR /app

# The package-local Agent is deliberately built outside the root Next.js process. It receives
# only its own source and operator environment; it never gets the root database, payment keys,
# browser secrets or Docker socket.
COPY subplatforms/auto/package.json ./package.json
RUN bun install --no-save --ignore-scripts
COPY subplatforms/auto/agent ./agent
COPY subplatforms/auto/tsconfig.json ./tsconfig.json
RUN bun run agent:check

ENV MATCHPLANE_AUTO_MCP_HOST=0.0.0.0
ENV MATCHPLANE_AUTO_MCP_PORT=8787
ENV MATCHPLANE_AUTO_DATA_DIR=/var/lib/matchplane-auto

RUN mkdir -p /var/lib/matchplane-auto && chown -R bun:bun /app /var/lib/matchplane-auto
USER bun

EXPOSE 8787
CMD ["bun", "run", "agent:serve"]
