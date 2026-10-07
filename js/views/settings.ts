import { esc, field, need, onAll, onSubmit } from '../lib/dom.ts';
import { createApiClient, isHttpUrl, isTilesHealth, normalizeBaseUrl, type AuditEntry } from '../lib/api.ts';
import type { Context, View } from './types.ts';

// Sign-in to the Tiles API, shown in API mode.
function accountCard(ctx: Context): string {
  const { config, signedIn } = ctx.auth;
  const { user } = ctx.state;
  let body: string;
  if (!config) body = '<p class="small soft">Checking how this API signs people in…</p>';
  else if (!config.enabled)
    body = '<p class="small soft">This API has no sign-in configured; requests act as the development user.</p>';
  else if (signedIn)
    body = `<p>Signed in as <b>${esc(user.name)}</b> <span class="soft">(${esc(user.email)})</span></p>
      <div><button class="btn" type="button" data-sign-out>Sign out</button></div>`;
  else
    body = `<p class="small soft">${
      config.dev_identity
        ? 'Not signed in: until you sign in, you act as the development user.'
        : 'Sign in to use this Tiles API.'
    }</p>
      <div><button class="btn primary" type="button" data-sign-in>Sign in</button></div>`;
  return `<div class="card stack" id="account" style="gap:12px"><h2>Account</h2>${body}</div>`;
}

// One line per change: what it did, in words.
export function describeAudit(e: AuditEntry): string {
  const ops = (v: unknown) => ((v as { ops?: unknown[] } | null)?.ops ?? []).length;
  const role = (v: unknown) => (v as { role?: string } | null)?.role ?? '?';
  switch (e.action) {
    case 'ontology.stage':
      return `Staged ${ops(e.after)} change(s)`;
    case 'ontology.discard':
      return `Discarded ${ops(e.before)} staged change(s)`;
    case 'ontology.commit':
      return `Committed “${(e.after as { message?: string } | null)?.message ?? ''}”`;
    case 'ontology.revert':
      return `Reverted commit ${(e.before as { reverted?: string } | null)?.reverted ?? ''}`;
    case 'member.role':
      return `Changed a member's role from ${role(e.before)} to ${role(e.after)}`;
    default:
      return `${e.action} ${e.entity_type} ${e.entity_id}`;
  }
}

function auditCard(): string {
  return `<div class="card stack" id="audit" style="gap:12px;grid-column:1 / -1">
      <h2>Audit log</h2>
      <p class="small soft">Every change on this site: who, what and when. Only site admins see this.</p>
      <div data-audit-rows aria-live="polite"><p class="small soft">Loading…</p></div>
    </div>`;
}

async function fillAudit(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-audit-rows]');
  const site = ctx.ontology.site;
  if (!box || !site || !ctx.api) return;
  try {
    const entries = await ctx.api.audit(site.id, { limit: 50 });
    box.innerHTML = entries.length
      ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${entries
          .map(
            (e) =>
              `<tr><td>${esc(new Date(e.at).toLocaleString('en-GB'))}</td><td>${esc(e.actor_name)}</td><td>${esc(describeAudit(e))}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : '<p class="small soft">No changes yet.</p>';
  } catch {
    box.innerHTML = '<p class="small soft">The audit log could not be loaded.</p>';
  }
}

const view: View = {
  id: 'settings',
  title: 'Settings',
  icon: '⚙',
  render(ctx) {
    const { user } = ctx.state;
    const ds = ctx.dataSource;
    return `
      <div class="page-head"><div><div class="eyebrow">Workspace</div><h1>Settings</h1></div></div>
      <div class="grid g2">
        <form class="card stack" id="profile" style="gap:12px">
          <h2>Profile</h2>
          <p class="small soft">Your name and email are recorded as the author of ontology commits and design runs.</p>
          <label class="field">Name<input type="text" name="name" value="${esc(user.name)}" required /></label>
          <label class="field">Email<input type="text" name="email" value="${esc(user.email)}" required /></label>
          <div><button class="btn primary" type="submit">Save</button></div>
        </form>
        <div class="card stack" style="gap:12px">
          <h2>Demo data</h2>
          <p class="small soft">Plant data (cutter batches, welder power, die-cast shots) is synthetic and regenerated from fixed seeds. Your ontology commits, design runs and chat are saved in this browser.</p>
          <div><button class="btn danger" data-reset>Reset workspace</button></div>
        </div>
        <form class="card stack" id="datasource" style="gap:12px">
          <h2>Data source</h2>
          <p class="small soft">Keep data in this browser, or share it through the Tiles API (<code>docker compose up</code> starts one on port 8000). Pages move to the API one at a time.</p>
          <label class="row" style="gap:8px"><input type="radio" name="mode" value="local" ${ds.mode === 'local' ? 'checked' : ''} /> This browser only</label>
          <label class="row" style="gap:8px"><input type="radio" name="mode" value="api" ${ds.mode === 'api' ? 'checked' : ''} /> Tiles API</label>
          <label class="field">API address<input type="url" name="apiUrl" value="${esc(ds.apiUrl)}" placeholder="http://localhost:8000" /></label>
          <div class="row" style="gap:8px"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-test-api>Test connection</button></div>
          <p class="small soft" data-api-status aria-live="polite"></p>
        </form>
        ${ds.mode === 'api' ? accountCard(ctx) : ''}
        ${ctx.ontology.role === 'admin' ? auditCard() : ''}
      </div>`;
  },
  bind(root, ctx) {
    onSubmit(root, '#profile', (form) => {
      const name = field(form, 'name').trim();
      const email = field(form, 'email').trim();
      ctx.update((s) => (s.user = { name, email }));
      ctx.toast('Profile saved');
    });
    onSubmit(root, '#datasource', (form) => {
      const mode = (form.elements.namedItem('mode') as RadioNodeList).value === 'api' ? 'api' : 'local';
      const apiUrl = normalizeBaseUrl(field(form, 'apiUrl'));
      // Only API mode needs an address; local mode keeps the last good one.
      if (mode === 'api' && !isHttpUrl(apiUrl)) {
        ctx.toast('Enter the API address, e.g. http://localhost:8000');
        return;
      }
      ctx.setDataSource({ mode, apiUrl: isHttpUrl(apiUrl) ? apiUrl : ctx.dataSource.apiUrl });
      ctx.toast(mode === 'api' ? 'Using the Tiles API' : 'Using this browser only');
    });
    onAll(root, '[data-test-api]', 'click', async () => {
      const status = need(root, '[data-api-status]');
      const url = field(need<HTMLFormElement>(root, '#datasource'), 'apiUrl');
      status.textContent = 'Checking…';
      try {
        const h = await createApiClient({ baseUrl: url, onError: (e) => ctx.toast(e.message) }).health();
        status.textContent = isTilesHealth(h)
          ? `Connected: Tiles API ${h.version} (${h.env})`
          : 'Something answered there, but it is not the Tiles API';
      } catch {
        status.textContent = 'Not reachable';
      }
    });
    if (ctx.ontology.role === 'admin') void fillAudit(root, ctx);
    onAll(root, '[data-sign-in]', 'click', () => void ctx.auth.signIn());
    onAll(root, '[data-sign-out]', 'click', () => void ctx.auth.signOut());
    onAll(root, '[data-reset]', 'click', () => {
      if (confirm('Reset ontology history, design runs and chat to the demo defaults?')) ctx.reset();
    });
  },
};

export default view;
