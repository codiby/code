FROM oven/bun:1.3 AS builder

WORKDIR /app

# Install dependencies (production + dev; bun-plugin-tailwind is a devDep).
# The workspace package.json files must be present for a frozen-lockfile install.
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/ui/package.json packages/ui/
COPY packages/desktop/package.json packages/desktop/
COPY packages/mobile/package.json packages/mobile/
RUN bun install --frozen-lockfile

# Copy server + frontend sources
COPY packages/core/ packages/core/
COPY packages/ui/ packages/ui/
COPY scripts/ scripts/
COPY tsconfig.json ./

# Build the frontend (emits /app/dist/{index.html,m/index.html,assets/*,...})
RUN bun run scripts/build.ts

# Bundle the server into a single file
RUN bun build ./packages/core/index.ts --outfile /app/server.js --target bun --minify

# ---- Runtime stage ----
FROM oven/bun:1.3-slim

# Install dependencies and Claude CLI
RUN apt-get update && apt-get install -y curl git bash && \
    apt-get clean && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://claude.ai/install.sh | bash

WORKDIR /app

COPY --from=builder /app/server.js /app/server.js
COPY --from=builder /app/dist      /app/dist

ENV CLAUDE_UI_PORT=3111
ENV CLAUDE_CWD=/workspace
ENV PATH="/root/.local/bin:${PATH}"

EXPOSE 3111

# Create default workspace and .claude dirs
RUN mkdir -p /workspace /root/.claude

VOLUME ["/root/.claude", "/workspace"]

CMD ["bun", "run", "/app/server.js"]
