FROM oven/bun:1.2-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile
COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY demo.ts tsconfig.json ./
ENV PORT=3004
EXPOSE 3004
CMD ["bun", "run", "src/server.ts"]
