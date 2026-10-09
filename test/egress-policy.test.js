import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The chart's egress allowlist (T5.11) names Microsoft's Teams webhook hosts itself, since a
// Cilium policy can't read the API's settings. They must be the ones notify.py accepts, or Teams
// notifications fail only once the allowlist is on.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('the egress allowlist', () => {
  it('allows the Teams hosts notify.py accepts, and no others', () => {
    const notify = read('api/src/tiles_api/notify.py').match(/^TEAMS_HOSTS = \(([^)]*)\)/m);
    const chart = read('deploy/helm/tiles/templates/egress.yaml').match(/\$teams := list ((?:"[^"]+" ?)+)/);
    const strings = (text) => [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(notify && chart).toBeTruthy();
    expect(strings(chart?.[1] ?? '').map((host) => `.${host}`)).toEqual(strings(notify?.[1] ?? ''));
  });
});
