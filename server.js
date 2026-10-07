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

export function createTilesServer() {
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
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 5173;
  createTilesServer().listen(port, () => console.log(`Tiles running at http://localhost:${port}`));
}
