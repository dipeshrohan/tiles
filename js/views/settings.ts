import { esc, field, need, onAll, onSubmit } from '../lib/dom.ts';
import {
  createApiClient,
  isHttpUrl,
  isTilesHealth,
  normalizeBaseUrl,
  type AuditEntry,
  type EdgeAgent,
} from '../lib/api.ts';
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
    case 'agent.register':
      return `Registered edge agent ${(e.after as { name?: string } | null)?.name ?? ''}`;
    case 'agent.revoke':
      return `Revoked edge agent ${(e.before as { name?: string } | null)?.name ?? ''}`;
    case 'signal.update': {
      const fields = Object.keys((e.after as Record<string, unknown> | null) ?? {}).filter((k) => k !== 'tag');
      const names: Record<string, string> = {
        node_id: 'ontology link',
        sample_rate_hz: 'sample rate',
        range_min: 'expected minimum',
        range_max: 'expected maximum',
        stuck_after_s: 'stuck limit',
      };
      return `Changed ${fields.map((f) => names[f] ?? f).join(', ')} of signal ${(e.after as { tag?: string } | null)?.tag ?? ''}`;
    }
    case 'signal.quality_check': {
      const a = e.after as { checked?: number; good?: number; warn?: number; bad?: number } | null;
      return `Checked the quality of ${a?.checked ?? 0} signal(s): ${a?.good ?? 0} good, ${a?.warn ?? 0} with warnings, ${a?.bad ?? 0} with problems`;
    }
    case 'import.start':
      return `Started importing ${(e.after as { name?: string } | null)?.name ?? ''}`;
    case 'import.finish': {
      const a = e.after as { received?: number; stored?: number } | null;
      return `Finished an import: ${a?.stored ?? 0} new readings of ${a?.received ?? 0} sent`;
    }
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

// A just-registered agent's token, shown until dismissed: Tiles never shows it again.
// It belongs to the API, site and admin it was created for, and is dropped as
// soon as any of them changes (another API or site, another user, signing out).
interface Revealed {
  name: string;
  token: string;
  apiUrl: string;
  siteId: string;
  user: string;
}
let revealed: Revealed | null = null;

// The latest "Test connection" result, kept so a re-render (say the ontology finishing loading)
// shows it again rather than wiping it.
let apiCheck = '';
let apiCheckSeq = 0;

// Who is looking: whether they are signed in, and as whom.
function viewer(ctx: Context): string {
  return `${ctx.auth.signedIn ? 'signed-in' : 'dev'}:${ctx.state.user.email}`;
}

export function tokenStillShown(
  r: Revealed | null,
  apiUrl: string | undefined,
  siteId: string | undefined,
  admin: boolean,
  user: string,
): r is Revealed {
  return !!r && admin && r.apiUrl === apiUrl && r.siteId === siteId && r.user === user;
}

function agentsCard(admin: boolean): string {
  return `<div class="card stack" id="agents" style="gap:12px;grid-column:1 / -1">
      <h2>Edge agents</h2>
      <p class="small soft">Agents run on the plant network and send data out to Tiles; they open no ports. Each one reports a heartbeat, so you can see whether it is online. See <code>edge/README.md</code> to install one.</p>
      <div data-agent-token aria-live="polite"></div>
      <div data-agent-rows aria-live="polite"><p class="small soft">Loading…</p></div>
      ${
        admin
          ? `<form class="row" id="agent-form" style="gap:8px;flex-wrap:wrap">
          <label class="field" style="flex:1;min-width:200px">New agent name<input type="text" name="name" placeholder="e.g. press-shop-edge" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,62}" title="Letters, digits, dot, dash or underscore; up to 63" required /></label>
          <div style="align-self:end"><button class="btn primary" type="submit">Register agent</button></div>
        </form>`
          : ''
      }
    </div>`;
}

// Each connector's name and status; the detail (e.g. why it is down) is in the tooltip.
export function connectorList(a: EdgeAgent): string {
  if (!a.connectors.length) return '—';
  const tone = { ok: 'good', degraded: 'warn', down: 'bad' } as const;
  return a.connectors
    .map(
      (c) =>
        `<span class="badge ${tone[c.status]}" title="${esc(`${c.kind}: ${c.detail}`)}">${esc(c.name)} ${esc(c.status)}</span>`,
    )
    .join(' ');
}

// Readings waiting on the agent's disk for Tiles; the counters and any problem are in the tooltip.
export function bufferSummary(a: Pick<EdgeAgent, 'buffer'>): string {
  const b = a.buffer;
  if (!b) return '—';
  const tone = b.dropped > 0 ? 'bad' : b.problem ? 'warn' : 'good';
  const since = b.oldest_at ? `, oldest from ${new Date(b.oldest_at).toLocaleString('en-GB')}` : '';
  const counts = `${b.sent} sent, ${b.dropped} dropped (buffer full or not writable), ${b.rejected} rejected by Tiles`;
  const title = `${b.queued} waiting${since}. ${counts}.${b.problem ? ` ${b.problem}` : ''}`;
  return `<span class="badge ${tone}" title="${esc(title)}">${esc(b.queued.toLocaleString('en-GB'))} queued</span>`;
}

function agentStatus(a: EdgeAgent): string {
  const tone = a.status === 'online' ? 'good' : a.status === 'offline' ? 'bad' : '';
  return `<span class="badge ${tone}">${esc(a.status)}</span>`;
}

function showToken(root: HTMLElement, ctx: Context): void {
  const box = root.querySelector('[data-agent-token]');
  if (!box) return;
  const admin = ctx.ontology.role === 'admin';
  if (!tokenStillShown(revealed, ctx.api?.baseUrl, ctx.ontology.site?.id, admin, viewer(ctx))) revealed = null;
  if (!revealed) {
    box.innerHTML = '';
    return;
  }
  const config = `[tiles]\nurl = "${revealed.apiUrl}"\ntoken_file = "token"\n\n[agent]\nheartbeat_seconds = 30`;
  box.innerHTML = `<div class="stack" style="gap:8px">
      <p><b>Token for ${esc(revealed.name)}.</b> Copy it now: Tiles keeps only its hash and won't show it again. Save it as <code>token</code> next to the agent's config file, readable only by the agent.</p>
      <pre class="code-block" data-token>${esc(revealed.token)}</pre>
      <p class="small soft">Config file (<code>tiles-edge.toml</code>):</p>
      <pre class="code-block">${esc(config)}</pre>
      <div><button class="btn" type="button" data-token-done>Done, I've saved it</button></div>
    </div>`;
  onAll(box, '[data-token-done]', 'click', () => {
    revealed = null;
    showToken(root, ctx);
  });
}

async function fillAgents(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-agent-rows]');
  const site = ctx.ontology.site;
  const api = ctx.api;
  if (!box || !site || !api) return;
  const admin = ctx.ontology.role === 'admin';
  let agents: EdgeAgent[];
  try {
    agents = await api.agents.list(site.id);
  } catch {
    box.innerHTML = '<p class="small soft">The agents could not be loaded.</p>';
    return;
  }
  box.innerHTML = agents.length
    ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Status</th><th>Last heartbeat</th><th>Host</th><th>Version</th><th>Connectors</th><th>Buffer</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>${agents
        .map(
          (a) =>
            `<tr><td>${esc(a.name)}</td><td>${agentStatus(a)}</td><td>${a.last_seen_at ? esc(new Date(a.last_seen_at).toLocaleString('en-GB')) : '—'}</td><td>${esc(a.hostname ?? '—')}</td><td>${esc(a.version ?? '—')}</td><td>${connectorList(a)}</td><td>${bufferSummary(a)}</td>${
              admin
                ? `<td><button class="btn sm danger" type="button" data-revoke-agent="${esc(a.id)}" data-agent-name="${esc(a.name)}">Revoke</button></td>`
                : ''
            }</tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p class="small soft">No agents registered for this site yet.</p>';
  onAll(box, '[data-revoke-agent]', 'click', (el) => {
    const name = el.dataset.agentName ?? '';
    if (!confirm(`Revoke ${name}? Its token stops working at once.`)) return;
    api.agents.revoke(site.id, el.dataset.revokeAgent ?? '').then(
      () => {
        ctx.toast(`Revoked ${name}`);
        return fillAgents(root, ctx);
      },
      () => undefined, // the client already showed why
    );
  });
}

function bindAgents(root: HTMLElement, ctx: Context): void {
  const site = ctx.ontology.site;
  const api = ctx.api;
  if (!site || !api || !root.querySelector('#agents')) return;
  showToken(root, ctx);
  void fillAgents(root, ctx);
  onSubmit(root, '#agent-form', (form) => {
    const name = field(form, 'name').trim();
    api.agents.register(site.id, name).then(
      ({ token }) => {
        revealed = { name, token, apiUrl: api.baseUrl, siteId: site.id, user: viewer(ctx) };
        form.reset();
        showToken(root, ctx);
        return fillAgents(root, ctx);
      },
      () => undefined, // the client already showed why
    );
  });
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
          <p class="small soft" data-api-status aria-live="polite">${esc(apiCheck)}</p>
        </form>
        ${ds.mode === 'api' ? accountCard(ctx) : ''}
        ${ctx.ontology.site ? agentsCard(ctx.ontology.role === 'admin') : ''}
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
      apiCheck = '';
      ctx.setDataSource({ mode, apiUrl: isHttpUrl(apiUrl) ? apiUrl : ctx.dataSource.apiUrl });
      ctx.toast(mode === 'api' ? 'Using the Tiles API' : 'Using this browser only');
    });
    onAll(root, '[data-test-api]', 'click', async () => {
      const url = field(need<HTMLFormElement>(root, '#datasource'), 'apiUrl');
      const seq = ++apiCheckSeq;
      // The page may have been re-rendered meanwhile: write to the status line shown now.
      const show = (text: string) => {
        if (seq !== apiCheckSeq) return; // a later check answers instead
        apiCheck = text;
        const status = document.querySelector('#view [data-api-status]');
        if (status) status.textContent = text;
      };
      show('Checking…');
      try {
        const h = await createApiClient({ baseUrl: url, onError: (e) => ctx.toast(e.message) }).health();
        show(
          isTilesHealth(h)
            ? `Connected: Tiles API ${h.version} (${h.env})`
            : 'Something answered there, but it is not the Tiles API',
        );
      } catch {
        show('Not reachable');
      }
    });
    if (ctx.ontology.role === 'admin') void fillAudit(root, ctx);
    bindAgents(root, ctx);
    onAll(root, '[data-sign-in]', 'click', () => void ctx.auth.signIn());
    onAll(root, '[data-sign-out]', 'click', () => void ctx.auth.signOut());
    onAll(root, '[data-reset]', 'click', () => {
      if (confirm('Reset ontology history, design runs and chat to the demo defaults?')) ctx.reset();
    });
  },
};

export default view;
