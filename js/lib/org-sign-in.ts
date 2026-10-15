// An organisation's own sign-in (T5.05): the form for its identity provider and the SCIM address.
// Pure, so it is unit-tested; the Settings page draws it.

import type { IdentityProviderIn, OrgRole } from './api.ts';
import { t } from './i18n.ts';

const ROLES: readonly OrgRole[] = ['viewer', 'engineer', 'admin'];

// Group roles as typed, one per line: `<group id> = <role>`. Blank lines and `#` comments are
// skipped; a bad line is reported by its number.
export function parseGroupRoles(text: string): { roles: Record<string, OrgRole>; errors: string[] } {
  const roles: Record<string, OrgRole> = {};
  const errors: string[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = /^(.+?)\s*[=:]\s*(\S+)$/.exec(line);
    const role = m?.[2]?.toLowerCase() as OrgRole | undefined;
    if (!m?.[1] || !role || !ROLES.includes(role)) {
      errors.push(t('orgSignIn.badLine', { line: i + 1 }));
      return;
    }
    roles[m[1].trim()] = role;
  });
  return { roles, errors };
}

export function groupRolesText(roles: Record<string, OrgRole>): string {
  return Object.entries(roles)
    .map(([group, role]) => `${group} = ${role}`)
    .join('\n');
}

// Entra ID's issuer for a tenant (v2 tokens), from its ID or a pasted issuer.
export function entraIssuer(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant.trim()}/v2.0`;
}

export function isEntraIssuer(issuer: string): boolean {
  return /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(issuer.trim());
}

// What the browser asks Entra ID for: sign-in, a refresh token and the API app's scope.
const ENTRA_SCOPES = 'openid profile email offline_access'; // i18n-ok
export function entraScope(apiAppId: string, scopeName = 'access'): string {
  return `${ENTRA_SCOPES} api://${apiAppId.trim()}/${scopeName}`;
}

// Where an identity provider's SCIM client sends its requests.
export function scimBaseUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/scim/v2`;
}

// The form's fields, as the API takes them; problems in words.
export function providerFromForm(f: {
  issuer: string;
  clientId: string;
  audience: string;
  scope: string;
  jwksUrl: string;
  groupRoles: string;
  enforced: boolean;
}): { provider: IdentityProviderIn | null; errors: string[] } {
  const errors: string[] = [];
  const issuer = f.issuer.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/?#\s]+(\/[^?#\s]*)?$/.test(issuer)) errors.push(t('orgSignIn.issuerHttps'));
  if (!f.clientId.trim()) errors.push(t('orgSignIn.clientId'));
  if (!f.audience.trim()) errors.push(t('orgSignIn.audience'));
  const jwks = f.jwksUrl.trim();
  if (jwks && !jwks.startsWith('https://')) errors.push(t('orgSignIn.jwksHttps'));
  const groups = parseGroupRoles(f.groupRoles);
  errors.push(...groups.errors);
  if (errors.length) return { provider: null, errors };
  return {
    provider: {
      issuer,
      client_id: f.clientId.trim(),
      audience: f.audience.trim(),
      scope: f.scope.trim() || 'openid email profile',
      jwks_url: jwks || null,
      group_roles: groups.roles,
      enforced: f.enforced,
    },
    errors,
  };
}
