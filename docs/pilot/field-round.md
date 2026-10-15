# Shopfloor field round

A day on the pilot line with the technicians who use the Shopfloor page (U5.08,
[#247](https://github.com/dipeshrohan/tiles/issues/247)). The forward-deployed engineer runs it with
the plant's shift lead. The goal is to check that technicians on the line can triage warnings
wearing gloves, in direct light, with the network as it really is. This page lists what to bring,
what to try and what to write down.

## Before the day

- [ ] The pilot site runs a Tiles version with the field-round changes. Look for **High contrast** on
  the Shopfloor page.
- [ ] A tablet of the kind the line will use, mounted where it will hang, signed in as an engineer of
  the site. It opens on the Shopfloor page in **Full view**.
- [ ] At least one detector raising warnings on a signal from the line. If nothing is out on the
  day, use a backtest's replay or an import of yesterday's data, so that there is something to act on.
- [ ] The gloves the line wears: cut-resistant, and the thick ones used at the casting cell.
- [ ] A way to measure light at the tablet (a phone's lux meter is enough), and the time of day
  the sun reaches the line.

## What to try

Each row is done by a technician, not by us. Note who, the gloves and the light.

| # | Try | Pass when |
| --- | --- | --- |
| 1 | With gloves, press **I'm on it**, **Take it**, **Resolve**, an outcome, **Back** and **Details** on a warning card | Every press hits the button meant, first time; none needs a second try |
| 2 | With gloves, scroll the warnings and the machine board | The page scrolls; no button is pressed by the scroll |
| 3 | Read the headline and a card from where the technician stands, in the brightest light of the day | The headline, the machine name and the state are read aloud correctly |
| 4 | Turn on **High contrast** in the same light | Everything on the card is readable, the grey text too; the choice stays after a reload |
| 5 | Take the tablet out of Wi-Fi range (or switch Wi-Fi off) | The page says **Offline: as of** the time of its last list, keeps that list, and its buttons wait |
| 6 | Bring it back | The list refreshes by itself within seconds; **Updated** shows the new time |
| 7 | Leave the tablet untouched for longer than its screen timeout | The screen stays on while the Shopfloor page is open |
| 8 | Lock and unlock the tablet, or switch to another app and back | The screen still stays on afterwards; the list is current |
| 9 | Triage a real warning from start to finish: take it, check the machine, resolve it with what it was | Done without help and without taking the gloves off |

## What to write down

For each finding: what happened, who it happened to (their role, not their name), the gloves, the
light (lux), the network, and a photo of the screen if useful. Then decide on the day:

- **Fix now** if it stops triage or makes a technician press the wrong thing. Fix it in the same task.
- **File it** if not: a GitHub issue labelled `ui` and `shopfloor`, linked from #247.

Write the round up in `docs/ui/research/` (date, site, participants by role, the table above with
results, the findings and what happened to each). Then close #247.

## What Tiles already does

The software side of the round is built and tested (`e2e/smoke.test.js`, "the shopfloor field
round…"):

- **Controls:** every control on the page is at least 64 px each way, with room between controls.
- **High contrast:** a button on the page (kept for this browser). It also follows the system's
  "increase contrast" setting.
- **Offline:** the last list stays, "as of" its time; taking and resolving wait for the network,
  and the list refreshes as soon as the network is back.
- **Wake lock:** the screen stays on while the page is open and shown. The lock is asked for again
  when the tab comes back, and let go when the page is left.
