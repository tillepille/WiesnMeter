# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source and compile TypeScript
COPY src/ ./src/
RUN npm run build

# Production runner stage
FROM node:20-alpine AS runner

WORKDIR /app

# Production environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=http://localhost:3000
ENV OTEL_SERVICE_NAME=wiesnmeter
ENV OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-eu-west-0.grafana.net/otlp
ENV OTEL_METRICS_EXPORTER=otlp
ENV OTEL_METRIC_EXPORT_INTERVAL=5000

# Install production dependencies only
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built application and static assets
COPY --from=builder /app/dist ./dist
COPY public/ ./public/

# Use non-root node user
USER node

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "dist/server.js"]
