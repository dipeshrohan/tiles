# Tiles edge agent image, with the OPC UA and MQTT connectors:
#   docker build -t tiles-edge edge/
#   docker run -v /etc/tiles-edge:/etc/tiles-edge:ro -v tiles-edge-buffer:/var/lib/tiles-edge tiles-edge
# It runs as UID 10001: give that user the token file (chown 10001), or pass
# the token in TILES_EDGE_TOKEN instead. See README.md.
FROM python:3.13-slim

# uv from PyPI (pinned), as in the API image, so the build only needs PyPI and Docker Hub.
RUN pip install --no-cache-dir uv==0.11.32

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first (only the connector extras), so code changes don't reinstall them.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --extra opcua --extra mqtt --no-install-project

COPY src ./src
RUN uv sync --locked --no-dev --extra opcua --extra mqtt

RUN useradd --system --uid 10001 tiles-edge \
    && install -d -o tiles-edge -m 700 /var/lib/tiles-edge
# The disk buffer (readings waiting for Tiles) lives here; keep it on a volume so it survives upgrades.
VOLUME /var/lib/tiles-edge
USER tiles-edge

ENV PATH="/app/.venv/bin:$PATH"

ENTRYPOINT ["tiles-edge"]
CMD ["run", "-c", "/etc/tiles-edge/tiles-edge.toml"]
