# Tiles edge agent image:
#   docker build -t tiles-edge edge/
#   docker run -v /etc/tiles-edge:/etc/tiles-edge:ro tiles-edge
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
