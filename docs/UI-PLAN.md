# Tiles: 6-month UI and UX plan

**Window:** 2 Nov 2026 – 30 Apr 2027, alongside the [roadmap](ROADMAP.md) · **Tasks:** the [UI and UX track](TASKS.md#ui-and-ux-track-nov-2026--apr-2027) in TASKS.md

Tiles works, and the [accessibility pass](TASKS.md#ux) made it usable with a keyboard and a screen reader. It doesn't yet feel like one product. Each page grew with its feature, so pages look, load, fail and explain themselves differently. This plan turns the 20 pages into one consistent, quick, self-explanatory app. It does that in six monthly steps, each of which ships on its own.

## Contents

- [Where the UI is today](#where-the-ui-is-today)
- [Goals and measures](#goals-and-measures)
- [Principles](#principles)
- [Who we design for](#who-we-design-for)
- [The months](#the-months)
- [Month by month](#month-by-month)
- [Dependencies on the product roadmap](#dependencies-on-the-product-roadmap)
- [Risks](#risks)
- [How the work is done](#how-the-work-is-done)

## Where the UI is today

From an audit of `js/views/`, `css/styles.css`, `js/app.ts` and `js/lib/svg.ts` (October 2026):

| Area | Today | Problem |
|---|---|---|
| Pages | 20 views; each renders an HTML string, and every change replaces the page and re-binds | Focus, scroll, open sections and text selection are lost on re-render, and the trace can close under a click |
| Styling | One 1,669-line stylesheet; colour tokens, but no spacing, type, radius, z-index or motion tokens. 240+ inline `style=""` attributes (31 in the ontology page alone) | Spacing and type drift between pages; the dark palette is written twice; the Home hero ignores the theme |
| Components | CSS classes only (`.btn`, `.card`, `.badge`, `.empty`…); markup copied between views | The same thing looks different on each page; there is nothing to test once |
| Icons | Unicode glyphs; ✦, ⌁ and ∿ are each used for two pages | Ambiguous menu; glyphs render differently per platform |
| Navigation | Flat sidebar with three groups; breadcrumb always "Home › Page"; no collapse, favourites or recent pages; the mobile drawer has no scrim or focus trap | Hard to find pages; no sense of place inside the plant or a record |
| Feedback | One toast at a time for 2.4 s, no types, queue or undo; 10 native `confirm()` dialogs; no `<dialog>` | Errors vanish before they are read; destructive actions can't be undone; dialogs can't be styled or explained |
| Loading | Text such as "Loading…"; no skeletons, spinners or `aria-busy` | Layout jumps when data arrives; slow APIs look broken |
| Empty and error states | Bare text; error cards in some pages, with "Try again" in a few | New users don't know what to do next |
| Forms | HTML `required` and toasts; no inline errors, `aria-invalid` or error summary; API 422 details not shown on fields | Users can't see which field is wrong |
| Motion | Two transitions (toast, mobile drawer); no page transitions; reduced motion handled | The app feels abrupt, and changes go unnoticed |
| Help | No help, glossary, tooltips (only `title=`), tours, command palette, global search or shortcuts; nothing in the app links to the user guide | Every concept has to be learned from people or docs outside the app |
| Onboarding | The site wizard is the last menu item and needs API mode; no first-run experience | New users land on a demo home with no next step |
| Charts | Static SVG; drag-to-zoom in the explorer only, with no reset; no hover readout | Exact values can't be read; charts can't be exported |
| Tables | Plain tables; no sorting, column choice, sticky header or paging | Large catalogues (signals, warnings) are hard to scan |
| State | Per-page UI state is in memory only; filters aren't in the URL | Reload or share a link and the view is lost |
| Locale | English only; `en-US` and `en-GB` formatting mixed; `timeAgo` returns a date | Not ready for a German-speaking plant; inconsistent numbers and dates |
| Print | No print styles | Warnings, insights and review diffs print badly |
| Testing | axe in light and dark on 19 routes (not Apps or Documents); no visual regression tests | Visual changes go unreviewed; two pages unchecked |

## Goals and measures

By 30 April 2027:

| Measure | Baseline | Target | How it's measured |
|---|---|---|---|
| System Usability Scale (SUS) | Measured in U1.01 | ≥ 75, and +10 on the baseline | 8+ users per round, U1.01 and U6.07 |
| Task success on 6 key tasks | Measured in U1.01 | ≥ 90% without help | Moderated test script in `docs/ui/research/` |
| Time on key tasks (triage a warning, find a signal and plot it, commit an ontology change) | Measured in U1.01 | −30% | Same script, timed |
| Accessibility | 0 axe violations on 19 routes | 0 on every route, including Apps and Documents; 5 flows walked with NVDA and VoiceOver; 200% zoom and forced colours work | `e2e/a11y.test.js`, U6.04 report |
| Consistency | 240+ inline styles; no tokens for spacing or type | ≤ 20 inline styles (only computed values); every page uses `js/lib/ui.ts` page head, empty state and error state | Lint rule (U1.03) and a count in CI |
| Responsiveness | Not measured | Interaction to Next Paint < 200 ms and no long task > 50 ms on the 2,069-node ontology fixture; Lighthouse performance ≥ 90 | U3.07 performance check in CI |
| Self-service | No in-app help | Every page has contextual help; 80% of pilot users' questions answered in the app or guide links (FDE log) | U4.04, monthly FDE notes |
| Visual regressions | Not checked | Screenshots of every page in light, dark and mobile compared on every PR | U1.08 |

## Principles

1. **Keep what works.** No runtime dependencies in the browser app, `index.html` still opens from `file://`, and the tested logic in `js/lib/` stays. New building blocks are small modules in `js/lib/`, written and tested like the rest.
2. **One way to do each thing.** A component, a token or a pattern once, documented in the style guide (U1.07), used everywhere. Pages compose; they don't style.
3. **Accessible by construction.** Every component meets WCAG 2.1 AA in light, dark and forced colours, with keyboard use and screen-reader names built in. axe runs on every page in CI; nothing ships that fails it.
4. **Motion explains, never decorates.** Transitions show where something came from or went: 120–320 ms, ease-out to enter, ease-in to leave. All of it is off with `prefers-reduced-motion` or the user's setting.
5. **Never lose the user's work or place.** Focus, scroll, open sections, typed text and filters survive re-renders, reloads and back/forward. Destructive actions can be undone or are confirmed in words.
6. **Say what happened and what to do next.** Every loading, empty, error and success state names the next step and, when it helps, links to help.
7. **Fill the screen.** No empty space on ultrawide screens; layouts grow columns rather than margins. The shopfloor view stays readable at arm's length with gloves.
8. **Measure.** Every month ends with a check against the measures above, and the next month's order can change on what it shows.

## Who we design for

| Persona | Where | What they need from the UI |
|---|---|---|
| **Process engineer** (primary) | Desk, two screens, often ultrawide | Find signals fast, compare, save and share findings; dense tables and charts with exact values |
| **Maintenance technician** | Tablet on the line, gloves | Warnings first, big targets, readable in bright light, works on a flaky network |
| **Shift lead** | Tablet and desk | What changed this shift, who is on what, hand-over |
| **Plant or site admin** | Desk | Set up sites, agents, people and the copilot without reading the docs end to end |
| **Data scientist or model author** | Desk | Run models, sweeps and backtests; export data and charts |

U1.01 checks these personas with the design partner and adjusts them.

## The months

| Month | Theme | Ships |
|---|---|---|
| **1** (Nov 2026) | Foundations: research and the design system | Baseline study, tokens, components, icons, page head, style guide, visual tests |
| **2** (Dec 2026) | Feedback and states | Dialogs, toasts with undo, skeletons, empty and error states, inline form errors |
| **3** (Jan 2027) | Motion, rendering and navigation | Motion system, page transitions, DOM patching that keeps state, URL state, sidebar v2, performance budget |
| **4** (Feb 2027) | Help, onboarding and discoverability | Command palette and search, shortcuts, contextual help, glossary, first run, tours, what's new, feedback |
| **5** (Mar 2027) | Workflow polish for the live pilot | Role-based home, tables v2, charts v2, triage flow, ontology builder UX, saved views, notifications |
| **6** (Apr 2027) | Language, accessibility and v1.0 polish | Internationalisation, German, accessibility round 2, print, preferences, the second study and fixes |

In all: 53 tasks plus 2 ongoing, about 148.5 engineer-days, mostly FE with PM for research, copy and help. That is roughly a quarter of the FE's time over the six months, alongside the product roadmap's FE tasks. Each month has an exit check. A month's tasks don't wait for the previous month's to all finish; only the dependencies named on each task do.

## Month by month

Estimates are engineer-days. Owners: FE frontend, PM product and design, BE backend, FDE on-site engineer. ◇ marks a stretch item.

### Month 1: Foundations (Nov 2026)

**Goal:** measure where users struggle, and build the design system every later month uses.

- **U1.01 Baseline usability study** [#204](https://github.com/dipeshrohan/tiles/issues/204) · PM+FDE · 3d. Heuristic review of every page (Nielsen's 10, plus the audit above). Then a moderated test of 6 key tasks with 8 people across the personas, 3 of them from the design partner:
  1. Triage a new warning.
  2. Find a signal and plot a week of it.
  3. Commit an ontology change through review.
  4. Run a correlation on a batch table.
  5. Ask the copilot about a machine.
  6. Set up a new site.

  Record success, time, errors and SUS; write the results and a ranked problem list to `docs/ui/research/2026-11-baseline.md`.
  *Done when:* the baseline numbers are in the [measures](#goals-and-measures) table and the top 20 problems each map to a task in this plan.
- **U1.02 Design tokens** [#205](https://github.com/dipeshrohan/tiles/issues/205) · FE · 3d. Add CSS custom properties to `css/styles.css`:
  - spacing (4 px base: `--space-1` … `--space-8`);
  - type scale (`--text-xs` … `--text-2xl`, with line heights);
  - radii (`--radius-sm/md/lg/full`);
  - shadows (`--shadow-1/2/3`);
  - z-index layers (`--z-nav`, `--z-dialog`, `--z-toast`, `--z-tooltip`);
  - motion (`--dur-fast` 120 ms, `--dur` 200 ms, `--dur-slow` 320 ms, `--ease-out`, `--ease-in`).

  Write the dark palette once (with `light-dark()`, or one shared block for the media query and `[data-theme=dark]`). Move the Home hero onto theme tokens. Replace hard-coded values with tokens across the stylesheet.
  *Done when:* no raw `px` for spacing, font size or radius is left in `styles.css` outside the token block, and screenshots match before and after (±1 px).
- **U1.03 Remove inline styles** [#206](https://github.com/dipeshrohan/tiles/issues/206) · FE · 4d · U1.02. Replace the 240+ `style=""` attributes in views with layout utilities (`.stack-*`, `.row-*`, `.gap-*`, `.grow`, `.muted`…) and component classes. Add a lint check (`scripts/check-inline-styles.js`, run by `npm run lint`) that fails on a new inline style in `js/views/`, except computed values passed through `styleVars()` as CSS variables.
  *Done when:* ≤ 20 inline styles remain, all computed; the check runs in CI.
- **U1.04 Component module `js/lib/ui.ts`** [#207](https://github.com/dipeshrohan/tiles/issues/207) · FE · 4d · U1.02. Typed functions that return escaped HTML strings: `button`, `iconButton`, `card`, `badge`, `chip`, `field` (label, hint, error), `select`, `pageHead`, `emptyState`, `errorState`, `skeleton`, `kv`, `tabs`, `table` (headers with `scope`, `sr-only` action column). Each one escapes every interpolated value, so a view can't forget `esc()`. Unit tests for markup, escaping and accessible names.
  *Done when:* three pages (Signals, Warnings, Documents) use the module for every component it has, with no visual change.
- **U1.05 Icon set** [#208](https://github.com/dipeshrohan/tiles/issues/208) · FE+PM · 2d. An inline SVG sprite in `index.html`: 24 px, 1.5 px stroke, `currentColor`, in one consistent style, drawn or taken from an MIT/ISC-licensed set. Then an `icon(name)` helper (`aria-hidden`, with a text label beside it or `sr-only`) and a unique icon for each page. Replace the Unicode glyphs in the menu, buttons and badges.
  *Done when:* no page shares an icon, icons follow the theme, and they look the same on Windows, macOS, Android and iOS.
- **U1.06 Page head and breadcrumbs** [#209](https://github.com/dipeshrohan/tiles/issues/209) · FE · 2d · U1.04. One `pageHead({ eyebrow, title, crumbs, actions, help })` used by every page (the Home hero and Shopfloor keep their own layouts but share its parts). Breadcrumbs follow the hierarchy: Plant › Line 2 › DC-01 › Signals; Insights › #12; Reviews › #4. They are links, and `aria-current` marks the last.
  *Done when:* every page with a record or a place shows where it is, and a reload or shared link shows the same breadcrumb.
- **U1.07 Style guide page** [#210](https://github.com/dipeshrohan/tiles/issues/210) · FE · 2d · U1.04, U1.05. `#/styleguide` (hidden from the menu, reachable from Settings → About). It shows every token, component, state and icon in light and dark, with the code to use it. axe-tested like any page.
  *Done when:* a new contributor can build a page from it alone, as tried in one PR.
- **U1.08 Visual regression tests** [#211](https://github.com/dipeshrohan/tiles/issues/211) · FE · 2d. Playwright screenshots of every page (and key states: empty, loading, error, dialog open) in light, dark and mobile, against the fake API with a fixed clock. Images are compared within a threshold, and the diffs are uploaded as a CI artefact. Baselines are updated only with `npm run test:visual -- --update` in a PR that says why.
  *Done when:* a 2 px padding change on `.card` fails CI with a readable diff.
- **U1.09 UX analytics, privacy first** [#212](https://github.com/dipeshrohan/tiles/issues/212) · FE+BE · 2d. Opt-in per organisation, off by default. The events are page views, task milestones (e.g. warning acknowledged), command-palette use, help opened, and errors shown. They carry no names, e-mails or free text; IDs are hashed. Events are kept 90 days, are visible to admins as counts, and are documented in the admin guide.
  *Done when:* U1.01's key tasks can be measured from events on the pilot site, and the data stays in the deployment.

**Month 1 exit check:** baseline measured; tokens and `ui.ts` used by at least three pages; style guide and visual tests in CI.

### Month 2: Feedback and states (Dec 2026)

**Goal:** the app always says what is happening, what went wrong and what to do next, and nothing destructive happens by accident.

- **U2.01 Dialogs** [#213](https://github.com/dipeshrohan/tiles/issues/213) · FE · 3d · U1.04. A `dialog()` helper on the native `<dialog>`:
  - focus moves in and stays in, Escape and the backdrop close it, and focus returns to the opener;
  - `aria-labelledby` and `aria-describedby`;
  - sizes: small for confirmations, medium for forms, a full-height side sheet for details.

  Replace all 10 `confirm()` calls (settings ×3, insights, correlate, documents, chat, apps, org sign-in ×2). A confirmation names the thing and the consequence. For something that can't be undone (reset demo data, revoke the SCIM token), the user types its name to confirm.
  *Done when:* no `confirm()`, `alert()` or `prompt()` remains (a lint rule enforces it), and the a11y test opens each dialog.
- **U2.02 Toasts v2** [#214](https://github.com/dipeshrohan/tiles/issues/214) · FE · 2d · U1.04. A queue of up to 3 at once, with types: success, info, warning, error.
  - Errors stay until dismissed and show the request ID.
  - Success toasts last 5 s and pause on hover or focus.
  - A toast can carry an action (Undo, View, Retry).
  - `role=status` for success and info, `role=alert` for errors.
  - `ctx.toast(message, { type, action })` keeps today's one-argument form working.
  *Done when:* an API error stays on screen with its request ID until dismissed, and screen readers announce it once.
- **U2.03 Undo instead of confirm** [#215](https://github.com/dipeshrohan/tiles/issues/215) · FE+BE · 3d · U2.02. Archiving a document, deleting a conversation, removing a dataset and removing an app become soft: they are hidden at once, with an Undo toast for 8 s, then made final. The API gets a `restore` endpoint, or a short delay in the client, per case. They keep the audit entries they have.
  *Done when:* each of the four can be undone from the toast, and a test proves the row is back.
- **U2.04 Skeletons and loading** [#216](https://github.com/dipeshrohan/tiles/issues/216) · FE · 3d · U1.04. `skeleton.table(rows, cols)`, `skeleton.card()`, `skeleton.chart()` and `skeleton.text(lines)`, matching the final layout's size so nothing jumps. They appear only after 300 ms, so fast answers don't flash. Regions carry `aria-busy="true"` while loading. Buttons that start work show an inline spinner and keep their width.
  *Done when:* every page that loads from the API shows a skeleton in its shape; layout shift (CLS) < 0.05 on page load.
- **U2.05 Empty states with a next step** [#217](https://github.com/dipeshrohan/tiles/issues/217) · PM+FE · 3d · U1.04, U1.05. One `emptyState({ icon, title, body, primary, secondary, help })` per empty place, with a themeable line illustration and words that say why it's empty and what to do. For example: "No warnings yet. Detectors raise them when a signal leaves its usual range. Set up a detector →".
  *Done when:* every list and chart in every page has a written empty state, reviewed against the copy guide (U2.09).
- **U2.06 Error states and offline** [#218](https://github.com/dipeshrohan/tiles/issues/218) · FE · 2d · U2.02.
  - **`errorState`** is the one error card: what failed, why (when known), Retry, and "Copy details" (request ID, time, page, version).
  - **Offline banner:** when the browser goes offline or the API can't be reached, a banner says so. Writes are disabled with a reason until the connection is back, and the banner offers to retry. Shopfloor keeps its last data with "as of 10:42".
  - **Errors by status:** 403 says which role is needed, 404 offers a way back, and 409 explains the conflict.
  *Done when:* each error kind has a test in the smoke suite with the fake API failing on purpose.
- **U2.07 Form validation** [#219](https://github.com/dipeshrohan/tiles/issues/219) · FE · 3d · U1.04. Inline errors under fields, with `aria-invalid` and `aria-describedby`. An error summary at the top of the form on submit links to each field. The API's 422 details (`loc`, `msg`) are mapped to fields. Fields are validated on blur after the first submit, never while typing the first time. Hints, units and examples sit in the field's hint text.
  *Done when:* every form (import mapping, signal edit, detector, notification settings, site creation, app config) shows the API's field errors on the fields.
- **U2.08 Pending and optimistic updates** [#220](https://github.com/dipeshrohan/tiles/issues/220) · FE · 2d · U2.02. Buttons show progress while their request runs (`aria-busy`, disabled, spinner) and can't be pressed twice. Quick toggles (acknowledge a warning, rate an answer, star a page) update at once, and roll back with an error toast if the API refuses.
  *Done when:* no double submissions in the smoke suite with a slowed API, and every optimistic change rolls back on failure.
- **U2.09 Words and tone guide** [#221](https://github.com/dipeshrohan/tiles/issues/221) · PM · 1.5d. `docs/ui/writing.md`: sentence case, plain words, verbs on buttons ("Acknowledge", not "OK"), units, numbers and dates, error message pattern (what happened, why, what to do), glossary terms (U4.05). Then review the copy of every page against it.
  *Done when:* the guide is merged and every page's copy reviewed against it.

**Month 2 exit check:** no native dialogs; every page has loading, empty and error states; the API's field errors appear on fields.

### Month 3: Motion, rendering and navigation (Jan 2027)

**Goal:** the app feels smooth and keeps the user's place; finding a page is easy.

- **U3.01 Motion system** [#222](https://github.com/dipeshrohan/tiles/issues/222) · PM+FE · 1d · U1.02. `docs/ui/motion.md`:
  - **Durations:** fast 120 ms (hover, press), standard 200 ms (expand, toast), slow 320 ms (page, sheet).
  - **Easing:** ease-out to enter, ease-in to leave.
  - **What moves:** only opacity and transform (no layout).
  - **Rules:** at most one thing moves at a time in one place, and nothing loops.
  - **Reduced motion:** `prefers-reduced-motion` and a setting (U6.06) turn movement into a fade or nothing.
  *Done when:* the guide is merged and the tokens from U1.02 implement it.
- **U3.02 Page transitions** [#223](https://github.com/dipeshrohan/tiles/issues/223) · FE · 2d · U3.01, U3.03. Route changes use the View Transitions API where the browser has it (a cross-fade with the page head kept in place; records open from a list grow from their row). Without it, nothing moves. Focus still goes to the new page's heading, and the change is announced.
  *Done when:* transitions run in Chromium and Safari, are absent with reduced motion, and the a11y and smoke suites pass.
- **U3.03 DOM patching that keeps state** [#224](https://github.com/dipeshrohan/tiles/issues/224) · FE · 5d. A small morphing renderer (`js/lib/morph.ts`, no dependency) replaces `innerHTML` swaps. It updates the existing DOM to match the new HTML, keyed by `id` and `data-key`. Focus, caret, scroll, `<details>` open state, `<dialog>` and text selection survive every re-render. Event binding moves to delegation on the view root, so re-binding after each render isn't needed.
  *Done when:* typing, scrolling a table and an open trace all survive a background refresh in tests, and the copilot trace flake (#195) can't happen again; render time on the large ontology fixture is no worse.
- **U3.04 Micro-interactions** [#225](https://github.com/dipeshrohan/tiles/issues/225) · FE · 2d · U3.01. Hover, press and focus states on every control, using tokens. `<details>` opens with a height animation. List rows fade in when added and out when removed. KPI numbers tick to their new value. Selected rows and active tabs move a highlight rather than jump.
  *Done when:* the style guide shows each; nothing moves with reduced motion.
- **U3.05 State in the URL and restored** [#226](https://github.com/dipeshrohan/tiles/issues/226) · FE · 3d · U3.03.
  - **In the query string:** filters, sort, search, selected record and chart range (`#/warnings?status=open&asset=DC-01&sort=-raised`), so links share a view.
  - **Per page, in sessionStorage:** other UI state (open sections, column widths).
  - **Scroll position:** restored on back and forward.
  - **Persisted:** the Explorer's signals and range, the Signals page's filters and the Warnings page's filters.
  *Done when:* reloading or opening a copied link shows the same view on those three pages, and back restores the scroll.
- **U3.06 Sidebar v2** [#227](https://github.com/dipeshrohan/tiles/issues/227) · FE · 3d · U1.05. The sidebar gets:
  - groups that collapse, remembered per user;
  - a collapsed icon rail (with tooltips) for wide data pages;
  - pinned favourites and the last 5 pages;
  - badges with counts (open warnings, reviews waiting for me);
  - on mobile, a scrim, a focus trap and swipe to close.

  The menu is reordered by the U1.01 findings (Operations first for maintenance, Data first for engineers, set by role in U4.06).
  *Done when:* each of these works by keyboard, is tested, and fits at 320 px wide.
- **U3.07 Performance budget** [#228](https://github.com/dipeshrohan/tiles/issues/228) · FE · 2d · U3.03. A CI check (Playwright with the performance API) on three heavy pages: the ontology with 2,069 nodes, signals with 5,000 rows, and the explorer with 4 signals over 30 days. No long task over 50 ms after load, Interaction to Next Paint under 200 ms on filter and zoom, and the bundle under a size budget. Lighthouse performance ≥ 90 on Home.
  *Done when:* the check fails on a deliberate regression and passes on main.
- **U3.08 ◇ Split view for records** [#229](https://github.com/dipeshrohan/tiles/issues/229) · FE · 3d · U3.03. On screens wider than 1,280 px, lists with records (warnings, reviews, insights, documents) open the record beside the list rather than replacing it. j/k move through the list, the URL names the record, and the layout fills ultrawide screens.
  *Done when:* the four pages work in split view and fall back to a single column on narrow screens.

**Month 3 exit check:** no lost focus or scroll on re-render; links carry filters; the performance check is green.

### Month 4: Help, onboarding and discoverability (Feb 2027)

**Goal:** a new user can learn Tiles in Tiles; an experienced one can get anywhere from the keyboard.

- **U4.01 Search across the site (API)** [#230](https://github.com/dipeshrohan/tiles/issues/230) · BE · 3d. `GET /sites/{id}/search?q=` searches signals (tag, description), ontology nodes (label, type), warnings (signal, asset), insights (title), documents (title and chunks, from T4.08), apps and pages. Results are ranked, grouped by kind, limited per kind, filtered by the user's role, and come back within 150 ms on the load-test site. Documented and tested.
  *Done when:* the endpoint is in the API reference, with tests for ranking and row security.
- **U4.02 Command palette** [#231](https://github.com/dipeshrohan/tiles/issues/231) · FE · 4d · U4.01, U2.01. Ctrl/⌘ K, or `/`, opens a palette with:
  - pages, recent records and actions ("New import", "Ask the copilot…", "Switch site", "Toggle dark mode");
  - site search results (U4.01) as you type.

  It is an accessible combobox (`role=combobox` with a listbox, arrow keys, Enter, Escape), works in local mode with pages and actions only, and remembers recent picks.
  *Done when:* each of the 6 key tasks can start from the palette, and the a11y test opens it.
- **U4.03 Keyboard shortcuts** [#232](https://github.com/dipeshrohan/tiles/issues/232) · FE · 2d · U4.02.
  - **Global:** `g` then a letter goes to a page (g w Warnings, g s Signals, g e Explorer, g o Ontology…), and `?` shows every shortcut in a dialog.
  - **Per page:** j/k to move, Enter to open, a to acknowledge, e to edit, / to search.
  - **Not while typing:** shortcuts never fire in a field.
  - **Listed in the UI:** in the dialog and in each button's tooltip, and they can be turned off in preferences (U6.06).
  *Done when:* the shortcuts work, are listed, and are tested; nothing clashes with screen-reader keys.
- **U4.04 Contextual help panel** [#233](https://github.com/dipeshrohan/tiles/issues/233) · PM+FE · 3d · U1.06, U2.01. A help button in each page head opens a side sheet with that page's help. The help is written in `docs/guides/user.md` sections, bundled into the app at build time (no network needed, works from `file://`), with links to the full guide. Help is searchable from the command palette.
  *Done when:* every page has help, the build fails if a page has none, and links from help land on the right section.
- **U4.05 Glossary and term tooltips** [#234](https://github.com/dipeshrohan/tiles/issues/234) · PM+FE · 3d · U2.01. `docs/ui/glossary.md` covers about 60 terms: ISA-95 levels, signal, tag, virtual sensor, MAD, baseline, persistence, cooldown, Cohen's d, point-biserial r, wear, Theil–Sen, grounding, change request…

  A tooltip component (not `title=`):
  - shows on hover after 400 ms, on focus at once, and on tap;
  - can be dismissed with Escape;
  - is described with `aria-describedby`.

  Terms are linked where they first appear on each page, and the glossary is a page of its own.
  *Done when:* the analytics pages (correlate, wear, performance, detectors) explain every statistical term in place.
- **U4.06 First run** [#235](https://github.com/dipeshrohan/tiles/issues/235) · PM+FE · 3d · U2.01. The first time someone signs in, a welcome dialog:
  - asks their role (engineer, maintenance, shift lead, admin), which sets their home page and menu order;
  - offers the site wizard (admins of a new site), a tour, or "just look around";
  - is remembered per user, and can be restarted from Help.

  In local mode it explains the demo data.
  *Done when:* a new user on the pilot site reaches their first useful page in under 2 minutes in U6.07's test.
- **U4.07 Guided tours** [#236](https://github.com/dipeshrohan/tiles/issues/236) · FE · 4d · U4.06. A tour runner: a spotlight on one element, a popover with text, Next and Back, and a step count. It can be left at any step, is keyboard and screen-reader friendly, and is paused with reduced motion. Four tours: triaging a warning, finding and plotting a signal, staging and committing an ontology change, asking the copilot. Tours are defined in data (`js/lib/tours.ts`), and a test checks every target still exists.
  *Done when:* the four tours run end to end in CI.
- **U4.08 What's new** [#237](https://github.com/dipeshrohan/tiles/issues/237) · FE · 1.5d. The build turns the CHANGELOG's top section into a "What's new" sheet. A dot on the help button marks a version the user hasn't seen, and entries link to the page or help they describe.
  *Done when:* updating the CHANGELOG updates the sheet with no other change.
- **U4.09 In-app feedback** [#238](https://github.com/dipeshrohan/tiles/issues/238) · BE+FE · 2d · U2.01. "Send feedback" in the help menu takes a short text and a mood (😞 😐 🙂). The page, version, browser and an optional screenshot of the page (the user can see and remove it) are attached. It is stored per site (row security, migration), and admins list it in Settings. The user can choose to include their name; otherwise it is anonymous.
  *Done when:* feedback is sent, stored, listed and audited, with tests.
- **U4.10 ◇ Onboarding wizard in local mode** [#239](https://github.com/dipeshrohan/tiles/issues/239) · FE · 2d · U4.06. The site wizard works on the demo data too: an outline is built in the browser, the agent step shows how to install one, and mapping uses the demo tags. New users can learn the flow before they have an API.
  *Done when:* the wizard runs to its end in local mode.

**Month 4 exit check:** every page has help; the palette, shortcuts, glossary and four tours are live; first run is on for new users.

### Month 5: Workflow polish for the live pilot (Mar 2027)

**Goal:** the pages people use every day on the pilot line are fast, dense where they should be and simple where they must be.

- **U5.01 Home by role** [#240](https://github.com/dipeshrohan/tiles/issues/240) · PM+FE · 4d · U4.06. Home becomes a dashboard of cards set by role:
  - **Maintenance:** my open warnings and machines out of range.
  - **Engineers:** reviews waiting for me, recent insights, data freshness.
  - **Shift lead:** this shift's warnings and acknowledgements.
  - **Admins:** agent health and data quality.

  Users can add, remove and order cards, and their choice is kept with the user (API). The demo hero stays in local mode only.
  *Done when:* each role's home answers "what needs me now?" in U6.07's test.
- **U5.02 Tables v2** [#241](https://github.com/dipeshrohan/tiles/issues/241) · FE · 4d · U1.04, U3.05. One `table()` behaviour for every list:
  - sortable headers with `aria-sort`;
  - a sticky header and first column;
  - column choice and widths, remembered;
  - density (comfortable or compact);
  - row selection with a bulk-action bar;
  - paging, or virtual rows past 500;
  - CSV export of the current view;
  - an empty state, and a skeleton while loading.

  Used by signals, warnings, documents, insights, reviews, agents and the audit log.
  *Done when:* the seven tables use it and 5,000 signal rows scroll at 60 fps.
- **U5.03 Charts v2** [#242](https://github.com/dipeshrohan/tiles/issues/242) · FE · 4d · U3.01. `timeChart` and the other charts in `svg.ts` get:
  - a hover and touch crosshair with a value readout per series;
  - keyboard focus on data (arrow keys step through points, read out);
  - a legend that toggles series;
  - a zoom reset and zoom out, with brushing kept in the explorer;
  - export to PNG and CSV.

  The summary for screen readers is kept, and the charts remain plain SVG.
  *Done when:* exact values can be read with a mouse, touch and keyboard, with a11y tests.
- **U5.04 Warning triage flow** [#243](https://github.com/dipeshrohan/tiles/issues/243) · FE · 3d · U3.08, U5.02. The warnings inbox gets:
  - keyboard triage (j/k, a acknowledge, s assign to me, r resolve with outcome);
  - bulk acknowledge and assign;
  - the signal chart and the warning's history beside the list (split view);
  - "Next warning" after each action.
  *Done when:* triaging 10 warnings takes under half the U1.01 time.
- **U5.05 Ontology builder UX** [#244](https://github.com/dipeshrohan/tiles/issues/244) · FE · 5d · U3.03. The builder gets:
  - an inspector panel for the selected node and its relationships;
  - a minimap;
  - drag from one node to another to add a relationship;
  - multi-select with a box or shift-click;
  - undo and redo of staged operations (Ctrl Z, Ctrl Shift Z);
  - keyboard moves between nodes;
  - "fit to screen" and "focus selection".

  It stays fast on the 2,069-node plant.
  *Done when:* committing a 5-node change takes under half the U1.01 time, and the performance check stays green.
- **U5.06 Filter bar and saved views** [#245](https://github.com/dipeshrohan/tiles/issues/245) · FE+BE · 3d · U3.05. A filter bar component: chips for each filter, an "add filter" menu, clear all, and the count of results. Users save a view (filters, sort, columns) under a name and can share it with the site. Saved views are stored by the API (migration, row security, audited) and listed in the sidebar's favourites.
  *Done when:* Warnings, Signals and Documents have saved views shared on the pilot site.
- **U5.07 Notification centre** [#246](https://github.com/dipeshrohan/tiles/issues/246) · FE+BE · 3d · U2.02. A bell in the top bar with an unread count lists warnings assigned to me, reviews requested of me, insights waiting for my review, and failed imports. Each links to its page and can be marked read. It is fed by the API (an inbox per user from the notifications outbox, T3.09), polled every 60 s, and announced politely.
  *Done when:* a review request reaches the reviewer's bell within a minute, with tests.
- **U5.08 Shopfloor field round** [#247](https://github.com/dipeshrohan/tiles/issues/247) · FDE+FE · 2d · U2.06. A day on the pilot line: glove tests on every control, readability in direct light (a high-contrast option for the shopfloor), what happens on a lost network (last data kept, "as of" time, retry), and a wake lock while the page is open. Findings are fixed in the same task or filed.
  *Done when:* technicians on the line can triage with gloves in sunlight, as tested with them.
- **U5.09 ◇ Compare mode** [#248](https://github.com/dipeshrohan/tiles/issues/248) · FE · 3d · U5.03. Overlay two time ranges, or two machines, on one chart in the explorer (shift-aligned), with the difference shown.
  *Done when:* engineers on the pilot use it to compare before and after a change.

**Month 5 exit check:** the pilot's daily pages (home, warnings, signals, explorer, ontology) are reworked and tested with pilot users.

### Month 6: Language, accessibility and v1.0 polish (Apr 2027)

**Goal:** v1.0 ships in the plant's language, works for everyone, and measurably beats the baseline.

- **U6.01 Internationalisation** [#249](https://github.com/dipeshrohan/tiles/issues/249) · FE · 4d · U1.04. A message catalogue (`js/i18n/en.json`, typed keys, ICU-style plurals and selects through `Intl.PluralRules`), with no dependency. Strings move out of views into it. A CI check finds hard-coded user-facing text in views and keys missing from a locale. Messages from the API (errors, help) carry a code the client can translate.
  *Done when:* every view's text comes from the catalogue, and the check runs in CI.
- **U6.02 Numbers, dates and units by locale** [#250](https://github.com/dipeshrohan/tiles/issues/250) · FE · 2d · U6.01. One `format.ts` on `Intl`: numbers, percentages, durations, dates and times (in the site's time zone, with the zone shown), and relative time ("3 min ago", fixing `timeAgo`). Units are shown with their signal. The `en-US` and `en-GB` mix is replaced. It follows the user's locale setting.
  *Done when:* no `toLocaleString` with a hard-coded locale remains, and tests cover three locales.
- **U6.03 German, and a pseudo-locale** [#251](https://github.com/dipeshrohan/tiles/issues/251) · PM+FE · 3d · U6.01. A German translation reviewed by a native-speaking engineer at the design partner, with the glossary's terms agreed. A pseudo-locale (accented, 40% longer) finds layouts that break with longer text; the visual tests run in it.
  *Done when:* the pilot's users can use Tiles in German, and no layout breaks in the pseudo-locale.
- **U6.04 Accessibility round 2** [#252](https://github.com/dipeshrohan/tiles/issues/252) · FE · 3d. The checks:
  - Apps and Documents added to `e2e/a11y.test.js`;
  - forced colours (Windows High Contrast);
  - 200% zoom and 320 px reflow;
  - visible focus on every control;
  - target sizes of 24 px or more (WCAG 2.2);
  - five key flows walked with NVDA on Firefox and VoiceOver on Safari, with the findings fixed.

  The report and remaining items go to `docs/ui/accessibility.md`.
  *Done when:* the report is merged, and the five flows work with both screen readers.
- **U6.05 Print styles** [#253](https://github.com/dipeshrohan/tiles/issues/253) · FE · 2d. `@media print` for warnings (with chart and activity), insights (with evidence), review diffs, the run audit and the plant sheet: no menu, page breaks between records, links printed after their text, and charts in black and white with patterns.
  *Done when:* each prints on A4 and Letter without cut content.
- **U6.06 Preferences** [#254](https://github.com/dipeshrohan/tiles/issues/254) · FE+BE · 2d · U6.01. A "Your preferences" page: theme, density, language and number format, time zone display, reduced motion, shortcuts on or off, start page and home cards. They are stored with the user (API) and follow them across devices.
  *Done when:* each preference applies at once and survives sign-out and sign-in.
- **U6.07 Usability study 2 and fixes** [#255](https://github.com/dipeshrohan/tiles/issues/255) · PM+FE · 5d · U5.01–U5.05. Repeat U1.01 with the same tasks and 8+ people, including pilot users, and compare with the baseline. Fix the top 10 problems found, within the task.
  *Done when:* the [measures](#goals-and-measures) are reported against their targets in `docs/ui/research/2027-04-v1.md`.
- **U6.08 UI handbook** [#256](https://github.com/dipeshrohan/tiles/issues/256) · FE · 1.5d · U1.07. `docs/ui/README.md` brings the plan's outputs together: tokens, components, motion, writing, help and glossary authoring, tours, i18n, accessibility, and visual tests. It is linked from CONTRIBUTING and CLAUDE.md.
  *Done when:* a new page built from the handbook passes review with no UI comments.

**Month 6 exit check:** v1.0 in English and German; the measures met or explained; the handbook merged.

### Every month

- **U0.01 Design review on every UI PR** [#257](https://github.com/dipeshrohan/tiles/issues/257) · PM+FE. Screenshots or a short recording in the PR (light and dark, desktop and mobile), visual diffs reviewed, and the style guide updated with any new component.
- **U0.02 Monthly UX check** [#258](https://github.com/dipeshrohan/tiles/issues/258) · PM. Look at the analytics (U1.09), the feedback (U4.09), the FDE's notes and the measures. Re-order the next month if the evidence says so, and record the decision in this plan.

## Dependencies on the product roadmap

| UI task | Needs | Why |
|---|---|---|
| U1.01, U6.07 | T2.16 design partner, T5.01 pilot live | Real users on real tasks |
| U4.01 search | T4.08 document search, T2.08 signal catalogue | Content to search |
| U4.04 help | T6.05 user guide | The help text is the guide |
| U5.07 notifications | T3.09 notifications outbox | The source of the inbox |
| U5.08 field round | T5.16 Shopfloor, the pilot line | Testing on the line |
| U6.03 German | Design partner's reviewer | Terms the plant uses |

## Risks

| Risk | Likelihood | Effect | Mitigation |
|---|---|---|---|
| The morphing renderer (U3.03) breaks pages in subtle ways | Medium | High | Land it behind a flag, page by page; the visual and smoke suites must pass per page |
| UI work competes with pilot work for the one FE | High | High | Month 5 is the pilot's pages; ◇ items are cut first; PM writes copy, help and glossary |
| Visual tests are flaky (fonts, timing) | Medium | Medium | Fixed clock, bundled font, animations off in tests, thresholds per page |
| Translations lag features | Medium | Low | The CI check fails on missing keys; English is the fallback, with a marker in the pseudo-locale |
| Analytics raise privacy concerns at the plant | Low | Medium | Off by default, no personal data, kept in the deployment, documented for the security review (T3.15) |

## How the work is done

- Each task is a GitHub issue under its month's epic ([1](https://github.com/dipeshrohan/tiles/issues/197) · [2](https://github.com/dipeshrohan/tiles/issues/198) · [3](https://github.com/dipeshrohan/tiles/issues/199) · [4](https://github.com/dipeshrohan/tiles/issues/200) · [5](https://github.com/dipeshrohan/tiles/issues/201) · [6](https://github.com/dipeshrohan/tiles/issues/202) · [every month](https://github.com/dipeshrohan/tiles/issues/203)), labelled `ui`, `ui-month-N` and its owner's role. Close it when its *Done when* is met.
- Every UI PR keeps the rules in CLAUDE.md: `esc()` on interpolation (or `ui.ts`, which does it), axe in light and dark, no runtime dependencies, `file://` works, tests with every behaviour change.
- Changes users notice go in the CHANGELOG's top section, which also feeds "What's new" (U4.08).
