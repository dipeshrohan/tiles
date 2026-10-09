# Tiles web image (T5.09): the static app and its zero-dependency server, nothing else.
#   docker build -t tiles-web .
#   docker run -p 5173:5173 -e TILES_API_URL=https://api.tiles.example.com tiles-web
# TILES_API_URL is the API the app opens in API mode; unset, it keeps its data in the browser.
# Build js/tiles.bundle.js first (`npm run build`; CI checks the committed one is fresh).
FROM node:22-alpine

# The base image's security updates (T5.08), as for the API image.
RUN apk upgrade --no-cache

WORKDIR /app
# Only what the browser loads, so the server can't hand out anything else in the repository.
COPY package.json server.js index.html ./
COPY css ./css
COPY js/tiles.bundle.js ./js/

USER node
ENV PORT=5173 NODE_ENV=production
EXPOSE 5173
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -q -O /dev/null http://127.0.0.1:5173/ || exit 1

CMD ["node", "server.js"]
