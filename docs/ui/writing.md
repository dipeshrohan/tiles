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

### Empty states: why it's empty, and the next step

"No warnings yet. Detectors raise them when a signal leaves its usual range." Then the action that fills it, when the user can take it: "Set up a detector".

Use `emptyState` from `js/lib/ui.ts` for every empty list, table or chart, with a `body` (or `bodyHtml`) that says why (`test/copy.test.js` checks). The title says what is missing ("No signals yet"). A search or filter that finds nothing says so ("No signals match") and offers to clear it, rather than suggesting the data doesn't exist. An action someone can't take (a viewer, or local mode) is left out, and the body says who can.

### Success and progress

- **Toasts confirm what changed**, naming it: "Archived SOP 14", "Linked 3 of 4 tags". No toast for what the page itself shows.
- **Progress names the work**: "Loading the signals…", "Checking 12 signals…", "Running the sweep (40%)…".

### Confirmations

The title asks the question with the thing in it ("Archive SOP 14?"). The body says what will happen ("It leaves the list and search, and the copilot stops citing it."). The buttons are the verb and Cancel.

## Numbers, units and dates

- **Numbers** with a comma for thousands and a point for decimals (12,480.5), as `fmt()` in `js/lib/dom.ts` writes them, and only the digits that mean something: a friction value to the newton, a share to one decimal.
- **Units** after the number, with a space, in SI symbols: 140 bar, 3,580 N, 2.5 s, 18 °C, 50 Hz. Percent with no space: 24.2%. Use the unit the signal's catalogue entry gives.
- **Dates** as 1 Oct 2026 (day, short month, year), and times in 24 hours: 09:42. Recent moments are relative ("3 min ago", "yesterday"), with the exact time in a tooltip or beside it where it matters (warnings, audit). Times are the browser's local time unless a page says otherwise.
- **Durations** in the largest unit that keeps them readable: "57 min", "2 h 10 min", "3 days".
- **Ranges** with an en dash and no spaces for numbers (140–160 bar), and "to" in sentences ("from 140 to 160 bar").

## Words Tiles uses

Use these terms, and only these, for these things (the full glossary is U4.05's `docs/ui/glossary.md`):

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

## Reviewing a page

When a page is added or changed, its PR checks:

1. Every heading, label, tab and button in sentence case, buttons as verbs.
2. Loading, empty and error states each say what to do next.
3. Errors follow what happened, why, what to do.
4. Numbers have their units; dates and times read as above.
5. The terms are the ones in the table.

`test/copy.test.js` covers what a test can: banned words, exclamation marks, button verbs and sentence case on buttons and headings.
