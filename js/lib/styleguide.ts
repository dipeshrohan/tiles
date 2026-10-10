// What the style guide (U1.07) shows: every design token in css/styles.css's :root, by kind, and an
// example of each component with the code that makes it. test/styleguide.test.js keeps the tokens
// here the same as the stylesheet's.
import {
  badge,
  button,
  card,
  chip,
  emptyState,
  errorState,
  field,
  iconButton,
  input,
  kv,
  linkButton,
  loadingState,
  needsApi,
  pageHead,
  select,
  table,
  tabs,
} from './ui.ts';

export interface TokenGroup {
  id: string;
  title: string;
  // How a token is shown: a colour swatch, a bar as long as a space, text at a size, a box with a
  // radius or shadow, or only its value.
  kind: 'colour' | 'space' | 'text' | 'radius' | 'shadow' | 'value';
  note: string;
  tokens: string[];
}

export const TOKEN_GROUPS: TokenGroup[] = [
  {
    id: 'surfaces',
    title: 'Surfaces and text',
    kind: 'colour',
    note: 'Page, panels and lines; ink for text. --muted and --soft meet 4.5:1 on panels.',
    tokens: ['--bg', '--panel', '--panel-2', '--ink', '--muted', '--soft', '--line', '--line-strong', '--hover'],
  },
  {
    id: 'accents',
    title: 'Accent and states',
    kind: 'colour',
    note: 'The accent for actions and the current place; bad, warn and good for states, with soft backgrounds. Text in warn colour uses --warn-ink.',
    tokens: [
      '--accent',
      '--accent-hover',
      '--accent-ink',
      '--accent-soft',
      '--accent-soft-hover',
      '--ring',
      '--warm',
      '--bad',
      '--bad-ink',
      '--bad-line',
      '--bad-soft',
      '--band',
      '--warn',
      '--warn-ink',
      '--warn-soft',
      '--good',
      '--good-soft',
      '--control-shadow',
      '--tab-shadow',
    ],
  },
  {
    id: 'hero',
    title: 'Hero',
    kind: 'colour',
    note: 'The Home hero is dark teal in both themes.',
    tokens: [
      '--hero-from',
      '--hero-to',
      '--hero-ink',
      '--hero-soft',
      '--hero-line',
      '--hero-surface',
      '--hero-surface-line',
      '--hero-pill',
    ],
  },
  {
    id: 'space',
    title: 'Spacing',
    kind: 'space',
    note: 'A 4 px scale with half steps: --space-N is N × 4 px. Utilities use the same steps (.gap-2, .mt-3).',
    tokens: [
      '--space-px',
      '--space-0_5',
      '--space-1',
      '--space-1_5',
      '--space-2',
      '--space-2_5',
      '--space-3',
      '--space-3_5',
      '--space-4',
      '--space-5',
      '--space-6',
      '--space-7',
      '--space-8',
    ],
  },
  {
    id: 'type',
    title: 'Type',
    kind: 'text',
    note: 'Sizes for text; body text is --text-base.',
    tokens: [
      '--text-2xs',
      '--text-xs',
      '--text-sm',
      '--text-base',
      '--text-md',
      '--text-lg',
      '--text-xl',
      '--text-2xl',
      '--text-3xl',
      '--text-4xl',
      '--text-5xl',
    ],
  },
  {
    id: 'leading',
    title: 'Line height and fonts',
    kind: 'value',
    note: 'Line heights, and the text and code fonts.',
    tokens: ['--leading-none', '--leading-snug', '--leading-tight', '--leading', '--font', '--mono'],
  },
  {
    id: 'radius',
    title: 'Radii',
    kind: 'radius',
    note: '--radius is the default for controls.',
    tokens: ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl', '--radius-full', '--radius'],
  },
  {
    id: 'shadow',
    title: 'Shadows',
    kind: 'shadow',
    note: 'Cards use --shadow (the first step); menus and dialogs the higher ones.',
    tokens: ['--shadow-1', '--shadow-2', '--shadow-3', '--shadow'],
  },
  {
    id: 'layers',
    title: 'Layers and motion',
    kind: 'value',
    note: 'z-index for what sits above the page; durations and easings for transitions (off with reduced motion).',
    tokens: [
      '--z-raised',
      '--z-nav',
      '--z-dialog',
      '--z-toast',
      '--z-tooltip',
      '--z-top',
      '--dur-fast',
      '--dur',
      '--dur-slow',
      '--ease-out',
      '--ease-in',
    ],
  },
];

export interface Example {
  title: string;
  code: string; // what to write in a view
  html: () => string; // what it makes
}

const STATUS: [string, string][] = [
  ['todo', 'To do'],
  ['all', 'All'],
];

export const COMPONENTS: Example[] = [
  {
    title: 'Buttons',
    code: `button('Save', { variant: 'primary', type: 'submit' })
button('Cancel')
button('Archive', { variant: 'danger', size: 'sm' })
button('Delete', { variant: 'destructive' })
button('More', { variant: 'ghost' })
button('Retry', { icon: 'refresh-cw', disabled: true })`,
    html: () =>
      `<div class="row gap-2 wrap">${[
        button('Save', { variant: 'primary', type: 'submit' }),
        button('Cancel'),
        button('Archive', { variant: 'danger', size: 'sm' }),
        button('Delete', { variant: 'destructive' }),
        button('More', { variant: 'ghost' }),
        button('Retry', { icon: 'refresh-cw', disabled: true }),
      ].join('')}</div>`,
  },
  {
    title: 'Icon buttons and links',
    code: `iconButton('x', 'Close')   // named, and a tooltip
linkButton('Open Settings', '#/settings', { icon: 'settings' })`,
    html: () =>
      `<div class="row gap-2 wrap">${iconButton('x', 'Close')}${linkButton('Open Settings', '#/settings', { icon: 'settings' })}</div>`,
  },
  {
    title: 'Badges and chips',
    code: `badge('New', 'bad')  // tones: good, bad, warn, accent, info or none
chip('Machines', { pressed: true })`,
    html: () =>
      `<div class="row gap-2 wrap">${badge('Plain')}${badge('Resolved', 'good')}${badge('New', 'bad')}${badge('Acknowledged', 'warn')}${badge('Link to', 'accent')}${chip('Machines', { pressed: true })}${chip('Lines', { pressed: false })}</div>`,
  },
  {
    title: 'Fields',
    code: `field('Unit', input({ name: 'unit', placeholder: 'e.g. °C' }), { hint: 'As the PLC reports it' })
field('Source', select('source', [['', 'Any'], ['edge', 'Edge agents']], ''))
field('Assigned to', select(null, people, current), { inline: true })`,
    html: () =>
      `<div class="row gap-3 wrap items-end">${field('Unit', input({ name: 'sg-unit', placeholder: 'e.g. °C' }), { hint: 'As the PLC reports it' })}${field(
        'Source',
        select(
          'sg-source',
          [
            ['', 'Any'],
            ['edge', 'Edge agents'],
          ],
          '',
        ),
      )}${field(
        'Assigned to',
        select(
          null,
          [
            ['me', 'me'],
            ['none', 'nobody'],
          ],
          'me',
        ),
        { inline: true },
      )}</div>`,
  },
  {
    title: 'Filter tabs',
    code: `tabs({ label: 'Status', items: [['todo', 'To do'], ['all', 'All']], current: 'todo', data: 'show' })`,
    html: () => tabs({ label: 'Status', items: STATUS, current: 'todo', data: 'sg-show' }),
  },
  {
    title: 'Card',
    code: `card('<h2>Documents</h2><p class="small soft">…</p>', { class: 'stack gap-2' })`,
    html: () =>
      card('<h2>Documents</h2><p class="small soft">SOPs and manuals, searched by their words.</p>', {
        class: 'stack gap-2',
      }),
  },
  {
    title: 'Tables',
    code: `table({ headers: ['Tag', 'Unit', { label: 'Actions', srOnly: true }], rowsHtml })
kv([['Peak', '3,580 N'], ['Baseline', '1,800 N']], { valueClass: 'mono' })`,
    html: () =>
      `${table({
        headers: ['Tag', 'Unit', { label: 'Actions', srOnly: true }],
        rowsHtml: `<tr><td><code>press1.temperature</code></td><td>°C</td><td>${button('Edit', { size: 'sm' })}</td></tr>`,
      })}${kv(
        [
          ['Peak', '3,580 N'],
          ['Baseline', '1,800 N'],
        ],
        { valueClass: 'mono' },
      )}`,
  },
  {
    title: 'Page head',
    code: `pageHead({ eyebrow: 'Data', title: 'Signals', lead: 'Every tag with readings…', actionsHtml })`,
    html: () =>
      pageHead({
        eyebrow: 'Data',
        title: 'Signals',
        lead: 'Every tag with readings on this site.',
        actionsHtml: button('Refresh'),
      }),
  },
];

export const STATES: Example[] = [
  {
    title: 'Empty',
    code: `emptyState({ illustration: 'inbox', title: 'No apps yet', body: 'Make one from a template.', action })`,
    html: () =>
      emptyState({
        illustration: 'inbox',
        compact: true,
        title: 'No apps yet',
        body: 'Make one from a template.',
        action: button('New app', { variant: 'primary', size: 'sm' }),
      }),
  },
  {
    title: 'Error',
    code: `errorState({ title: 'The documents could not be loaded', retry: 'retry-docs' })`,
    html: () => errorState({ title: 'The documents could not be loaded', retry: 'sg-retry', compact: true }),
  },
  {
    title: 'Loading',
    code: `loadingState('Loading the signal…', 3)`,
    html: () => loadingState('Loading the signal…', 3),
  },
  {
    title: 'Needs the API',
    code: 'needsApi(`Documents are kept by the Tiles API.`)',
    html: () => needsApi('Documents are kept by the Tiles API.'),
  },
];
