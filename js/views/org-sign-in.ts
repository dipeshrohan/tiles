// Settings: the organisation's own sign-in (T5.05), for organisation admins. Its identity provider
// (a customer's Entra ID tenant, say) and the SCIM tokens its provisioning client uses. Shown in
// API mode; the card hides itself for anyone who isn't an organisation admin.

import { esc, field, onAll, onSubmit } from '../lib/dom.ts';
import type { IdentityProvider, ScimToken } from '../lib/api.ts';
import { groupRolesText, providerFromForm, scimBaseUrl } from '../lib/org-sign-in.ts';
import type { Context } from './types.ts';
import { loadFailed } from '../lib/ui.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { t, tHtml } from '../lib/i18n.ts';
import { dateTime } from '../lib/format.ts';

// A SCIM token just made: shown until dismissed, to the admin who made it, for that API only.
const GUIDE = '<code>docs/guides/entra-id.md</code>'; // i18n-ok
const ISS = '<code>iss</code>'; // i18n-ok
const AUD = '<code>aud</code>'; // i18n-ok
const SCOPES = 'openid profile email offline_access api://'; // i18n-ok
// A placeholder in an example: <tenant ID>.
const angled = (words: string): string => `&lt;${esc(words)}&gt;`; // i18n-ok

let revealed: { name: string; token: string; apiUrl: string; user: string } | null = null;

export function orgSignInCard(): string {
  return `<div class="card stack gap-3 span-all" id="org-sign-in" hidden>
      <h2>${esc(t('orgSignIn.title'))}</h2>
      <p class="small soft">${tHtml('orgSignIn.lead', { guide: GUIDE })}</p>
      <div data-org-provider aria-live="polite"></div>
      <h3>${esc(t('orgSignIn.scim.title'))}</h3>
      <div data-scim aria-live="polite"></div>
    </div>`;
}

function providerForm(p: IdentityProvider | null, viaProvider: boolean): string {
  const v = (s: string | null | undefined) => esc(s ?? '');
  const updated = p ? ` ${esc(t('orgSignIn.updated', { time: dateTime(p.updated_at) }))}` : '';
  const status = !p
    ? `<p class="small soft">${esc(t('orgSignIn.deploymentProvider'))}</p>`
    : p.verified
      ? `<p class="small">${tHtml('orgSignIn.signsIn', { issuer: `<b>${esc(p.issuer)}</b>`, enforced: p.enforced ? 'yes' : 'no' })}${updated}</p>`
      : `<p class="small" data-org-provider-pending><span class="badge warn">${esc(t('orgSignIn.notConfirmed'))}</span> ${tHtml('orgSignIn.confirm', { issuer: `<b>${esc(p.issuer)}</b>`, account: `<i>${esc(t('orgSignIn.account'))}</i>` })}${updated}</p>`;
  const enforceHint = viaProvider ? t('orgSignIn.enforce') : t('orgSignIn.enforceFirst');
  return `${status}
    <form class="stack gap-2" id="org-provider-form">
      <label class="field">${tHtml('orgSignIn.form.issuer', { iss: ISS, example: `https://login.microsoftonline.com/${angled(t('orgSignIn.form.tenantId'))}/v2.0` })}<input type="url" name="issuer" value="${v(p?.issuer)}" required autocomplete="off" /></label>
      <div class="grid g2 gap-2">
        <label class="field">${esc(t('orgSignIn.form.clientId'))}<input type="text" name="clientId" value="${v(p?.client_id)}" required autocomplete="off" /></label>
        <label class="field">${tHtml('orgSignIn.form.audience', { aud: AUD })}<input type="text" name="audience" value="${v(p?.audience)}" required autocomplete="off" /></label>
      </div>
      <label class="field">${tHtml('orgSignIn.form.scope', { example: `${SCOPES}${angled(t('orgSignIn.form.apiAppId'))}/access` })}<input type="text" name="scope" value="${v(p?.scope ?? 'openid email profile')}" autocomplete="off" /></label>
      <label class="field">${esc(t('orgSignIn.form.jwks'))}<input type="url" name="jwksUrl" value="${v(p?.jwks_url)}" autocomplete="off" /></label>
      <label class="field">${tHtml('orgSignIn.form.groups', { example: `<code>${angled(t('orgSignIn.form.groupId'))} = engineer</code>` })}<textarea name="groupRoles" rows="3" spellcheck="false">${esc(groupRolesText(p?.group_roles ?? {}))}</textarea></label>
      <label class="row gap-2"><input type="checkbox" name="enforced" ${p?.enforced ? 'checked' : ''} /> ${esc(enforceHint)}</label>
      <div class="row gap-2"><button class="btn primary" type="submit">${esc(t('orgSignIn.form.save'))}</button>${p ? `<button class="btn danger" type="button" data-org-provider-remove>${esc(t('orgSignIn.remove'))}</button>` : ''}</div>
    </form>`;
}

function scimHtml(ctx: Context, tokens: ScimToken[]): string {
  const api = ctx.api;
  if (!api) return '';
  const shown =
    revealed && revealed.apiUrl === api.baseUrl && revealed.user === ctx.state.user.email
      ? `<div class="stack gap-2" data-scim-token>
          <p>${tHtml('orgSignIn.scim.revealed', { name: `<b>${esc(t('orgSignIn.scim.tokenFor', { name: revealed.name }))}</b>` })}</p>
          <pre class="code-block">${esc(revealed.token)}</pre>
          <div><button class="btn" type="button" data-scim-token-done>${esc(t('orgSignIn.scim.done'))}</button></div>
        </div>`
      : '';
  const active = tokens.filter((tok) => !tok.revoked_at);
  const rows = active.length
    ? `<div class="table-wrap"><table><thead><tr><th>${esc(t('orgSignIn.scim.head.token'))}</th><th>${esc(t('orgSignIn.scim.head.made'))}</th><th>${esc(t('orgSignIn.scim.head.lastUsed'))}</th><th><span class="sr-only">${esc(t('orgSignIn.scim.head.actions'))}</span></th></tr></thead><tbody>${active
        .map(
          (tok) =>
            `<tr><td>${esc(tok.name)}</td><td>${esc(dateTime(tok.created_at))}</td><td>${tok.last_used_at ? esc(dateTime(tok.last_used_at)) : esc(t('orgSignIn.scim.never'))}</td><td><button class="btn sm danger" type="button" data-revoke-scim="${esc(tok.id)}" data-scim-name="${esc(tok.name)}">${esc(t('orgSignIn.scim.revoke'))}</button></td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : `<p class="small soft">${esc(t('orgSignIn.scim.none'))}</p>`;
  return `<p class="small">${tHtml('orgSignIn.scim.tenant', { url: `<code>${esc(scimBaseUrl(api.baseUrl))}</code>` })}</p>
    ${shown}${rows}
    <form class="row gap-2 wrap" id="scim-token-form">
      <label class="field grow min-w-field">${esc(t('orgSignIn.scim.newFor'))}<input type="text" name="name" placeholder="${esc(t('orgSignIn.scim.placeholder'))}" maxlength="120" required /></label>
      <div class="self-end"><button class="btn primary" type="submit">${esc(t('orgSignIn.scim.make'))}</button></div>
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
    box.innerHTML = loadFailed(t('orgSignIn.scim.loadName'), 4);
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
      title: t('orgSignIn.scim.revokeTitle', { name }),
      body: t('orgSignIn.scim.revokeBody'),
      confirm: t('orgSignIn.scim.revoke'),
      tone: 'danger',
    });
    if (!yes) return;
    api.org.revokeScimToken(el.dataset.revokeScim ?? '').then(
      () => {
        ctx.toast(t('orgSignIn.scim.revoked', { name }));
        return fillScim(root, ctx);
      },
      () => undefined, // the client already showed why
    );
  });
  onSubmit(box, '#scim-token-form', (form) => {
    const name = field(form, 'name').trim();
    return api.org.createScimToken(name).then(
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
    box.innerHTML = `<p class="small soft">${esc(t('orgSignIn.loadFailed'))}</p>`;
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
    return api.org.setIdentityProvider(body).then(
      () => {
        ctx.toast(t('orgSignIn.saved'));
        return bindOrgSignIn(root, ctx);
      },
      () => undefined,
    );
  });
  onAll(box, '[data-org-provider-remove]', 'click', async () => {
    const yes = await confirmDialog({
      title: t('orgSignIn.removeTitle'),
      body: t('orgSignIn.removeBody'),
      confirm: t('orgSignIn.remove'),
      tone: 'danger',
    });
    if (!yes) return;
    api.org.removeIdentityProvider().then(
      () => {
        ctx.toast(t('orgSignIn.removed'));
        return bindOrgSignIn(root, ctx);
      },
      () => undefined,
    );
  });
  await fillScim(root, ctx);
}
