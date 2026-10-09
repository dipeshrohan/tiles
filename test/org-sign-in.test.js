import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  entraIssuer,
  entraScope,
  groupRolesText,
  isEntraIssuer,
  parseGroupRoles,
  providerFromForm,
  scimBaseUrl,
} from '../js/lib/org-sign-in.ts';

const TENANT = '6f1d0a59-0000-4000-8000-000000000001';

test('group roles are typed one per line, and bad lines are named', () => {
  const { roles, errors } = parseGroupRoles(
    `# Moulding engineers\n5e6f-a = engineer\n\n7a8b-c: Admin\nnot a line\n9d0e = owner`,
  );
  assert.deepEqual(roles, { '5e6f-a': 'engineer', '7a8b-c': 'admin' });
  assert.deepEqual(errors, [
    'Line 5: write a group ID, then = and viewer, engineer or admin',
    'Line 6: write a group ID, then = and viewer, engineer or admin',
  ]);
  assert.equal(groupRolesText(roles), '5e6f-a = engineer\n7a8b-c = admin');
  assert.deepEqual(parseGroupRoles(groupRolesText(roles)).roles, roles);
});

test("Entra ID's issuer, scope and the SCIM address", () => {
  assert.equal(entraIssuer(` ${TENANT} `), `https://login.microsoftonline.com/${TENANT}/v2.0`);
  assert.ok(isEntraIssuer(entraIssuer(TENANT)));
  assert.ok(!isEntraIssuer(`https://sts.windows.net/${TENANT}/`)); // v1 tokens: not accepted
  assert.equal(entraScope('8a2b'), 'openid profile email offline_access api://8a2b/access');
  assert.equal(scimBaseUrl('https://api.tiles.example/'), 'https://api.tiles.example/scim/v2');
});

test('the form becomes what the API takes, or says what is wrong', () => {
  const form = {
    issuer: `${entraIssuer(TENANT)}/`,
    clientId: ' spa ',
    audience: 'api-app',
    scope: '',
    jwksUrl: '',
    groupRoles: 'g = engineer',
    enforced: false,
  };
  assert.deepEqual(providerFromForm(form), {
    provider: {
      issuer: entraIssuer(TENANT),
      client_id: 'spa',
      audience: 'api-app',
      scope: 'openid email profile',
      jwks_url: null,
      group_roles: { g: 'engineer' },
      enforced: false,
    },
    errors: [],
  });
  const bad = providerFromForm({ ...form, issuer: 'http://idp', audience: ' ', jwksUrl: 'http://k', groupRoles: 'g' });
  assert.equal(bad.provider, null);
  assert.equal(bad.errors.length, 4);
});
