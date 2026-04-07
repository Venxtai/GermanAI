# This Dockerfile expects build context = analyzer/ directory
# Curriculum data is copied separately via cloudbuild.yaml or
# symlinked before build.

# Stage 1: Build frontend
FROM node:20-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Production server
FROM node:20-alpine
WORKDIR /app

# Copy server dependencies
COPY package*.json ./
RUN npm ci --production

# Copy server code
COPY server/ ./server/

# Copy curriculum data (must be present in analyzer/curriculum/ at build time)
COPY curriculum/ ./curriculum/

# Copy built frontend
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Cloud Run sets PORT automatically (default 8080)
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/server.js"]
