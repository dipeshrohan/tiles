// Settings: the organisation's own sign-in (T5.05), for organisation admins. Its identity provider
// (a customer's Entra ID tenant, say) and the SCIM tokens its provisioning client uses. Shown in
// API mode; the card hides itself for anyone who isn't an organisation admin.

import { esc, field, onAll, onSubmit } from '../lib/dom.ts';
import type { IdentityProvider, ScimToken } from '../lib/api.ts';
import { groupRolesText, providerFromForm, scimBaseUrl } from '../lib/org-sign-in.ts';
import type { Context } from './types.ts';
import { confirmDialog } from '../lib/overlay.ts';

// A SCIM token just made: shown until dismissed, to the admin who made it, for that API only.
let revealed: { name: string; token: string; apiUrl: string; user: string } | null = null;

export function orgSignInCard(): string {
  return `<div class="card stack gap-3 span-all" id="org-sign-in" hidden>
      <h2>Organisation sign-in</h2>
      <p class="small soft">Sign your organisation's people in with its own identity provider, such as Microsoft Entra ID, and let it create and deactivate their accounts (SCIM). See <code>docs/guides/entra-id.md</code>. Only organisation admins see this.</p>
      <div data-org-provider aria-live="polite"></div>
      <h3>User provisioning (SCIM)</h3>
      <div data-scim aria-live="polite"></div>
    </div>`;
}

function providerForm(p: IdentityProvider | null, viaProvider: boolean): string {
  const v = (s: string | null | undefined) => esc(s ?? '');
  const updated = p ? ` Updated ${esc(new Date(p.updated_at).toLocaleString('en-GB'))}.` : '';
  const status = !p
    ? '<p class="small soft">Your organisation signs in through this deployment’s provider.</p>'
    : p.verified
      ? `<p class="small">Signs in through <b>${esc(p.issuer)}</b>${p.enforced ? ', and no other sign-in reaches your organisation' : ''}.${updated}</p>`
      : `<p class="small" data-org-provider-pending><span class="badge warn">Not confirmed</span> Sign in through <b>${esc(p.issuer)}</b> yourself, with the same email, under <i>Account</i> above: that confirms your organisation controls it. Until then it takes no one else.${updated}</p>`;
  const enforceHint = viaProvider
    ? 'Refuse every other sign-in for your organisation.'
    : 'Refuse every other sign-in. Save the provider first, then sign in through it to turn this on.';
  return `${status}
    <form class="stack gap-2" id="org-provider-form">
      <label class="field">Issuer (the tokens’ <code>iss</code>; Entra ID: https://login.microsoftonline.com/&lt;tenant ID&gt;/v2.0)<input type="url" name="issuer" value="${v(p?.issuer)}" required autocomplete="off" /></label>
      <div class="grid g2 gap-2">
        <label class="field">Browser client ID (a single-page app registration)<input type="text" name="clientId" value="${v(p?.client_id)}" required autocomplete="off" /></label>
        <label class="field">Audience (the API app’s ID, as the tokens’ <code>aud</code> names it)<input type="text" name="audience" value="${v(p?.audience)}" required autocomplete="off" /></label>
      </div>
      <label class="field">Scope (Entra ID: openid profile email offline_access api://&lt;API app ID&gt;/access)<input type="text" name="scope" value="${v(p?.scope ?? 'openid email profile')}" autocomplete="off" /></label>
      <label class="field">Signing keys (leave empty to find them from the issuer)<input type="url" name="jwksUrl" value="${v(p?.jwks_url)}" autocomplete="off" /></label>
      <label class="field">Groups and the role each grants, one per line: <code>&lt;group ID&gt; = engineer</code><textarea name="groupRoles" rows="3" spellcheck="false">${esc(groupRolesText(p?.group_roles ?? {}))}</textarea></label>
      <label class="row gap-2"><input type="checkbox" name="enforced" ${p?.enforced ? 'checked' : ''} /> ${esc(enforceHint)}</label>
      <div class="row gap-2"><button class="btn primary" type="submit">Save</button>${p ? '<button class="btn danger" type="button" data-org-provider-remove>Remove</button>' : ''}</div>
    </form>`;
}

function scimHtml(ctx: Context, tokens: ScimToken[]): string {
  const api = ctx.api;
  if (!api) return '';
  const shown =
    revealed && revealed.apiUrl === api.baseUrl && revealed.user === ctx.state.user.email
      ? `<div class="stack gap-2" data-scim-token>
          <p><b>Token for ${esc(revealed.name)}.</b> Copy it now into your provider’s provisioning settings as the secret token: Tiles keeps only its hash and won’t show it again.</p>
          <pre class="code-block">${esc(revealed.token)}</pre>
          <div><button class="btn" type="button" data-scim-token-done>Done, I've saved it</button></div>
        </div>`
      : '';
  const active = tokens.filter((t) => !t.revoked_at);
  const rows = active.length
    ? `<div class="table-wrap"><table><thead><tr><th>Token</th><th>Made</th><th>Last used</th><th><span class="sr-only">Actions</span></th></tr></thead><tbody>${active
        .map(
          (t) =>
            `<tr><td>${esc(t.name)}</td><td>${esc(new Date(t.created_at).toLocaleString('en-GB'))}</td><td>${t.last_used_at ? esc(new Date(t.last_used_at).toLocaleString('en-GB')) : 'never'}</td><td><button class="btn sm danger" type="button" data-revoke-scim="${esc(t.id)}" data-scim-name="${esc(t.name)}">Revoke</button></td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="small soft">No SCIM tokens yet: make one below, then give it and the tenant URL to your identity provider’s provisioning settings.</p>';
  return `<p class="small">Tenant URL for your provider: <code>${esc(scimBaseUrl(api.baseUrl))}</code>. Users only: roles come from sign-in, memberships from site admins.</p>
    ${shown}${rows}
    <form class="row gap-2 wrap" id="scim-token-form">
      <label class="field grow min-w-field">New token for<input type="text" name="name" placeholder="e.g. Entra ID provisioning" maxlength="120" required /></label>
      <div class="self-end"><button class="btn primary" type="submit">Make a token</button></div>
    </form>`;
}

async function fillScim(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-scim]');
  const api = ctx.api;
  if (!box || !api) return;
  let tokens: ScimToken[];
  try {
    tokens = await api.org.scimTokens();
  } catch {
    box.innerHTML = '<p class="small soft">The SCIM tokens could not be loaded.</p>';
    return;
  }
  box.innerHTML = scimHtml(ctx, tokens);
  onAll(box, '[data-scim-token-done]', 'click', () => {
    revealed = null;
    void fillScim(root, ctx);
  });
  onAll(box, '[data-revoke-scim]', 'click', async (el) => {
    const name = el.dataset.scimName ?? '';
    const yes = await confirmDialog({
      title: `Revoke ${name}?`,
      body: 'Provisioning with this token stops at once. It can’t be restored: make a new one.',
      confirm: 'Revoke',
      tone: 'danger',
    });
    if (!yes) return;
    api.org.revokeScimToken(el.dataset.revokeScim ?? '').then(
      () => {
        ctx.toast(`Revoked ${name}`);
        return fillScim(root, ctx);
      },
      () => undefined, // the client already showed why
    );
  });
  onSubmit(box, '#scim-token-form', (form) => {
    const name = field(form, 'name').trim();
    api.org.createScimToken(name).then(
      ({ token }) => {
        revealed = { name, token, apiUrl: api.baseUrl, user: ctx.state.user.email };
        return fillScim(root, ctx);
      },
      () => undefined,
    );
  });
}

export async function bindOrgSignIn(root: HTMLElement, ctx: Context): Promise<void> {
  const card = root.querySelector<HTMLElement>('#org-sign-in');
  const box = root.querySelector('[data-org-provider]');
  const api = ctx.api;
  if (!card || !box || !api) return;
  let provider: IdentityProvider | null;
  try {
    // Only organisation admins see the card.
    if (!(await api.org.me()).admin) return card.remove();
    provider = await api.org.identityProvider();
  } catch {
    card.hidden = false;
    box.innerHTML = '<p class="small soft">The organisation’s sign-in could not be loaded.</p>';
    return;
  }
  card.hidden = false;
  const viaProvider = !!provider && ctx.auth.signedIn && ctx.auth.signInOrg !== '';
  box.innerHTML = providerForm(provider, viaProvider);
  onSubmit(box, '#org-provider-form', (form) => {
    const { provider: body, errors } = providerFromForm({
      issuer: field(form, 'issuer'),
      clientId: field(form, 'clientId'),
      audience: field(form, 'audience'),
      scope: field(form, 'scope'),
      jwksUrl: field(form, 'jwksUrl'),
      groupRoles: field(form, 'groupRoles'),
      enforced: (form.elements.namedItem('enforced') as HTMLInputElement).checked,
    });
    if (!body) return ctx.toast(errors.join('. '));
    api.org.setIdentityProvider(body).then(
      () => {
        ctx.toast('Organisation sign-in saved');
        return bindOrgSignIn(root, ctx);
      },
      () => undefined,
    );
  });
  onAll(box, '[data-org-provider-remove]', 'click', async () => {
    const yes = await confirmDialog({
      title: 'Remove your organisation’s provider?',
      body: 'Sign-ins through it stop working at once.',
      confirm: 'Remove',
      tone: 'danger',
    });
    if (!yes) return;
    api.org.removeIdentityProvider().then(
      () => {
        ctx.toast('Organisation sign-in removed');
        return bindOrgSignIn(root, ctx);
      },
      () => undefined,
    );
  });
  await fillScim(root, ctx);
}
