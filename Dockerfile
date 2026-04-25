# Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Production server
FROM node:20-alpine
WORKDIR /app

# Install server dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server code
COPY server/ ./server/
COPY curriculum/ ./curriculum/

# Copy built frontend from build stage
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Copy landing page (served at impulsdeutsch.com root domain)
COPY landing/ ./landing/

# Copy invite page (served at buddy.impulsdeutsch.com/invite)
COPY invite/ ./invite/

# Copy teacher dashboard (served at buddy.impulsdeutsch.com/dashboard)
COPY dashboard/ ./dashboard/

# Copy service account (will be overridden by env var in Cloud Run)
# COPY service-account.json ./service-account.json

# Cloud Run sets PORT automatically
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server/server.js"]
