# Writing for Tiles

How Tiles talks to the people who use it (U2.09): process engineers at a desk, technicians at a tablet on the line, shift leads, site admins and model authors. The words are part of the interface, so they follow the same rule as the rest of it: say what happened and what to do next.

`test/copy.test.js` checks the mechanical rules below on every page's source. The rest is for whoever writes or reviews a page.

## Voice

- **Plain words, short sentences.** Write as an experienced engineer would explain it to a colleague: "The signal has been out of its range for 57 minutes", not "Anomalous deviation persisted".
- **British English**: colour, organisation, analyse, behaviour. The code's identifiers keep their own spelling.
- **Say what is, not how sorry we are.** No "Oops", "Sorry", "Please" or "successfully": "Saved oven.temp", not "Your changes were saved successfully!".
- **No exclamation marks.** A warning is serious and a success is ordinary.
- **Address the user as "you"** when it helps ("Your staged changes no longer fit"), and the product as "Tiles" (never "we").
- **Be exact about what happened.** "Acknowledged by Ana 3 min ago", not "Updated".

## Case and punctuation

- **Sentence case everywhere**: page titles, headings, buttons, menu items, labels, column headers, tabs. Only the first word and proper nouns take a capital: "Change reviews", "Data explorer", "Correlation finder".
- Proper nouns keep theirs: Tiles, App Studio, Microsoft Teams, Entra ID, ISA-95, OPC UA, MQTT, Sparkplug B, TimescaleDB, SCIM, and product areas such as Tiles Design and Tiles Operations.
- **Abbreviations** in capitals, without points: API, CSV, JSON, PDF, PLC, MES, SOP, OEE.
- **No full stop** on buttons, labels, headings, column headers or one-line toasts. Full sentences in descriptions and help end with one.
- **Ellipsis (…)**, one character, for something under way ("Loading the signals…", "Checking…"). It doesn't mark a button that opens a dialog.
- **Curly quotes and apostrophes** in prose (“the run”, it’s). Straight ones in code and in values a user types.
- **Arrows** for flow and hierarchy: Site → Workcenter → Line, and › in breadcrumbs.

## Buttons and links

- **A button is a verb** for what it does: "Acknowledge", "Resolve", "Save run", "Test connection", "Archive". Never "OK", "Submit", "Yes" or "Click here".
- **A destructive button names the thing**: "Delete node", "Revoke", "Remove the channel". Its dialog says what will happen and what can't be undone. What can't be undone asks for the thing's name before the button works.
- **Cancel is "Cancel"**, the verb for the other choice is the action itself ("Archive" and "Cancel", not "Yes" and "No").
- **A link names where it goes**: "Open Settings", "Map tags on the Signals page". It is underlined in running text.
- **One primary button per form or card**: the thing most people came to do.

## Messages

### Errors: what happened, why, what to do

Each error says what failed, why when Tiles knows, and what the user can do about it, in that order:

> The documents could not be loaded. The Tiles API didn't answer. Try again, or check the data source in Settings.

- Name the thing: "The signals could not be loaded", not "Error loading data".
- Give the reason in the user's terms: "Your session has ended", not "401". Errors from the API keep its request ID, which the toast shows, so support can find the request.
- Offer the way out: Try again, Sign in, Open Settings, or the field to fix.
- Field errors sit under the field and say what is expected: "The sample rate is a number of readings per second, above 0."

### Form errors: under the field, saying what to do

"Enter the new agent name", "Enter 6 or less", "The sample rate is a number of readings per second, above 0." Each error is under its field and in the summary at the top of the form, which links to it. Say what to enter, not that it is invalid. A pattern's message is the field's `title` (say what it accepts: "Letters, digits, dot, dash or underscore; up to 63"). Forms sent with `onSubmit` (`js/lib/dom.ts`) are checked by `js/lib/forms.ts`; a check of your own returns `{ name, message }` and shows it with `showErrors`.

### Empty states: why it's empty, and the next step

"No warnings yet. Detectors raise them when a signal leaves its usual range." Then the action that fills it, when the user can take it: "Set up a detector".

Use `emptyState` from `js/lib/ui.ts` for every empty list, table or chart, with a `body` (or `bodyHtml`) that says why (`test/copy.test.js` checks). The title says what is missing ("No signals yet"). A search or filter that finds nothing says so ("No signals match") and offers to clear it, rather than suggesting the data doesn't exist. An action someone can't take (a viewer, or local mode) is left out, and the body says who can.

### Success and progress

- **Toasts confirm what changed**, naming it: "Archived SOP 14", "Linked 3 of 4 tags". No toast for what the page itself shows.
- **Progress names the work**: "Loading the signals…", "Checking 12 signals…", "Running the sweep (40%)…".

### Confirmations and Undo

Don't ask about what can come back: do it, and offer Undo. The toast says what happened, with the thing in it ("Archived SOP 14", "Conversation deleted"), and its button is Undo; Undo says what came back ("Restored SOP 14").

Ask only about what can't be undone (revoking a token, resetting the workspace). The title asks the question with the thing in it ("Revoke press-shop-edge?"). The body says what will happen ("It stops sending data at once."). The buttons are the verb and Cancel.

## Numbers, units and dates

- **Numbers** as the reader's language writes them, through `js/lib/format.ts` (U6.02): in English a comma for thousands and a point for decimals (12,480.5; 12.480,5 in German), and only the digits that mean something: a friction value to the newton, a share to one decimal. `fmt()` in `js/lib/dom.ts` is `number()`; `upTo()`, `significant()` and `percent()` are its others. Never `toLocaleString('en-GB')` or an `Intl` formatter with a locale written in (`scripts/check-format.js`, in lint).
- **Units** after the number, with a space, in SI symbols: 140 bar, 3,580 N, 2.5 s, 18 °C, 50 Hz. Percent as the language writes it: 24.2% in English. Use the unit the signal's catalogue entry gives.
- **Dates** as the language writes them, in English 15 Oct 2026 (`date()`), and times in 24 hours: 09:42 (`time()`). A time with its date (`dateTime()`) names its zone: 15 Oct 2026, 09:42 CEST. Times are in the site's time zone (set with the site, `setTimeZone`), so everyone reads the plant's own clock; without the API, this browser's. Recent moments are relative ("3 minutes ago", "yesterday", `relative()` and `timeAgo()`), with the exact time in a tooltip or beside it where it matters (warnings, audit).
- **Durations** in the largest unit that keeps them readable (`duration()`): "45 s", "57 min", "2 h 10 min", "3 days".
- **Sorting** as the language sorts, numbers inside text by value ("Line 2" before "Line 10"): `textOrder()`.
- **Ranges** with an en dash and no spaces for numbers (140–160 bar), and "to" in sentences ("from 140 to 160 bar").

## Words Tiles uses

Use these terms, and only these, for these things (the full glossary is [glossary.md](glossary.md), which the app shows on its Glossary page and in its term tooltips):

| Say | Not | Meaning |
| --- | --- | --- |
| signal | tag (except for the source's name of it), channel, point | A stream of readings from one source, in the catalogue |
| reading | sample, data point | One value of a signal at a time |
| warning | alert, alarm, event | What a detector raises when a signal leaves its usual range |
| event | incident | Downtime, scrap or another occurrence the MES reports, with a code |
| detector | rule, monitor | What watches a signal and raises warnings |
| ontology | model of the plant, graph | The plant's places, machines and signals and how they relate |
| change request | PR, pull request | Ontology changes waiting for another engineer |
| insight | finding, note | A saved finding with its evidence and proposed actions |
| run | job, simulation | One model version evaluated on parameters |
| site | plant, factory (in the product) | One plant in Tiles, with its own people and data |
| edge agent | gateway, collector | The program on site that sends readings to Tiles |

## Words in the catalogue

Every word a page shows comes from the message catalogue, `js/i18n/en.json` (U6.01), so Tiles can be translated without its pages changing:

- **Put words in with `t(key, params)`**, or `tHtml(key, params)` when the sentence holds markup (a term, a link, `<b>`), both from `js/lib/i18n.ts`. Keys are `<page or module>.<name>` (`warnings.bulk.failed`); shared words are `common.*`. A key that isn't in `en.json` doesn't compile.
- **Whole sentences, not pieces.** Word order differs between languages, so a message is a sentence with its values in it ("Checked {count} signals"), never words joined together in code. A choice of phrasing is a `select` (`{note, select, yes {…} other {…}}`).
- **Real plurals.** Never "signal(s)": `{count, plural, one {# signal} other {# signals}}`, chosen by the language's own rules (`=0 {No warnings}` first when nothing has its own words). `#` writes the number as the language does (1,430).
- **Never at load.** Library code keeps keys (typed `MessageKey`) or getters, and translates where the words are shown, so a change of language reaches every page.
- **What isn't words stays in code**: units, codes (`DT-SEIZURE`), tags, commands and paths. `scripts/check-i18n.js` (in `npm run lint`) finds text written straight into `js/app.ts`, `js/views` and `js/lib`; a line that holds something that only looks like words ends with `// i18n-ok`. The glossary, the demo plant's data and the style guide's code samples are content, not messages.
- **The API's errors** carry a `code` and `params` next to their English (`api/src/tiles_api/errors.py`: raise `Problem(status, "warning.not_found", "No such warning")`); the catalogue's `api.<code>` says them, with the same `{params}` (`api/tests/test_errors.py` checks both sides).

## Reviewing a page

When a page is added or changed, its PR checks:

1. Every heading, label, tab and button in sentence case, buttons as verbs, and from the catalogue.
2. Loading, empty and error states each say what to do next.
3. Errors follow what happened, why, what to do.
4. Numbers have their units; dates and times read as above.
5. The terms are the ones in the table.

`test/copy.test.js` covers what a test can: banned words, exclamation marks, button verbs and sentence case on buttons and headings.
