// Detector templates on the Plant page (T7.02): a place's templates, applied to every machine of
// their kind under it, each detector tuned by a backtest on its own history, with its report.
import type { DetectorTemplate, TemplateApplied, AppliedMachine } from '../lib/api.ts';
import { appliedOrder, combinations, parseValues, reportFile, valuesText } from '../lib/detector-templates.ts';
import { esc, onAction, onSubmit, onNavigate, routeOf, download } from '../lib/dom.ts';
import { number, percent } from '../lib/format.ts';
import { showErrors, type FieldError } from '../lib/forms.ts';
import { t } from '../lib/i18n.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { button, card, field, input, loadFailed, select, skeleton, table } from '../lib/ui.ts';
import type { Context } from './types.ts';

// The site's templates (null while loading), and what applying one did, for the place it was applied to.
let templates: { site: string; list: DetectorTemplate[] | null | 'failed' } | null = null;
// The settings one backtest may try at once (backtest.MAX_SETTINGS).
const MAX_SETTINGS = 48;

let applied: { key: string; template: string; out: TemplateApplied } | null = null;
// What the new template's form held when sent, drawn again until it is made.
let draft: Record<string, string> | null = null;

onNavigate((hash) => {
  if (routeOf(hash) !== 'plant') {
    templates = null;
    applied = null;
    draft = null;
  }
});

const siteOf = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const placeKey = (site: string, place: string): string => `${site}|${place}`;
const canEdit = (ctx: Context): boolean => ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';

async function load(ctx: Context, site: string): Promise<void> {
  if (!ctx.api) return;
  templates = { site, list: null };
  let list: DetectorTemplate[] | 'failed';
  try {
    list = await ctx.api.detectorTemplates(site);
  } catch {
    list = 'failed'; // the client showed why
  }
  if (templates?.site === site) {
    templates = { site, list };
    ctx.rerender();
  }
}

const RESULT: Record<AppliedMachine['result'], [string, () => string]> = {
  created: ['good', () => t('plant.templates.result.created')],
  exists: ['', () => t('plant.templates.result.exists')],
  no_history: ['warn', () => t('plant.templates.result.noHistory')],
  no_tag: ['warn', () => t('plant.templates.result.noTag')],
  no_signal: ['warn', () => t('plant.templates.result.noSignal')],
};

const share = (x: number | null): string => (x === null ? '–' : percent(x));

function appliedTable(out: TemplateApplied): string {
  if (!out.machines.length)
    return `<p class="small soft" data-template-applied>${esc(t('plant.templates.noMachines', { template: out.template }))}</p>`;
  const rows = appliedOrder(out.machines)
    .map((m) => {
      const [cls, label] = RESULT[m.result];
      const report =
        m.result === 'created' && m.detector_id
          ? button(t('plant.templates.report'), {
              size: 'sm',
              variant: 'ghost',
              attrs: { 'data-template-report': m.detector_id, 'data-detector': m.detector ?? '' },
            })
          : '';
      return `<tr data-key="${esc(m.machine)}">
          <td>${esc(m.label)}</td>
          <td><span class="badge ${cls}">${esc(label())}</span></td>
          <td>${esc(m.detector ?? '–')}</td>
          <td>${m.events === null ? '–' : esc(number(m.events))}</td>
          <td>${esc(share(m.recall))}</td>
          <td>${m.false_per_day === null ? '–' : esc(number(m.false_per_day, 2))}</td>
          <td class="no-print">${report}</td>
        </tr>`;
    })
    .join('');
  return `<div data-template-applied>
      <h3>${esc(t('plant.templates.appliedTitle', { template: out.template }))}</h3>
      ${table({
        headers: [
          t('plant.coverage.machine'),
          t('plant.templates.resultHead'),
          t('plant.templates.detector'),
          t('plant.templates.events'),
          t('plant.templates.recall'),
          t('plant.templates.falsePerDay'),
          { label: t('plant.templates.actions'), srOnly: true },
        ],
        rowsHtml: rows,
      })}
      <p class="small soft">${esc(t('plant.templates.appliedHint'))}</p>
    </div>`;
}

// Examples in the fields: names in the plant model, not words.
const EXAMPLE = { name: 'dc-friction', kind: 'die-caster', measure: 'friction' }; // i18n-ok

function form(): string {
  const d = draft ?? {};
  const v = (name: string, fallback = ''): string => d[name] ?? fallback;
  const directions: [string, string][] = [
    ['above', t('plant.templates.direction.above')],
    ['below', t('plant.templates.direction.below')],
    ['both', t('plant.templates.direction.both')],
  ];
  return `<details class="no-print" data-template-new${draft ? ' open' : ''}>
      <summary>${esc(t('plant.templates.new'))}</summary>
      <form id="template-form" class="roi-form mt-3">
        ${field(t('plant.templates.name'), input({ name: 'name', value: v('name'), placeholder: EXAMPLE.name, attrs: { required: true, pattern: '[a-z0-9][a-z0-9._\\-]{0,39}', title: t('plant.templates.nameHint') } }), { hint: t('plant.templates.nameHint') })}
        ${field(t('plant.templates.kind'), input({ name: 'kind', value: v('kind'), placeholder: EXAMPLE.kind, attrs: { required: true, maxlength: '100' } }), { hint: t('plant.templates.kindHint') })}
        ${field(t('plant.templates.measure'), input({ name: 'measure', value: v('measure'), placeholder: EXAMPLE.measure, attrs: { required: true, maxlength: '100' } }), { hint: t('plant.templates.measureHint') })}
        ${field(t('plant.templates.k'), input({ name: 'k', value: v('k', '3 4 5'), attrs: { required: true } }), { hint: t('plant.templates.valuesHint') })}
        ${field(t('plant.templates.persist'), input({ name: 'persist', value: v('persist', '3'), attrs: { required: true } }))}
        ${field(t('plant.templates.window'), input({ name: 'window', value: v('window', '200'), attrs: { required: true } }))}
        ${field(t('plant.templates.directionLabel'), select('direction', directions, v('direction', 'above')))}
        ${field(t('plant.templates.horizon'), input({ name: 'horizon', type: 'number', value: v('horizon', '8'), attrs: { required: true, min: '0.1', max: '2160', step: '0.1' } }))}
        ${field(t('plant.templates.codes'), input({ name: 'codes', value: v('codes'), placeholder: 'DT-SEIZURE' }), { hint: t('plant.templates.codesHint') })}
        <div>${button(t('plant.templates.add'), { type: 'submit', variant: 'primary' })}</div>
      </form>
    </details>`;
}

// The card for a place (not a machine), in API mode.
export function templatesCard(ctx: Context, place: string): string {
  const site = siteOf(ctx);
  if (!ctx.api || !site) return '';
  const head = `<div class="card-head"><h2>${esc(t('plant.templates.title'))}</h2></div>
    <p class="small soft">${esc(t('plant.templates.lead'))}</p>`;
  const list = templates?.site === site ? templates.list : null;
  if (list === 'failed')
    return card(`${head}${loadFailed(t('plant.templates.title'), 3)}`, { attrs: { 'data-templates': '' } });
  if (!list)
    return card(`${head}${skeleton.table(2, 5, t('plant.templates.loading'))}`, { attrs: { 'data-templates': '' } });
  const edit = canEdit(ctx);
  const rows = list
    .map(
      (tpl) => `<tr data-key="${esc(tpl.id)}">
        <td>${esc(tpl.name)}</td>
        <td>${esc(tpl.machine_kind)}</td>
        <td>${esc(tpl.measure)}</td>
        <td class="small">${esc(t('plant.templates.tries', { count: combinations(tpl.grid), k: valuesText(tpl.grid.k) }))}</td>
        ${
          edit
            ? `<td class="no-print"><div class="row gap-1 wrap">${button(t('plant.templates.apply'), { size: 'sm', attrs: { 'data-template-apply': tpl.id } })}${button(t('plant.templates.remove'), { size: 'sm', variant: 'ghost', attrs: { 'data-template-remove': tpl.id, 'data-name': tpl.name } })}</div></td>`
            : ''
        }
      </tr>`,
    )
    .join('');
  const listHtml = list.length
    ? table({
        headers: [
          t('plant.templates.name'),
          t('plant.templates.kind'),
          t('plant.templates.measure'),
          t('plant.templates.settings'),
          ...(edit ? [{ label: t('plant.templates.actions'), srOnly: true }] : []),
        ],
        rowsHtml: rows,
      })
    : `<p class="small soft">${esc(t('plant.templates.none'))}</p>`;
  const result = applied?.key === placeKey(site, place) ? appliedTable(applied.out) : '';
  return card(`${head}${listHtml}${result}${edit ? form() : ''}`, { attrs: { 'data-templates': '' } });
}

// Wires the card; `changed` runs after a template was applied (the place's coverage changed).
export function bindTemplates(root: ParentNode, ctx: Context, place: string, changed: () => void): void {
  const site = siteOf(ctx);
  const api = ctx.api;
  if (!api || !site || !root.querySelector('[data-templates]')) return;
  if (templates?.site !== site) {
    draft = null; // another site's form
    void load(ctx, site);
  }
  onSubmit(root, '#template-form', (f) => {
    const data = new FormData(f);
    const text = (name: string): string => String(data.get(name) ?? '').trim();
    draft = Object.fromEntries(
      ['name', 'kind', 'measure', 'k', 'persist', 'window', 'direction', 'horizon', 'codes'].map((n) => [n, text(n)]),
    );
    const k = parseValues(draft.k ?? '');
    const persist = parseValues(draft.persist ?? '', true);
    const window = parseValues(draft.window ?? '', true);
    const errors: FieldError[] = [];
    const tooMany = (values: number[] | null): boolean => !values || values.length > 4;
    if (tooMany(k) || k?.some((x) => x <= 0 || x > 50))
      errors.push({ name: 'k', message: t('plant.templates.error.k') });
    if (tooMany(persist) || persist?.some((x) => x < 1))
      errors.push({ name: 'persist', message: t('plant.templates.error.persist') });
    if (tooMany(window) || window?.some((x) => x < 10 || x > 2000))
      errors.push({ name: 'window', message: t('plant.templates.error.window') });
    if (!errors.length && k && persist && window && k.length * persist.length * window.length > MAX_SETTINGS)
      errors.push({ name: 'k', message: t('plant.templates.error.tooMany', { most: MAX_SETTINGS }) });
    if (errors.length || !k || !persist || !window) return showErrors(f, errors);
    const direction = (draft.direction ?? 'above') as 'above' | 'below' | 'both';
    return api
      .addDetectorTemplate(site, {
        name: draft.name ?? '',
        machine_kind: draft.kind ?? '',
        measure: draft.measure ?? '',
        grid: { k, persist, window, direction: [direction] },
        horizon_seconds: Number(draft.horizon) * 3600,
        codes: (draft.codes ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
      })
      .then(
        (tpl) => {
          draft = null;
          f.reset();
          ctx.toast(t('plant.templates.added', { name: tpl.name }));
          void load(ctx, site);
        },
        () => undefined, // the client showed why, on the form
      );
  });
  onAction(root, '[data-template-apply]', (el) => {
    const id = el.dataset.templateApply ?? '';
    return api.applyDetectorTemplate(site, id, place).then(
      (out) => {
        applied = { key: placeKey(site, place), template: id, out };
        const made = out.machines.filter((m) => m.result === 'created').length;
        ctx.toast(t('plant.templates.appliedToast', { count: made, template: out.template }));
        changed();
      },
      () => undefined, // the client showed why
    );
  });
  onAction(root, '[data-template-remove]', async (el) => {
    const id = el.dataset.templateRemove ?? '';
    const name = el.dataset.name ?? '';
    const yes = await confirmDialog({
      title: t('plant.templates.confirm.title', { name }),
      body: t('plant.templates.confirm.body'),
      confirm: t('plant.templates.remove'),
      tone: 'danger',
    });
    if (!yes) return;
    await api.removeDetectorTemplate(site, id).then(
      () => {
        if (applied?.template === id) applied = null; // its results go with it
        ctx.toast(t('plant.templates.removed', { name }));
        void load(ctx, site);
      },
      () => undefined, // the client showed why
    );
  });
  onAction(root, '[data-template-report]', (el) => {
    const id = el.dataset.templateReport ?? '';
    const detector = el.dataset.detector ?? '';
    return api.detectorBacktest(site, id).then(
      (bt) => download(reportFile(detector), bt.report, 'text/markdown'),
      () => undefined, // the client showed why
    );
  });
}
