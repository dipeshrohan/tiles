// The install guide (T5.12) shows terraform.tfvars as the example file starts it, and CI's install
// dry run starts from that file: the two must stay the same, or the dry run tests other settings.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test("the guide's terraform.tfvars is the example file the dry run starts from", () => {
  const guide = read('docs/install.md');
  const shown = guide.match(/Edit `terraform\.tfvars`, which starts as:\n\n```hcl\n([\s\S]*?)```/)?.[1];
  assert.ok(shown, 'the guide shows terraform.tfvars in step 3');
  const example = read('deploy/terraform/environments/customer-hosted/terraform.tfvars.example')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
  assert.equal(shown, example);
});

test('the dry run copies the example, and overrides only what kind needs', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = ci.slice(ci.indexOf('  install:'), ci.indexOf('\n  stack:'));
  assert.match(job, /cp terraform\.tfvars\.example terraform\.tfvars/);
  const overrides = job.match(/cat > kind\.auto\.tfvars <<'TFVARS'\n([\s\S]*?)\n\s*TFVARS/)?.[1] ?? '';
  const keys = [...overrides.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);
  assert.deepEqual(keys.sort(), [
    'api_url',
    'database_size',
    'image_tag',
    'images',
    'ingress_enabled',
    'kube_context',
    'storage_class',
    'url',
  ]);
});
