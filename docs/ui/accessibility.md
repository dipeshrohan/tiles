# Accessibility

Tiles aims at WCAG 2.2 AA for every page, in the light and the dark theme, with a keyboard, a screen reader, a magnifier and Windows High Contrast. This page reports where that stands (U6.04), how it is checked, and what is left.

## What the tests check, on every change

`e2e/a11y.test.js` runs in CI's Browser smoke test job. The round-2 checks (reflow, focus, forced colours, target size) run on every page in local mode, and on Home, Warnings, Change reviews, Signals, Insights, Apps and Documents with the API (a fake one holding a warning and a change request):

| Check | WCAG | How |
| --- | --- | --- |
| axe-core's A and AA rules, and the best practices that matter here | 2.1 A/AA | Every page in light and dark, in local mode and with the API's data on screen (charts, Apps and Documents included); dialogs, toasts, tooltips, the command palette, the shortcuts and the help |
| Reflow | 1.4.10 | Every page at 320 px wide (1280 px at 400%) and at 640 px (200%): nothing scrolls sideways, measured inside the scrollbar. A table or chart scrolls inside its own box. |
| Focus visible | 2.4.7 | Tab through every page to the end: each control the keyboard reaches shows an outline or a ring it hasn't at rest |
| Forced colours | 1.4.11, 2.4.7 | The same walk in forced colours (Windows High Contrast), where shadows are dropped: each control shows an outline. What is chosen (the page you're on, a pressed filter, a selected row) is outlined in the system's highlight colour, not shown by background alone. |
| Target size | 2.5.8 (2.2) | Each control (with its label, when it has one) is 24 by 24 px or more; or is inline in running text; or a 24 px circle on its centre touches no other control and no other small control's circle. `--target-min` (24 px) is the token; the Shopfloor uses 64 px. |
| Keyboard order | 2.4.1, 2.4.3 | The first Tab offers **Skip to content**; the menu says whether it is open |
| Live regions | 4.1.3 | The Shopfloor's headline, toasts and the notification count are announced |

The visual tests (`e2e/visual/`) add the pseudo-locale (U6.03): every page with text 40% longer, failing when a page scrolls sideways.

## Round 2 (U6.04): what was found and fixed

| Found | Fix |
| --- | --- |
| The Copilot page was 1 px wider than a 320 px window: a long chip or button set the width of its grid | `.chat` has a `minmax(0, 1fr)` column |
| The breadcrumbs' links were 20 px tall, side by side | `min-height: var(--target-min)` |
| The menu's group headings (which fold their group) were 21 px tall, next to the pages | the same |
| In forced colours, the page you're on in the menu, the section of the guide or the wizard's step you're at, pressed filter buttons and selected rows showed only by background, which High Contrast replaces | outlined in `Highlight`; the focus is a thicker outline outside, so a chosen control shows when it has it too (`@media (forced-colors: active)` at the end of `css/styles.css`) |
| In tables: the row checkboxes (16 px), the sort buttons in the headings (18 px), the column resize handles (8 px), links in cells (16 px), the buttons that open a record (20 px) and the labels in the Columns menu (22 px) | each `--target-min`; the resize handle is 24 px wide with its line at the column's edge |

Checked and found fine: focus rings on every control in both colour modes (Apps and Documents included), and reflow at 200%.

## Exceptions

- **The ontology canvas's nodes** are a map of the plant: their size and spacing are the zoom the person chose (the essential exception of 2.5.8). Every node is reachable with Tab and the arrow keys, has a name (its type, label and how many it folds), and **Fit** and the zoom buttons are full-size controls.
- **Charts and wide tables** scroll inside their own box at narrow widths (two-dimensional content, allowed by 1.4.10). Each chart has a name and a summary of its numbers, and the arrow keys read its points.

## Screen readers: five key flows

These need a person with the screen reader, and are the part of U6.04 still open (#252). Walk each flow with **NVDA on Firefox** (Windows) and **VoiceOver on Safari** (macOS), in local mode and with the Tiles API, and record what happened in the table below. A flow passes when it can be finished without sight, and every step announces what changed.

1. **Triage a warning.** Open Warnings (g w), move through the list with j and k, open one, acknowledge it (a), assign it to yourself (s), resolve it with an outcome (r). Expect: each row's name and status read; the record's heading on opening; "Acknowledged" and the new status announced; the next warning offered.
2. **Find and plot a signal.** Signals (g s), search for a tag, filter by quality, select two rows, plot them. In the Data explorer, change the range, step through a chart's points with the arrow keys, export CSV. Expect: the match count after typing; each chart's summary; each point's time and value.
3. **Change the plant model.** Ontology (g o), add a node, relate it to another with the keyboard, commit with a message (or open a change request); another engineer approves it in Change reviews. Expect: the node's name and folded count; the staged count; the review's diff read as a list.
4. **Ask the copilot.** Copilot, type a question, follow the answer as it streams, open a cited source, rate the answer. Expect: "Answering…" then the answer once (not each word); citations as links; the rating's result.
5. **Get help and change a preference.** Open the help (the ? button) on a page, open the full guide, find a glossary term, switch the language to German in Settings and back. Expect: the sheet's title, the guide's headings as a list of links, the term's definition, the page read in German after the switch.

| Flow | NVDA + Firefox | VoiceOver + Safari | Findings |
| --- | --- | --- | --- |
| 1. Triage a warning | not yet walked | not yet walked | |
| 2. Find and plot a signal | not yet walked | not yet walked | |
| 3. Change the plant model | not yet walked | not yet walked | |
| 4. Ask the copilot | not yet walked | not yet walked | |
| 5. Help and preferences | not yet walked | not yet walked | |

## Remaining

- The screen-reader walks above, and fixing what they find.
- A magnifier walk (ZoomText or Windows Magnifier at 400%) of the Shopfloor and the Data explorer.
- Speech input (Dragon, Voice Control): every control's visible label should start its accessible name; axe's `label-content-name-mismatch` is an experimental rule, not yet in the run.
