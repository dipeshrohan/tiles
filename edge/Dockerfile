# Tiles edge agent image:
#   docker build -t tiles-edge edge/
#   docker run -v /etc/tiles-edge:/etc/tiles-edge:ro tiles-edge
# It runs as UID 10001: give that user the token file (chown 10001), or pass
# the token in TILES_EDGE_TOKEN instead. See README.md.
# The agent uses only the standard library, so nothing is installed.
FROM python:3.13-slim

ENV PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY src /app/src

RUN useradd --system --uid 10001 tiles-edge
USER tiles-edge

ENTRYPOINT ["python", "-m", "tiles_edge"]
CMD ["run", "-c", "/etc/tiles-edge/tiles-edge.toml"]
