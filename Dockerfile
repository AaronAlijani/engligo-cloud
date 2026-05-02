# EngliGo Dockerfile - multi-stage build
# Stage 1 (builder): compile native modules with build tools
# Stage 2 (runtime): minimal image with only runtime deps

# --- Stage 1: builder ---
FROM node:20-alpine AS builder
WORKDIR /app

# Build deps for native modules (bcrypt, sqlite3 compile here)
RUN apk add --no-cache python3 make g++ sqlite

# Copy package files first to leverage layer caching
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# --- Stage 2: runtime ---
FROM node:20-alpine
WORKDIR /app

# Runtime-only dependencies
RUN apk add --no-cache sqlite-libs wget

# Create non-root user for security
RUN addgroup -S app && adduser -S app -G app

# Copy compiled node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY --chown=app:app index.js database_init.js package.json ./
COPY --chown=app:app public_html ./public_html
COPY --chown=app:app views ./views

# Create the data directory where the PVC will mount
RUN mkdir -p /data && chown -R app:app /data

# Switch to non-root user for runtime
USER app

# Default environment - can be overridden by Kubernetes
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/engligo.db

EXPOSE 3000

# Docker-level healthcheck (Kubernetes uses its own probes via deployment.yaml)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# Run DB init then start the server
CMD ["sh", "-c", "node database_init.js && node index.js"]