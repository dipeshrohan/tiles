# Glossary

The words Tiles uses, each in a sentence or two. Pages explain a term where it first appears: point at it, Tab to it or tap it. This file is the source: `scripts/glossary.js` makes the app's term tooltips and its Glossary page from it (`npm run glossary`). Each `##` is a group and each `###` a term, followed by one paragraph in plain words, without links or formatting. The words on pages follow [writing.md](writing.md).

## Factory model

### Enterprise

The top of the ISA-95 hierarchy: the company that owns the sites.

### Site

One plant, at one location. In Tiles a site also holds its own signals, warnings, people and their roles.

### Workcenter

A part of a site that makes one kind of thing, such as a die-casting hall. ISA-95 calls it an area.

### Line

A sequence of machines that a part goes through, in a workcenter.

### Cell

A group of machines that work together on a line.

### Machine

One piece of equipment, such as a die-casting machine or a press.

### PLC

The controller on a machine. It emits the machine's signals.

### Ontology

The map of your factory: nodes, such as sites, lines, machines, PLCs and signals, and the relationships between them.

### Node

One thing in the ontology, such as a machine, a line, a PLC or a signal.

### Relationship

A link between two nodes, such as Line contains Machine or PLC emits Signal.

### Staged change

An ontology edit that is not committed yet. Only you see it.

### Commit

A saved set of ontology changes, with a message, an author and a time. A commit can be reverted.

### Revert

A new commit that undoes an earlier one.

### Change request

Staged ontology changes sent for review, with a number. Another engineer approves it, which commits it, or rejects it.

## Plant data

### Signal

A stream of readings with a tag, a unit and a sample rate. Also the ontology node that stands for it.

### Tag

The name of a signal as it comes from the plant, such as tt-101.

### Reading

One value of a signal at one time.

### Sample rate

How many readings a signal sends each second, in hertz (Hz).

### Edge agent

A small program on the plant network that reads machines over OPC UA, MQTT or SQL and sends their readings to Tiles. It only reads.

### Data quality

The check of a signal's recent readings for gaps, stuck values, values out of range, readings the source flagged and a unit that doesn't match.

### Gap

A stretch with no readings, longer than the signal's sample rate allows.

### Stuck value

The same reading, unchanged, for longer than the signal's stuck limit.

### Expected range

The lowest and highest values a signal should have. Readings outside it count against its data quality.

### Bucket

A stretch of time whose readings are summed up as one point: their average, minimum and maximum, or their median. Long ranges are drawn in buckets.

## Models and virtual sensors

### Virtual sensor

A value worked out by a physics model from other measurements, such as plunger friction from pressure and velocity.

### Model

A calculation with named inputs, outputs and parameters, registered in versions that never change once published.

### Binding

A link that feeds a model version's inputs from live signals and writes its outputs to new, derived signals.

### Derived signal

A signal that a model writes, rather than the plant.

### Residual

The difference between what a model expects and what was measured.

## Warnings and detectors

### Detector

A rule that watches a signal and raises a warning when its readings move too far from their usual level, for long enough.

### Baseline

The usual level of a signal: the median of its recent readings, over a rolling window. Detectors and the wear check compare readings with it.

### Median

The middle value: half the readings are above it and half below. Unlike the average, a few odd readings barely move it.

### MAD

The median absolute deviation: the median distance of the readings from their median. A measure of spread that a few odd readings barely move.

### Robust σ

The spread of the readings worked out from the MAD (1.4826 × MAD), so a few odd readings don't widen it. For normal data it is close to the standard deviation.

### Threshold

The level a reading must pass to count as out: the baseline plus k robust σ (or minus, for a signal watched downwards).

### k

How many robust σ from the baseline a reading must be to count as out. A larger k raises fewer warnings.

### Persistence

How many readings in a row must be out before a warning is raised, so a single spike raises none.

### Cooldown

How many readings must pass after a warning ends before the detector can raise another on the same signal.

### Warning

What a detector raises when a signal is out. People acknowledge, assign and resolve it.

### Acknowledge

Mark a new warning as seen. It moves from New to Acknowledged.

### Outcome

What a resolved warning turned out to be: a true alarm, a false alarm or unknown.

### Event

A reading on a signal that stands for downtime, scrap or another event, its value the event's code.

### Asset

A machine as your MES names it, such as DC-01. Event signals and detectors carry an asset, so events can be matched to warnings.

### Warning time

How long before an event its warning started. Longer gives more time to act.

### Percentile

The value below which that share of the values fall: the 10th percentile (p10) is above the lowest tenth, the 90th (p90) below the highest tenth.

### Recall

The share of events that a warning came before: the events warned of.

### Precision

The share of warnings that an event followed. The rest were false.

### False per day

Warnings that no event followed, per day of the period.

### Backtest

Replaying a signal's history through a detector with different settings, to see which would have warned of past events with fewest false warnings.

## Analysis

### Batch table

A table with one row per batch: its settings and measurements, and whether it failed. The correlation finder reads it.

### Outcome column

The column of a batch table that says whether each batch failed.

### Segment

A part of the batches, such as one material, line or shift, looked at on its own.

### Effect

How differently a variable ran in failed batches than in good ones.

### Cohen's d

The size of an effect: the difference between the failed and the good batches' means, in standard deviations. 0.2 is small, 0.5 medium, 0.8 or more large.

### Confidence interval

The range the true value most likely lies in: with a 95% interval, 95 times in 100. An interval that includes 0 means there may be no effect at all.

### Point-biserial r

The correlation between a variable and failing, from −1 to 1: how closely the variable follows failure. 0 is none.

### Forest plot

A chart of effects, each a point with its confidence interval as a line, against a line at 0.

### Wear

A slow drift of a signal as a part wears, such as friction rising as a plunger tip wears.

### Wear check

A comparison of a signal's recent level with its baseline, saying whether it is wearing and, given a limit, when it may reach it.

### Theil–Sen slope

How fast a signal is drifting: the median of the slopes between every pair of points, so a few odd points don't tilt it.

### Time to limit

How long until a drifting signal reaches its limit, at its current slope.

### SPC

Statistical process control: a control chart's centre line and limits, from a baseline, and rules that say when a process has gone out of control.

### Control limits

The lines three standard deviations above and below a control chart's centre line. A point outside them is out of control.

### Western Electric rules

Rules that find an out-of-control process on a control chart from runs of points, not only points outside the limits, such as 8 points in a row on one side of the centre.

### App

A check set up from an App Studio template on one of your signals, such as a wear check or SPC limits.

### Insight

A saved finding: the question, the evidence and proposed actions, reviewed by another engineer.

## Copilot, documents and design

### Document

An SOP, manual or other file uploaded to a site, searched by its words, page by page.

### Copilot

The assistant that answers questions from your site's data and cites where each answer comes from.

### Grounding

The check that every number and name in a copilot answer comes from a cited source or from your question.

### Citation

A numbered mark in a copilot answer, such as [1], that links to the tool result the words come from.

### Run

One evaluation of a design model version with a set of parameters, saved with its result, author and the run before it.

### Project

A shared folder of design runs on a site.

### Sweep

A grid of runs over one or two parameters, shown as a heat map.

### Audit record

A file with a design run, its whole lineage, the model specifications and a digest that shows nothing was changed.
