// UX analytics on the Settings page (U1.09): organisation admins turn it on or off; site admins see
// the counts. What is recorded is said here, where it is turned on.
import { esc, fmt } from '../lib/dom.ts';
import type { UxSummary } from '../lib/api.ts';
import type { Context } from './types.ts';
import { emptyState, loadFailed, skeleton, table } from '../lib/ui.ts';

const KIND_LABELS: Record<UxSummary['counts'][number]['kind'], string> = {
  page: 'Page viewed',
  task: 'Task done',
  palette: 'Command palette',
  help: 'Help opened',
  error: 'Error shown',
};

export function uxCard(): string {
  return `<div class="card stack gap-3 span-all" id="ux-analytics" hidden>
      <h2>UX analytics</h2>
      <p class="small soft">When your organisation turns it on, its sites record how Tiles is used, to make it easier: pages viewed, tasks done (a warning acknowledged, an app made), the command palette, help and errors shown. Each event is its kind and name, the time, and a random id for the browser tab, stored hashed. No names, e-mail addresses, records or anything typed. Events stay in this deployment for 90 days.</p>
      <div data-ux-setting aria-live="polite">${skeleton.text(1, 'Loading…')}</div>
      <div data-ux-counts aria-live="polite"></div>
    </div>`;
}

export function countsHtml(s: UxSummary): string {
  if (!s.counts.length)
    return emptyState({
      compact: true,
      level: 3,
      title: `Nothing recorded in the last ${s.days} days`,
      body: s.enabled
        ? 'Events appear here as people use this site.'
        : 'Your organisation hasn’t turned UX analytics on, so nothing is recorded.',
    });
  const rows = s.counts
    .map(
      (c) =>
        `<tr><td>${esc(KIND_LABELS[c.kind])}</td><td><code>${esc(c.name)}</code></td><td class="num">${fmt(c.events)}</td><td class="num">${fmt(c.sessions)}</td></tr>`,
    )
    .join('');
  return `<p class="small" data-ux-sessions>${fmt(s.sessions)} browser session(s) in the last ${s.days} days.</p>
    ${table({ headers: ['Kind', 'Name', 'Events', 'Sessions'], rowsHtml: rows })}`;
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
    counts.innerHTML = skeleton.table(3, 4, 'Loading the counts…');
    try {
      counts.innerHTML = countsHtml(await api.ux.summary(site.id, 30));
    } catch {
      counts.innerHTML = loadFailed('The counts');
    }
  };

  if (!orgAdmin) {
    // Site admins see whether it is on; their organisation's admins decide.
    const on = site ? (await api.ux.enabled(site.id).catch(() => ({ enabled: false }))).enabled : false;
    setting.innerHTML = `<p class="small">${on ? 'On for your organisation.' : 'Off for your organisation.'} Your organisation’s admins turn it on or off.</p>`;
    return showCounts();
  }
  let on: boolean;
  try {
    on = (await api.org.uxAnalytics()).enabled;
  } catch {
    setting.innerHTML = loadFailed('The setting', 3);
    return showCounts();
  }
  setting.innerHTML = `<label class="row gap-2"><input type="checkbox" name="ux-enabled" data-ux-enabled ${on ? 'checked' : ''} /> Record UX analytics on your organisation’s sites</label>`;
  const box = setting.querySelector<HTMLInputElement>('[data-ux-enabled]');
  box?.addEventListener('change', () => {
    const wanted = box.checked;
    box.disabled = true;
    api.org
      .setUxAnalytics(wanted)
      .then(
        (r) => {
          box.checked = r.enabled;
          document.dispatchEvent(new CustomEvent('tiles:ux-setting', { detail: { enabled: r.enabled } }));
          ctx.toast(r.enabled ? 'UX analytics on' : 'UX analytics off', {
            type: 'success',
            description: 'Other open tabs follow it when they are next loaded.',
          });
          void showCounts();
        },
        () => (box.checked = !wanted), // the client showed why
      )
      .finally(() => (box.disabled = false));
  });
  return showCounts();
}
