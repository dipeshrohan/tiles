import { esc, onAll } from '../lib/dom.ts';
import { icon, type IconName } from '../lib/icons.ts';
import { ICONS } from '../lib/icon-data.ts';
import { ILLUSTRATIONS, illustration } from '../lib/illustrations.ts';
import { confirmDialog } from '../lib/overlay.ts';
import { COMPONENTS, STATES, TOKEN_GROUPS, type Example, type TokenGroup } from '../lib/styleguide.ts';
import { button, card, pageHead } from '../lib/ui.ts';
import type { View } from './types.ts';

// The style guide (U1.07): every design token, component, state, icon and illustration, in the light
// and the dark theme side by side, with the code that makes each. Not in the menu: Settings → About
// links to it. A page is built from what is here.

const SCHEMES = [
  ['light', 'Light'],
  ['dark', 'Dark'],
] as const;

// Each sample is styled from code in bind() (a token per element), not with inline styles.
function sample(g: TokenGroup, token: string): string {
  const set = (prop: string): string => `data-sg-prop="${prop}" data-sg-token="${esc(token)}"`;
  switch (g.kind) {
    case 'colour':
      return `<span class="sg-swatch" ${set('background')}></span>`;
    case 'space':
      return `<span class="sg-bar" ${set('width')}></span>`;
    case 'text':
      return `<span class="sg-text" ${set('font-size')}>Friction warning</span>`;
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
    .map((t) => {
      const cells = themed
        ? SCHEMES.map(([s]) => `<td class="sg-scheme ${s}">${sample(g, t)}</td>`).join('')
        : `<td>${sample(g, t)}</td>`;
      return `<tr><th scope="row"><code>${esc(t)}</code></th>${cells}<td class="small soft mono" data-sg-value="${esc(t)}"></td></tr>`;
    })
    .join('');
  const heads = themed ? SCHEMES.map(([, l]) => `<th scope="col">${l}</th>`).join('') : '<th scope="col">Sample</th>';
  return `<section class="card stack gap-2" aria-labelledby="sg-${g.id}">
      <h3 id="sg-${g.id}">${esc(g.title)}</h3><p class="small soft">${esc(g.note)}</p>
      <div class="table-wrap"><table class="sg-tokens"><thead><tr><th scope="col">Token</th>${heads}<th scope="col">Value</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`;
}

// An example in both themes, then its code.
function example(e: Example): string {
  return `<section class="card stack gap-2" aria-label="${esc(e.title)}">
      <h3>${esc(e.title)}</h3>
      <div class="sg-pair">${SCHEMES.map(
        ([s, l]) => `<div class="sg-scheme ${s}"><span class="sg-scheme-name">${l}</span>${e.html()}</div>`,
      ).join('')}</div>
      <pre class="sg-code"><code>${esc(e.code)}</code></pre>
    </section>`;
}

const SECTIONS = [
  ['tokens', 'Tokens'],
  ['components', 'Components'],
  ['states', 'States'],
  ['overlays', 'Dialogs, toasts and tooltips'],
  ['icons', 'Icons'],
  ['illustrations', 'Illustrations'],
] as const;

const view: View = {
  id: 'styleguide',
  title: 'Style guide',
  icon: 'palette',
  render() {
    const head = pageHead({
      eyebrow: 'Settings · About',
      title: 'Style guide',
      lead: 'The tokens, components and states pages are built from, in the light and the dark theme, with the code for each. Components come from js/lib/ui.ts, tokens from css/styles.css.',
    });
    const jump = `<div class="row gap-2 wrap" role="group" aria-label="Sections">${SECTIONS.map(([id, l]) =>
      button(l, { size: 'sm', variant: 'ghost', attrs: { 'data-jump': id } }),
    ).join('')}</div>`;
    const icons = (Object.keys(ICONS) as IconName[])
      .map((n) => `<li class="sg-icon">${icon(n, { size: 20 })}<code>${esc(n)}</code></li>`)
      .join('');
    const pictures = ILLUSTRATIONS.map(
      (n) => `<li class="sg-illustration">${illustration(n, 120)}<code>${esc(n)}</code></li>`,
    ).join('');
    return `${head}${jump}
      <h2 class="mt-4 mb-2" id="sg-sec-tokens">Tokens</h2>
      <div class="sg-grid">${TOKEN_GROUPS.map(tokens).join('')}</div>
      <h2 class="mt-4 mb-2" id="sg-sec-components">Components</h2>
      <div class="stack gap-3">${COMPONENTS.map(example).join('')}</div>
      <h2 class="mt-4 mb-2" id="sg-sec-states">States</h2>
      <div class="stack gap-3">${STATES.map(example).join('')}</div>
      <h2 class="mt-4 mb-2" id="sg-sec-overlays">Dialogs, toasts and tooltips</h2>
      ${card(
        `<p class="small soft">They open over the page: try them.</p>
        <div class="row gap-2 wrap">
          ${button('Open a dialog', { attrs: { 'data-sg-dialog': true } })}
          ${['success', 'info', 'warning', 'error'].map((t) => button(`Show ${t}`, { attrs: { 'data-sg-toast': t } })).join('')}
          <button class="btn" type="button" data-tooltip="Says what it does">Point at me</button>
        </div>
        <pre class="sg-code"><code>${esc(`if (await confirmDialog({ title: 'Archive SOP 14?', body: 'It leaves the list and search.', confirm: 'Archive' })) …
ctx.toast('Saved', { type: 'success' })        // errors from the API stay, with their request ID
<button … data-tooltip="Says what it does">`)}</code></pre>`,
        { class: 'stack gap-2' },
      )}
      <h2 class="mt-4 mb-2" id="sg-sec-icons">Icons</h2>
      ${card(`<p class="small soft">Lucide, drawn with the text colour: <code>icon('house')</code>, decorative unless given a <code>label</code>.</p><ul class="sg-icons">${icons}</ul>`, { class: 'stack gap-2' })}
      <h2 class="mt-4 mb-2" id="sg-sec-illustrations">Illustrations</h2>
      ${card(`<p class="small soft">For empty, waiting and error states: <code>illustration('inbox')</code>, coloured by the theme.</p><ul class="sg-illustrations">${pictures}</ul>`, { class: 'stack gap-2' })}`;
  },
  bind(root, ctx) {
    for (const el of root.querySelectorAll<HTMLElement>('[data-sg-token]')) {
      el.style.setProperty(el.dataset.sgProp ?? 'background', `var(${el.dataset.sgToken})`);
    }
    // Each token's value as the browser has it (a colour as the current theme resolves it).
    const styles = getComputedStyle(document.documentElement);
    for (const el of root.querySelectorAll<HTMLElement>('[data-sg-value]')) {
      el.textContent = styles.getPropertyValue(el.dataset.sgValue ?? '').trim();
    }
    onAll(root, '[data-jump]', 'click', (el) => {
      const target = root.querySelector<HTMLElement>(`#sg-sec-${el.dataset.jump}`);
      target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      target?.setAttribute('tabindex', '-1');
      target?.focus({ preventScroll: true });
    });
    onAll(root, '[data-sg-dialog]', 'click', async () => {
      const yes = await confirmDialog({
        title: 'Archive SOP 14?',
        body: 'It leaves the list and search, and the copilot stops citing it.',
        confirm: 'Archive',
      });
      ctx.toast(yes ? 'You chose Archive (nothing was archived)' : 'You cancelled');
    });
    onAll(root, '[data-sg-toast]', 'click', (el) => {
      const type = el.dataset.sgToast as 'success' | 'info' | 'warning' | 'error';
      ctx.toast(`A ${type} toast`, {
        type,
        description: type === 'error' ? 'Errors from the API stay until dismissed.' : undefined,
        requestId: type === 'error' ? 'req-000042' : undefined,
      });
    });
  },
};

export default view;
