// Zero-dependency static server: `node server.js` then open http://localhost:5173
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

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

// Text is sent compressed when the browser takes it (U3.07: the bundle goes from about 600 kB to
// under 150 kB), each file compressed once and again only when it changes.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg']);
export function encodingFor(accept = '') {
  const taken = new Map();
  for (const part of accept.split(',')) {
    const [name = '', ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)).find(Boolean);
    taken.set(name, q ? Number(q[1]) : 1);
  }
  const ok = (name) => (taken.get(name) ?? taken.get('*') ?? 0) > 0;
  return ok('br') ? 'br' : ok('gzip') ? 'gzip' : null;
}
const compressed = new Map(); // file → { source, br, gzip }
function compress(file, body, encoding) {
  let entry = compressed.get(file);
  if (!entry || !entry.source.equals(body)) compressed.set(file, (entry = { source: body }));
  entry[encoding] ??=
    encoding === 'br'
      ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } })
      : gzipSync(body, { level: 9 });
  return entry[encoding];
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
      const type = { 'content-type': types[extname(file)] ?? 'application/octet-stream' };
      const encoding = COMPRESSIBLE.has(extname(file)) ? encodingFor(req.headers['accept-encoding']) : null;
      if (!encoding) {
        res.writeHead(200, { ...headers, ...type, vary: 'accept-encoding' }).end(body);
        return;
      }
      const sent = compress(file, body, encoding);
      res.writeHead(200, { ...headers, ...type, vary: 'accept-encoding', 'content-encoding': encoding }).end(sent);
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
