# Vektor headless worker — build from the repo root:  docker build -f worker/Dockerfile -t vektor-worker .
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY worker ./worker
COPY tsconfig.json ./
ENV VEKTOR_PORT=8787 VEKTOR_STATE=/data/state.json VEKTOR_GRIDS=/app/worker/grids.json
VOLUME ["/data"]
EXPOSE 8787
CMD ["npx", "tsx", "worker/index.ts"]
