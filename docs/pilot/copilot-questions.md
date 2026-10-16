# Collecting the partner's copilot questions

The copilot's evaluation (T4.06) is gated on 17 questions about a known demo plant. Before the pilot relies on the copilot, it must answer the partner's own questions on the partner's own data: at least 100 of them, with the answers they expect (T4.05). This page says how to collect them, how to write each one so it can be scored, and how to run them.

## Contents

- [Who to ask](#who-to-ask)
- [What to collect](#what-to-collect)
- [Writing a case](#writing-a-case)
- [The tools](#the-tools)
- [Running the set](#running-the-set)

## Who to ask

During the assessment visit ([assessment](assessment.md), its interviews) and the first weeks of the pilot, ask each role what they would ask about the line if they could ask in words:

- **Process engineers:** trends, limits, the effect of a change, what correlates with scrap.
- **Shift leads:** what is open now, what happened on the last shift, which machine to look at first.
- **Maintenance:** a machine's history, the procedure for a part, wear.
- **Quality:** scrap by code and machine, batches that failed.

Write down the question in their words, not a tidied version: the set is only worth something if it sounds like the people who will use the copilot. Aim for at least 100, and at least 15 of each role.

## What to collect

For each question, with the person who asked it:

- the answer they expect, and where they would look for it today (a report, a system, a colleague);
- what must not be in the answer (a wrong machine, a retired code);
- whether the data to answer it is in Tiles yet. A question Tiles can't answer from its data is still useful: its right answer is to say so (a **decline** case). Keep about one in ten of those.

Then check each expected answer against the data in Tiles, with the person: an expected answer that the data contradicts is a finding about the data or about the expectation, not a case.

## Writing a case

Cases go in a spreadsheet saved as CSV, one row a case, in the columns of [the template](copilot-questions.csv):

| Column | What it holds |
| --- | --- |
| `id` | A short name, unique in the set: `dc01-last-pressure` |
| `question` | The question in the asker's words |
| `tools` | The tools a good answer needs, separated by semicolons ([the tools](#the-tools)) |
| `facts` | What the answer must state, separated by semicolons: a number (matched within 0.5%) or words (matched whatever their case). Alternatives for one fact are separated by `\|`: `152 \| 152.0` |
| `absent` | What the answer must not say, separated by semicolons |
| `decline` | `yes` when the right answer is that the data doesn't have it (then no facts) |
| `notes` | Anything else (who asked, the source of the answer): not read |

Keep each fact to what the data gives: "152 bar" is checked as the number 152; "about 150" can't be. A row with no question is skipped, so notes can sit between cases. `tiles-evaluate` refuses a set it can't score, naming the row or case and why.

## The tools

What the copilot can call; a case names the ones its answer needs:

| Tool | What it gives |
| --- | --- |
| `site_overview` | The site's counts: ontology nodes by type, signals, open warnings |
| `find_signals` | Signals by tag, description or linked node, with each one's unit and latest reading |
| `graph_query` | The ontology around a node: what contains it, controls it, it emits |
| `ontology_health` | The ontology health check: a score and its issues |
| `time_series` | A signal's readings over a range: min, max, mean, first and last |
| `wear_check` | Whether a signal's level has moved from its baseline, how fast, and when it reaches a limit |
| `virtual_sensors` | The physics models bound to signals and their outputs |
| `events` | Warnings and the MES's events (downtime, scrap) |
| `search_documents` | Passages from the site's documents (SOPs, manuals, history), with their page |
| `correlate` | The correlation finder on an uploaded batch table |
| `propose_ontology_change` | A change request to the ontology (engineers and admins), for another engineer to approve |

## Running the set

On the partner's site, as one of its engineers, against Claude (`TILES_ANTHROPIC_API_KEY`, `TILES_COPILOT_MODEL` and the site's database in `TILES_DATABASE_URL`), from `api/`:

```sh
uv run tiles-evaluate --cases partner-questions.csv --site <site slug or id> --as <engineer's email> --report report.md
```

It asks every case as that person, with their role's tools, and loads nothing; the report gives the accuracy, the unsupported claims and the tool choice against the gate (at least 85% accurate, no unsupported claims, the right tools 90% of the time), and each case that failed with why. T4.06 is done when the partner's set passes the gate. The set holds the partner's data in its facts: keep it with the pilot's documents, not in this repository, unless the partner agrees.
