# Changelog

Every release of Tiles, newest first, in the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Tiles uses [semantic versioning](https://semver.org/spec/v2.0.0.html); [releasing](docs/releasing.md) says what counts as a breaking change and how a release is made.

The top section is the next version, marked **Unreleased** until it is released. Each pull request adds its user-visible change there; the release replaces **Unreleased** with the date.

## [0.1.0] - Unreleased

The first version: everything up to the pilot. Not yet tagged.

### Added

- **Factory model:**
  - an ontology mapped to ISA-95, with Git-style staged changes, commits, history and diffs;
  - change reviews;
  - bulk import and export;
  - a canvas that scales to thousands of nodes.
- **Plant data:**
  - **edge agent:** OPC UA, MQTT with Sparkplug B, and SQL sources; a disk buffer; read-only toward the plant;
  - CSV imports;
  - a signal catalogue with data-quality checks;
  - a data explorer;
  - suggested tag mappings.
- **Models and warnings:**
  - a model registry and a model runner that writes derived signals;
  - an organisation's own models, computed by its service and registered with their spec and an https endpoint on a host the deployment allows; they are tried, bound, run and swept like the built-in ones, every call checked against the spec, the endpoint's token sealed; or from a GitHub repository at a commit, the code kept and run only in a sandbox: a new process per evaluation, the standard library only, within limits, in a pod that reaches nothing (T4.15);
  - streaming detectors, with backtests;
  - a warnings inbox with acknowledgement, assignment and outcomes;
  - a shopfloor view for tablets on the line: warnings first on their machines, large type, buttons big enough for gloves, a board of every machine, and a full view without the menu (T5.16);
  - a plant navigator from the site to its lines and machines, built from the ontology's hierarchy, with open warnings on every place and a page per machine: its signals with their latest readings, controllers, processes, models, documents and neighbours (T5.17);
  - e-mail and Teams notifications;
  - warning performance against downtime and scrap events;
  - line coverage on the Plant page: each machine's signals, detectors, models and event streams, and what is still missing;
  - the ROI report: a pilot period against its baseline, with what was avoided in stops, hours, scrap and cost, as Markdown with a digest of the events it counted.
- **Analysis:**
  - a correlation finder over batch tables;
  - saved insights with evidence and proposed actions;
  - a wear check with time to a limit;
  - **document search:** SOPs, manuals and lessons learned (PDF, text, Markdown) searched by their words in their language, each match with its page to open, and a copilot tool that cites the document and page (T4.08);
  - **App Studio:** checks set up from templates without code: a wear check, and SPC limits (a control chart with limits from a baseline and the Western Electric rules), each run on a signal's latest readings (T6.10).
- **Design studio:** physics-based design models, runs with lineage and audit export (PDF), and parameter sweeps.
- **Copilot:**
  - Claude with read-only tools over the site's data;
  - grounded answers;
  - proposals for ontology changes, which go through review;
  - cost controls per question, organisation and day;
  - **on per site:** a site's admins turn the copilot on in Settings, which says what it sends to Anthropic; off on a new site (sites that already used it stay on);
  - **an evaluation gate** (`tiles-evaluate`): questions about a known plant asked of the copilot and scored on accuracy, unsupported claims and tool choice, run in CI when the copilot's key is set (T4.06).
- **Platform:**
  - **accessibility (WCAG 2.1 AA):** every page tested with axe in light and dark; text contrast raised to 4.5:1; charts described to screen readers, with their numbers; a skip link, the current page marked in the menu, underlined links in text, and less motion when asked (T5.18);
  - single sign-on (OIDC) with site roles; requests without a token are refused wherever sign-in is configured;
  - security headers on the app (a Content-Security-Policy with scripts from its own server only, no framing, no referrer), a body-size cap in the API and a rate limit per client at the chart's ingress;
  - **an organisation's own sign-in** (Microsoft Entra ID or any OpenID Connect provider), which can be enforced, with its groups and app roles mapped to roles, and **SCIM 2.0 user provisioning** that creates, deactivates and deletes people (`docs/guides/entra-id.md`, T5.05);
  - **a command palette** (Ctrl/⌘ K or /): every page and common action, and the site's signals with the API, ranked as you type and opened with the keyboard; a search button in the top bar opens it too (U4.02);
  - **illustrated empty states:** pages that need the API, empty lists, nothing chosen yet and failures each show a drawing, say why and offer the next step; every empty list, table and chart says why it is empty and what fills it, and a search or filter that finds nothing offers to clear it (Signals, Warnings); loading shows shimmering placeholders (U2.04, U2.05);
  - **dialogs, toasts and tooltips** after shadcn/ui: confirmations are animated dialogs that say what will happen (what can't be undone asks for its name), toasts stack in the corner with icons, a close button and actions (errors from the API stay until dismissed and show their request ID, with a copy button, and are read out once as an alert, not again when the same failure repeats), and icon buttons explain themselves on hover or focus (U2.01, U2.02);
  - **a shadcn/ui-style look:** Lucide icons for every page and control, buttons in outline, primary, secondary, ghost and destructive variants and three sizes, fields with focus rings, tabs on a tinted track, cards, badges and chips that respond to the pointer, and pages that fade in when opened (U1.05);
  - **design tokens** for spacing, type, radii, shadows, layers and motion, with the light and dark palettes in one place; spacing and type moved onto the scale (U1.02);
  - **no inline styles**: pages lay out with the stylesheet's utilities (`.gap-*`, `.mt-*`, `.grow`, `.wrap`…) instead of `style` attributes; `npm run lint` refuses a new one unless its value is computed (U1.03);
  - **shared components** in `js/lib/ui.ts` (buttons, badges, cards, fields, selects, tables, tabs, page heads, empty and error states) that escape what they show; Signals, Warnings and Documents are built from them, the warning filters say which is on, and a tooltip that repeats a button's name isn't read twice (U1.04);
  - **loading in the shape of what is coming**: tables, lists, cards and charts load as grey shapes of their size, shown only after 300 ms so quick answers don't flash, marked busy for screen readers; buttons at work show a spinner and keep their width; pages that load from the API move less than 0.05 (layout shift) as they fill (U2.04);
  - **calmer motion** (`docs/ui/motion.md`): a new page comes in as one, toasts arrive and go quicker, illustrations no longer float in a loop, and everything stands still for people who ask their system for less motion (U3.01);
  - **pages that keep your place:** a page drawn again — when its data refreshes, or after an action — keeps what you typed, where the caret and focus were, how far a table or the copilot's log was scrolled, the sections you opened and the text you selected (U3.03);
  - **page transitions:** another page cross-fades in with its heading held in place, and a place or record opened from a list grows from the row you clicked; the new page's heading takes the focus and is announced. Nothing moves where the browser can't, or when less motion is asked for (U3.02);
  - **micro-interactions:** rows fade in and out of lists, numbers count to their new value, the highlight of a selected tab or row slides to the new one, sections fade open, and every control answers hover, press and focus; all still when less motion is asked for (U3.04);
  - **links that keep the view:** the Warnings filters and open warning, the Signals search and filters, and the Data explorer's signals and range are in the page's address, so a reload or a copied link shows the same; Back and Forward put each page back where it was scrolled to, and a tab keeps its pages' state across a reload (U3.05);
  - **a better menu:** groups fold away, pages can be pinned, the last five pages visited are listed, Warnings and Change reviews show how many are waiting, and wide screens can shrink the menu to a rail of icons; each person's choices are remembered. On a phone the menu opens over a dimmed page, keeps the focus, and closes with a tap beside it or a swipe (U3.06);
  - **faster:** Home is ready sooner (the demo plant's warnings are worked out after the page is drawn, and the app is sent compressed), and folding, zooming and searching a 2,000-node ontology stays quick; a performance check in CI keeps it so (U3.07);
  - **records beside their lists:** Warnings, Change reviews, Insights and Documents open a record beside its list on a wide screen, with **j** and **k** to move through it and the record in the address; on a narrow screen the record takes the list's place, with a way back. Documents gets a page per document (its details and the pages a search found in it) (U3.08);
  - **search across a site (API):** `GET /sites/{id}/search` finds signals, ontology nodes, warnings, insights, documents and apps in one query, ranked and grouped by kind, for the command palette to come (U4.01);
  - **the command palette searches the site:** Ctrl K finds the site's signals, ontology nodes, warnings, insights, documents and apps as you type, keeps the records you open among its recent picks, starts each key task (triage warnings, plot a signal, change the ontology, run a correlation, ask the copilot, set up a site), switches sites, and takes what you typed to the copilot (U4.02);
  - **German:** Tiles in German (Deutsch), chosen in Settings, with `?lang=de` or by the browser's language; and a pseudo-locale for testing layouts with longer words (U6.03);
  - **your preferences:** a page for how Tiles looks and works for you (theme, table rows, motion, language, how numbers and dates are written, the site's clock or this device's, single-key shortcuts and the page Tiles opens at), each applied at once and, with the Tiles API, kept with you on every site and browser, back after signing out and in (U6.06);
  - **printing:** a warning (with its chart and activity), an insight (with its evidence), a change review, the Design Studio's run history and a machine's page print on A4 and Letter without the menu or controls, each link's address after it, and charts in black and white with dashed lines and hatching (U6.05);
  - **numbers, dates and times by language and site:** numbers, percentages, durations (2 h 10 min, 3 days), dates and the order of lists follow the language Tiles is shown in; times are the site's own clock with its zone named, and recent moments say how long ago (U6.02);
  - **ready for other languages:** every word on the pages comes from a message catalogue (`js/i18n/en.json`) with real plurals ("1 signal", "5 signals" where pages said "signal(s)"), and every error the API answers carries a code and its values, so a translation can say it in its own words (U6.01);
  - **accessibility, round 2:** every page reflows at 320 px and at 200% zoom, shows the focus on every control also in Windows High Contrast (where what is chosen is now outlined), and has controls of 24 px or more; the report and the screen-reader flows still to walk are in `docs/ui/accessibility.md` (U6.04);
  - **warning triage by keyboard:** s assigns the warning open to you, r goes to its outcome, n opens the next warning after a step (Next warning), and the list's selected warnings can be assigned to you at once (U5.04);
  - **the ontology builder:** drag from a selected node onto another to relate them (the relationship their types suggest), select several with Shift-click or a Shift-dragged box and set a property on or delete them all at once, undo and redo staged changes (Ctrl Z, Ctrl Shift Z), the arrow keys between nodes, a minimap, Fit to screen and Focus selection (U5.05);
  - **filters and saved views:** Warnings, Signals and Documents show their filters as chips with Add filter, Clear all and how many match; their filters, sort and columns are saved as views, kept for yourself or shared with the site, and listed in the menu (U5.06);
  - **notifications:** a bell in the top bar counts what waits for you (warnings assigned to you, change requests and insights to review, imports that didn't finish), checked every minute and announced politely; each links to its page and can be marked read (U5.07);
  - **the Shopfloor on the line:** a High contrast option for direct light, the last list kept "as of" its time when the network goes and refreshed as it returns, the screen kept on while the page is open, and every control checked at 64 px for gloves (U5.08);
  - **compare mode:** in the Data explorer, one signal against a range a day or a week earlier (or just before, or from a chosen start), lined up from their starts, or two signals over one range, with the difference and which is higher on average (U5.09);
  - **charts you can read point by point:** a crosshair with the exact time and value under the pointer or a tap, the arrow keys stepping through readings (read out by screen readers), a legend that shows and hides each part, PNG and CSV export of every chart, and Reset zoom in the Data explorer (U5.03);
  - **tables:** the signal catalogue (every matching signal, up to 10,000), warnings, change reviews, insights, documents, edge agents and the audit log sort by any column, choose their columns and widths, show compact rows, select rows for a bulk action (plot or check signals, acknowledge warnings), export the view as CSV, and draw only the rows in view past 200, so 5,000 scroll at 60 fps; preferences are remembered per table (U5.02);
  - **home by role:** with the Tiles API, Home shows cards that answer "what needs me now?" for your role (your open warnings and machines out of range; reviews waiting for you, recent insights and stale signals; this shift's warnings; agent health and data quality), which you can add, remove and order, kept for you per site (U5.01);
  - **the site wizard on the demo plant:** without the Tiles API, Set up a site runs to its end in the browser: a line outlined into its ontology, how to install an edge agent with a demo agent standing in, and the demo's tags mapped to Signal nodes as suggested (U4.10);
  - **send feedback:** from the help panel, the Help page or the command palette, with a mood, your words, and if you choose your name and a screenshot of the page (shown before it is sent); anonymous otherwise; site admins read it in Settings and can delete it (U4.09);
  - **what's new:** after an update, a dot on the help button; what the version brings, each entry linked to its page, from the help, the Help page or the command palette (U4.08);
  - **guided tours:** triage a warning, find and plot a signal, change the plant model and ask the copilot, step by step on the pages themselves, from Help, the command palette or the welcome (U4.07);
  - **a welcome on the first visit:** it asks what you mostly do (engineer, maintenance, shift lead or admin), opens Tiles at that role's page with its pages pinned in the menu, offers the next step (the site wizard for an admin of a new site, the page or its help), says when the plant is a demo, and can be shown again from Help (U4.06);
  - **a glossary, explained in place:** 74 terms (ISA-95 levels, signals and tags, baselines, MAD, persistence, cooldown, Cohen's d, confidence intervals, point-biserial r, recall and precision, Theil–Sen…) on a Glossary page and in the command palette; on the analytics pages each statistical term is dotted and shows its definition on hover, focus or a tap (U4.05);
  - **help on every page:** a help button in the top bar shows the page's part of the user guide in a side sheet, the whole guide is on a Help page with its contents, and the command palette finds its headings; it is built into the app, so it works offline (U4.04);
  - **keyboard shortcuts:** g then a letter goes to a page, ? lists every shortcut, a acknowledges the warning open, e edits the insight or app open, / goes to the page's search; each key shows in its button's tooltip, nothing happens while typing, and single-key shortcuts can be turned off (U4.03);
  - **UX analytics, privacy first**: an organisation can turn on a record of how Tiles is used (pages viewed, tasks done, the command palette, errors shown), kept 90 days in its own deployment, with no names, records or typed text; site admins see the counts in Settings (U1.09);
  - **undo instead of confirm**: archiving a document or an app, and deleting a conversation or a batch table, happen at once with an Undo toast for 8 seconds instead of a question first (a deletion still waiting when the page is closed is made when Tiles is next opened); the API can restore an archived document or app (U2.03);
  - **nothing sent twice**: a button shows a spinner while its request runs and can't be pressed again meanwhile; acknowledging a warning and rating an answer change at once, and go back if the API refuses (U2.08);
  - **form errors on their fields**: a form says what to correct under each field, with a summary at the top that links to them, when it is sent and as each field is left after that (never while it is first typed); the API's refusals of a field appear on that field, also on forms drawn again while saving (U2.07);
  - **one way of writing** (`docs/ui/writing.md`): sentence case, buttons that are verbs, errors that say what happened, why and what to do, units and dates written one way, and the words Tiles uses; every page's copy was reviewed against it, and a page that can't reach the Tiles API now says what to check and tries again (U2.09);
  - **errors that say what to do** (U2.06): a request the API refuses says what happened, why and the way out (no access names who gives it; a conflict offers Refresh; not found offers Go back; a signed-out session offers Sign in), error states copy their details for support (request ID, page, time, version), and offline a banner says what is shown is as of when, while changes aren't sent and say why; Shopfloor keeps its last warnings when a refresh fails and says so;
  - **breadcrumbs** in the top bar say where you are, from the link: Home › Plant › Casting › DC line 1, Insights › #12, App Studio › #3 › Change; each place above is a link, and every page starts with the same page head (U1.06);
  - **a style guide** (`#/styleguide`, from Settings → About): every token, component, state, icon and illustration in the light and the dark theme side by side, with the code for each (U1.07);
  - row security per site in the database; the API and the scheduled jobs work as a role that can't skip it or change the schema;
  - credentials sealed with rotatable data keys;
  - an audit log;
  - dependency and image scanning with SBOMs;
  - a threat model, and a SOC 2 and ISO 27001 readiness plan: controls mapped to both, with owners, status, evidence and a timeline (T6.08);
  - a Helm chart;
  - **hybrid mode** (`docs/hybrid.md`): firewall rules for plant IT and the cloud (outbound only), a sandboxed systemd service for the edge agent, and an egress allowlist by host name for the API and jobs (Cilium; on by default in the managed Azure environment). The agent exits with code 5, which its service retries, when its buffer can't open (T5.11);
  - **customer-hosted install guide** (`docs/install.md`): prerequisites, sign-in, mirrored images, settings, install, checks, backups, upgrades and troubleshooting, followed on a new cluster by CI's install dry run (T5.12);
  - **Terraform modules:** Tiles on any cluster, and the managed cloud on Azure (AKS with Entra ID sign-in, enforced network policies, backup storage), with a customer-hosted reference install; tested with mock providers and `trivy config` in CI (T5.10);
  - backups with a point-in-time restore drill;
  - a load test (10,000 readings a second, 50 users);
  - **monitoring:** OpenTelemetry traces and metrics (ingest lag from the agents' buffers, job runs, notifications, requests), alert rules tested with promtool, a Grafana dashboard and a collector configuration (T5.13);
  - **guides:** a user guide, an administrator guide, a model-author guide and an API reference generated from the code, with a test that keeps it current (T6.05);
  - **pilot kit:** the partner assessment's checklist, interview guide, problem scoring and report outline (T2.15);
  - **a security review pack** for a partner's IT and OT teams: what connects where, the data end to end, a questionnaire quick reference, the open items and the review meeting's agenda (T3.15);
  - **setting up a site:** organisation admins create sites (`POST /sites`), and a wizard takes each from new to its first dashboard (outline the plant, connect an edge agent, map tags), with its progress worked out from the site's data (`GET /sites/{id}/onboarding`) (T6.06);
  - **release process:** one version across the browser app, the API, the edge agent and the Helm chart; this changelog; release notes and assets made from a version tag; an upgrade test that migrates the previous version's database, with its data, to the new one and back (T6.04).

[0.1.0]: https://github.com/dipeshrohan/tiles/releases/tag/v0.1.0
