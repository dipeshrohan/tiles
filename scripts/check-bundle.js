// Checks that the committed js/tiles.bundle.js matches a fresh Vite build of
// the sources. Used by `npm test` (via test/bundle.test.js) and runnable
// directly: `node scripts/check-bundle.js`.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function freshBundle() {
  const outDir = mkdtempSync(join(tmpdir(), 'tiles-bundle-'));
  try {
    process.env.TILES_OUT_DIR = outDir;
    await build({ root, logLevel: 'silent', configFile: join(root, 'vite.config.js') });
    return readFileSync(join(outDir, 'tiles.bundle.js'), 'utf8');
  } finally {
    delete process.env.TILES_OUT_DIR;
    rmSync(outDir, { recursive: true, force: true });
  }
}

export function committedBundle() {
  return readFileSync(join(root, 'js/tiles.bundle.js'), 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if ((await freshBundle()) !== committedBundle()) {
    console.error('js/tiles.bundle.js is out of date. Run: npm run build');
    process.exit(1);
  }
  console.log('Bundle is up to date.');
}
