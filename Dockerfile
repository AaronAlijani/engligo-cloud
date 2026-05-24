# EngliGo Dockerfile — Stage 3 (PostgreSQL sidecar)
# Removed sqlite3 (native module requiring build tools).
# pg (node-postgres) is pure JavaScript — no C compiler needed.
# Result: simpler single-stage build, smaller image.

FROM node:20-alpine
WORKDIR /app

# wget for Docker HEALTHCHECK only
RUN apk add --no-cache wget

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

# Install dependencies (pg is pure JS — no native compile step needed)
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy application source
COPY --chown=app:app index.js database_init.js package.json ./
COPY --chown=app:app public_html ./public_html
COPY --chown=app:app views ./views

USER app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "index.js"]