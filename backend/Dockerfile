# Portable LLM Wiki — backend image
#
# Builds a minimal Python 3.12-slim image that runs the FastAPI app under
# uvicorn. WIKI_ROOT defaults to /app/wiki — for a hosted demo, copy the
# repo's wiki-demo/ over /app/wiki at build time. For real deployment with
# write persistence, mount a volume at /app/wiki and clone your wiki into it.

FROM python:3.12-slim

# System deps: git is needed if you want the container to clone your wiki
# from a remote on first boot (see entrypoint). curl is for healthchecks.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first (cache-friendly)
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /app/backend/requirements.txt

# Copy the backend app + demo wiki as the default content
COPY backend /app/backend
COPY wiki-demo /app/wiki

# Keep an untouched copy of the demo content (wiki-demo/) and the
# seeding script at their original repo-relative paths. The Avery
# multi-tenant seeder (app/avery_seed.py + scripts/seed_avery_tenant.py)
# looks for /app/wiki-demo/wiki/ and is invoked by render.yaml's
# dockerCommand when SINGLE_TENANT_MODE=0. Single-tenant deploys ignore
# both — /app/wiki remains the live wiki root as before.
COPY wiki-demo /app/wiki-demo
COPY scripts /app/scripts

# Default env (override at deploy time)
ENV WIKI_ROOT=/app/wiki \
    DEFAULT_TIER=public \
    PUBLIC_BASE_URL=http://localhost:8000 \
    CORS_ORIGINS=http://localhost:3000 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS http://localhost:8000/healthz || exit 1

CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
