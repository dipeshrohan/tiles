// Runs the visual regression tests (e2e/visual) in the Playwright container, where the browser and
// its fonts are the same as in CI's Visual regression job. `--update` writes new baselines.
// Needs Docker; the image is the one for the playwright version in package.json.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const { devDependencies } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const image = `mcr.microsoft.com/playwright:v${devDependencies.playwright}-noble`;
const update = process.argv.includes('--update');
const user = process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
const run = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--ipc=host',
    ...user,
    '-e',
    'HOME=/tmp',
    '-e',
    `UPDATE_VISUAL=${update ? 1 : 0}`,
    '-v',
    `${root}:/work`,
    '-w',
    '/work',
    image,
    'node',
    '--test',
    '--test-concurrency=1',
    'e2e/visual/visual.test.js',
  ],
  { stdio: 'inherit' },
);
process.exit(run.status ?? 1);
