# Heuristic review, November 2026

The heuristic half of the baseline (U1.01, [#204](https://github.com/dipeshrohan/tiles/issues/204)): every page of Tiles checked against Nielsen's 10 usability heuristics and [the writing guide](writing.md), before the [moderated study](research/README.md) measures the same app with people. It lists only what was seen on the screen; each finding says how to see it again.

## Contents

- [How it was done](#how-it-was-done)
- [Summary](#summary)
- [Findings](#findings)
- [What already works](#what-already-works)
- [Not covered](#not-covered)
- [Issues to create once approved](#issues-to-create-once-approved)

## How it was done

- **Version:** `main` at `2f73809`, on 18 Nov 2026.
- **Data:** the Tiles API with the evaluation plant loaded into Plant 1, exactly as [the study's setup](research/setup.md) does it: Line 2 with DC-01 and DC-02, five signals over three days, two open warnings on `dc01.plunger_friction`, one downtime event list, SOP 14. The copilot service was not configured. Then the same pages again with no API (this browser only).
- **Browser:** Chromium through Playwright, at 1440 × 900 and at 390 × 844, light theme, the browser's language English (US). Each page opened from the menu, waited for, captured whole, and its text read; then the six key tasks walked as a participant would. The screenshots were kept outside the repository.
- **Severity:** Nielsen's scale. 0 not a problem; 1 cosmetic, fix when there is time; 2 minor, low priority; 3 major, important to fix; 4 a catastrophe, fix before release.
- **Heuristics:** H1 visibility of system status; H2 match between the system and the real world; H3 user control and freedom; H4 consistency and standards; H5 error prevention; H6 recognition rather than recall; H7 flexibility and efficiency of use; H8 aesthetic and minimalist design; H9 help users recognise, diagnose and recover from errors; H10 help and documentation. "Writing" marks a rule of [writing.md](writing.md).

**Pages walked** (25): Home, Copilot, Shopfloor, Plant, Ontology builder, Change reviews, Warnings, Warning performance, Work orders, Process & quality, Factory physics, Signals, Data explorer, Correlation finder, Insights, App Studio, Documents, Import data, Design studio, Set up a site, Settings, Your preferences, Help, Glossary, Style guide; and the welcome and the command palette. No page logged a console error or a failed script, and none scrolled sideways at either width.

## Summary

No finding is a 4. Four are 3s, and three of those bear on a key task of the study: the copilot (H-02), "what needs you now" (H-03) and triage on the Shopfloor (H-04).

| # | Page | Finding | Heuristic | Severity |
| --- | --- | --- | --- | --- |
| [H-01](#h-01-two-demo-pages-look-like-the-sites-own) | Factory physics, Process & quality | The browser's demo plant shown as if it were the site's | H2, H1 | 3 |
| [H-02](#h-02-with-the-copilot-off-the-copilot-page-answers-nothing-about-the-site) | Copilot | With the service off: settings' names, demo questions, the site's question unanswered | H9, H2 | 3 |
| [H-03](#h-03-home-for-an-engineer-leaves-out-the-open-warnings) | Home | An engineer's Home leaves out the open warnings | H1 | 3 |
| [H-04](#h-04-the-shopfloors-machine-board-says-dc-01-has-no-warnings-while-two-are-open-on-it) | Shopfloor | DC-01 "OK, no warnings" with two open on it | H1, H2 | 3 |
| [H-05](#h-05-beside-an-open-warning-the-list-shows-two-identical-rows) | Warnings | Beside a record, two identical rows | H6 | 2 |
| [H-06](#h-06-a-warnings-record-doesnt-name-its-machine) | Warnings | A warning's record doesn't name its machine | H2 | 2 |
| [H-07](#h-07-the-warning-charts-labels-are-shrunk-to-about-8-px) | Warnings | The chart's labels shrunk to about 8 px | H8 | 2 |
| [H-08](#h-08-set-up-a-site-ticks-map-the-tags-at-1-of-5) | Set up a site | "Map the tags" ticked at 1 of 5 | H1 | 2 |
| [H-09](#h-09-after-request-review-the-change-disappears-with-no-way-to-it) | Ontology builder | After Request review, the change vanishes with no way to it | H1, H3 | 2 |
| [H-10](#h-10-a-taken-name-is-reported-as-this-changed-while-you-were-working) | Correlation finder | A taken name reported as "This changed while you were working" | H9 | 2 |
| [H-11](#h-11-the-correlation-finder-hides-its-finding-behind-a-split-and-offers-id-as-a-split) | Correlation finder | The finding hides behind a split; `id` offered as a split | H6, H5 | 2 |
| [H-12](#h-12-settings-says-things-that-arent-true-with-the-api-and-talks-to-developers) | Settings | Untrue with the API, and written for developers | H2, H10 | 2 |
| [H-13](#h-13-data-freshness-calls-signals-stale-without-saying-why) | Home | "Stale" without saying why | H1 | 2 |
| [H-14](#h-14-the-ontology-canvas-cuts-node-names) | Ontology builder | Node names cut, no ellipsis | H6 | 2 |
| [H-15](#h-15-without-the-api-11-pages-in-the-menu-are-dead-ends) | Menu (no API) | 11 pages are dead ends | H1, H8 | 2 |
| [H-16](#h-16-four-pages-headings-differ-from-their-names) | Four pages | Headings differ from the menu and breadcrumb | H4 | 1 |
| [H-17](#h-17-units-durations-and-ranges-written-against-the-guide) | Data explorer, Design studio, Correlation finder | Units, durations and ranges against the guide | Writing, H4 | 1 |
| [H-18](#h-18-date-and-time-fields-dont-match-the-dates-around-them) | Data explorer, Warning performance | Date fields in another format from the page | H4 | 1 |
| [H-19](#h-19-two-primary-buttons-in-the-warnings-action-form) | Warnings | Two primary buttons in one form | Writing, H8 | 1 |
| [H-20](#h-20-ontology-builder-cut-in-the-menu-at-1440-px) | Menu | "Ontology buil…" at 1440 px | H6 | 1 |
| [H-21](#h-21-on-a-phone-the-breadcrumbs-current-page-is-cut) | Breadcrumbs (phone) | The current page cut to "Warnin…" | H1 | 1 |
| [H-22](#h-22-a-new-node-starts-as-an-enterprise) | Ontology builder | A new node starts as an Enterprise | H5 | 1 |
| [H-23](#h-23-sentences-that-are-hard-to-read) | Correlation finder, Warnings, Home | Sentences that are hard to read | Writing | 1 |

## Findings

### H-01 Two demo pages look like the site's own

- **Page:** Factory physics (`#/physics`), Process & quality (`#/quality`), with the API.
- **Heuristic:** H2, H1. **Severity:** 3.
- **Seen:** connected to Plant 1, Factory physics is headed "Plunger friction · Die-caster DC-02" with 1,600 shots, 3 warning windows and downtime DT-101 to DT-103; Process & quality is headed "Why are cutter batches failing?" about Notching Cutter C-01 and Tab Welder W-03. None of that is on Plant 1, and neither page says it is demo data (the Help page calls them "demo pages"). Plant 1 has its own "DC-02 die-casting cell", so the physics page reads as being about it. The menu shows a red **3** on Factory physics next to the real **2** on Warnings.
- **Fix:** with the API, say on both pages that they show the built-in demo plant, not the site, and drop the menu count; or leave them out of the menu until they read the site's data.

### H-02 With the copilot off, the Copilot page answers nothing about the site

- **Page:** Copilot (`#/chat`), with the API but without its copilot service.
- **Heuristic:** H9, H2. **Severity:** 3.
- **Seen:** every user reads "The copilot service is off on this Tiles API (it needs TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL): the built-in skills answer on the demo data." The suggested questions are about cutter batches, "the DC-02 plunger", the welder tip and Tab Welder W-03. Asking "Is DC-01's hydraulic pressure where its start-up procedure wants it?" (the study's copilot card) answers "I couldn't map that to a skill yet" and lists the same demo questions, although SOP 14 and the signal are on the site.
- **Fix:** for people who aren't admins, say the copilot isn't set up on this site and who can turn it on, without the settings' names (those belong in the admin guide and the admins' view). Offer the built-in skills only for what they can answer on this site's data, or say plainly that they answer on the demo plant.

### H-03 Home for an engineer leaves out the open warnings

- **Page:** Home (`#/`), an engineer, with the API.
- **Heuristic:** H1. **Severity:** 3.
- **Seen:** "What needs you now on Plant 1" shows three cards: Reviews waiting for me (none), Recent insights (none) and Data freshness. Two warnings are open and nobody has taken them; the menu shows **2** on Warnings, but Home doesn't mention them. The cards come from `ROLE_CARDS.engineer` in `js/lib/home-cards.ts` (reviews, insights, freshness); maintenance and shift leads get warnings cards.
- **Fix:** give the engineer's Home a card for open warnings nobody has taken (or the site's open warnings), so "what needs you now" includes them.

### H-04 The Shopfloor's machine board says DC-01 has no warnings while two are open on it

- **Page:** Shopfloor (`#/shopfloor`), with the API.
- **Heuristic:** H1, H2. **Severity:** 3.
- **Seen:** the headline reads "2 open warnings: 2 nobody has taken". Below, the Machines board shows "DC-01 die-casting cell · OK · No warnings". Both warnings are on `dc01.plunger_friction`, from detector `dc01-friction` whose asset is DC-01 (Warning performance shows it), but that signal isn't linked to a Signal node, so the page can't place them. Each warning card is titled `dc01.plunger_friction` and repeats `dc01.plunger_friction` underneath.
- **Fix:** place a warning by its detector's asset when its signal has no node; show warnings it still can't place as "Not on a machine" instead of leaving every machine OK; don't repeat the tag as the card's subtitle.

### H-05 Beside an open warning, the list shows two identical rows

- **Page:** Warnings (`#/warnings`), a warning open, at 1440 × 900.
- **Heuristic:** H6. **Severity:** 2.
- **Seen:** with a record open, the list keeps its seven columns in a box about 290 px wide: only Signal and Status fit, and Started is cut off at the edge. Both rows read "dc01.plunger_friction · New", so the only way to tell them apart is to open each.
- **Fix:** beside an open record, show a compact row (signal, status and started, on two lines) instead of the full table, or keep Started as the second column.

### H-06 A warning's record doesn't name its machine

- **Page:** Warnings, a warning's record.
- **Heuristic:** H2. **Severity:** 2.
- **Seen:** the record is headed `dc01.plunger_friction`, then "dc01-friction · started 3 h ago · 8 readings out · unassigned". DC-01 appears only further down, in "No batch table names DC-01 yet". The study's triage card speaks of "a die-casting cell", as people on the line do.
- **Fix:** name the machine (from the signal's node or the detector's asset) in the record's head, and in the list.

### H-07 The warning chart's labels are shrunk to about 8 px

- **Page:** Warnings, a warning's record, at 1440 × 900.
- **Heuristic:** H8. **Severity:** 2.
- **Seen:** the chart is drawn 1,116 units wide and shown 763 px wide, so its 11 px tick labels render about 9 px high (7.5 px type); the Data explorer's chart of the same kind renders its labels 14 px high. The values carry two decimals ("10.00" to "15.00" kN), where the readings need none or one.
- **Fix:** draw the chart at the width it is shown, as the Data explorer does, so text keeps its size; give the ticks only the digits that mean something.

### H-08 Set up a site ticks "Map the tags" at 1 of 5

- **Page:** Set up a site (`#/onboarding`), Plant 1.
- **Heuristic:** H1. **Severity:** 2.
- **Seen:** the steps read "✓ Map the tags · Done: 1 of 5 tags mapped" and "✓ Outline the plant · Done: 3 machines in the ontology", next to "3 · Connect an edge agent · No edge agent yet". Four of five tags have no node, and the step is ticked.
- **Fix:** tick it when every reading signal is mapped (leave event signals such as `dc01.downtime` out of the count), and show "1 of 5" as in progress until then.

### H-09 After Request review, the change disappears with no way to it

- **Page:** Ontology builder (`#/ontology`).
- **Heuristic:** H1, H3. **Severity:** 2.
- **Seen:** after staging "TP-04 trim press" under Line 2 and pressing **Request review**, the toast says only "Sent for review", the staged bar goes, and TP-04 is no longer on the canvas. Nothing says it became change request #1, or links to it; the Change reviews page lists it.
- **Fix:** "Sent change request #1 for review", with an Open action to `#/reviews/1`, and a line on the page while the request is open ("TP-04 trim press and 1 more change wait in change request #1").

### H-10 A taken name is reported as "This changed while you were working"

- **Page:** Correlation finder (`#/correlate`).
- **Heuristic:** H9. **Severity:** 2.
- **Seen:** uploading `batches.csv` a second time with the suggested name "batches" shows a toast titled "This changed while you were working": "A dataset is already called batches. Refresh to see the latest, then try again." Nothing changed meanwhile and refreshing doesn't help: the name is taken. "Dataset" isn't the page's word, which is batch table.
- **Fix:** an error under **Name**: "A batch table is already called batches. Choose another name." And suggest a free name ("batches (2)") when the file is chosen.

### H-11 The correlation finder hides its finding behind a split, and offers id as a split

- **Page:** Correlation finder, the study's `batches.csv` (720 cutter batches).
- **Heuristic:** H6, H5. **Severity:** 2.
- **Seen:** the first run, pooled, says "No large, clear effect (|d| ≥ 0.8 with an interval that leaves out 0)". The same data split by material shows front stock tension at +2.20 for anode and −1.98 for cathode (Process & quality draws exactly this). Nothing on the page suggests trying a split. **Split by** offers `id`, a column with 720 different values, beside `material`.
- **Fix:** when the pooled run finds nothing large, run the text columns with few values as splits and say which one shows effects; offer only columns with few distinct values as splits.

### H-12 Settings says things that aren't true with the API, and talks to developers

- **Page:** Settings (`#/settings`), with the API.
- **Heuristic:** H2, H10. **Severity:** 2.
- **Seen:** the Demo data card says "Your ontology commits, design runs and chat are saved in this browser", with **Reset workspace**; connected to the API they are shared through it. The Data source card says "(docker compose up starts one on port 8000)", and Edge agents says "See edge/README.md to install one".
- **Fix:** with the API, say what Reset workspace resets (this browser's own data only) or hide it; move the Docker and README pointers to the admin guide and link to its section.

### H-13 Data freshness calls signals stale without saying why

- **Page:** Home, the Data freshness card.
- **Heuristic:** H1. **Severity:** 2.
- **Seen:** "4 of 5 signals stale", each listed with "Last reading 1 h ago". The signals are read hourly (none has a sample rate set), so the card's rule isn't the reader's, and the card doesn't say what stale means here.
- **Fix:** say the rule on the card (for example "no reading for over 30 min"), or judge each signal against its own sample rate when it has one.

### H-14 The ontology canvas cuts node names

- **Page:** Ontology builder, the canvas, at 1440 × 900.
- **Heuristic:** H6. **Severity:** 2.
- **Seen:** nodes read "DC-01 die-casting c", "DC-02 die-casting c" and "DC-01 hydraulic pres": cut mid-word with no ellipsis, while most of the canvas is empty.
- **Fix:** an ellipsis and the full name on hover and focus; nodes wide enough for the longest label in their column, up to a limit.

### H-15 Without the API, 11 pages in the menu are dead ends

- **Page:** the menu, this browser only.
- **Heuristic:** H1, H8. **Severity:** 2.
- **Seen:** Change reviews, Warnings, Warning performance, Work orders, Signals, Data explorer, Correlation finder, Insights, App Studio, Documents and Import data each show only that they need the Tiles API, with a link to Settings. The menu lists them like the pages that work, so 4 of the study's 6 key tasks lead to a dead end.
- **Fix:** mark them in the menu without the API (a "needs the API" hint, or one group), and say once, on Home, what connecting adds.

### H-16 Four pages' headings differ from their names

- **Page:** Ontology builder, Copilot, Factory physics, Process & quality.
- **Heuristic:** H4. **Severity:** 1.
- **Seen:** the menu and breadcrumb say "Ontology builder", the heading "A map of the factory"; "Copilot" and "Talk to your data & docs"; "Factory physics" and "Plunger friction · Die-caster DC-02"; "Process & quality" and "Why are cutter batches failing?". The other pages' headings are their names.
- **Fix:** head each page with its name and put the rest in the lead.

### H-17 Units, durations and ranges written against the guide

- **Page:** Data explorer, Design studio, Correlation finder.
- **Heuristic:** writing, H4. **Severity:** 1.
- **Seen:** the Data explorer's range buttons read "Last 1h", "Last 24h", "Last 7d" and "Last 30d" (the guide: "1 h", "7 days"). Design studio shows "80.0 %" and "2.78 – 5.53 kN" (the guide: 80.0%, and 2.78–5.53 kN). The Correlation finder's intervals read "-0.00 to 0.34", a negative zero with a hyphen.
- **Fix:** write them through `duration()` and `percent()`, ranges with an en dash and no spaces, and zero without a sign.

### H-18 Date and time fields don't match the dates around them

- **Page:** Data explorer (From, To), Warning performance (planned stops, ROI report).
- **Heuristic:** H4. **Severity:** 1.
- **Seen:** with the browser in English (US), the fields show "11/17/2026, 12:00 PM" and "07/22/2026", while the same pages write "18 Nov 2026, 12:00 UTC" and 24-hour times. The fields follow the browser's language, not Tiles' language and number format.
- **Fix:** show the chosen date and time written out beside each field in Tiles' format (and its zone), so the two can be compared.

### H-19 Two primary buttons in the warning's action form

- **Page:** Warnings, a warning's record.
- **Heuristic:** writing ("one primary button per form or card"), H8. **Severity:** 1.
- **Seen:** **Acknowledge** and **Resolve** are both filled buttons, one above the other, in the same form; Assign, Assign to me and Comment are outlined.
- **Fix:** one primary: Acknowledge while the warning is new, Resolve once it is acknowledged.

### H-20 "Ontology builder" cut in the menu at 1440 px

- **Page:** the menu, Operations group.
- **Heuristic:** H6. **Severity:** 1.
- **Seen:** "Ontology buil…" with its count badge, at 1440 px; the same item in the Recent group, with the same badge, is shown in full.
- **Fix:** let the label take the room the Recent group gives it, or wrap it.

### H-21 On a phone, the breadcrumb's current page is cut

- **Page:** any, at 390 × 844 (seen on Warnings).
- **Heuristic:** H1. **Severity:** 1.
- **Seen:** the top bar's breadcrumbs read "H… › Warnin…", with room left in the bar.
- **Fix:** on a phone show only the current page, in full, with a back link to its parent.

### H-22 A new node starts as an Enterprise

- **Page:** Ontology builder, New node.
- **Heuristic:** H5. **Severity:** 1.
- **Seen:** **Type** starts at Enterprise, the first in the list, so adding a machine (the study's commit task) means changing it first.
- **Fix:** start at Machine, or at the type that fits under the node selected.

### H-23 Sentences that are hard to read

- **Page:** Correlation finder, Warnings, Home.
- **Heuristic:** writing. **Severity:** 1.
- **Seen:** the outcome field's hint "Failed when it is (default true)"; a warning's "The most similar warning: 0 true alarms, 0 false alarms, 1 open or unknown; no event followed any." (one warning, counted as a list); Home's lead "The cards for engineers: Customise changes them."
- **Fix:** "A batch failed when this is: (true if empty)"; "1 similar warning, still open; no event followed it."; "Cards for engineers. Customise to change them."

## What already works

Seen in the same walk, so the study doesn't spend its time on them:

- The welcome asks one plain question ("What do you mostly do?") with four roles in the users' words, says what the choice changes, and can be left ("Just look around").
- The command palette found the study's signal three ways from "hydraulic": the tag, its Signal node, and page 2 of SOP 14.
- The warning's record explains the detector in a sentence with glossary terms (baseline, threshold, persistence) and shows similar past warnings and what followed.
- Empty states say why and what next ("No review waits for you · Change requests you may approve show here").
- No console errors and no sideways scroll on any page, at 1440 and 390 px.

## Not covered

- Dark theme, the pseudo-locale and German: the visual tests already run every page in them.
- Screen readers and keyboard-only use: U6.04's flows in [accessibility.md](accessibility.md).
- The copilot's real answers, which need the copilot service; Keycloak sign-in; the edge agent and tag-mapping steps of Set up a site, which need a plant network.
- Pages reached only through a record: a machine's page under Plant, the timeline, App Studio's templates, a document's search.

## Issues to create once approved

Not created yet. Each would be labelled `ui` and `ui-month-1`, link this review's finding, and be linked from U1.01 ([#204](https://github.com/dipeshrohan/tiles/issues/204)) so the baseline's problem list can map to them.

1. **Label the demo pages as demo data when connected to the API, and drop their menu count** (H-01, severity 3).
2. **Copilot without its service: say who can turn it on, without settings' names, and no demo questions on a site** (H-02, severity 3).
3. **Add an open-warnings card to an engineer's Home** (H-03, severity 3).
4. **Shopfloor: place warnings by their detector's asset, and show the ones it can't place** (H-04, severity 3).
5. **Warnings: a compact list beside an open record, and the machine in the record's head** (H-05, H-06, severity 2).
6. **Warning chart: draw at its shown width, so labels keep their size** (H-07, severity 2).
7. **Set up a site: tick "Map the tags" only when the reading signals are mapped** (H-08, severity 2).
8. **Request review: name and link the change request it made** (H-09, severity 2).
9. **Correlation finder: a taken name as a field error, splits that make sense, and a hint when pooled finds nothing** (H-10, H-11, severity 2).
10. **Settings with the API: true words for Demo data, and developer pointers moved to the admin guide** (H-12, severity 2).
11. **Data freshness: say what stale means, or use the signal's sample rate** (H-13, severity 2).
12. **Ontology canvas: full node names on hover and focus, with an ellipsis** (H-14, severity 2).
13. **Menu without the API: mark the pages that need it** (H-15, severity 2).
14. **Copy and consistency pass: headings, units, ranges, date fields, primary buttons, menu and breadcrumb truncation, the new node's default type, three sentences** (H-16 to H-23, severity 1).
