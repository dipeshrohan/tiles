# The Tiles UI handbook

How Tiles' pages are built, in one place (U6.08). It brings together what the UI plan made: design tokens, components, page states, motion, words, help, the glossary, tours, languages, accessibility, print and preferences, and the tests that keep them. Each section says what to use and links to the detail. Build a new page from it, then check it against [the review checklist](#review-checklist) before you ask for a review.

The browser app has no runtime dependencies and works from `file://`: everything below is plain TypeScript in `js/`, built into one bundle (`npm run build`).

## Contents

1. [A new page, step by step](#a-new-page-step-by-step)
2. [Design tokens](#design-tokens)
3. [Components](#components)
4. [Page states](#page-states)
5. [Lists, records, tables and charts](#lists-records-tables-and-charts)
6. [Drawing and binding](#drawing-and-binding)
7. [Forms](#forms)
8. [Dialogs, toasts and undo](#dialogs-toasts-and-undo)
9. [Motion](#motion)
10. [Words](#words)
11. [Help, the glossary, tours and what's new](#help-the-glossary-tours-and-whats-new)
12. [Languages, numbers and dates](#languages-numbers-and-dates)
13. [Accessibility](#accessibility)
14. [Print](#print)
15. [Preferences](#preferences)
16. [Tests](#tests)
17. [Review checklist](#review-checklist)

## A new page, step by step

The Preferences page (`js/views/preferences.ts`, U6.06) was built this way; read it beside these steps.

1. **The module.** One file in `js/views/`, default-exporting a `View` (`js/views/types.ts`): `id` (its address, `#/<id>`), `title` (a getter, so it follows the language), `icon` (its own, which `test/icons.test.js` checks, from `js/lib/icons.ts`; a new one is added to `scripts/icons.js` and made with `npm run icons`), `render(ctx)` returning HTML, and `bind(root, ctx)` wiring it. Optional: `crumbs(ctx)` for the record the address names, and `query` for what a link should share (filters, the record open).
2. **The head.** Start with `pageHead({ eyebrow, title, lead })` from `js/lib/ui.ts`. Its `h1` takes the focus when the page opens.
3. **The menu and the routes.** Add the view to `VIEWS` in `js/app.ts`, and to a group of `NAV` if it belongs in the menu (a page reached from another, like the style guide, stays out and names that page in `under`, which marks it current in the menu and in the breadcrumbs). Optional lists a page may join: a `g` letter in `GO_KEYS` and its own keys in `PAGE_KEYS` (`js/lib/shortcuts.ts`), `TASK_PAGES` in `scripts/help.js` (What's new entries link to it), `FILTERS` and the API's saved-view page (filters, below) and `CARD_LINKS` (a Home card). The command palette lists the menu's pages by itself.
4. **Its words.** Every word goes through `t('page.key')` with the message in `js/i18n/en.json` and its German in `js/i18n/de.json` ([Languages](#languages-numbers-and-dates)); write them as [writing.md](writing.md) says.
5. **Its help.** A section in `docs/guides/user.md` and the page in `PAGE_HELP` in `scripts/help.js`: the build fails without it. A statistical or plant term it shows goes in [the glossary](glossary.md) first ([Help](#help-the-glossary-tours-and-whats-new)).
6. **Its states.** Loading, empty, failed, and without the API ([Page states](#page-states)).
7. **Its data.** Through `ctx.api` (null in local mode; a failed call has already shown a toast), or the browser's state (`ctx.state`, `ctx.update`). Per-page UI state goes through a typed helper over `ctx.ui(id, defaults)`, kept in the tab's session storage across a reload (`const ui = (ctx) => ctx.ui<Ui>('glossary', { q: '' })`).
8. **The tests.** Add the page to the lists in `e2e/smoke.test.js`, `e2e/a11y.test.js` and `e2e/visual/visual.test.js` (a page in `js/views/` missing from the visual list fails it), write what it does into an e2e test with the fake API (`e2e/fake-api.js`), unit-test its logic in `test/`, and make its visual baselines ([Tests](#tests)).
9. **The changelog.** A line in the top section of `CHANGELOG.md`, and `npm run build` again (the What's new sheet is made from it).

## Design tokens

Every colour, space, type size, radius, shadow, layer and duration is a token on `:root` in `css/styles.css` (U1.02): `--space-*`, `--text-*`, `--radius-*`, `--shadow-*`, `--z-*`, `--dur*` and `--ease-*`, `--target-min` (the smallest control, 24 px), and colours as `light-dark()` pairs, so the theme is `color-scheme` alone. The [style guide](../../js/views/styleguide.ts) page (`#/styleguide`, from Settings → About) shows them all in light and dark.

- Use a token, never a raw value: `test/css-tokens.test.js` fails on raw px for spacing, type or radius, and on a colour that isn't a token.
- A new token goes on `:root` (a colour also in the fallback for browsers without `light-dark()`) and in `js/lib/styleguide.ts` (`test/styleguide.test.js` keeps it in step).
- No `style` attributes in the HTML the app builds (U1.03): use a component's class or the utilities at the end of `css/styles.css` (`.gap-N`, `.mt-N`/`.mb-N`, `.grow`, `.wrap`, `.justify-between`, `.text-bad`…, `N` a `--space-N` step). `scripts/check-inline-styles.js` (in `npm run lint`) allows only computed values.

## Components

`js/lib/ui.ts` (U1.04) has the components, after shadcn/ui, each escaping its text: `button`, `iconButton`, `linkButton`, `badge`, `chip`, `card`, `pageHead`, `breadcrumbs`, `field` (a label, and a hint the control is described by; not `dom.ts`'s `field()`, which reads a form's values), `input`, `select`/`options` (a third item gives an option's `lang`), `table`, `kv`, `tabs` (a toggle group of filters), `term` (a glossary term), and the states below. Options named `*Html` take built markup; `attrs` can't set a component's `class` or `type`. The style guide shows each with the code that makes it (`js/lib/styleguide.ts`).

- Buttons are `.btn` (outline) with `.primary`, `.secondary`, `.ghost`, `.danger`, `.destructive`, and `.sm`, `.lg`, `.icon`. A link that looks like a button is `linkButton`; a button is never a link.
- Icons: `icon(name, { size, label })`, Lucide's line icons. A decorative icon has no label; an icon-only button is `iconButton`, which names it.
- DOM helpers in `js/lib/dom.ts`: `esc()` for every interpolated text, `need()`, `field()`, `onAll()`, `onSubmit()`, `onAction()`, `announce()` (read out by `#announcer`).

## Page states

- **Loading:** `skeleton.table(rows, cols)`, `.list()`, `.card()`, `.chart()`, `.text()`: the shape of what loads, shown after 300 ms, `aria-busy` (U2.04).
- **Empty:** `emptyState({ illustration, title, body, action })` with a next step (U2.05). Illustrations are line art coloured by theme classes (`js/lib/illustrations.ts`).
- **Failed:** `errorState({ title, body, details })` (Copy details gives the version and the error) or `apiUnreachable(error)` when the page needs the API and can't reach it (Try again reconnects). A failed request's toast already says what happened, why and what to do (`describeApiError`, `js/lib/errors.ts`, U2.06).
- **Without the API:** `needsApi(bodyHtml)`, or a local version of the page (the demo plant).
- **Busy:** `button(label, { busy })` or `setBusy(el, busy)`; a handler that returns its request's promise holds its form or button while it runs (U2.08).
- **Offline:** the client refuses changes with `OFFLINE_WRITE` and `#offline` shows a banner; a page has nothing to add.

## Lists, records, tables and charts

- **A list with records** (Warnings, Change reviews, Insights, Documents) draws `split(list, record, { open, back, label })` (`js/lib/split.ts`, U3.08): side by side from 960 px, one at a time below it, `listKeys` for j and k, and the record in the address (`#/reviews/<n>`).
- **Tables:** `dataTable(o)` in the HTML and `bindTable(root, o)` in `bind` (`js/lib/data-table.ts`, U5.02): sortable columns (`value`), hidden columns, widths, density, selection with bulk actions, pages or virtual rows past 200, CSV. Rows a table draws again lose their listeners: handle clicks on the list, or in `drawn`.
- **Filters** under a list: `filterBar` and saved views (`js/lib/filter-bar.ts`, U5.06); a page's filters live in its address (`query`) and in `FILTERS`.
- **Charts:** `timeChart` and `lineChart` (`js/lib/svg.ts`, U5.03) in a `.chart-box` with a legend, PNG and CSV, a crosshair and arrow keys (`installCharts`). Pass a `title`: each chart gets a name and a summary of its numbers.

## Drawing and binding

A new page replaces `#view`; the same page drawn again is patched in place by `js/lib/morph.ts` (U3.03), so the focus, the caret, scroll, opened details and typed values survive a refresh.

- `bind` runs after every draw: every listener a view adds passes `{ signal: bound() }` (`test/view-listeners.test.js` checks), so the last binding's are dropped.
- Give list rows a `data-key` when rows can be added or removed; they then fade in and out.
- Keep per-element state in a `WeakMap`/`WeakSet`, never a `data-` flag (the morph removes attributes the HTML doesn't have).
- A large drawing marked `data-morph="replace"` takes its new content whole; `data-morph="if-changed"` is left alone when drawn the same (U3.07).

## Forms

`onSubmit(root, sel, handler)` (`js/lib/dom.ts`) checks the form first (U2.07): the browser's constraints (`required`, `pattern` with a `title`, `min`, `max`) shown under each field with `aria-invalid`, a summary linking to them, each field checked again as it is left; a view's own checks return `FieldError`s for `showErrors`. The API's 422 field errors land on the form sent last (`data-api="…"` names a field the API calls differently). Label every field (`field()` from `ui.ts`). A quick toggle changes on screen at once and is put back if the API refuses.

## Dialogs, toasts and undo

- Ask with `await confirmDialog({ title, body, confirm, tone: 'danger', typeToConfirm })`; `sheet()` and `panelDialog()` for more (`js/lib/overlay.ts`). Native `confirm`, `alert` and `prompt` fail lint. A dialog doesn't block the page: check again what it was about after the `await`.
- `ctx.toast(message, { type, description, action })` for what happened (`js/lib/toaster.ts`).
- Prefer undo to confirm (U2.03, `js/lib/undo.ts`): `removeLater` sends a removal only when its Undo toast goes; `removeNow` archives at once and Undo restores.
- `data-tooltip="…"` gives any element a tooltip; a control's key shortcut is its `aria-keyshortcuts`, from `keyAttrs(key)` (U4.03).

## Motion

[motion.md](motion.md) (U3.01): the `--dur-fast`/`--dur`/`--dur-slow` tokens, ease-out in and ease-in out, only opacity and transform, one thing moving at a time, nothing looping but progress, and all of it stopped by reduced motion (the system's, or `data-motion="reduce"` from Preferences). A scroll from script uses `scrollBehavior()`. Pages change with a view transition (U3.02); keyed rows fade, numbers tick and highlights glide (U3.04, `js/lib/micro.ts`). `test/motion.test.js` checks the stylesheet.

## Words

[writing.md](writing.md) (U2.09): sentence case, buttons as verbs, errors as what happened, why and what to do, units and dates as it says, and its terms; British English. `test/copy.test.js` checks the mechanical rules.

## Help, the glossary, tours and what's new

- **Help** (U4.04): each page's section of `docs/guides/user.md` opens beside it from the top bar's help button; `scripts/help.js` cuts the guide into `js/help-data.js` at build time and fails when a page has no section in `PAGE_HELP`.
- **The glossary** (U4.05): a term in [glossary.md](glossary.md) (a `##` group, a `###` term, one paragraph), made into `js/lib/glossary-data.ts` by `npm run glossary`; `term(key)` shows it dotted, its definition in a tooltip, where it first appears on a page.
- **Tours** (U4.07): steps in `js/lib/tours.ts`, each naming a `data-tour="…"` a page draws; renaming one means changing its tour (`test/tours.test.js`).
- **What's new** (U4.08): the changelog's top section; a dot on the help button until the person opens it.
- **Feedback** (U4.09) and **the welcome** (U4.06) need nothing from a page.

## Languages, numbers and dates

- Words: `t('key', values)` (ICU messages: plurals and selects) from `js/lib/i18n.ts`, escaped with `esc()` where they go into HTML (`scripts/i18n-escape.js` checks); `tHtml` for a message with built markup. A new message has its German in `js/i18n/de.json`, with English's values, plurals and selects (`scripts/check-i18n.js`), marked for review in the PR (U6.01, U6.03).
- The pseudo-locale (`?lang=en-XA`) shows every message accented and 40% longer: the visual tests run every page in it.
- Numbers, dates and times come from `js/lib/format.ts` (U6.02): `number`, `duration`, `date`, `dateTime`, `relative`… in the person's language (or the format they chose) and the site's clock (or their device's), the zone named. Nothing else writes a number or a date with a fixed locale (`scripts/check-format.js`).

## Accessibility

[accessibility.md](accessibility.md) (T5.18, U6.04): WCAG 2.1 AA and 2.2's target size, light and dark. Real buttons and links; labelled fields and table headers (`sr-only` for an action column); text colours that meet 4.5:1 (`--warn-ink` for text); underlined links in running text; controls at least 24 px (`--target-min`) or spaced apart; a visible focus; nothing scrolling sideways at 320 px or 640 px; what is chosen outlined in forced colours, not shown by background alone. `e2e/a11y.test.js` checks every page with axe and the round-2 checks (reflow, focus, forced colours, target size).

## Print

A page prints as a document (U6.05, the `@media print` block at the end of `css/styles.css`): no menu or controls, the record alone, nothing cut, light, links with their address, charts in black and white with patterns. Hide a record's action form or tools on paper with the `no-print` class; mark a link that reads as its address `print-plain`. `e2e/print.test.js` prints the records on A4 and Letter.

## Preferences

A person's theme, table rows, motion, language, number format, clock, shortcuts and start page (U6.06, `ctx.preferences`) apply at once and are kept with them. A page doesn't read them: it uses the tokens (theme), `dataTable` (density), `lessMotion()` (motion), `t()` and `format.ts` (language, numbers, clock) and `keyAttrs()` (shortcuts), which follow them.

## Tests

| Run | What it checks |
| --- | --- |
| `npm run lint` | ESLint, Prettier, inline styles, `t()` escaped, formats, messages |
| `npm run typecheck` | Strict TypeScript |
| `npm test` | Unit tests in `test/` (tokens, motion, copy, help, glossary, tours, icons…), and that the bundle and help are current |
| `npm run test:e2e` | The main pages in light, dark and on a phone; the pages' behaviour with the fake API; accessibility; print |
| `npm run test:visual` | Every page against its PNG baseline (light, dark, phone, the pseudo-locale), and the empty, error and dialog states, in the Playwright container; after a deliberate change, `-- --update` and say why in the PR |
| `npm run test:perf` | Long tasks, interaction to next paint, Lighthouse and the gzipped bundle's and stylesheet's sizes |

## Review checklist

Before asking for a review of a page:

- [ ] Built from `ui.ts` components and tokens: no raw values, no `style` attributes, every interpolation escaped.
- [ ] Every word through `t()`, in English and German, written as [writing.md](writing.md) says; terms in the glossary.
- [ ] Loading, empty, failed and without-the-API states.
- [ ] Listeners on `bound()`; rows keyed; nothing kept in `data-` flags.
- [ ] A help section, and the page in the test lists; its behaviour in an e2e test; its logic in unit tests.
- [ ] Keyboard only: every control reached, focus visible, nothing trapped; a screen reader hears names, states and changes.
- [ ] 320 px wide and an ultrawide screen: nothing scrolls sideways, no empty space.
- [ ] Light, dark, forced colours, reduced motion and the pseudo-locale.
- [ ] It prints sensibly (a record without its actions).
- [ ] `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run test:visual` and `npm run test:perf` pass.
