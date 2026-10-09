# Tiles user guide

This guide is for engineers, shift leads and viewers who use the Tiles web app. It follows the order a new user usually takes: open the app, sign in, learn the factory map, look at signals and warnings, analyse data, design, and ask the copilot.

Other guides:

- [Admin guide](admin.md): sites, members and roles, sign-in, edge agents, notifications and budgets.
- [Model author guide](model-author.md): physics models, versions and bindings.
- [API guide](api.md): the HTTP API behind the app.
- [Data model](../data-model.md): node types and relationships, mapped to ISA-95.

## Contents

1. [Getting started](#getting-started)
2. [Home](#home)
3. [Ontology builder](#ontology-builder)
4. [Change reviews](#change-reviews)
5. [Signals and data quality](#signals-and-data-quality)
6. [Import data](#import-data)
7. [Data explorer](#data-explorer)
8. [Warnings](#warnings)
9. [Warning performance](#warning-performance)
10. [Factory physics and Process & quality (demo pages)](#factory-physics-and-process--quality-demo-pages)
11. [Correlation finder](#correlation-finder)
12. [Insights](#insights)
13. [Design studio](#design-studio)
14. [Copilot](#copilot)
15. [Settings](#settings)
16. [Glossary](#glossary)

---

## Getting started

### The two ways Tiles runs

Tiles keeps your work in one of two places. You choose which on the **Settings** page, under **Data source**.

- **This browser only** (local mode). Tiles runs on built-in demo data: a battery plant with a die-caster, a notching cutter and a tab welder. Your ontology commits, design runs and copilot chat are saved in this browser only. Nobody else sees them. This is good for learning and demos.
- **Tiles API** (API mode). Tiles connects to a Tiles server that your team shares. Everyone on a site sees the same ontology, signals, warnings, insights and design runs. Real plant data arrives through edge agents and file imports.

Some pages only work in API mode, because their data is shared: **Change reviews**, **Warnings**, **Warning performance**, **Signals**, **Data explorer**, **Correlation finder**, **Insights** and **Import data**. In local mode, these pages tell you to connect in **Settings**.

Three pages always show the built-in demo data, in both modes: **Home** (its key figures), **Factory physics** and **Process & quality**.

### Opening the app

Open the address your team gives you. Your deployment may already point at its Tiles API. If so, you start in API mode.

To switch the data source yourself:

1. Open **Settings** (bottom of the left menu).
2. Under **Data source**, choose **This browser only** or **Tiles API**.
3. For the API, type the **API address**, for example `http://localhost:8000`.
4. Click **Test connection**. You should see "Connected: Tiles API" with its version. "Not reachable" means the address is wrong or the server is down.
5. Click **Save**.

You can also add `?api=<address>` to the app's web address to use that API for the visit, for example `…/index.html?api=https://tiles.example.com`. Use `?api=local` to force local mode.

When you connect, Tiles opens your site and loads its ontology. While it loads, pages say "Loading from the Tiles API…". If it can't connect, the Ontology page shows why, with a **Sign in** button if you need one and a link to **Data source settings**.

### Signing in

In API mode, the **Settings** page has an **Account** card.

1. Click **Sign in**. Your browser goes to your company's sign-in page.
2. Sign in there. You come back to the page you left, and Tiles says "Signed in".
3. Your name and email now come from your sign-in, and Tiles records them on your work.

To sign out, click **Sign out** on the same card.

If the API has no sign-in set up (a test or development server), the card says so, and you act as a development user. Some servers let you work as the development user until you sign in; the card tells you when that is the case.

### Roles

In API mode, each person has one role on a site. An admin sets it (see the [admin guide](admin.md)). In local mode there are no roles: you can do everything.

| You can… | Viewer | Engineer | Admin |
| --- | --- | --- | --- |
| See the ontology, its history and health | Yes | Yes | Yes |
| Stage, commit and revert ontology changes, import ontology files | No | Yes | Yes |
| Comment on, approve and reject change requests (not your own) | No | Yes | Yes |
| Turn on "Require a review for every change" | No | No | Yes |
| Search signals, plot them, see quality reports | Yes | Yes | Yes |
| Edit signals, run quality checks, link tags to nodes | No | Yes | Yes |
| Import readings from files | No (sees past imports) | Yes | Yes |
| See warnings | Yes | Yes | Yes |
| Acknowledge, assign, resolve, reopen and comment on warnings | No | Yes | Yes |
| Set a detector's asset on **Warning performance** | No | Yes | Yes |
| Run the correlation finder | Yes | Yes | Yes |
| Upload and delete batch tables | No | Yes | Yes |
| Save insights, accept or reject other people's | No | Yes | Yes |
| Save design runs, create projects, start sweeps on the API | No | Yes | Yes |
| Ask the copilot | Yes | Yes | Yes |
| Let the copilot propose ontology changes | No | Yes | Yes |
| Choose your warning emails | No | Yes | Yes |
| Set the Teams channel, register and revoke edge agents | No | No | Yes |
| See copilot usage and the audit log | No | No | Yes |

The app hides controls you can't use. If you think you need more rights, ask a site admin.

### Finding your way

- The left menu groups pages: **Home** and **Copilot** at the top, then **Operations**, **Data**, **Design** and **Settings**.
- A small badge on **Ontology builder** shows your uncommitted changes, or the number of health issues. A badge on **Factory physics** shows its open warning windows.
- The button at the top switches between light and dark themes. On a phone, the menu button opens the left menu.
- Short messages ("toasts") appear at the bottom of the screen when something is saved or fails.

---

## Home

**What it's for:** a starting point with key figures and recent activity.

On this page you see:

- Four figure cards: **Friction warnings · DC-02**, **Cutter NG rate**, **Ontology health** and **Design runs logged**. The friction and cutter cards use the demo data. Click a card to open its page.
- Two product cards, **Tiles Design** and **Tiles Operations**, with links into the Design studio and Process & quality pages.
- **Recent activity**: the latest ontology commits and design runs. Click an item to open it.

Use **Ask the copilot** to open the Copilot, or **See live warnings** to open the Factory physics demo.

---

## Ontology builder

**What it's for:** a map of your factory. It links Site, Workcenter, Line, Cell and Machine to processes, materials, PLCs, signals, documents and models. Every change is staged first, then committed with a message, and you can revert it later. It works like version control for your plant model.

The page has three tabs: **Canvas**, **History** and **Health**.

### Node types and relationships

Node types: Enterprise, Site, Workcenter, Line, Cell, Machine, Process, Material, PLC, Signal, Document and Model. Some types need a property:

- Site needs `location`.
- Machine needs `vendor`.
- PLC needs `protocol`.
- Signal needs `unit`.

Relationships: `contains`, `runs`, `consumes`, `controlledBy`, `emits`, `describes`, `reads`, `monitors` and `feeds`. See the [data model](../data-model.md) for what each one means.

### Moving around the canvas

- **Zoom**: scroll the mouse wheel, or use the **+** and **−** buttons. **Fit** shows the whole map.
- **Move**: drag the canvas.
- **Select a node**: click it (or tab to it and press Enter). Its details open in the panel on the right.
- **Fold or open a node**: double-click it. A folded node shows "+N" for the nodes hidden below it.
- **Fold a whole level**: use the fold list: **Show everything**, **Fold signals into their PLC**, **Fold into machines**, **Fold into lines** or **Fold into workcenters**. Large ontologies (over 400 nodes) open with signals folded into their PLC.
- **Find a node**: type in **Find a node**. Matches light up. Press Enter or **Next** to go to each one; Tiles opens any folds above it.
- **Hide a type**: click a type chip under the canvas to hide or show that type.

Nodes with health issues and nodes touched by your staged changes are marked on the canvas.

### Adding a node

1. Make sure no node is selected (close the panel with **✕**). The **New node** form shows.
2. Choose the **Type** and type a **Label**.
3. Optionally choose **Link from** and a **Relationship** to connect it to an existing node.
4. Click **+ Stage node**.

### Editing a node

1. Click the node on the canvas.
2. In the panel:
   - To set a property, type a key and value and click **Set**. Missing required properties are listed in orange, and the first one is filled in as the key.
   - To remove a property, click **✕** next to it.
   - To add a relationship, choose a relationship and a target node and click **Link**.
   - To remove a relationship, click **✕** next to it.
   - To delete the node, first remove its relationships, then click **Delete node**.

Click a related node's name to go to it. The path above the properties shows where the node sits, for example Site → Line → Machine.

### Committing your changes

Every edit is staged, not saved. A bar at the top shows "N uncommitted" with a summary.

1. Type a message that says what you changed, for example "add alarms node to ontology".
2. Click **Commit**.

To throw away all staged changes, click **Discard**.

In API mode you can also send the changes for review instead (see [Change reviews](#change-reviews)):

1. Type the message.
2. Optionally pick a reviewer. Leave **Any engineer** to let anyone review.
3. Click **Request review**.

If your site requires a review for every change, there is no **Commit** button; **Request review** is the only way.

Tips:

- Staged changes are yours. Other people don't see them until you commit.
- If someone else commits first and your staged changes no longer fit, the bar turns red. Click **Discard** and redo what you still need.

### History

The **History** tab lists every commit, newest first: message, author, reviewer (if approved through a review), time, and what changed. Open "N operation(s)" to see each change.

To undo a commit, click **Revert**. Tiles adds a new commit that reverses it. When reviews are required, the button reads **Request revert** and sends the revert for review.

### Health

The **Health** tab gives a score out of 100 and lists issues: orphan nodes, dangling and duplicate relationships, and missing required properties. Each issue has a fix:

- **Stage delete** for an orphan node.
- **Remove duplicate** for a duplicate relationship.
- **Inspect** to open the node on the canvas.

Fixes are staged like any other change. Commit them afterwards.

### Import and export (API mode)

The bar at the top of the page (API mode only) has these buttons:

- **Export JSON** and **Export CSV** download the committed ontology.
- **Import file** reads a JSON or CSV ontology file. (Commit or discard your staged changes first.)
- **Load demo ontology** appears when the site's ontology is empty. It copies in the demo plant.
- **Change reviews** opens the reviews page. **Refresh** reloads the ontology.

To import a file:

1. Click **Import file** and choose the file.
2. Tiles checks the file against the ontology and shows a preview of every change.
3. Choose the **Mode**:
   - **Merge: add and update** adds new nodes and relationships and updates properties.
   - **Replace: the ontology becomes the file** also removes what is not in the file.
4. Read the summary, then click **Stage N change(s)**, or **Cancel**.
5. Commit the staged changes or send them for review.

If someone commits between the preview and your click, Tiles refuses and shows the new preview.

---

## Change reviews

**What it's for:** a second engineer checks ontology changes before they are committed. This page needs API mode.

The page shows the site's policy at the top: either "Engineers commit directly, or ask for a review when they want one", or "Every ontology change on this site needs another engineer's approval". Admins see a **Require a review for every change** checkbox there.

### Reviewing a change request

1. Open **Change reviews**. The **Open** tab lists requests waiting for review.
2. Click a request. You see its changes as a diff (`+` added, `−` removed, `~` changed) and its discussion.
3. Read the changes. A "doesn't apply" badge means a change no longer fits the ontology.
4. Write a comment if you like, then:
   - Click **Approve and commit** to commit the changes. You are recorded as the reviewer.
   - Click **Reject** to send them back. You must say why.
   - Click **Comment** to discuss without deciding.

Rules:

- You can't review your own change.
- If the author named a reviewer, only that person or an admin can decide.
- A request that no longer fits the ontology can't be approved; its author must rework it.

### Reworking your own request

- **Withdraw and rework** (open request) or **Rework** (rejected request) puts the changes back into your staged changes on the Ontology page. Edit them, then send them again.
- For a revert request, **Withdraw** just withdraws it.

The **Closed** tab lists approved, rejected and withdrawn requests. An approved request links to its commit in the ontology **History**.

Requests marked **Proposed by the copilot** were written by the copilot for the person who asked. That person can't approve them; another engineer must (see [Copilot](#copilot)).

---

## Signals and data quality

**What it's for:** the catalogue of every tag with readings on your site: its unit, sample rate, source, ontology link, latest reading and data quality. This page needs API mode.

Signals appear here once an edge agent or a file import sends readings for them.

### Finding signals

Use the search bar at the top:

- **Search**: part of a tag, description or node name.
- **Source**: **Edge agents**, **Imports** or **Entered by hand**.
- **Ontology link**: **Linked** or **Not linked**.
- **Quality**: **Problems**, **Warnings**, **Good**, **No data** or **Not checked**.

Click a tag to plot it in the [Data explorer](#data-explorer).

### Editing a signal (engineers and admins)

1. Click **Edit** at the end of the row.
2. Fill in what you know:
   - **Unit**, for example °C.
   - **Sample rate (Hz)**.
   - **Description**.
   - **Ontology node**: the committed Signal node this tag belongs to. Each node can have one tag.
   - **Expected min** and **Expected max**: readings outside this range count as out of range.
   - **Stuck after (min)**: how long a value may stay the same before it counts as stuck (60 if empty).
   - **Events**: mark the signal as an event stream (**downtime**, **scrap** or **other events**). Each reading is then an event, and its value is the event code. Leave **none: readings** for normal signals.
   - **Asset**: the machine as your MES names it, for example DC-01. Events are matched to detectors by asset.
3. Click **Save**, or **Cancel**.

### Checking data quality

Each signal has a quality badge: **Good**, **Warnings**, **Problems**, **No data** or **Not checked**. Click the badge to see the report: how many readings were checked, how often readings are expected, how much of the time is covered, and each problem found.

The check looks for gaps, stuck values, out-of-range values, readings the source flagged as bad, unit mismatches and edge tags that went silent.

To run it now (engineers and admins):

1. Filter the list to the signals you want.
2. Click **Check quality**. Tiles checks the signals listed and updates their badges.

Quality is also checked after you edit a signal's settings, and on a schedule if your admin set one up.

### Mapping tags to the ontology

The **Map tags to the ontology** card suggests a Signal node for each tag that has none.

1. Click **Suggest mappings**.
2. Each suggestion is either **Link to** an existing free Signal node, or **New node** under the PLC the tag comes from (or the machine the tag names). It shows how sure Tiles is and why.
3. For each one, click **Link** (or **Stage node** for a new node), or **Skip**. **Link all N** links every link suggestion at once.
4. New nodes are staged. Commit them on the Ontology page, then click **Suggest mappings** again to link them.

---

## Import data

**What it's for:** backfilling history from a CSV file or a historian export. This page needs API mode. Viewers can see past imports but can't run one.

The file is read in your browser. Readings Tiles already has (same signal and time) are skipped, so importing the same file twice is safe.

### Importing a file

1. Under **Import readings**, choose the **File** (CSV, TSV or text).
2. Tiles shows the first rows and guesses the layout. Check it:
   - **One column per signal**: a time column, then one column per signal. Tick the columns to import and check the signal name for each.
   - **One row per reading (tag, time, value)**: choose the **Tag column** and **Value column**. Tags become signal names in lower case (TT-101 becomes tt-101).
3. Choose the **Time column** and **Time format**: ISO 8601, day first, month first, seconds since 1970 or milliseconds since 1970.
4. Set the **Time zone** for times that don't include one. It starts as your browser's zone.
5. Tick **Decimal comma (21,5)** if your numbers use commas. Tick **Keep text cells as text readings** to keep non-numeric values.
6. Read the summary: how many readings, for which signals, over what time range, and any rows skipped (with example lines).
7. Click **Import**. A progress bar shows readings sent and how many were new. Click **Stop** to stop early; what was sent is kept.

**Past imports** lists each import with its file, who ran it, when, readings sent, new readings and status.

---

## Data explorer

**What it's for:** plotting any of your site's signals over a time range, and checking a signal for wear. This page needs API mode.

### Plotting signals

1. Type in **Add a signal** (tag, description or node) and click a result to add it. You can plot up to eight signals on one time axis.
2. Pick a range: **Last 1h**, **Last 24h**, **Last 7d**, **Last 30d**, or **Latest data** (the 24 hours up to the latest reading). Or set **From** and **To** and click **Show**.
3. Move through time with **←** (earlier) and **→** (later). Click **Zoom out** to double the range.
4. Drag across a chart to zoom into that stretch of time.

Long ranges show averages with their minimum and maximum, so a year plots as fast as an hour. Text signals show their latest values in a table. Remove a signal with the **×** on its chip. You can show up to five years at once.

You can also reach this page from a tag on the **Signals** page, from a saved insight, or from a copilot answer.

### Checking for wear

Each chart has a wear check. It compares the recent level of the signal (about the last day of the range) with the baseline before it.

1. Set the range you want to check (up to 120 days).
2. Under the chart, set **Wear moves it**: **either way**, **up** or **down**.
3. Optionally type a **Limit**, the value at which the part should be replaced.
4. Click **Check for wear**.

The result is **Wearing**, **Stable** or **Not enough data**, with a sentence explaining it and, if you gave a limit and the signal is moving towards it, an estimate of when it gets there. The chart shows the baseline, your limit, and the recent window shaded.

If the range is too short, Tiles asks you to zoom out; if it is longer than 120 days, to zoom in.

### Saving an insight (engineers and admins)

1. Set up the charts you want to keep.
2. Click **Save as insight**.
3. Edit the **Title**, **Summary** and **Proposed actions** (one per line).
4. Save. Tiles keeps the charts as they are now. Another engineer then reviews the insight (see [Insights](#insights)).

---

## Warnings

**What it's for:** the inbox of warnings that detectors raised on your site. You see the signal around each warning and work it through: acknowledge, assign, resolve with what it turned out to be. This page needs API mode.

Detectors watch signals and raise a warning when a reading moves too far from its normal level for long enough. Engineers and admins set detectors up through the Tiles API (`POST /sites/{site_id}/detectors`; there is no page for it yet); the [model-author guide](model-author.md) explains their settings.

### Two separate states

Each warning has:

- A **workflow status**: **New**, **Acknowledged** or **Resolved**. People change it.
- A **signal state**: **still out** or **back**. Only the detector changes it, when the signal returns to normal.

A warning can be resolved while the signal is still out, and the signal can be back while the warning is still new.

### Filtering

- Tabs: **To do** (not resolved), **New**, **Acknowledged**, **Resolved**, **All**.
- **Assigned to**: **anyone**, **me** or **nobody**.
- **Signal**: **out or back**, **still out** or **back in**.
- **Refresh** fetches the latest. **Show older warnings** loads more.

### Working a warning (engineers and admins)

1. Click a warning in the list. You see the signal chart around it, with the threshold and baseline as lines and the warning shaded, how far the signal went, and the activity so far.
2. Optionally write a note in the text box. It is saved with the step.
3. Take a step:
   - **Acknowledge**: you have seen it (only for new warnings).
   - **Assign**: choose a person under **Assign to** and click **Assign**. Choose **nobody** to unassign.
   - **Resolve**: choose an **Outcome**: **True alarm**, **False alarm** or **Unknown**, then click **Resolve**.
   - **Reopen**: for a resolved warning that needs more work.
   - **Comment**: adds your note without changing anything. A comment needs text.

Every step and comment is kept in **Activity**, with who did it and when. Open **Payload** to see what the detector saw and how it was set.

Tips:

- Resolve with an honest outcome. **Warning performance** uses these outcomes to show how good each detector is.
- Viewers can see warnings but not act on them.

### Notifications

Engineers and admins can get emails about warnings. Set them on the **Settings** page under **Notifications** (see [Settings](#notifications)). You can choose:

- **A warning someone assigns to me**.
- **Every new warning on this site**.

Admins can also post every new warning to a Microsoft Teams channel.

---

## Warning performance

**What it's for:** how well the warnings did against the downtime and scrap your MES reported. You see which events were warned of, which warnings were followed by an event, and how far ahead. This page needs API mode.

Events are readings on signals marked as event streams on the **Signals** page, with their asset. A detector's warnings are matched to events of the same asset.

### Reading the report

1. Choose **Last** (1, 7, 30 or 90 days).
2. Choose **Warned within** (1 to 24 hours): how long before an event a warning may start and still count.
3. Optionally list **Only codes**, for example `DT-SEIZURE, DT-LUBRICATION`.
4. Click **Show**.

You see:

- Four figure cards: **Events warned of**, **Warnings an event followed**, **Confirmed true by people** and **Warning time (median)**.
- **By detector**: each detector's warnings, events warned of, the share followed by an event, false warnings per day, warning time (median, 10th to 90th percentile) and how people resolved its warnings.
- **Events**: each event with its asset, kind and code, and whether it was **warned** (and how far ahead) or **missed**.

### Matching a detector to an asset (engineers and admins)

A detector with no asset can't be scored. In **By detector**, type the asset (for example DC-01) and click **Set**. If events exist for assets that no detector watches, the page lists them.

---

## Factory physics and Process & quality (demo pages)

These two pages show what Tiles does on the built-in demo data. They work in both modes and don't change your site's data.

**Factory physics** (Plunger friction · Die-caster DC-02) shows a virtual sensor. Friction can't be measured directly, so Tiles solves the plunger's equation of motion for each shot and turns pressure and velocity into a friction value.

- The **Run chart** shows friction, the threshold, warning windows and downtime events. Click the chart to inspect a shot.
- Use the slider or **‹** and **›** to step through shots and see each shot's payload.
- **Downtime events** lists each stop, whether it was warned of, and the lead time. Click a row to go to the shot where the warning started.

**Process & quality** (Why are cutter batches failing?) shows the correlation finder and a wear check on demo data.

- Switch between **Pooled** and **Split by material** to see how splitting reveals the cause.
- Choose a variable to compare failed and healthy averages per material.
- The welder card shows the cathode tip's welding power rising before a scheduled swap.

To do the same on your own data, use the [Correlation finder](#correlation-finder) and the wear check in the [Data explorer](#checking-for-wear).

---

## Correlation finder

**What it's for:** finding which settings separate failed batches from good ones. You upload a table with one row per batch. Tiles gives each variable's effect size (Cohen's d) with its 95% confidence interval, overall or split by material, line or shift. This page needs API mode.

### Uploading a batch table (engineers and admins)

1. Under **Upload a batch table**, choose a **CSV file**. It needs one row per batch: its settings and measurements, and a column that says whether it failed.
2. Give it a **Name**, for example "Cutter batches, September".
3. Click **Upload**.

### Finding effects

1. Choose a batch table from the list.
2. Choose the **Outcome** column.
3. In **Failed when it is**, type the value that means failed, for example `NG` or `scrap` (for a true/false column, `true` by default).
4. Choose **Split by** a column (material, line, shift…), or **nothing (pooled)**.
5. Tick the **Variables** to test.
6. Click **Find**.

You get:

- How many batches had an outcome, and how many failed.
- Plain sentences for each large, clear effect (|d| at least 0.8 with an interval that leaves out 0).
- A forest plot of the effects with their intervals.
- A table per segment and variable: failed mean, good mean, d, 95% interval, r and failed/good counts.

Tips:

- If nothing stands out pooled, try a split. One setting can fail two materials in opposite directions.
- Engineers can click **Save as insight** to keep a result, and **Delete** to remove a batch table.

---

## Insights

**What it's for:** findings worth keeping. Each insight has the question asked, the evidence Tiles computed for it at the time, and proposed actions. Another engineer accepts or rejects it. This page needs API mode.

You save insights from the **Correlation finder** and the **Data explorer**. Each one gets a number, and you can link to it as `#/insights/<number>`.

### Reading insights

1. Choose a tab: **To review**, **Accepted**, **Rejected** or **All**.
2. Click an insight. You see its title, summary, proposed actions and evidence.
3. The evidence is kept as it was when saved. Use the link under **Evidence** to see the same query on today's data.

### Reviewing an insight (engineers and admins)

You can't review your own insight.

1. Open an insight in **To review**.
2. Optionally write a **Review note**. A note is needed to reject.
3. Click **Accept** or **Reject**.

### Managing your own insights

- **Edit**: change the title, summary or actions while it waits for review.
- **Reopen**: send an accepted or rejected insight back for review.
- **Delete**: remove it.

Admins can do these on any insight.

---

## Design studio

**What it's for:** exploring physics models from first principles. Every run records the model version and parameters, so you can trace, compare and export any result for audit.

The models are **Cell swelling force** and **Humanoid joint actuator**. See the [model author guide](model-author.md) for how they work.

### Trying a design

1. Choose a model at the top right.
2. Choose a version. The latest is marked.
3. Move the parameter sliders. The result updates as you move.
4. **Across model versions** shows the same parameters on every version.
5. **Sensitivity** shows how much the output changes for ±10% of each parameter.
6. **Reset to defaults** puts the sliders back.

### Saving runs

In local mode, runs are saved in this browser. In API mode, runs belong to a shared **project** on your site, and the API computes and stores each result.

1. (API mode) Choose a **Project**, or type a **New project name** and click **Create project**.
2. Optionally type a **Note for this run**.
3. Click **Save run**.

**Run history** lists the runs of this model, newest first, with author, time and what changed from the run before. Click a run to restore its exact parameters and version. If you then save, the new run records its parent, so the history shows the lineage.

Runs are never changed after they are saved.

### Parameter sweeps

The **Parameter sweep** card shows a heat map of the output across two parameters, with the others held at their current values.

1. Choose the two parameters (X × Y).
2. The heat map updates in your browser.

In API mode, engineers can run a larger sweep on the server:

1. Choose **Points per axis**.
2. Click **Run on the API**. A progress bar shows the points done. Click **Cancel** to stop it.
3. When it ends, the card says how many points were computed. An identical earlier sweep is reused instead of being computed again.

### Audit export

- In local mode, **Export audit record** downloads the runs of this model as JSON.
- In API mode:
  - **Audit record (JSON)**: the latest run with its whole lineage, each model version's specification and a SHA-256 digest of the runs.
  - **Audit report (PDF)**: the same, as a report you can file.
  - **All runs (JSON)**: every run of this model in the project.

---

## Copilot

**What it's for:** asking questions about your plant in plain language. The copilot looks up the answer in your site's data and shows where each fact came from.

### Two kinds of copilot

- **With the Tiles API and its copilot turned on**, the copilot answers from your site's own data. Your conversations are saved on the server and are yours alone.
- **Otherwise** (local mode, or the server's copilot is off), built-in skills answer on the demo data. They show each step they took and link to the evidence. Questions like "Why are cutter batches failing on tab width?", "Is the welder tip wearing?" or "Where is Tab Welder W-03?" work. **Clear conversation** clears the chat.

### What it can answer (API mode)

The copilot uses read-only tools that look at your site as you are allowed to see it:

- Site overview.
- Signal search and recent readings (time series).
- The ontology: graph queries and the health check.
- Wear checks.
- Virtual sensors.
- Warnings and events.
- The correlation finder on batch tables.

For engineers and admins it can also propose ontology changes (see below).

### Asking a question

1. Open **Copilot**.
2. Click **New conversation**, or pick one from the list.
3. Type your question, or click a suggestion chip, and click **Ask**.
4. The answer streams in. Open **Used N tools** to see each tool it called, what it asked and what came back.
5. Numbers in square brackets, like [1], cite a tool result. Click one to jump to that result. Each result links to where you can see the evidence in Tiles, for example **Plot <tag>** or **Open the warnings**.

To delete a conversation, open it and click **Delete**.

### Grounding: can you trust the answer?

Tiles checks every answer before it is kept. Every number and code name in the answer must appear in a tool result it cites, or in your question.

- If the first draft fails the check, Tiles withdraws it and asks again once. You see "A first draft was withdrawn" with the reason.
- If the answer still fails, it is shown with a warning that starts "Check this answer:" and says what is unsupported. Treat those parts with care and check the evidence yourself.

### Proposals go through review

If you are an engineer or admin and ask the copilot to change the ontology (for example, to add a missing node), it doesn't change anything directly. It opens a change request in your name, marked **Proposed by the copilot**, and links to it as **Review change request #N**.

You can't approve it yourself. Another engineer must review it on [Change reviews](#change-reviews). Nothing is committed until they approve.

### Rating answers

Under each answer, click thumbs up (**Helpful**) or thumbs down (**Not helpful**). With a thumbs down you can say what was wrong and click **Send**. Rating an answer shares it, with its question, with your site's admins.

### Limits and budgets

Your organisation may limit how many questions people ask per minute and how many tokens the copilot uses per question and per day.

- If you ask too fast, Tiles tells you to wait and try again shortly.
- If a question uses up its own budget before it finds an answer, Tiles stops and asks you to ask a narrower one.
- If your organisation has used its daily budget, the copilot is unavailable until the next day (UTC).

Admins see usage on the **Settings** page.

---

## Settings

**What it's for:** your profile, the data source, sign-in and, for some roles, notifications, edge agents, copilot usage and the audit log.

### Profile

Your **Name** and **Email** are recorded as the author of ontology commits and design runs. Edit them and click **Save**. When you sign in to a Tiles API, they come from your sign-in.

### Demo data

**Reset workspace** resets this browser's ontology history, design runs and chat to the demo defaults. It doesn't touch data on a Tiles API, and it keeps your data source choice.

### Data source and Account

See [Getting started](#getting-started).

### Notifications

Shown when you are connected to a site. Emails are sent by the Tiles server.

Engineers and admins:

1. Check the email address shown ("Emails go to …").
2. Tick **A warning someone assigns to me** and/or **Every new warning on this site**.
3. Click **Save**.

Admins also see:

- **Microsoft Teams channel**: paste the channel's webhook URL, tick **Post every new warning there**, and click **Save**. The URL is never shown again; leave the box empty to keep the current one. **Remove the channel** stops posting.
- **Recent messages**: each message with its state: **Sent**, **Waiting**, **Retrying** or **Gave up** (hover for the reason).

### Edge agents

Edge agents run on the plant network and send data out to Tiles. Everyone on the site sees the list: each agent's status (online or offline), last heartbeat, host, version, connectors and buffer (readings waiting to be sent; hover for details).

Admins can register and revoke agents:

1. Type a **New agent name**, for example `press-shop-edge`.
2. Click **Register agent**.
3. Copy the token now. Tiles keeps only a fingerprint of it and won't show it again. The card also shows a starter config file.
4. Click **Done, I've saved it**.

To stop an agent, click **Revoke**. Its token stops working at once. See the [admin guide](admin.md) and `edge/README.md` for installing an agent.

### Copilot usage (admins)

Questions asked on the site over the last 30 days: answered, failed, over budget and ungrounded; tokens used and the share from cache; and how long answers took. It also shows today's organisation budget and the limits in force.

### Audit log (admins)

Every change on the site: who, what and when. For example staged and committed ontology changes, role changes, agents registered and revoked, signal edits, quality checks and imports.

---

## Glossary

- **Acknowledge**: Mark a new warning as seen. It moves from **New** to **Acknowledged**.
- **Asset**: A machine as your MES names it, for example DC-01. Event signals and detectors carry an asset so events can be matched to warnings.
- **Audit record**: A file with a design run, its whole lineage, the model specifications and a digest that shows nothing was changed.
- **Binding**: A link that feeds a model version's inputs from live signals and writes its outputs to new, derived signals. Set up by a model author (see [model-author.md](model-author.md)).
- **Change request**: Staged ontology changes sent for review, with a number. Another engineer approves (commits) or rejects it.
- **Commit**: A saved set of ontology changes with a message, author and time. Commits can be reverted.
- **Copilot**: The question-and-answer assistant. It answers from your site's data and cites its sources.
- **Detector**: A rule that watches a signal and raises a warning when readings move too far from their normal level for long enough.
- **Edge agent**: A small program on the plant network that reads machines (OPC UA, MQTT, SQL) and sends readings to Tiles.
- **Event**: A reading on a signal marked as downtime, scrap or other events. Its value is the event code.
- **Grounding**: The check that every number and name in a copilot answer comes from a cited tool result or your question.
- **Insight**: A saved finding: the question, the evidence, and proposed actions, reviewed by another engineer.
- **Node**: One thing in the ontology, such as a machine, line, PLC or signal.
- **Ontology**: The map of your factory: nodes and the relationships between them.
- **Outcome**: What a resolved warning turned out to be: true alarm, false alarm or unknown.
- **Project**: A shared folder of design runs on a site.
- **Relationship**: A link between two nodes, such as Line `contains` Machine or PLC `emits` Signal.
- **Revert**: A new commit that undoes an earlier one.
- **Run**: One evaluation of a design model at a version with a set of parameters, saved with its result, author and parent.
- **Signal**: A stream of readings with a tag, unit and sample rate. Also the ontology node type that represents it.
- **Staged change**: An ontology edit that is not yet committed. Only you see it.
- **Sweep**: A grid of runs over one or two parameters, shown as a heat map.
- **Tag**: The name of a signal as it comes from the plant, for example `tt-101`.
- **Virtual sensor**: A value computed by a physics model from other measurements, such as plunger friction from pressure and velocity.
- **Warning**: An alert a detector raised on a signal. People acknowledge, assign and resolve it.
- **Wear check**: A comparison of a signal's recent level with its baseline, saying whether it is wearing and, given a limit, when it may reach it.
