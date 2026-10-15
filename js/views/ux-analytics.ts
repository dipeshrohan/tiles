// UX analytics on the Settings page (U1.09): organisation admins turn it on or off; site admins see
// the counts. What is recorded is said here, where it is turned on.
import { esc, fmt, bound } from '../lib/dom.ts';
import type { UxSummary } from '../lib/api.ts';
import type { Context } from './types.ts';
import { emptyState, loadFailed, skeleton, table } from '../lib/ui.ts';
import { t, type MessageKey } from '../lib/i18n.ts';

const KIND_LABELS: Record<UxSummary['counts'][number]['kind'], MessageKey> = {
  page: 'ux.kind.page',
  task: 'ux.kind.task',
  palette: 'ux.kind.palette',
  help: 'ux.kind.help',
  error: 'ux.kind.error',
};

export function uxCard(): string {
  return `<div class="card stack gap-3 span-all" id="ux-analytics" hidden>
      <h2>${esc(t('ux.title'))}</h2>
      <p class="small soft">${esc(t('ux.lead'))}</p>
      <div data-ux-setting aria-live="polite">${skeleton.text(1, t('ux.loading'))}</div>
      <div data-ux-counts aria-live="polite"></div>
    </div>`;
}

export function countsHtml(s: UxSummary): string {
  if (!s.counts.length)
    return emptyState({
      compact: true,
      level: 3,
      title: t('ux.emptyTitle', { days: s.days }),
      body: s.enabled ? t('ux.emptyOn') : t('ux.emptyOff'),
    });
  const rows = s.counts
    .map(
      (c) =>
        `<tr><td>${esc(t(KIND_LABELS[c.kind]))}</td><td><code>${esc(c.name)}</code></td><td class="num">${fmt(c.events)}</td><td class="num">${fmt(c.sessions)}</td></tr>`,
    )
    .join('');
  return `<p class="small" data-ux-sessions>${esc(t('ux.sessions', { sessions: fmt(s.sessions), count: s.sessions, days: s.days }))}</p>
    ${table({ headers: [t('ux.head.kind'), t('ux.head.name'), t('ux.head.events'), t('ux.head.sessions')], rowsHtml: rows })}`;
}

export async function bindUx(root: HTMLElement, ctx: Context): Promise<void> {
  const card = root.querySelector<HTMLElement>('#ux-analytics');
  const setting = root.querySelector<HTMLElement>('[data-ux-setting]');
  const counts = root.querySelector<HTMLElement>('[data-ux-counts]');
  const api = ctx.api;
  const site = ctx.ontology.site;
  if (!card || !setting || !counts || !api) return;
  const siteAdmin = ctx.ontology.role === 'admin' && site !== null;
  const orgAdmin = await api.org.me().then(
    (o) => o.admin,
    () => false,
  );
  if (!card.isConnected) return;
  if (!orgAdmin && !siteAdmin) return card.remove();
  card.hidden = false;

  const showCounts = async () => {
    if (!siteAdmin || !site) return;
    counts.innerHTML = skeleton.table(3, 4, t('ux.loadingCounts'));
    try {
      counts.innerHTML = countsHtml(await api.ux.summary(site.id, 30));
    } catch {
      counts.innerHTML = loadFailed(t('ux.countsName'));
    }
  };

  if (!orgAdmin) {
    // Site admins see whether it is on; their organisation's admins decide.
    const on = site ? (await api.ux.enabled(site.id).catch(() => ({ enabled: false }))).enabled : false;
    setting.innerHTML = `<p class="small">${esc(t(on ? 'ux.on' : 'ux.off'))} ${esc(t('ux.orgDecides'))}</p>`;
    return showCounts();
  }
  let on: boolean;
  try {
    on = (await api.org.uxAnalytics()).enabled;
  } catch {
    setting.innerHTML = loadFailed(t('ux.settingName'), 3);
    return showCounts();
  }
  setting.innerHTML = `<label class="row gap-2"><input type="checkbox" name="ux-enabled" data-ux-enabled ${on ? 'checked' : ''} /> ${esc(t('ux.toggle'))}</label>`;
  const box = setting.querySelector<HTMLInputElement>('[data-ux-enabled]');
  box?.addEventListener(
    'change',
    () => {
      const wanted = box.checked;
      box.disabled = true;
      api.org
        .setUxAnalytics(wanted)
        .then(
          (r) => {
            box.checked = r.enabled;
            document.dispatchEvent(new CustomEvent('tiles:ux-setting', { detail: { enabled: r.enabled } }));
            ctx.toast(t(r.enabled ? 'ux.turnedOn' : 'ux.turnedOff'), {
              type: 'success',
              description: t('ux.otherTabs'),
            });
            void showCounts();
          },
          () => (box.checked = !wanted), // the client showed why
        )
        .finally(() => (box.disabled = false));
    },
    { signal: bound() },
  );
  return showCounts();
}
