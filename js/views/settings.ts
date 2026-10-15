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
import { bindFeedback, feedbackCard } from './feedback-admin.ts';
import type { Context, View } from './types.ts';
import { emptyState, linkButton, pageHead, skeleton, loadFailed } from '../lib/ui.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { bindTable, dataTable, type TableOptions } from '../lib/data-table.ts';
import { t, tHtml, type MessageKey } from '../lib/i18n.ts';
import { dateTime } from '../lib/format.ts';

const AUDIT_ROWS = 200; // the latest changes, in pages of 25

// Names of files, commands and examples, written as they are.
const NOTIFY_JOB = 'tiles-notify'; // i18n-ok
const TEAMS_EXAMPLE = 'https://….webhook.office.com/…'; // i18n-ok
const EDGE_README = 'edge/README.md'; // i18n-ok
const TOKEN_FILE = 'token'; // i18n-ok
const CONFIG_FILE = 'tiles-edge.toml'; // i18n-ok
const COMPOSE_UP = 'docker compose up'; // i18n-ok
const API_EXAMPLE = 'http://localhost:8000'; // i18n-ok

// Sign-in to the Tiles API, shown in API mode.
function accountCard(ctx: Context): string {
  const { config, signedIn } = ctx.auth;
  const { user } = ctx.state;
  let body: string;
  // An organisation with its own identity provider (T5.05) signs in through it, by its slug.
  const orgForm = `<form class="row gap-2 wrap" id="org-sign-in-form">
      <label class="field grow min-w-field">${esc(t('settings.account.orgLabel'))}<input type="text" name="org" value="${esc(ctx.auth.signInOrg)}" placeholder="${esc(t('settings.account.orgPlaceholder'))}" pattern="[A-Za-z0-9][A-Za-z0-9\\-]{0,62}" required /></label>
      <div class="self-end"><button class="btn" type="submit">${esc(t('settings.account.orgSubmit'))}</button></div>
    </form>`;
  if (!config) body = `<p class="small soft">${esc(t('settings.account.checking'))}</p>`;
  else if (signedIn)
    body = `<p>${tHtml(ctx.auth.signInOrg ? 'settings.account.signedInThrough' : 'settings.account.signedIn', {
      name: `<b>${esc(user.name)}</b>`,
      email: `<span class="soft">(${esc(user.email)})</span>`,
      org: `<b>${esc(ctx.auth.signInOrg)}</b>`,
    })}</p>
      <div><button class="btn" type="button" data-sign-out>${esc(t('settings.account.signOut'))}</button></div>`;
  else if (!config.enabled) body = `<p class="small soft">${esc(t('settings.account.noSignIn'))}</p>${orgForm}`;
  else
    body = `<p class="small soft">${esc(t(config.dev_identity ? 'settings.account.devUser' : 'settings.account.signInFirst'))}</p>
      <div><button class="btn primary" type="button" data-sign-in>${esc(t('settings.account.signIn'))}</button></div>${orgForm}`;
  return `<div class="card stack gap-3" id="account"><h2>${esc(t('settings.account.title'))}</h2>${body}</div>`;
}

// One line per change: what it did, in words.
export function describeAudit(e: AuditEntry): string {
  const ops = (v: unknown) => ((v as { ops?: unknown[] } | null)?.ops ?? []).length;
  const role = (v: unknown) => (v as { role?: string } | null)?.role ?? '?';
  switch (e.action) {
    case 'ontology.stage':
      return t('settings.audit.staged', { count: ops(e.after) });
    case 'ontology.discard':
      return t('settings.audit.discarded', { count: ops(e.before) });
    case 'ontology.commit':
      return t('settings.audit.committed', { message: (e.after as { message?: string } | null)?.message ?? '' });
    case 'ontology.revert':
      return t('settings.audit.reverted', { commit: (e.before as { reverted?: string } | null)?.reverted ?? '' });
    case 'member.role':
      return t('settings.audit.role', { from: role(e.before), to: role(e.after) });
    case 'agent.register':
      return t('settings.audit.agentRegistered', { name: (e.after as { name?: string } | null)?.name ?? '' });
    case 'agent.revoke':
      return t('settings.audit.agentRevoked', { name: (e.before as { name?: string } | null)?.name ?? '' });
    case 'signal.update': {
      const fields = Object.keys((e.after as Record<string, unknown> | null) ?? {}).filter((k) => k !== 'tag');
      const names: Record<string, MessageKey> = {
        node_id: 'settings.audit.field.nodeId',
        sample_rate_hz: 'settings.audit.field.sampleRate',
        range_min: 'settings.audit.field.rangeMin',
        range_max: 'settings.audit.field.rangeMax',
        stuck_after_s: 'settings.audit.field.stuckAfter',
      };
      const named = (f: string): string => {
        const key = names[f];
        return key ? t(key) : f;
      };
      return t('settings.audit.signal', {
        fields: fields.map(named).join(', '),
        tag: (e.after as { tag?: string } | null)?.tag ?? '',
      });
    }
    case 'signal.quality_check': {
      const a = e.after as { checked?: number; good?: number; warn?: number; bad?: number } | null;
      return t('settings.audit.quality', {
        count: a?.checked ?? 0,
        good: a?.good ?? 0,
        warn: a?.warn ?? 0,
        bad: a?.bad ?? 0,
      });
    }
    case 'import.start':
      return t('settings.audit.importStarted', { name: (e.after as { name?: string } | null)?.name ?? '' });
    case 'import.finish': {
      const a = e.after as { received?: number; stored?: number } | null;
      return t('settings.audit.importFinished', { stored: a?.stored ?? 0, received: a?.received ?? 0 });
    }
    default:
      return `${e.action} ${e.entity_type} ${e.entity_id}`;
  }
}

function auditCard(): string {
  return `<div class="card stack gap-3 span-all" id="audit">
      <h2>${esc(t('settings.audit.title'))}</h2>
      <p class="small soft">${esc(t('settings.audit.lead'))}</p>
      <div data-audit-rows aria-live="polite">${skeleton.table(4, 4, t('settings.audit.loading'))}</div>
    </div>`;
}

async function fillAudit(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-audit-rows]');
  const site = ctx.ontology.site;
  if (!box || !site || !ctx.api) return;
  try {
    const entries = await ctx.api.audit(site.id, { limit: AUDIT_ROWS });
    // A table of the latest changes (U5.02): sorted, in pages, exported as CSV.
    const o: TableOptions<AuditEntry> = {
      id: 'audit',
      label: t('settings.audit.title'),
      columns: [
        {
          key: 'at',
          label: t('settings.audit.col.when'),
          value: (e) => e.at,
          cell: (e) => esc(dateTime(e.at)),
        },
        { key: 'who', label: t('settings.audit.col.who'), value: (e) => e.actor_name, cell: (e) => esc(e.actor_name) },
        {
          key: 'what',
          label: t('settings.audit.col.what'),
          value: (e) => describeAudit(e),
          cell: (e) => esc(describeAudit(e)),
        },
        {
          key: 'request',
          label: t('settings.audit.col.request'),
          value: (e) => e.request_id ?? '',
          cell: (e) => `<code>${esc(e.request_id ?? '—')}</code>`,
        },
      ],
      rows: entries,
      key: (e) => String(e.id),
      empty: emptyState({
        compact: true,
        level: 3,
        title: t('settings.audit.emptyTitle'),
        body: t('settings.audit.emptyBody'),
      }),
      status: `<p class="small soft m-0">${esc(t('settings.audit.status', { count: entries.length, shown: fmt(entries.length) }))}</p>`,
      pageSize: 25,
      csv: 'audit-log.csv',
    };
    box.innerHTML = dataTable(o);
    bindTable(box, o);
  } catch {
    box.innerHTML = loadFailed(t('settings.audit.failed'));
  }
}

function copilotUsageCard(): string {
  return `<div class="card stack gap-3 span-all" id="copilot-usage">
      <h2>${esc(t('settings.usage.title'))}</h2>
      <p class="small soft">${esc(t('settings.usage.lead'))}</p>
      <div data-copilot-usage aria-live="polite">${skeleton.text(3, t('settings.usage.loading'))}</div>
    </div>`;
}

function usageHtml(u: CopilotUsage): string {
  const total = usageTotals(u);
  const b = budgetToday(u);
  const l = u.limits;
  const limit = (n: number, what: 'orgPerMinute' | 'userPerMinute' | 'orgDaily' | 'perQuestion') =>
    n ? t(`settings.usage.limit.${what}`, { n: fmt(n) }) : t(`settings.usage.noLimit.${what}`);
  const budget =
    b.limit === null
      ? esc(t('settings.usage.budgetNoLimit', { used: tokens(b.used) }))
      : esc(
          t('settings.usage.budget', {
            used: tokens(b.used),
            limit: tokens(b.limit),
            share: percent(b.share),
            site: tokens(u.today.site_billed_tokens),
          }),
        );
  const days = u.days.length
    ? `<div class="table-wrap"><table><thead><tr><th>${esc(t('settings.usage.col.day'))}</th><th>${esc(t('settings.usage.col.questions'))}</th><th>${esc(t('settings.usage.col.answered'))}</th><th>${esc(t('settings.usage.col.failed'))}</th><th>${esc(t('settings.usage.col.overBudget'))}</th><th>${esc(t('settings.usage.col.ungrounded'))}</th><th>${esc(t('settings.usage.col.tokens'))}</th><th>${esc(t('settings.usage.col.fromCache'))}</th><th>${esc(t('settings.usage.col.firstText'))}</th><th>${esc(t('settings.usage.col.wholeAnswer'))}</th></tr></thead><tbody>${u.days
        .map(
          (d) =>
            `<tr><td>${esc(d.day)}</td><td>${fmt(d.questions)}</td><td>${fmt(d.answered)}</td><td>${fmt(d.failed)}</td><td>${fmt(d.over_budget)}</td><td>${fmt(d.ungrounded)}</td><td>${esc(tokens(d.billed_tokens))}</td><td>${esc(percent(cacheShare(d)))}</td><td>${esc(duration(d.first_text_p50_ms))} · ${esc(duration(d.first_text_p95_ms))}</td><td>${esc(duration(d.total_p50_ms))} · ${esc(duration(d.total_p95_ms))}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : emptyState({
        compact: true,
        level: 3,
        title: t('settings.usage.emptyTitle'),
        bodyHtml: tHtml('settings.usage.emptyBody', {
          link: `<a href="#/chat">${esc(t('settings.usage.copilot'))}</a>`,
        }),
      });
  const users = u.users.length
    ? `<div class="table-wrap"><table><thead><tr><th>${esc(t('settings.usage.col.who'))}</th><th>${esc(t('settings.usage.col.questions'))}</th><th>${esc(t('settings.usage.col.tokens'))}</th></tr></thead><tbody>${u.users
        .map(
          (p) =>
            `<tr><td>${esc(p.user)} <span class="soft small">${esc(p.email)}</span></td><td>${fmt(p.questions)}</td><td>${esc(tokens(p.billed_tokens))}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '';
  return `<p data-copilot-budget>${budget}</p>
    <div class="row gap-6 wrap" data-copilot-totals>
      <div><div class="small soft">${esc(t('settings.usage.col.questions'))}</div><strong>${fmt(total.questions)}</strong></div>
      <div><div class="small soft">${esc(t('settings.usage.col.answered'))}</div><strong>${fmt(total.answered)}</strong></div>
      <div><div class="small soft">${esc(t('settings.usage.col.failed'))}</div><strong>${fmt(total.failed)}</strong></div>
      <div><div class="small soft">${esc(t('settings.usage.col.overBudget'))}</div><strong>${fmt(total.overBudget)}</strong></div>
      <div><div class="small soft">${esc(t('settings.usage.col.tokens'))}</div><strong>${esc(tokens(total.billed))}</strong></div>
      <div><div class="small soft">${esc(t('settings.usage.col.fromCache'))}</div><strong>${esc(percent(total.cacheShare))}</strong></div>
    </div>
    ${days}${users}
    <p class="small soft">${esc(
      t('settings.usage.limits', {
        orgPerMinute: limit(l.org_questions_per_minute, 'orgPerMinute'),
        userPerMinute: limit(l.user_questions_per_minute, 'userPerMinute'),
        orgDaily: limit(l.org_daily_tokens, 'orgDaily'),
        perQuestion: limit(l.question_tokens, 'perQuestion'),
      }),
    )}</p>`;
}

async function fillCopilotUsage(root: HTMLElement, ctx: Context): Promise<void> {
  const box = root.querySelector('[data-copilot-usage]');
  const site = ctx.ontology.site;
  if (!box || !site || !ctx.api) return;
  try {
    box.innerHTML = usageHtml(await ctx.api.copilot.usage(site.id, 30));
  } catch {
    box.innerHTML = loadFailed(t('settings.usage.title'));
  }
}

// The copilot on this site (threat model G-A4): admins turn it on, knowing what it sends.
function copilotPolicyCard(): string {
  return `<div class="card stack gap-3" id="copilot-policy">
      <h2>${esc(t('settings.policy.title'))}</h2>
      <p class="small soft">${esc(t('settings.policy.lead'))}</p>
      <label class="row gap-2"><input type="checkbox" name="copilot-enabled" data-copilot-enabled disabled /> ${esc(t('settings.policy.toggle'))}</label>
      <p class="small soft" data-copilot-policy aria-live="polite">${esc(t('settings.loading'))}</p>
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
    note.textContent = `${t(s.enabled ? 'settings.policy.on' : 'settings.policy.off')}${s.configured ? '' : ` ${t('settings.policy.notSetUp')}`}`;
  };
  try {
    show(await api.copilot.status(site.id));
  } catch {
    note.textContent = t('settings.policy.failed');
    return;
  }
  box.addEventListener(
    'change',
    async () => {
      const wanted = box.checked;
      box.disabled = true;
      try {
        show(await api.copilot.setEnabled(site.id, wanted));
        ctx.toast(t(wanted ? 'settings.policy.turnedOn' : 'settings.policy.turnedOff'));
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
        <p class="small soft" data-notify-email>${esc(t('settings.loading'))}</p>
        <label class="row gap-2"><input type="checkbox" name="on_assigned" disabled /> ${esc(t('settings.notify.onAssigned'))}</label>
        <label class="row gap-2"><input type="checkbox" name="on_raised" disabled /> ${esc(t('settings.notify.onRaised'))}</label>
        <div><button class="btn primary" type="submit" disabled>${esc(t('settings.save'))}</button></div>
      </form>`
    : `<p class="small soft">${esc(t('settings.notify.readOnly'))}</p>`;
  const teams =
    role === 'admin'
      ? `<form class="stack gap-2" id="teams-form">
        <h3>${esc(t('settings.teams.title'))}</h3>
        <p class="small soft" data-teams-status>${esc(t('settings.loading'))}</p>
        <label class="field">${esc(t('settings.teams.urlLabel'))}<input type="url" name="url" placeholder="${esc(TEAMS_EXAMPLE)}" autocomplete="off" /></label>
        <label class="row gap-2"><input type="checkbox" name="on_raised" checked /> ${esc(t('settings.teams.onRaised'))}</label>
        <div class="row gap-2"><button class="btn primary" type="submit">${esc(t('settings.save'))}</button><button class="btn" type="button" data-teams-remove>${esc(t('settings.teams.remove'))}</button></div>
      </form>
      <h3>${esc(t('settings.teams.recent'))}</h3>
      <div data-deliveries aria-live="polite">${skeleton.table(3, 4, t('settings.teams.loading'))}</div>`
      : '';
  return `<div class="card stack gap-3 span-all" id="notifications">
      <h2>${esc(t('settings.notify.title'))}</h2>
      <p class="small soft">${tHtml('settings.notify.lead', { job: `<code>${esc(NOTIFY_JOB)}</code>` })}</p>
      ${mine}
      ${teams}
    </div>`;
}

export function deliveryState(d: Pick<Delivery, 'sent_at' | 'failed_at' | 'attempts' | 'last_error'>): string {
  if (d.sent_at) return `<span class="badge good">${esc(t('settings.delivery.sent'))}</span>`;
  if (d.failed_at)
    return `<span class="badge bad" title="${esc(d.last_error ?? '')}">${esc(t('settings.delivery.gaveUp'))}</span>`;
  if (d.attempts)
    return `<span class="badge warn" title="${esc(d.last_error ?? '')}">${esc(t('settings.delivery.retrying'))}</span>`;
  return `<span class="badge">${esc(t('settings.delivery.waiting'))}</span>`;
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
      need(prefsForm, '[data-notify-email]').textContent = t('settings.notify.emailsGoTo', { email: p.email });
      box('on_raised').checked = draft.on_raised ?? p.on_raised;
      box('on_assigned').checked = draft.on_assigned ?? p.on_assigned;
      for (const el of prefsForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
        el.disabled = false;
    };
    for (const name of ['on_raised', 'on_assigned'] as const)
      box(name).addEventListener('change', () => (draft[name] = box(name).checked), { signal: bound() });
    api.notifications.preferences(site.id).then(show, () => {
      need(prefsForm, '[data-notify-email]').textContent = t('settings.notify.failed');
    });
    onSubmit(root, '#notify-prefs', () => {
      const prefs = { on_raised: box('on_raised').checked, on_assigned: box('on_assigned').checked };
      return api.notifications.setPreferences(site.id, prefs).then(
        (p) => {
          delete draft.on_raised;
          delete draft.on_assigned;
          show(p);
          ctx.toast(t('settings.notify.saved'));
        },
        () => undefined, // the client showed why
      );
    });
  }
  const teamsForm = root.querySelector<HTMLFormElement>('#teams-form');
  if (!teamsForm) return;
  const status = need(teamsForm, '[data-teams-status]');
  let configured = false;
  const showTeams = (ch: TeamsChannel) => {
    configured = ch.configured;
    status.textContent = ch.configured
      ? t(ch.on_raised ? 'settings.teams.connectedAll' : 'settings.teams.connectedNone', { host: ch.host ?? '' })
      : t('settings.teams.none');
    need<HTMLInputElement>(teamsForm, '[name=on_raised]').checked = draft.teams_on_raised ?? ch.on_raised;
  };
  const urlBox = need<HTMLInputElement>(teamsForm, '[name=url]');
  const onRaisedBox = need<HTMLInputElement>(teamsForm, '[name=on_raised]');
  urlBox.value = draft.url ?? '';
  if (draft.teams_on_raised !== undefined) onRaisedBox.checked = draft.teams_on_raised;
  urlBox.addEventListener('input', () => (draft.url = urlBox.value), { signal: bound() });
  onRaisedBox.addEventListener('change', () => (draft.teams_on_raised = onRaisedBox.checked), { signal: bound() });
  api.notifications.teams(site.id).then(showTeams, () => (status.textContent = t('settings.teams.failed')));
  const save = (url: string | null | undefined) =>
    api.notifications.setTeams(site.id, url, need<HTMLInputElement>(teamsForm, '[name=on_raised]').checked).then(
      (ch) => {
        delete draft.url;
        delete draft.teams_on_raised;
        teamsForm.reset();
        showTeams(ch);
        ctx.toast(
          t(
            url === undefined
              ? 'settings.teams.updated'
              : ch.configured
                ? 'settings.teams.saved'
                : 'settings.teams.removed',
          ),
        );
      },
      () => undefined, // the client showed why
    );
  onSubmit(root, '#teams-form', (form) => {
    const url = field(form, 'url').trim();
    if (!url && !configured) {
      ctx.toast(t('settings.teams.pasteUrl'));
      return;
    }
    return save(url || undefined); // no URL: keep the channel, change only what it hears of
  });
  onAll(root, '[data-teams-remove]', 'click', async () => {
    const yes = await confirmDialog({
      title: t('settings.teams.confirmTitle'),
      body: t('settings.teams.confirmBody'),
      confirm: t('settings.teams.confirm'),
      tone: 'danger',
    });
    if (yes) void save(null);
  });
  const list = root.querySelector('[data-deliveries]');
  if (!list) return;
  try {
    const rows = await api.notifications.deliveries(site.id, { limit: 20 });
    list.innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>${esc(t('settings.delivery.col.when'))}</th><th>${esc(t('settings.delivery.col.what'))}</th><th>${esc(t('settings.delivery.col.to'))}</th><th>${esc(t('settings.delivery.col.state'))}</th><th>${esc(t('settings.delivery.col.why'))}</th></tr></thead><tbody>${rows
          .map(
            (d) =>
              `<tr><td>${esc(dateTime(d.created_at))}</td><td>${esc(t(d.kind === 'warning_raised' ? 'settings.delivery.raised' : 'settings.delivery.assigned'))} · <span class="mono">${esc(d.signal_tag)}</span></td><td>${esc(d.recipient)}</td><td>${deliveryState(d)}</td><td class="small">${esc(d.sent_at ? '' : (d.last_error ?? ''))}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : emptyState({
          compact: true,
          level: 4,
          title: t('settings.delivery.emptyTitle'),
          body: t('settings.delivery.emptyBody'),
        });
  } catch {
    list.innerHTML = loadFailed(t('settings.delivery.failed'), 4);
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
      <h2>${esc(t('settings.agents.title'))}</h2>
      <p class="small soft">${tHtml('settings.agents.lead', { readme: `<code>${esc(EDGE_README)}</code>` })}</p>
      <div data-agent-token aria-live="polite"></div>
      <div data-agent-rows aria-live="polite">${skeleton.table(2, 5, t('settings.agents.loading'))}</div>
      ${
        admin
          ? `<form class="row gap-2 wrap" id="agent-form">
          <label class="field grow min-w-field">${esc(t('settings.agents.nameLabel'))}<input type="text" name="name" placeholder="${esc(t('settings.agents.namePlaceholder'))}" pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,62}" title="${esc(t('settings.agents.nameRule'))}" required /></label>
          <div class="self-end"><button class="btn primary" type="submit">${esc(t('settings.agents.register'))}</button></div>
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
  const waiting = b.oldest_at
    ? t('settings.buffer.waitingSince', { queued: b.queued, when: dateTime(b.oldest_at) })
    : t('settings.buffer.waiting', { queued: b.queued });
  const counts = t('settings.buffer.counts', { sent: b.sent, dropped: b.dropped, rejected: b.rejected });
  const title = `${waiting}. ${counts}.${b.problem ? ` ${b.problem}` : ''}`;
  return `<span class="badge ${tone}" title="${esc(title)}">${esc(t('settings.buffer.queued', { queued: fmt(b.queued) }))}</span>`;
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
      <p>${tHtml('settings.token.lead', { title: `<b>${esc(t('settings.token.for', { name: revealed.name }))}</b>`, file: `<code>${esc(TOKEN_FILE)}</code>` })}</p>
      <pre class="code-block" data-token>${esc(revealed.token)}</pre>
      <p class="small soft">${tHtml('settings.token.config', { file: `<code>${esc(CONFIG_FILE)}</code>` })}</p>
      <pre class="code-block">${esc(config)}</pre>
      <div><button class="btn" type="button" data-token-done>${esc(t('settings.token.done'))}</button></div>
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
    box.innerHTML = loadFailed(t('settings.agents.failed'));
    return;
  }
  // The agents as a table (U5.02): sorted, their columns chosen.
  const o: TableOptions<EdgeAgent> = {
    id: 'agents',
    label: t('settings.agents.title'),
    columns: [
      { key: 'name', label: t('settings.agents.col.name'), value: (a) => a.name, cell: (a) => esc(a.name) },
      { key: 'status', label: t('settings.agents.col.status'), value: (a) => a.status, cell: (a) => agentStatus(a) },
      {
        key: 'seen',
        label: t('settings.agents.col.seen'),
        value: (a) => a.last_seen_at,
        cell: (a) => (a.last_seen_at ? esc(dateTime(a.last_seen_at)) : '—'),
      },
      {
        key: 'host',
        label: t('settings.agents.col.host'),
        value: (a) => a.hostname,
        cell: (a) => esc(a.hostname ?? '—'),
      },
      {
        key: 'version',
        label: t('settings.agents.col.version'),
        value: (a) => a.version,
        cell: (a) => esc(a.version ?? '—'),
      },
      { key: 'connectors', label: t('settings.agents.col.connectors'), cell: (a) => connectorList(a) },
      {
        key: 'buffer',
        label: t('settings.agents.col.buffer'),
        value: (a) => a.buffer?.queued ?? null,
        cell: (a) => bufferSummary(a),
      },
      ...(admin
        ? [
            {
              key: 'actions',
              label: t('settings.agents.col.actions'),
              srOnly: true,
              fixed: true,
              cell: (a: EdgeAgent) =>
                `<button class="btn sm danger" type="button" data-revoke-agent="${esc(a.id)}" data-agent-name="${esc(a.name)}">${esc(t('settings.agents.revoke'))}</button>`,
            },
          ]
        : []),
    ],
    rows: agents,
    key: (a) => a.id,
    empty: emptyState({
      compact: true,
      level: 3,
      title: t('settings.agents.emptyTitle'),
      body: admin ? t('settings.agents.emptyAdmin') : t('settings.agents.emptyOther'),
    }),
  };
  box.innerHTML = dataTable(o);
  bindTable(box, o);
  onAll(box, '[data-revoke-agent]', 'click', async (el) => {
    const name = el.dataset.agentName ?? '';
    const yes = await confirmDialog({
      title: t('settings.agents.confirmTitle', { name }),
      body: t('settings.agents.confirmBody'),
      confirm: t('settings.agents.revoke'),
      tone: 'danger',
    });
    if (!yes) return;
    api.agents.revoke(site.id, el.dataset.revokeAgent ?? '').then(
      () => {
        ctx.toast(t('settings.agents.revoked', { name }));
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
  get title() {
    return t('settings.title');
  },
  icon: 'settings',
  render(ctx) {
    const { user } = ctx.state;
    const ds = ctx.dataSource;
    // The form shows what is being typed; the page follows what is saved.
    const typed = sourceDraft?.base === sourceKey(ds) ? sourceDraft : ds;
    return `
      ${pageHead({ eyebrow: t('settings.eyebrow'), title: t('settings.title') })}
      <div class="grid g2">
        <form class="card stack gap-3" id="profile">
          <h2>${esc(t('settings.profile.title'))}</h2>
          <p class="small soft">${esc(t('settings.profile.lead'))}</p>
          <label class="field">${esc(t('settings.profile.name'))}<input type="text" name="name" value="${esc(user.name)}" required /></label>
          <label class="field">${esc(t('settings.profile.email'))}<input type="text" name="email" value="${esc(user.email)}" required /></label>
          <div><button class="btn primary" type="submit">${esc(t('settings.save'))}</button></div>
        </form>
        <div class="card stack gap-3" id="your-preferences">
          <h2>${esc(t('settings.prefs.title'))}</h2>
          <p class="small soft">${esc(t('settings.prefs.lead'))}</p>
          <div>${linkButton(t('settings.prefs.open'), '#/preferences', { icon: 'sliders-horizontal' })}</div>
        </div>
        <div class="card stack gap-3">
          <h2>${esc(t('settings.demo.title'))}</h2>
          <p class="small soft">${esc(t('settings.demo.lead'))}</p>
          <div><button class="btn danger" data-reset>${esc(t('settings.demo.reset'))}</button></div>
        </div>
        <form class="card stack gap-3" id="datasource">
          <h2>${esc(t('settings.source.title'))}</h2>
          <p class="small soft">${tHtml('settings.source.lead', { command: `<code>${esc(COMPOSE_UP)}</code>` })}</p>
          <label class="row gap-2"><input type="radio" name="mode" value="local" ${typed.mode === 'local' ? 'checked' : ''} /> ${esc(t('settings.source.local'))}</label>
          <label class="row gap-2"><input type="radio" name="mode" value="api" ${typed.mode === 'api' ? 'checked' : ''} /> ${esc(t('settings.source.api'))}</label>
          <label class="field">${esc(t('settings.source.address'))}<input type="url" name="apiUrl" value="${esc(typed.apiUrl)}" placeholder="${esc(API_EXAMPLE)}" /></label>
          <div class="row gap-2"><button class="btn primary" type="submit">${esc(t('settings.save'))}</button><button class="btn" type="button" data-test-api>${esc(t('settings.source.test'))}</button></div>
          <p class="small soft" data-api-status aria-live="polite">${esc(apiCheck)}</p>
        </form>
        ${ds.mode === 'api' ? accountCard(ctx) : ''}
        ${ds.mode === 'api' ? orgSignInCard() : ''}
        ${ctx.ontology.site ? notificationsCard(ctx) : ''}
        ${ctx.ontology.site ? agentsCard(ctx.ontology.role === 'admin') : ''}
        ${ctx.ontology.role === 'admin' && ctx.ontology.site ? copilotPolicyCard() : ''}
        ${ctx.ontology.role === 'admin' ? copilotUsageCard() : ''}
        ${ds.mode === 'api' ? uxCard() : ''}
        ${ctx.api && ctx.ontology.role === 'admin' && ctx.ontology.site ? feedbackCard() : ''}
        ${ctx.ontology.role === 'admin' ? auditCard() : ''}
        <div class="card stack gap-3" id="about">
          <h2>${esc(t('settings.about.title'))}</h2>
          <p class="small soft">${esc(t('settings.about.lead'))}</p>
          <div>${linkButton(t('settings.about.styleguide'), '#/styleguide', { icon: 'palette' })}</div>
        </div>
      </div>`;
  },
  bind(root, ctx) {
    onSubmit(root, '#profile', (form) => {
      const name = field(form, 'name').trim();
      const email = field(form, 'email').trim();
      ctx.update((s) => (s.user = { name, email }));
      ctx.toast(t('settings.profile.saved'));
    });
    onSubmit(root, '#datasource', (form) => {
      const { mode, apiUrl: typedUrl } = readSource(form);
      const apiUrl = normalizeBaseUrl(typedUrl);
      // Only API mode needs an address; local mode keeps the last good one.
      if (mode === 'api' && !isHttpUrl(apiUrl)) {
        ctx.toast(t('settings.source.needAddress'));
        return;
      }
      apiCheck = '';
      sourceDraft = null;
      ctx.setDataSource({ mode, apiUrl: isHttpUrl(apiUrl) ? apiUrl : ctx.dataSource.apiUrl });
      ctx.toast(t(mode === 'api' ? 'settings.source.usingApi' : 'settings.source.usingLocal'));
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
      show(t('settings.source.checking'));
      try {
        const h = await createApiClient({ baseUrl: url, onError: (e) => ctx.toast(e.message) }).health();
        show(
          isTilesHealth(h)
            ? t('settings.source.connected', { version: h.version, env: h.env })
            : t('settings.source.notTiles'),
        );
      } catch {
        show(t('settings.source.unreachable'));
      }
    });
    if (ctx.ontology.role === 'admin') {
      void bindCopilotPolicy(root, ctx);
      void fillCopilotUsage(root, ctx);
      void fillAudit(root, ctx);
      void bindFeedback(root, ctx);
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
        title: t('settings.demo.confirmTitle'),
        body: t('settings.demo.confirmBody'),
        confirm: t('settings.demo.reset'),
        tone: 'danger',
        typeToConfirm: 'reset',
      });
      if (yes) ctx.reset();
    });
  },
};

export default view;
