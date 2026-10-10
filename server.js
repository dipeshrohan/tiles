// Zero-dependency static server: `node server.js` then open http://localhost:5173
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
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

// Security headers (threat model G-B1). Scripts come only from this server (the bundle; no inline
// script), nothing may frame the app, and the sign-in code in a URL is never sent on as a referrer.
// Styles allow inline `style` attributes, which the views use. The API and the sign-in provider are
// wherever a deployment or a user (Settings, `?api=`) puts them, plain http on a plant's network
// included. Documents' PDFs open in the browser's viewer from a blob.
export function securityHeaders() {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self' https: http:",
    "object-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };
}

const attr = (text) => text.replace(/[&"<>]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]);

// `apiUrl` (TILES_API_URL when run directly, T5.09): the API a deployment serves the app with,
// written into index.html's `tiles-api` meta tag; the app uses it until a browser chooses otherwise.
export function createTilesServer({ apiUrl = '' } = {}) {
  // The same test as isHttpUrl in js/lib/api.ts (this file runs without a build, so it can't import it).
  if (apiUrl && !/^https?:\/\/[^\s/]+/i.test(apiUrl)) throw new Error(`Not an http(s) URL: ${apiUrl}`);
  const index = join(root, 'index.html');
  // The page with the address in, made once; a page without the tag fails here, not silently.
  let page = null;
  if (apiUrl) {
    const html = readFileSync(index, 'utf8');
    const tag = /<meta\s+name="tiles-api"\s+content="[^"]*"\s*\/?>/;
    if (!tag.test(html)) throw new Error('index.html has no <meta name="tiles-api"> tag to put the API address in');
    page = Buffer.from(html.replace(tag, `<meta name="tiles-api" content="${attr(apiUrl)}" />`));
  }
  const headers = securityHeaders();
  return createServer(async (req, res) => {
    let path;
    try {
      path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    } catch {
      res.writeHead(400, headers).end('Bad request');
      return;
    }
    if (path.startsWith('..')) {
      res.writeHead(403, headers).end();
      return;
    }
    const file = join(root, path || 'index.html');
    try {
      const body = page && file === index ? page : await readFile(file);
      res.writeHead(200, { ...headers, 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
    } catch {
      res.writeHead(404, headers).end('Not found');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT) || 5173;
  createTilesServer({ apiUrl: process.env.TILES_API_URL ?? '' }).listen(port, () =>
    console.log(`Tiles running at http://localhost:${port}`),
  );
}
