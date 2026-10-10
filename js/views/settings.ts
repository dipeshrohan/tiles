import { esc, field, fmt, need, onAll, onSubmit, onNavigate, routeOf, bound } from '../lib/dom.ts';
import {
  createApiClient,
  isHttpUrl,
  isTilesHealth,
  normalizeBaseUrl,
  type AuditEntry,
  type CopilotUsage,
  type Delivery,
  type EdgeAgent,
  type NotificationPrefs,
  type TeamsChannel,
} from '../lib/api.ts';
import { budgetToday, cacheShare, duration, percent, tokens, usageTotals } from '../lib/copilot-usage.ts';
import { bindOrgSignIn, orgSignInCard } from './org-sign-in.ts';
import { bindUx, uxCard } from './ux-analytics.ts';
import type { Context, View } from './types.ts';
import { emptyState, linkButton, pageHead, skeleton, loadFailed } from '../lib/ui.ts';
import { confirmDialog } from '../lib/overlay.ts';

// Sign-in to the Tiles API, shown in API mode.
function accountCard(ctx: Context): string {
  const { config, signedIn } = ctx.auth;
  const { user } = ctx.state;
  let body: string;
  // An organisation with its own identity provider (T5.05) signs in through it, by its slug.
  const orgForm = `<form class="row gap-2 wrap" id="org-sign-in-form">
      <label class="field grow min-w-field">Or with your organisation's own sign-in<input type="text" name="org" value="${esc(ctx.auth.signInOrg)}" placeholder="your organisation, e.g. acme" pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,62}" required /></label>
      <div class="self-end"><button class="btn" type="submit">Sign in with it</button></div>
    </form>`;
  if (!config) body = '<p class="small soft">Checking how this API signs people in…</p>';
  else if (signedIn)
    body = `<p>Signed in as <b>${esc(user.name)}</b> <span class="soft">(${esc(user.email)})</span>${
      ctx.auth.signInOrg ? ` through <b>${esc(ctx.auth.signInOrg)}</b>'s own sign-in` : ''
    }</p>
      <div><button class="btn" type="button" data-sign-out>Sign out</button></div>`;
  else if (!config.enabled)
    body = `<p class="small soft">This API has no sign-in of its own; requests act as the development user.</p>${orgForm}`;
  else
    body = `<p class="small soft">${
      config.dev_identity
        ? 'Not signed in: until you sign in, you act as the development user.'
        : 'Sign in to use this Tiles API.'
    }</p>
      <div><button class="btn primary" type="button" data-sign-in>Sign in</button></div>${orgForm}`;
  return `<div class="card stack gap-3" id="account"><h2>Account</h2>${body}</div>`;
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
  return `<div class="card stack gap-3 span-all" id="audit">
      <h2>Audit log</h2>
      <p class="small soft">Every change on this site: who, what and when. Only site admins see this.</p>
      <div data-audit-rows aria-live="polite">${skeleton.table(4, 4, 'Loading the audit log…')}</div>
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
      : emptyState({
          compact: true,
          level: 3,
          title: 'No changes yet',
          body: 'Each change to the site (a commit, a signal edit, a member’s role) is listed here with who made it.',
        });
  } catch {
    box.innerHTML = loadFailed('The audit log');
  }
}

function copilotUsageCard(): string {
  return `<div class="card stack gap-3 span-all" id="copilot-usage">
      <h2>Copilot usage</h2>
      <p class="small soft">Questions asked on this site over the last 30 days (UTC), the tokens they used and how long answers took. Tokens are weighted by price, in input tokens: an output token counts five, a prompt-cache write one and a quarter, a cache read a tenth. Only site admins see this.</p>
      <div data-copilot-usage aria-live="polite">${skeleton.text(3, 'Loading the usage…')}</div>
    </div>`;
}

function usageHtml(u: CopilotUsage): string {
  const t = usageTotals(u);
  const b = budgetToday(u);
  const l = u.limits;
  const limit = (n: number, what: string) => (n ? `${fmt(n)} ${what}` : `no limit on ${what}`);
  const budget =
    b.limit === null
      ? `Today the organisation has used ${esc(tokens(b.used))} tokens (no daily limit).`
      : `Today the organisation has used ${esc(tokens(b.used))} of its ${esc(tokens(b.limit))} tokens (${esc(percent(b.share))}); this site ${esc(tokens(u.today.site_billed_tokens))}.`;
  const days = u.days.length
    ? `<div class="table-wrap"><table><thead><tr><th>Day</th><th>Questions</th><th>Answered</th><th>Failed</th><th>Over budget</th><th>Ungrounded</th><th>Tokens</th><th>From cache</th><th>First text (median · 95%)</th><th>Whole answer (median · 95%)</th></tr></thead><tbody>${u.days
        .map(
          (d) =>
            `<tr><td>${esc(d.day)}</td><td>${fmt(d.questions)}</td><td>${fmt(d.answered)}</td><td>${fmt(d.failed)}</td><td>${fmt(d.over_budget)}</td><td>${fmt(d.ungrounded)}</td><td>${esc(tokens(d.billed_tokens))}</td><td>${esc(percent(cacheShare(d)))}</td><td>${esc(duration(d.first_text_p50_ms))} · ${esc(duration(d.first_text_p95_ms))}</td><td>${esc(duration(d.total_p50_ms))} · ${esc(duration(d.total_p95_ms))}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : emptyState({
        compact: true,
        level: 3,
        title: 'No questions in the last 30 days',
        bodyHtml: 'Questions asked on the <a href="#/chat">Copilot</a> page are counted here, by day and by person.',
      });
  const users = u.users.length
    ? `<div class="table-wrap"><table><thead><tr><th>Who</th><th>Questions</th><th>Tokens</th></tr></thead><tbody>${u.users
        .map(
          (p) =>
            `<tr><td>${esc(p.user)} <span class="soft small">${esc(p.email)}</span></td><td>${fmt(p.questions)}</td><td>${esc(tokens(p.billed_tokens))}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '';
  return `<p data-copilot-budget>${budget}</p>
    <div class="row gap-6 wrap" data-copilot-totals>
      <div><div class="small soft">Questions</div><strong>${fmt(t.questions)}</strong></div>
      <div><div class="small soft">Answered</div><strong>${fmt(t.answered)}</strong></div>
      <div><div class="small soft">Failed</div><strong>${fmt(t.failed)}</strong></div>
      <div><div class="small soft">Over budget</div><strong>${fmt(t.overBudget)}</strong></div>
      <div><div class="small soft">Tokens</div><strong>${esc(tokens(t.billed))}</strong></div>
      <div><div class="small soft">From cache</div><strong>${esc(percent(t.cacheShare))}</strong></div>
    </div>
    ${days}${users}
    <p class="small soft">Limits: ${esc(limit(l.org_questions_per_minute, 'questions a minute per organisation'))}; ${esc(limit(l.user_questions_per_minute, 'questions a minute per person'))}; ${esc(limit(l.org_daily_tokens, 'tokens a day per organisation'))}; ${esc(limit(l.question_tokens, 'tokens per question'))}. Set with the API's TILES_COPILOT_* variables.</p>`;
}

async function fillCopilotUsage(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-copilot-usage]');
  const site = ctx.ontology.site;
  if (!box || !site || !ctx.api) return;
  try {
    box.innerHTML = usageHtml(await ctx.api.copilot.usage(site.id, 30));
  } catch {
    box.innerHTML = loadFailed('Copilot usage');
  }
}

// The copilot on this site (threat model G-A4): admins turn it on, knowing what it sends.
function copilotPolicyCard(): string {
  return `<div class="card stack gap-3" id="copilot-policy">
      <h2>Copilot on this site</h2>
      <p class="small soft">When it is on, each question, and the site's data the copilot reads to answer it (only what the person asking may see), goes to Anthropic's API under your deployment's terms. Nothing is sent while it is off: the Copilot page answers with its built-in skills on the demo data.</p>
      <label class="row gap-2"><input type="checkbox" name="copilot-enabled" data-copilot-enabled disabled /> Use the copilot on this site</label>
      <p class="small soft" data-copilot-policy aria-live="polite">Loading…</p>
    </div>`;
}

async function bindCopilotPolicy(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector<HTMLInputElement>('[data-copilot-enabled]');
  const note = root.querySelector('[data-copilot-policy]');
  const site = ctx.ontology.site;
  if (!box || !note || !site || !ctx.api) return;
  const api = ctx.api;
  const show = (s: { configured: boolean; enabled: boolean }) => {
    box.checked = s.enabled;
    box.disabled = false;
    note.textContent = `${s.enabled ? 'On' : 'Off'} for this site.${s.configured ? '' : ' The copilot service is not set up on this Tiles API yet (TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL), so it answers nothing until it is.'}`;
  };
  try {
    show(await api.copilot.status(site.id));
  } catch {
    note.textContent = 'Whether the copilot is on could not be loaded.';
    return;
  }
  box.addEventListener(
    'change',
    async () => {
      const wanted = box.checked;
      box.disabled = true;
      try {
        show(await api.copilot.setEnabled(site.id, wanted));
        ctx.toast(wanted ? 'The copilot is on for this site' : 'The copilot is off for this site');
      } catch {
        box.checked = !wanted;
        box.disabled = false;
      }
    },
    { signal: bound() },
  );
}

function notificationsCard(ctx: Context): string {
  const role = ctx.ontology.role;
  const canChoose = role === 'engineer' || role === 'admin';
  const mine = canChoose
    ? `<form class="stack gap-2" id="notify-prefs" aria-live="polite">
        <p class="small soft" data-notify-email>Loading…</p>
        <label class="row gap-2"><input type="checkbox" name="on_assigned" disabled /> A warning someone assigns to me</label>
        <label class="row gap-2"><input type="checkbox" name="on_raised" disabled /> Every new warning on this site</label>
        <div><button class="btn primary" type="submit" disabled>Save</button></div>
      </form>`
    : '<p class="small soft">Engineers and admins of the site choose which warnings they hear about.</p>';
  const teams =
    role === 'admin'
      ? `<form class="stack gap-2" id="teams-form">
        <h3>Microsoft Teams channel</h3>
        <p class="small soft" data-teams-status>Loading…</p>
        <label class="field">Webhook URL (from the channel's Workflows, or an incoming webhook; leave it empty to keep the one set)<input type="url" name="url" placeholder="https://….webhook.office.com/…" autocomplete="off" /></label>
        <label class="row gap-2"><input type="checkbox" name="on_raised" checked /> Post every new warning there</label>
        <div class="row gap-2"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-teams-remove>Remove the channel</button></div>
      </form>
      <h3>Recent messages</h3>
      <div data-deliveries aria-live="polite">${skeleton.table(3, 4, 'Loading the deliveries…')}</div>`
      : '';
  return `<div class="card stack gap-3 span-all" id="notifications">
      <h2>Notifications</h2>
      <p class="small soft">Emails about warnings on this site, sent by the Tiles API's <code>tiles-notify</code> job.</p>
      ${mine}
      ${teams}
    </div>`;
}

export function deliveryState(d: Pick<Delivery, 'sent_at' | 'failed_at' | 'attempts' | 'last_error'>): string {
  if (d.sent_at) return '<span class="badge good">Sent</span>';
  if (d.failed_at) return `<span class="badge bad" title="${esc(d.last_error ?? '')}">Gave up</span>`;
  if (d.attempts) return `<span class="badge warn" title="${esc(d.last_error ?? '')}">Retrying</span>`;
  return '<span class="badge">Waiting</span>';
}

// Choices made but not yet saved, kept across re-renders (the page re-renders as the API answers),
// for whoever made them, on the site and API they were made on; dropped on leaving the page.
interface NotifyDraft {
  key: string;
  on_raised?: boolean;
  on_assigned?: boolean;
  url?: string;
  teams_on_raised?: boolean;
}
let notifyDraft: NotifyDraft = { key: '' };
// Leaving the page drops what was typed and not saved (the router reads routes in any case).
onNavigate((hash) => {
  if (routeOf(hash) === 'settings') return;
  notifyDraft = { key: '' };
  sourceDraft = null;
});

async function fillNotifications(root: HTMLElement, ctx: Context): Promise<void> {
  const site = ctx.ontology.site;
  const api = ctx.api;
  if (!site || !api || !root.querySelector('#notifications')) return;
  const key = `${api.baseUrl}|${site.id}|${viewer(ctx)}`;
  if (notifyDraft.key !== key) notifyDraft = { key };
  const draft = notifyDraft;
  const prefsForm = root.querySelector<HTMLFormElement>('#notify-prefs');
  if (prefsForm) {
    const box = (name: string) => need<HTMLInputElement>(prefsForm, `[name=${name}]`);
    const show = (p: NotificationPrefs) => {
      need(prefsForm, '[data-notify-email]').textContent = `Emails go to ${p.email}. Send me:`;
      box('on_raised').checked = draft.on_raised ?? p.on_raised;
      box('on_assigned').checked = draft.on_assigned ?? p.on_assigned;
      for (const el of prefsForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
        el.disabled = false;
    };
    for (const name of ['on_raised', 'on_assigned'] as const)
      box(name).addEventListener('change', () => (draft[name] = box(name).checked), { signal: bound() });
    api.notifications.preferences(site.id).then(show, () => {
      need(prefsForm, '[data-notify-email]').textContent = 'Your preferences could not be loaded.';
    });
    onSubmit(root, '#notify-prefs', () => {
      const prefs = { on_raised: box('on_raised').checked, on_assigned: box('on_assigned').checked };
      return api.notifications.setPreferences(site.id, prefs).then(
        (p) => {
          delete draft.on_raised;
          delete draft.on_assigned;
          show(p);
          ctx.toast('Notification preferences saved');
        },
        () => undefined, // the client showed why
      );
    });
  }
  const teamsForm = root.querySelector<HTMLFormElement>('#teams-form');
  if (!teamsForm) return;
  const status = need(teamsForm, '[data-teams-status]');
  let configured = false;
  const showTeams = (t: TeamsChannel) => {
    configured = t.configured;
    status.textContent = t.configured
      ? `Connected to a channel at ${t.host}${t.on_raised ? ', which hears of every new warning' : ', posting nothing for now'}. Paste a new URL to change it.`
      : 'No channel yet.';
    need<HTMLInputElement>(teamsForm, '[name=on_raised]').checked = draft.teams_on_raised ?? t.on_raised;
  };
  const urlBox = need<HTMLInputElement>(teamsForm, '[name=url]');
  const onRaisedBox = need<HTMLInputElement>(teamsForm, '[name=on_raised]');
  urlBox.value = draft.url ?? '';
  if (draft.teams_on_raised !== undefined) onRaisedBox.checked = draft.teams_on_raised;
  urlBox.addEventListener('input', () => (draft.url = urlBox.value), { signal: bound() });
  onRaisedBox.addEventListener('change', () => (draft.teams_on_raised = onRaisedBox.checked), { signal: bound() });
  api.notifications.teams(site.id).then(showTeams, () => (status.textContent = 'The channel could not be loaded.'));
  const save = (url: string | null | undefined) =>
    api.notifications.setTeams(site.id, url, need<HTMLInputElement>(teamsForm, '[name=on_raised]').checked).then(
      (t) => {
        delete draft.url;
        delete draft.teams_on_raised;
        teamsForm.reset();
        showTeams(t);
        ctx.toast(
          url === undefined ? 'Teams channel updated' : t.configured ? 'Teams channel saved' : 'Teams channel removed',
        );
      },
      () => undefined, // the client showed why
    );
  onSubmit(root, '#teams-form', (form) => {
    const url = field(form, 'url').trim();
    if (!url && !configured) {
      ctx.toast('Paste the channel’s webhook URL');
      return;
    }
    return save(url || undefined); // no URL: keep the channel, change only what it hears of
  });
  onAll(root, '[data-teams-remove]', 'click', async () => {
    const yes = await confirmDialog({
      title: 'Stop posting to the Teams channel?',
      body: 'Warnings stop going to the channel. Its address isn’t kept: to post again, set it again.',
      confirm: 'Stop posting',
      tone: 'danger',
    });
    if (yes) void save(null);
  });
  const list = root.querySelector('[data-deliveries]');
  if (!list) return;
  try {
    const rows = await api.notifications.deliveries(site.id, { limit: 20 });
    list.innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>What</th><th>To</th><th>State</th><th>Why</th></tr></thead><tbody>${rows
          .map(
            (d) =>
              `<tr><td>${esc(new Date(d.created_at).toLocaleString('en-GB'))}</td><td>${d.kind === 'warning_raised' ? 'New warning' : 'Assigned'} · <span class="mono">${esc(d.signal_tag)}</span></td><td>${esc(d.recipient)}</td><td>${deliveryState(d)}</td><td class="small">${esc(d.sent_at ? '' : (d.last_error ?? ''))}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : emptyState({
          compact: true,
          level: 4,
          title: 'Nothing sent yet',
          body: 'Messages appear here when a warning is raised or assigned to someone who asked to hear of it.',
        });
  } catch {
    list.innerHTML = loadFailed('The messages', 4);
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
// The data source as typed and not yet saved, and the saved one it was typed against: a re-render
// must not wipe an address being typed or a choice being made, but a source saved some other way
// (signing in, a ?api= link) replaces it.
let sourceDraft: { base: string; mode: 'local' | 'api'; apiUrl: string } | null = null;
const sourceKey = (ds: { mode: string; apiUrl: string }): string => `${ds.mode}|${ds.apiUrl}`;

function readSource(form: HTMLFormElement): { mode: 'local' | 'api'; apiUrl: string } {
  const mode = (form.elements.namedItem('mode') as RadioNodeList).value === 'api' ? 'api' : 'local';
  return { mode, apiUrl: field(form, 'apiUrl') };
}

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
  return `<div class="card stack gap-3 span-all" id="agents">
      <h2>Edge agents</h2>
      <p class="small soft">Agents run on the plant network and send data out to Tiles; they open no ports. Each one reports a heartbeat, so you can see whether it is online. See <code>edge/README.md</code> to install one.</p>
      <div data-agent-token aria-live="polite"></div>
      <div data-agent-rows aria-live="polite">${skeleton.table(2, 5, 'Loading the edge agents…')}</div>
      ${
        admin
          ? `<form class="row gap-2 wrap" id="agent-form">
          <label class="field grow min-w-field">New agent name<input type="text" name="name" placeholder="e.g. press-shop-edge" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,62}" title="Letters, digits, dot, dash or underscore; up to 63" required /></label>
          <div class="self-end"><button class="btn primary" type="submit">Register agent</button></div>
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
  box.innerHTML = `<div class="stack gap-2">
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
    box.innerHTML = loadFailed('The agents');
    return;
  }
  box.innerHTML = agents.length
    ? `<div class="table-wrap"><table><thead><tr><th>Agent</th><th>Status</th><th>Last heartbeat</th><th>Host</th><th>Version</th><th>Connectors</th><th>Buffer</th>${admin ? '<th><span class="sr-only">Actions</span></th>' : ''}</tr></thead><tbody>${agents
        .map(
          (a) =>
            `<tr><td>${esc(a.name)}</td><td>${agentStatus(a)}</td><td>${a.last_seen_at ? esc(new Date(a.last_seen_at).toLocaleString('en-GB')) : '—'}</td><td>${esc(a.hostname ?? '—')}</td><td>${esc(a.version ?? '—')}</td><td>${connectorList(a)}</td><td>${bufferSummary(a)}</td>${
              admin
                ? `<td><button class="btn sm danger" type="button" data-revoke-agent="${esc(a.id)}" data-agent-name="${esc(a.name)}">Revoke</button></td>`
                : ''
            }</tr>`,
        )
        .join('')}</tbody></table></div>`
    : emptyState({
        compact: true,
        level: 3,
        title: 'No edge agents yet',
        body: admin
          ? 'Register one below, then put its token in the agent’s config on the plant network. It connects out to Tiles; nothing connects in.'
          : 'An admin of this site registers edge agents; they send the plant’s readings to Tiles.',
      });
  onAll(box, '[data-revoke-agent]', 'click', async (el) => {
    const name = el.dataset.agentName ?? '';
    const yes = await confirmDialog({
      title: `Revoke ${name}?`,
      body: 'Its token stops working at once, and the agent stops sending readings.',
      confirm: 'Revoke',
      tone: 'danger',
    });
    if (!yes) return;
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
    return api.agents.register(site.id, name).then(
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
  icon: 'settings',
  render(ctx) {
    const { user } = ctx.state;
    const ds = ctx.dataSource;
    // The form shows what is being typed; the page follows what is saved.
    const typed = sourceDraft?.base === sourceKey(ds) ? sourceDraft : ds;
    return `
      ${pageHead({ eyebrow: 'Workspace', title: 'Settings' })}
      <div class="grid g2">
        <form class="card stack gap-3" id="profile">
          <h2>Profile</h2>
          <p class="small soft">Your name and email are recorded as the author of ontology commits and design runs.</p>
          <label class="field">Name<input type="text" name="name" value="${esc(user.name)}" required /></label>
          <label class="field">Email<input type="text" name="email" value="${esc(user.email)}" required /></label>
          <div><button class="btn primary" type="submit">Save</button></div>
        </form>
        <div class="card stack gap-3">
          <h2>Demo data</h2>
          <p class="small soft">Plant data (cutter batches, welder power, die-cast shots) is synthetic and regenerated from fixed seeds. Your ontology commits, design runs and chat are saved in this browser.</p>
          <div><button class="btn danger" data-reset>Reset workspace</button></div>
        </div>
        <form class="card stack gap-3" id="datasource">
          <h2>Data source</h2>
          <p class="small soft">Keep data in this browser, or share it through the Tiles API (<code>docker compose up</code> starts one on port 8000). Pages move to the API one at a time.</p>
          <label class="row gap-2"><input type="radio" name="mode" value="local" ${typed.mode === 'local' ? 'checked' : ''} /> This browser only</label>
          <label class="row gap-2"><input type="radio" name="mode" value="api" ${typed.mode === 'api' ? 'checked' : ''} /> Tiles API</label>
          <label class="field">API address<input type="url" name="apiUrl" value="${esc(typed.apiUrl)}" placeholder="http://localhost:8000" /></label>
          <div class="row gap-2"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" data-test-api>Test connection</button></div>
          <p class="small soft" data-api-status aria-live="polite">${esc(apiCheck)}</p>
        </form>
        ${ds.mode === 'api' ? accountCard(ctx) : ''}
        ${ds.mode === 'api' ? orgSignInCard() : ''}
        ${ctx.ontology.site ? notificationsCard(ctx) : ''}
        ${ctx.ontology.site ? agentsCard(ctx.ontology.role === 'admin') : ''}
        ${ctx.ontology.role === 'admin' && ctx.ontology.site ? copilotPolicyCard() : ''}
        ${ctx.ontology.role === 'admin' ? copilotUsageCard() : ''}
        ${ds.mode === 'api' ? uxCard() : ''}
        ${ctx.ontology.role === 'admin' ? auditCard() : ''}
        <div class="card stack gap-3" id="about">
          <h2>About</h2>
          <p class="small soft">Tiles works from this browser on its own, or with the Tiles API for a shared site. Press Ctrl K (⌘ K on a Mac) or / to find any page or action.</p>
          <div>${linkButton('Style guide', '#/styleguide', { icon: 'palette' })}</div>
        </div>
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
      const { mode, apiUrl: typedUrl } = readSource(form);
      const apiUrl = normalizeBaseUrl(typedUrl);
      // Only API mode needs an address; local mode keeps the last good one.
      if (mode === 'api' && !isHttpUrl(apiUrl)) {
        ctx.toast('Enter the API address, e.g. http://localhost:8000');
        return;
      }
      apiCheck = '';
      sourceDraft = null;
      ctx.setDataSource({ mode, apiUrl: isHttpUrl(apiUrl) ? apiUrl : ctx.dataSource.apiUrl });
      ctx.toast(mode === 'api' ? 'Using the Tiles API' : 'Using this browser only');
    });
    const source = need<HTMLFormElement>(root, '#datasource');
    source.addEventListener(
      'input',
      () => {
        sourceDraft = { base: sourceKey(ctx.dataSource), ...readSource(source) };
      },
      { signal: bound() },
    );
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
    if (ctx.ontology.role === 'admin') {
      void bindCopilotPolicy(root, ctx);
      void fillCopilotUsage(root, ctx);
      void fillAudit(root, ctx);
    }
    bindAgents(root, ctx);
    void fillNotifications(root, ctx);
    onAll(root, '[data-sign-in]', 'click', () => void ctx.auth.signIn());
    onSubmit(root, '#org-sign-in-form', (form) => ctx.auth.signIn(field(form, 'org')));
    onAll(root, '[data-sign-out]', 'click', () => void ctx.auth.signOut());
    void bindOrgSignIn(root, ctx);
    void bindUx(root, ctx);
    onAll(root, '[data-reset]', 'click', async () => {
      const yes = await confirmDialog({
        title: 'Reset this browser’s workspace?',
        body: 'Ontology history, design runs and chat go back to the demo defaults. This can’t be undone.',
        confirm: 'Reset workspace',
        tone: 'danger',
        typeToConfirm: 'reset',
      });
      if (yes) ctx.reset();
    });
  },
};

export default view;
