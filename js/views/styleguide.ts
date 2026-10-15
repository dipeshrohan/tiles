import { esc, fmt, onAll, scrollBehavior } from '../lib/dom.ts';
import { icon, type IconName } from '../lib/icons.ts';
import { ICONS } from '../lib/icon-data.ts';
import { ILLUSTRATIONS, illustration } from '../lib/illustrations.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { COMPONENTS, STATES, TOKEN_GROUPS, type Example, type TokenGroup } from '../lib/styleguide.ts';
import { button, card, pageHead, tabs } from '../lib/ui.ts';
import type { Context, View } from './types.ts';
import { t, tHtml } from '../lib/i18n.ts';

// The style guide (U1.07): every design token, component, state, icon and illustration, in the light
// and the dark theme side by side, with the code that makes each. Not in the menu: Settings → About
// links to it. A page is built from what is here.

const SCHEMES = [
  ['light', 'styleguide.light'],
  ['dark', 'styleguide.dark'],
] as const;

// Samples of type and of code, not words to translate.
const TYPE_SAMPLE = 'Aa'; // i18n-ok
const ICON_CODE = "icon('house')"; // i18n-ok
const LABEL_CODE = 'label'; // i18n-ok
const ILLUSTRATION_CODE = "illustration('inbox')"; // i18n-ok
const MOTION_CODE = [
  '<li data-key="warning-12">…</li>     // a row with a key fades in when added and out when removed', // i18n-ok
  '<div class="kpi"><div class="value">1,204</div></div>   // or data-tick: a number ticks to its new value', // i18n-ok
  'tabs({ … }), .review-row.sel, .seg button.active      // the highlight moves from the one selected before', // i18n-ok
].join('\n');
const OVERLAY_CODE = [
  "if (await confirmDialog({ title: 'Revoke the agent?', confirm: 'Revoke', tone: 'danger' })) …", // i18n-ok
  "removeLater({ toast, message: 'Conversation deleted', hide, restore, send })   // Undo instead", // i18n-ok
  "ctx.toast('Saved', { type: 'success' })        // errors from the API stay, with their request ID", // i18n-ok
  '<button … data-tooltip="Says what it does">', // i18n-ok
].join('\n');

// Each sample is styled from code in bind() (a token per element), not with inline styles.
function sample(g: TokenGroup, token: string): string {
  const set = (prop: string): string => `data-sg-prop="${prop}" data-sg-token="${esc(token)}"`;
  switch (g.kind) {
    case 'colour':
      return `<span class="sg-swatch" ${set('background')}></span>`;
    case 'space':
      return `<span class="sg-bar" ${set('width')}></span>`;
    case 'text':
      return `<span class="sg-text" ${set('font-size')}>${TYPE_SAMPLE}</span>`;
    case 'radius':
      return `<span class="sg-box" ${set('border-radius')}></span>`;
    case 'shadow':
      return `<span class="sg-box" ${set('box-shadow')}></span>`;
    default:
      return '';
  }
}

function tokens(g: TokenGroup): string {
  const themed = g.kind === 'colour' || g.kind === 'shadow';
  const rows = g.tokens
    .map((token) => {
      const cells = themed
        ? SCHEMES.map(([s]) => `<td class="sg-scheme ${s}">${sample(g, token)}</td>`).join('')
        : `<td>${sample(g, token)}</td>`;
      return `<tr><th scope="row"><code>${esc(token)}</code></th>${cells}<td class="small soft mono" data-sg-value="${esc(token)}"></td></tr>`;
    })
    .join('');
  const heads = themed
    ? SCHEMES.map(([, l]) => `<th scope="col">${esc(t(l))}</th>`).join('')
    : `<th scope="col">${esc(t('styleguide.sample'))}</th>`;
  return `<section class="card stack gap-2" aria-labelledby="sg-${g.id}">
      <h3 id="sg-${g.id}">${esc(g.title)}</h3><p class="small soft">${esc(g.note)}</p>
      <div class="table-wrap"><table class="sg-tokens"><thead><tr><th scope="col">${esc(t('styleguide.token'))}</th>${heads}<th scope="col">${esc(t('styleguide.value'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
}

// An example in both themes (the same markup), then its code.
function example(e: Example): string {
  const html = e.html();
  return `<section class="card stack gap-2" aria-label="${esc(e.title)}">
      <h3>${esc(e.title)}</h3>
      <div class="sg-pair">${SCHEMES.map(
        ([s, l]) => `<div class="sg-scheme ${s}"><span class="sg-scheme-name">${esc(t(l))}</span>${html}</div>`,
      ).join('')}</div>
      <pre class="sg-code"><code>${esc(e.code)}</code></pre>
    </section>`;
}

// The motion samples (U3.04) are drawn by the page, like any page's state: each change draws it again,
// and what changed moves as it would anywhere (js/lib/micro.ts), or not at all with less motion.
interface MotionUi {
  tab: string;
  rows: string[];
  next: number;
  selected: string;
  readings: number;
}
const uiState = (ctx: Context) =>
  ctx.ui<MotionUi>('styleguide', {
    tab: 'open',
    rows: ['DC-01', 'DC-02', 'DC-03'],
    next: 4,
    selected: 'DC-01',
    readings: 1204,
  });

function motionCard(motion: MotionUi): string {
  const rows = motion.rows
    .map(
      (id) =>
        `<button class="review-row ${motion.selected === id ? 'sel' : ''}" type="button" data-key="sg-row-${esc(id)}" data-sg-row="${esc(id)}"><b>${esc(t('styleguide.dieCaster', { id }))}</b><span class="small muted">${esc(t('styleguide.rowNote'))}</span></button>`,
    )
    .join('');
  return card(
    `<p class="small soft">${esc(t('styleguide.motionLead'))}</p>
    ${tabs({
      label: t('styleguide.status'),
      items: [
        ['open', t('styleguide.tab.open')],
        ['taken', t('styleguide.tab.taken')],
        ['resolved', t('styleguide.tab.resolved')],
      ],
      current: motion.tab,
      data: 'sg-motion-tab',
    })}
    <div class="sg-motion">
      <div class="stack gap-2">
        <div class="review-list">${rows}</div>
        <div class="row gap-2 wrap">${button(t('styleguide.addRow'), { size: 'sm', attrs: { 'data-sg-add': true } })}${button(t('styleguide.removeFirst'), { size: 'sm', attrs: { 'data-sg-remove': true } })}</div>
      </div>
      <div class="stack gap-2">
        <div class="kpi"><div class="label">${esc(t('styleguide.readingsToday'))}</div><div class="value">${fmt(motion.readings)}</div></div>
        <div>${button(t('styleguide.addReadings'), { size: 'sm', attrs: { 'data-sg-count': true } })}</div>
        <details class="sg-details"><summary>${esc(t('styleguide.detailsSummary'))}</summary><p class="small">${esc(t('styleguide.detailsBody'))}</p></details>
      </div>
    </div>
    <pre class="sg-code"><code>${esc(MOTION_CODE)}</code></pre>`,
    { class: 'stack gap-3' },
  );
}

const SECTIONS = [
  ['tokens', 'styleguide.sec.tokens'],
  ['components', 'styleguide.sec.components'],
  ['states', 'styleguide.sec.states'],
  ['overlays', 'styleguide.sec.overlays'],
  ['motion', 'styleguide.sec.motion'],
  ['icons', 'styleguide.sec.icons'],
  ['illustrations', 'styleguide.sec.illustrations'],
] as const;

const view: View = {
  id: 'styleguide',
  get title() {
    return t('styleguide.title');
  },
  icon: 'palette',
  under: 'settings',
  render(ctx) {
    const head = pageHead({
      eyebrow: t('styleguide.eyebrow'),
      title: t('styleguide.title'),
      lead: t('styleguide.lead'),
    });
    const jump = `<div class="row gap-2 wrap" role="group" aria-label="${esc(t('styleguide.sections'))}">${SECTIONS.map(
      ([id, l]) => button(t(l), { size: 'sm', variant: 'ghost', attrs: { 'data-jump': id } }),
    ).join('')}</div>`;
    const icons = (Object.keys(ICONS) as IconName[])
      .map((n) => `<li class="sg-icon">${icon(n, { size: 20 })}<code>${esc(n)}</code></li>`)
      .join('');
    const pictures = ILLUSTRATIONS.map(
      (n) => `<li class="sg-illustration">${illustration(n, 120)}<code>${esc(n)}</code></li>`,
    ).join('');
    return `${head}${jump}
      <h2 class="mt-4 mb-2" id="sg-sec-tokens">${esc(t('styleguide.sec.tokens'))}</h2>
      <div class="sg-grid">${TOKEN_GROUPS.map(tokens).join('')}</div>
      <h2 class="mt-4 mb-2" id="sg-sec-components">${esc(t('styleguide.sec.components'))}</h2>
      <div class="stack gap-3">${COMPONENTS.map(example).join('')}</div>
      <h2 class="mt-4 mb-2" id="sg-sec-states">${esc(t('styleguide.sec.states'))}</h2>
      <div class="stack gap-3">${STATES.map(example).join('')}</div>
      <h2 class="mt-4 mb-2" id="sg-sec-overlays">${esc(t('styleguide.sec.overlays'))}</h2>
      ${card(
        `<p class="small soft">${esc(t('styleguide.overlaysLead'))}</p>
        <div class="row gap-2 wrap">
          ${button(t('styleguide.openDialog'), { attrs: { 'data-sg-dialog': true } })}
          ${(['success', 'info', 'warning', 'error'] as const)
            .map((type) => button(t(`styleguide.show.${type}`), { attrs: { 'data-sg-toast': type } }))
            .join('')}
          <button class="btn" type="button" data-tooltip="${esc(t('styleguide.tooltip'))}">${esc(t('styleguide.pointAtMe'))}</button>
        </div>
        <pre class="sg-code"><code>${esc(OVERLAY_CODE)}</code></pre>`,
        { class: 'stack gap-2' },
      )}
      <h2 class="mt-4 mb-2" id="sg-sec-motion">${esc(t('styleguide.sec.motion'))}</h2>
      ${motionCard(uiState(ctx))}
      <h2 class="mt-4 mb-2" id="sg-sec-icons">${esc(t('styleguide.sec.icons'))}</h2>
      ${card(`<p class="small soft">${tHtml('styleguide.iconsLead', { code: `<code>${esc(ICON_CODE)}</code>`, label: `<code>${esc(LABEL_CODE)}</code>` })}</p><ul class="sg-icons">${icons}</ul>`, { class: 'stack gap-2' })}
      <h2 class="mt-4 mb-2" id="sg-sec-illustrations">${esc(t('styleguide.sec.illustrations'))}</h2>
      ${card(`<p class="small soft">${tHtml('styleguide.illustrationsLead', { code: `<code>${esc(ILLUSTRATION_CODE)}</code>` })}</p><ul class="sg-illustrations">${pictures}</ul>`, { class: 'stack gap-2' })}`;
  },
  bind(root, ctx) {
    const motion = uiState(ctx);
    for (const el of root.querySelectorAll<HTMLElement>('[data-sg-token]')) {
      el.style.setProperty(el.dataset.sgProp ?? 'background', `var(${el.dataset.sgToken})`);
    }
    // Each token's value as the stylesheet writes it (a colour as its light and dark pair).
    const styles = getComputedStyle(document.documentElement);
    for (const el of root.querySelectorAll<HTMLElement>('[data-sg-value]')) {
      el.textContent = styles.getPropertyValue(el.dataset.sgValue ?? '').trim();
    }
    // A browser without light-dark() has one palette at a time: say so, rather than show it twice.
    if (typeof CSS !== 'undefined' && !CSS.supports('color', 'light-dark(red, blue)'))
      root
        .querySelector('.page-head')
        ?.insertAdjacentHTML('afterend', `<p class="card small" role="note">${esc(t('styleguide.oneTheme'))}</p>`);
    // The examples work like the real ones: filters and chips toggle, Try again answers.
    onAll(root, '[data-sg-show]', 'click', (el) => {
      for (const b of el.parentElement?.querySelectorAll<HTMLElement>('[data-sg-show]') ?? []) {
        b.classList.toggle('active', b === el);
        b.setAttribute('aria-pressed', String(b === el));
      }
    });
    onAll(root, '.sg-pair .chip', 'click', (el) =>
      el.setAttribute('aria-pressed', String(el.getAttribute('aria-pressed') !== 'true')),
    );
    onAll(root, '[data-sg-retry]', 'click', () => ctx.toast(t('styleguide.retry')));
    onAll(root, '[data-jump]', 'click', (el) => {
      const target = root.querySelector<HTMLElement>(`#sg-sec-${el.dataset.jump}`);
      target?.scrollIntoView({ behavior: scrollBehavior() });
      target?.setAttribute('tabindex', '-1');
      target?.focus({ preventScroll: true });
    });
    onAll(root, '[data-sg-motion-tab]', 'click', (el) => {
      motion.tab = el.dataset.sgMotionTab ?? 'open';
      ctx.rerender();
    });
    onAll(root, '[data-sg-row]', 'click', (el) => {
      motion.selected = el.dataset.sgRow ?? '';
      ctx.rerender();
    });
    onAll(root, '[data-sg-add]', 'click', () => {
      motion.rows.unshift(`DC-${String(motion.next++).padStart(2, '0')}`);
      ctx.rerender();
    });
    onAll(root, '[data-sg-remove]', 'click', () => {
      motion.rows.shift();
      ctx.rerender();
    });
    onAll(root, '[data-sg-count]', 'click', () => {
      motion.readings += 250;
      ctx.rerender();
    });
    onAll(root, '[data-sg-dialog]', 'click', async () => {
      // A dialog is for what can't be undone; what can come back gets an Undo toast instead (U2.03).
      const yes = await confirmDialog({
        title: t('styleguide.dialog.title'),
        body: t('styleguide.dialog.body'),
        confirm: t('styleguide.dialog.confirm'),
        tone: 'danger',
      });
      ctx.toast(yes ? t('styleguide.dialog.yes') : t('styleguide.dialog.no'));
    });
    onAll(root, '[data-sg-toast]', 'click', (el) => {
      const type = el.dataset.sgToast as 'success' | 'info' | 'warning' | 'error';
      ctx.toast(t(`styleguide.toast.${type}`), {
        type,
        description: type === 'error' ? t('styleguide.toastError') : undefined,
        requestId: type === 'error' ? 'req-000042' : undefined,
      });
    });
  },
};

export default view;
