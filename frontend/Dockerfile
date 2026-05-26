# Portable LLM Wiki — frontend image
#
# Multi-stage Next.js production build. The runner stage runs `next start`
# under Node 20-alpine for a small footprint (~150MB). `NEXT_PUBLIC_BACKEND_URL`
# must be set at build time, NOT runtime, because Next.js inlines NEXT_PUBLIC_*
# values into the client bundle. For docker compose use, the default points
# at the `backend` service over the compose-internal network.

# --- deps stage ----------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
# Copy only the lockfile + package.json first for layer cache reuse.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- build stage ---------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ ./
# Inlined into the client bundle. Override with --build-arg if you're
# building for a non-compose deployment.
ARG NEXT_PUBLIC_BACKEND_URL=http://backend:8000
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
RUN npm run build

# --- runner stage --------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Non-root user — Next.js's standalone output doesn't need root.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O - http://localhost:3000/ > /dev/null || exit 1
CMD ["npm", "start"]
