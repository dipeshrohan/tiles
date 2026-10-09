# Tiles edge agent image, with the OPC UA, MQTT and SQL connectors:
#   docker build -t tiles-edge edge/
#   docker run -v /etc/tiles-edge:/etc/tiles-edge:ro -v tiles-edge-buffer:/var/lib/tiles-edge tiles-edge
# It runs as UID 10001: give that user the token file (chown 10001), or pass
# the token in TILES_EDGE_TOKEN instead. See README.md.
FROM python:3.13-slim

# The base image's security updates (T5.08: the image scan fails on known vulnerabilities that have
# a fix), and what the SQL Server driver's bundled ODBC driver loads at run time.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends libltdl7 libkrb5-3 libgssapi-krb5-2 \
    && rm -rf /var/lib/apt/lists/*

# uv from PyPI (pinned), as in the API image; then pip goes, unused at run time.
RUN pip install --no-cache-dir uv==0.11.32 && pip uninstall -y pip

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first (only the connector extras), so code changes don't reinstall them.
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --extra opcua --extra mqtt --extra postgresql --extra sqlserver --no-install-project

COPY src ./src
RUN uv sync --locked --no-dev --extra opcua --extra mqtt --extra postgresql --extra sqlserver

RUN useradd --system --uid 10001 tiles-edge \
    && install -d -o tiles-edge -m 700 /var/lib/tiles-edge
# The disk buffer (readings waiting for Tiles) lives here; keep it on a volume so it survives upgrades.
VOLUME /var/lib/tiles-edge
USER tiles-edge

ENV PATH="/app/.venv/bin:$PATH"

ENTRYPOINT ["tiles-edge"]
CMD ["run", "-c", "/etc/tiles-edge/tiles-edge.toml"]
