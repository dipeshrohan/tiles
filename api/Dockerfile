# Tiles API image. Built by docker-compose.yml; also usable on its own:
#   docker build -t tiles-api api/
FROM python:3.13-slim

# uv from PyPI (pinned) rather than a container registry, so the build only
# needs PyPI and Docker Hub.
# The base image's security updates, and a current pip (T5.08: the image scan fails on known
# vulnerabilities that have a fix).
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir --upgrade pip uv==0.11.32

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project

COPY src ./src
RUN uv sync --locked --no-dev

RUN useradd --system --uid 10001 tiles
USER tiles

ENV PATH="/app/.venv/bin:$PATH" \
    TILES_HOST=0.0.0.0 \
    TILES_PORT=8000

EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"

CMD ["tiles-api"]
