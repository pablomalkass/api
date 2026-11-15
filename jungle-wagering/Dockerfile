FROM oven/bun:1

WORKDIR /app

# Dependencies first, so the layer is cached until package.json changes.
# (`bun.lock` is copied when present; commit it for reproducible builds.)
COPY package.json bun.lock* ./
RUN bun install --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# Bun runs TypeScript directly: there is no build step.
CMD ["bun", "src/main.ts"]
