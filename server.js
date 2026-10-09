// Zero-dependency static server: `node server.js` then open http://localhost:5173
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const attr = (text) => text.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

// `apiUrl` (TILES_API_URL when run directly, T5.09): the API a deployment serves the app with,
// written into index.html's `tiles-api` meta tag; the app uses it until a browser chooses otherwise.
export function createTilesServer({ apiUrl = '' } = {}) {
  // The same test as isHttpUrl in js/lib/api.ts (this file runs without a build, so it can't import it).
  if (apiUrl && !/^https?:\/\/[^\s/]+/i.test(apiUrl)) throw new Error(`Not an http(s) URL: ${apiUrl}`);
  return createServer(async (req, res) => {
    let path;
    try {
      path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (path.startsWith('..')) {
      res.writeHead(403).end();
      return;
    }
    const file = join(root, path || 'index.html');
    try {
      let body = await readFile(file);
      if (apiUrl && file === join(root, 'index.html')) {
        body = body
          .toString('utf8')
          .replace('<meta name="tiles-api" content="" />', `<meta name="tiles-api" content="${attr(apiUrl)}" />`);
      }
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 5173;
  createTilesServer({ apiUrl: process.env.TILES_API_URL ?? '' }).listen(port, () =>
    console.log(`Tiles running at http://localhost:${port}`),
  );
}
