// Setpoint recommendations on a machine's page (T11.02): its recommendations, newest open ones
// first, with what each changes, within which limits and what the model expects; engineers ask for
// one (a sweep of a design model over the machine's state), approve someone else's, reject one
// and say when the line applied it by hand. Tiles never writes to a PLC. The limits per parameter
// (T11.04) are set here too; the API refuses anything outside them.
import type { ModelInfo, Recommendation, RecommendationLimit, RecommendationOutcome, SignalInfo } from '../lib/api.ts';
import { esc, onAction, onAll, onNavigate, onSubmit, routeOf } from '../lib/dom.ts';
import { dateTime, number, percent, significant } from '../lib/format.ts';
import { showErrors, type FieldError } from '../lib/forms.ts';
import { t } from '../lib/i18n.ts';
import {
  MAX_SETTABLE,
  allowed,
  changes,
  isChance,
  ordered,
  recommendable,
  settableOf,
  stateOf,
} from '../lib/recommendations.ts';
import { badge, button, card, field, input, loadFailed, select, skeleton, table } from '../lib/ui.ts';
import type { Context } from './types.ts';

type Loaded<T> = T | null | 'failed'; // null: loading

interface MachineState {
  key: string; // site|asset
  models: Loaded<ModelInfo[]>;
  model: string | null; // the model chosen
  limits: Loaded<RecommendationLimit[]>;
  recs: Loaded<Recommendation[]>;
  outcomes: Map<number, RecommendationOutcome | 'failed'>; // the applied ones' (T11.03)
}

let shown: MachineState | null = null;
let asked = 0; // only the latest request's answer is shown
const PREFERRED = 'die-porosity'; // i18n-ok: the process model for recommendations (T11.01)

onNavigate((hash) => {
  if (routeOf(hash) !== 'plant') shown = null;
});

const siteOf = (ctx: Context): string | null => ctx.ontology.site?.id ?? null;
const canEdit = (ctx: Context): boolean => ctx.ontology.role === 'engineer' || ctx.ontology.role === 'admin';
const keyOf = (site: string, asset: string): string => `${site}|${asset}`;

async function loadAll(ctx: Context, site: string, asset: string): Promise<void> {
  const api = ctx.api;
  if (!api) return;
  const mine = ++asked;
  const key = keyOf(site, asset);
  shown = {
    key,
    models: null,
    model: shown?.key === key ? shown.model : null,
    limits: null,
    recs: null,
    outcomes: new Map(),
  };
  const [models, recs] = await Promise.all([
    api.models(site).then(recommendable, () => 'failed' as const), // the client showed why
    api.recommendations(site, asset).then(ordered, () => 'failed' as const),
  ]);
  if (mine !== asked || shown?.key !== key) return;
  const chosen =
    models === 'failed' || !models.length
      ? null
      : (models.find((m) => m.key === shown?.model) ?? models.find((m) => m.key === PREFERRED) ?? models[0] ?? null);
  shown = { ...shown, models, recs, model: chosen?.key ?? null };
  ctx.rerender();
  if (recs !== 'failed') void loadOutcomes(ctx, site, key, recs);
  if (chosen) await loadLimits(ctx, site, chosen.key, mine);
}

// What followed each applied recommendation (T11.03), asked once the list is in.
async function loadOutcomes(ctx: Context, site: string, key: string, recs: Recommendation[]): Promise<void> {
  const api = ctx.api;
  if (!api) return;
  const applied = recs.filter((r) => r.status === 'applied');
  if (!applied.length) return;
  const got = await Promise.all(
    applied.map((r) =>
      api.recommendationOutcome(site, r.number).then(
        (o): [number, RecommendationOutcome | 'failed'] => [r.number, o],
        (): [number, 'failed'] => [r.number, 'failed'], // the client showed why
      ),
    ),
  );
  if (shown?.key !== key) return;
  shown = { ...shown, outcomes: new Map(got) };
  ctx.rerender();
}

async function loadLimits(ctx: Context, site: string, model: string, mine = ++asked): Promise<void> {
  if (!ctx.api || !shown) return;
  shown = { ...shown, model, limits: null };
  let limits: Loaded<RecommendationLimit[]>;
  try {
    limits = await ctx.api.recommendationLimits(site, model);
  } catch {
    limits = 'failed'; // the client showed why
  }
  if (mine !== asked || shown?.model !== model) return;
  shown = { ...shown, limits };
  ctx.rerender();
}

const chosenModel = (): ModelInfo | null =>
  shown && Array.isArray(shown.models) ? (shown.models.find((m) => m.key === shown?.model) ?? null) : null;

const value = (x: number | null, unit: string): string =>
  x === null ? '–' : unit ? `${significant(x, 4)} ${unit}` : significant(x, 4); // i18n-ok

const outcome = (output: string, x: number | null | undefined): string =>
  x === null || x === undefined ? '–' : isChance(output) ? percent(x, 1) : significant(x, 3);

const share = (x: number | null): string => (x === null ? '–' : percent(x, 0));
const mean = (m: { mean: number | null } | null): string => (m?.mean == null ? '–' : significant(m.mean, 3));

// What followed an applied recommendation against what the model expected.
function outcomeHtml(o: RecommendationOutcome | 'failed' | undefined): string {
  if (o === undefined) return `<p class="small soft" data-rec-outcome>${esc(t('plant.recs.outcome.loading'))}</p>`;
  if (o === 'failed') return `<p class="small soft" data-rec-outcome>${esc(t('plant.recs.outcome.failed'))}</p>`;
  const lines = [
    t(o.state === 'complete' ? 'plant.recs.outcome.complete' : 'plant.recs.outcome.collecting', { days: o.days }),
    t('plant.recs.outcome.expected', {
      output: o.objective,
      now: outcome(o.objective, o.expected_now),
      proposed: outcome(o.objective, o.expected_proposed),
      change: share(o.expected_change),
    }),
  ];
  if (o.signal_tag)
    lines.push(
      t('plant.recs.outcome.measured', {
        tag: o.signal_tag,
        before: mean(o.before),
        after: mean(o.after),
        change: share(o.measured_change),
      }),
    );
  if (o.events_before && o.events_after)
    lines.push(
      t('plant.recs.outcome.events', {
        scrapBefore: number(o.events_before.scrap, 1),
        scrapAfter: number(o.events_after.scrap, 1),
        stopsBefore: number(o.events_before.downtime, 1),
        stopsAfter: number(o.events_after.downtime, 1),
      }),
    );
  return `<ul class="plain small" data-rec-outcome>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

const STATUS: Record<Recommendation['status'], [string, () => string]> = {
  proposed: ['warn', () => t('plant.recs.status.proposed')],
  approved: ['good', () => t('plant.recs.status.approved')],
  applied: ['', () => t('plant.recs.status.applied')],
  rejected: ['', () => t('plant.recs.status.rejected')],
};

function recRow(ctx: Context, rec: Recommendation, model: ModelInfo | null): string {
  const [tone, label] = STATUS[rec.status];
  const what = changes(rec, model?.key === rec.model ? model.params : [])
    .map(
      (c) =>
        `<li><code>${esc(c.param)}</code> ${esc(t('plant.recs.change', { from: value(c.from, c.unit), to: value(c.to, c.unit) }))}${
          c.min === null || c.max === null
            ? ''
            : ` <span class="small soft">${esc(t('plant.recs.within', { min: value(c.min, c.unit), max: value(c.max, c.unit) }))}</span>`
        }</li>`,
    )
    .join('');
  const expected = esc(
    t('plant.recs.expected', {
      output: rec.objective,
      now: outcome(rec.objective, rec.expected.now[rec.objective]),
      proposed: outcome(rec.objective, rec.expected.proposed[rec.objective]),
    }),
  );
  const who =
    rec.status === 'applied' && rec.applied_at
      ? t('plant.recs.appliedBy', { who: rec.applied_by ?? '', at: dateTime(rec.applied_at) })
      : rec.decided_at
        ? t('plant.recs.decidedBy', { who: rec.decided_by ?? '', at: dateTime(rec.decided_at) })
        : t('plant.recs.proposedBy', { who: rec.proposed_by, at: dateTime(rec.proposed_at) });
  const may = allowed(rec, canEdit(ctx));
  const actions = [
    may.approve
      ? button(t('plant.recs.approve'), {
          size: 'sm',
          variant: 'primary',
          attrs: { 'data-rec-approve': String(rec.number) },
        })
      : '',
    may.applied
      ? button(t('plant.recs.applied'), { size: 'sm', attrs: { 'data-rec-applied': String(rec.number) } })
      : '',
    may.reject
      ? button(rec.mine ? t('plant.recs.withdraw') : t('plant.recs.reject'), {
          size: 'sm',
          variant: 'ghost',
          attrs: { 'data-rec-reject': String(rec.number) },
        })
      : '',
  ].join('');
  const note = rec.applied_note || rec.decision_note;
  return `<tr data-key="${rec.number}" data-rec="${rec.number}">
      <td>${esc(t('plant.recs.number', { number: rec.number }))}</td>
      <td>${badge(label(), tone as '')}</td>
      <td><ul class="plain">${what}</ul><p class="small soft">${expected}</p>${
        rec.status === 'applied' ? outcomeHtml(shown?.outcomes.get(rec.number)) : ''
      }</td>
      <td class="small">${esc(who)}${note ? `<br><span class="soft">${esc(note)}</span>` : ''}</td>
      ${canEdit(ctx) ? `<td class="no-print"><div class="row gap-1 wrap">${actions}</div></td>` : ''}
    </tr>`;
}

function recsList(ctx: Context, recs: Recommendation[], model: ModelInfo | null): string {
  if (!recs.length) return `<p class="small soft" data-recs-none>${esc(t('plant.recs.none'))}</p>`;
  return table({
    headers: [
      t('plant.recs.numberHead'),
      t('plant.recs.statusHead'),
      t('plant.recs.changeHead'),
      t('plant.recs.whoHead'),
      ...(canEdit(ctx) ? [{ label: t('plant.recs.actions'), srOnly: true }] : []),
    ],
    rowsHtml: recs.map((r) => recRow(ctx, r, model)).join(''),
  });
}

function limitsSection(ctx: Context, model: ModelInfo, limits: RecommendationLimit[]): string {
  const of = new Map(limits.map((l) => [l.param, l]));
  const edit = canEdit(ctx);
  const rows = model.params
    .map((p) => {
      const l = of.get(p.name);
      if (!edit)
        return l
          ? `<tr data-key="${esc(p.name)}"><td>${esc(p.description || p.name)}</td><td>${esc(value(l.min, p.unit))}</td><td>${esc(value(l.max, p.unit))}</td></tr>`
          : '';
      const bounds = {
        min: p.min === null ? undefined : String(p.min),
        max: p.max === null ? undefined : String(p.max),
        step: 'any',
      };
      return `<tr data-key="${esc(p.name)}">
          <td>${esc(p.description || p.name)}${p.unit ? ` <span class="small soft">${esc(p.unit)}</span>` : ''}</td>
          <td>${input({ name: `min:${p.name}`, type: 'number', value: l ? String(l.min) : '', attrs: { ...bounds, 'aria-label': t('plant.recs.limitMin', { param: p.description || p.name }) } })}</td>
          <td>${input({ name: `max:${p.name}`, type: 'number', value: l ? String(l.max) : '', attrs: { ...bounds, 'aria-label': t('plant.recs.limitMax', { param: p.description || p.name }) } })}</td>
          <td class="no-print"><div class="row gap-1">${button(t('plant.recs.saveLimit'), { size: 'sm', attrs: { 'data-limit-save': p.name } })}${
            l
              ? button(t('plant.recs.removeLimit'), {
                  size: 'sm',
                  variant: 'ghost',
                  attrs: { 'data-limit-remove': p.name },
                })
              : ''
          }</div></td>
        </tr>`;
    })
    .join('');
  if (!edit && !limits.length) return `<p class="small soft">${esc(t('plant.recs.noLimits'))}</p>`;
  return `<details class="mt-3" data-rec-limits${edit && !limits.length ? ' open' : ''}>
      <summary>${esc(t('plant.recs.limitsTitle', { count: limits.length }))}</summary>
      <p class="small soft">${esc(t('plant.recs.limitsLead'))}</p>
      <form id="rec-limits">
      ${table({
        headers: [
          t('plant.recs.param'),
          t('plant.recs.min'),
          t('plant.recs.max'),
          ...(edit ? [{ label: t('plant.recs.actions'), srOnly: true }] : []),
        ],
        rowsHtml: rows,
      })}
      </form>
    </details>`;
}

function recommendForm(model: ModelInfo, limits: RecommendationLimit[], signals: SignalInfo[]): string {
  const limited = new Set(limits.map((l) => l.param));
  const settable = settableOf(model, limited);
  if (!settable.length) return `<p class="small soft mt-3">${esc(t('plant.recs.setLimitsFirst'))}</p>`;
  const objectives = model.outputs.map((o): [string, string] => [o.name, o.description || o.name]);
  const preferred = model.outputs.find((o) => isChance(o.name))?.name ?? model.outputs[0]?.name ?? '';
  const signalOptions: [string, string][] = [
    ['', t('plant.recs.typed')],
    ...signals.map((s): [string, string] => [s.id, s.tag]),
  ];
  const stateRows = model.params
    .map(
      (p) => `<tr data-key="${esc(p.name)}">
        <td>${esc(p.description || p.name)}${p.unit ? ` <span class="small soft">${esc(p.unit)}</span>` : ''}</td>
        <td>${input({ name: `value:${p.name}`, type: 'number', placeholder: number(p.default, 2), attrs: { step: 'any', 'aria-label': t('plant.recs.valueOf', { param: p.description || p.name }) } })}</td>
        <td>${signals.length ? select(`signal:${p.name}`, signalOptions, '', { attrs: { 'aria-label': t('plant.recs.signalOf', { param: p.description || p.name }) } }) : ''}</td>
      </tr>`,
    )
    .join('');
  const boxes = settable
    .map(
      (p, i) =>
        `<label class="row gap-1"><input type="checkbox" name="settable" value="${esc(p.name)}"${i < MAX_SETTABLE ? ' checked' : ''}> ${esc(p.description || p.name)}</label>`,
    )
    .join('');
  return `<details class="mt-3 no-print" data-rec-new>
      <summary>${esc(t('plant.recs.new'))}</summary>
      <form id="rec-form" class="mt-3">
        ${field(t('plant.recs.objective'), select('objective', objectives, preferred))}
        <fieldset class="mt-2" data-api="settable"><legend>${esc(t('plant.recs.settable', { most: MAX_SETTABLE }))}</legend><div class="row gap-3 wrap">${boxes}</div></fieldset>
        <p class="small soft mt-2">${esc(t('plant.recs.stateLead'))}</p>
        ${table({ headers: [t('plant.recs.param'), t('plant.recs.value'), ...(signals.length ? [t('plant.recs.signal')] : [])], rowsHtml: stateRows })}
        <div class="row gap-3 wrap mt-2">
          ${signals.length ? field(t('plant.recs.outcomeSignal'), select('outcome_signal', [['', t('plant.recs.outcomeNone')], ...signals.map((s): [string, string] => [s.id, s.tag])], ''), { hint: t('plant.recs.outcomeHint') }) : ''}
          ${field(t('plant.recs.outcomeDays'), input({ name: 'outcome_days', type: 'number', value: '7', attrs: { min: '1', max: '90', step: '1', required: true } }))}
        </div>
        <div class="mt-2">${button(t('plant.recs.recommend'), { type: 'submit', variant: 'primary' })}</div>
      </form>
    </details>`;
}

// The card on a machine's page, in API mode; `signals` are the machine's linked signals.
export function recsCard(ctx: Context, asset: string, signals: SignalInfo[]): string {
  const site = siteOf(ctx);
  if (!ctx.api || !site) return '';
  const head = `<div class="card-head"><h2>${esc(t('plant.recs.title'))}</h2></div>
    <p class="small soft">${esc(t('plant.recs.lead'))}</p>`;
  const attrs = { 'data-recs': asset };
  const mine = shown?.key === keyOf(site, asset) ? shown : null;
  if (!mine || mine.recs === null || mine.models === null)
    return card(`${head}${skeleton.table(2, 4, t('plant.recs.loading'))}`, { attrs });
  if (mine.recs === 'failed' || mine.models === 'failed')
    return card(`${head}${loadFailed(t('plant.recs.title'), 3)}`, { attrs });
  const model = chosenModel();
  const list = recsList(ctx, mine.recs, model);
  if (!model) return card(`${head}${list}<p class="small soft">${esc(t('plant.recs.noModel'))}</p>`, { attrs });
  const pick =
    mine.models.length > 1
      ? field(
          t('plant.recs.model'),
          select(
            null,
            mine.models.map((m): [string, string] => [m.key, `${m.name} (${m.key} ${m.version})`]),
            model.key,
            { attrs: { 'data-rec-model': '' } },
          ),
        )
      : `<p class="small">${esc(t('plant.recs.modelIs', { name: model.name, key: model.key, version: model.version }))}</p>`;
  const limits = mine.limits;
  const rest =
    limits === null
      ? skeleton.text()
      : limits === 'failed'
        ? loadFailed(t('plant.recs.limitsTitle', { count: 0 }), 3)
        : `${canEdit(ctx) ? recommendForm(model, limits, signals) : ''}${limitsSection(ctx, model, limits)}`;
  return card(`${head}${list}<div class="mt-3">${pick}</div>${rest}`, { attrs });
}

const numberOf = (el: HTMLElement): number =>
  Number(el.dataset.recApprove ?? el.dataset.recReject ?? el.dataset.recApplied);

// Wires the card on a machine's page.
export function bindRecs(root: ParentNode, ctx: Context): void {
  const site = siteOf(ctx);
  const api = ctx.api;
  const box = root.querySelector<HTMLElement>('[data-recs]');
  if (!api || !site || !box) return;
  const asset = box.dataset.recs ?? '';
  if (shown?.key !== keyOf(site, asset)) void loadAll(ctx, site, asset);
  const again = (): void => void loadAll(ctx, site, asset);
  onAll(root, '[data-plant-refresh]', 'click', again); // Refresh asks again, as the other cards do
  onAll(root, '[data-rec-model]', 'change', (el) => {
    void loadLimits(ctx, site, (el as HTMLSelectElement).value);
  });
  onAction(root, '[data-rec-approve]', (el) =>
    api.decideRecommendation(site, numberOf(el), 'approve').then(
      (rec) => {
        ctx.toast(t('plant.recs.approvedToast', { number: rec.number }));
        again();
      },
      () => again(), // the client showed why (a limit changed, say): show where it is now
    ),
  );
  onAction(root, '[data-rec-reject]', (el) =>
    api.decideRecommendation(site, numberOf(el), 'reject').then(
      (rec) => {
        ctx.toast(t('plant.recs.rejectedToast', { number: rec.number }));
        again();
      },
      () => again(),
    ),
  );
  onAction(root, '[data-rec-applied]', (el) =>
    api.recommendationApplied(site, numberOf(el)).then(
      (rec) => {
        ctx.toast(t('plant.recs.appliedToast', { number: rec.number }));
        again();
      },
      () => again(),
    ),
  );
  const model = chosenModel();
  onAction(root, '[data-limit-save]', (el) => {
    const param = el.dataset.limitSave ?? '';
    const form = root.querySelector<HTMLFormElement>('#rec-limits');
    if (!model || !form) return;
    const low = form.querySelector<HTMLInputElement>(`[name="min:${CSS.escape(param)}"]`);
    const high = form.querySelector<HTMLInputElement>(`[name="max:${CSS.escape(param)}"]`);
    const min = Number(low?.value ?? '');
    const max = Number(high?.value ?? '');
    const errors: FieldError[] = [];
    if (!low?.value.trim() || !Number.isFinite(min))
      errors.push({ name: `min:${param}`, message: t('plant.recs.error.number') });
    if (!high?.value.trim() || !Number.isFinite(max))
      errors.push({ name: `max:${param}`, message: t('plant.recs.error.number') });
    if (!errors.length && min > max) errors.push({ name: `max:${param}`, message: t('plant.recs.error.order') });
    if (errors.length) return showErrors(form, errors);
    return api.setRecommendationLimit(site, model.key, param, min, max).then(
      () => {
        ctx.toast(t('plant.recs.limitSaved', { param }));
        void loadLimits(ctx, site, model.key);
      },
      () => undefined, // the client showed why
    );
  });
  onAction(root, '[data-limit-remove]', (el) => {
    const param = el.dataset.limitRemove ?? '';
    if (!model) return;
    return api.removeRecommendationLimit(site, model.key, param).then(
      () => {
        ctx.toast(t('plant.recs.limitRemoved', { param }));
        void loadLimits(ctx, site, model.key);
      },
      () => undefined,
    );
  });
  onSubmit(root, '#rec-form', (f) => {
    if (!model) return;
    const data = new FormData(f);
    const settable = data.getAll('settable').map(String);
    const values: Record<string, string> = {};
    const signals: Record<string, string> = {};
    for (const p of model.params) {
      values[p.name] = String(data.get(`value:${p.name}`) ?? '');
      signals[p.name] = String(data.get(`signal:${p.name}`) ?? '');
    }
    const read = stateOf(model, values, signals);
    const errors: FieldError[] = read.bad.map((p) => ({ name: `value:${p}`, message: t('plant.recs.error.number') }));
    if (!settable.length || settable.length > MAX_SETTABLE)
      errors.push({ name: 'settable', message: t('plant.recs.error.settable', { most: MAX_SETTABLE }) });
    if (errors.length) return showErrors(f, errors);
    return api
      .recommend(site, {
        model: model.key,
        objective: String(data.get('objective') ?? ''),
        settable,
        state: read.state,
        signals: read.signals,
        asset,
        outcome_days: Number(data.get('outcome_days') ?? 7),
        ...(data.get('outcome_signal') ? { outcome_signal: String(data.get('outcome_signal')) } : {}),
      })
      .then(
        (rec) => {
          ctx.toast(t('plant.recs.made', { number: rec.number }));
          again();
        },
        () => undefined, // the client showed why (no better setting, a stale signal…), on the form
      );
  });
}
