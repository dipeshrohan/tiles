# Decisions

Every answer the user gave the lead, dated, with the options they turned down. Only the user's
own words or chosen options go here; the lead's recommendations are marked as such. Correct a
wrong entry the same day and say so.

## 2026-11-25

- **"Make sure the child sessions follow rules, I do not want work stopped because ci doesn't
  work."** (the user's words). The lead's reading, sent to UI 5 and UI 6: a red CI job is the
  child's to root-cause and fix at once, never to wait on; an infrastructure failure gets one
  re-run, then a fix in the PR or an immediate report; the bundle budget is not raised without the
  user (make room: catalogue, reuse, lazy-loaded files).

- **What next, after H-05 to H-15 merged.** Chosen: _polish H-16 to H-23_ (#413 to #420) and
  #425's follow-ups. Turned down: planning ROADMAP-3; branch protection (#421) steps; pause.

- **Time zone for times given to the user.** Chosen (typed): _"Cet"_, read by the lead as
  Central European Time, UTC+1 now; whether summer times follow CEST wasn't asked. Turned down: India (IST), UK (London), US Eastern, keep
  UTC.
- **The lead's context past 80 %.** Chosen: _/compact here_ (the user runs it). Turned down: a
  fresh lead session from the notes (the lead's recommendation); keep going as is.
- **What next, after H-01 to H-04** ("Continue tasks", then the question). Chosen: _the usability
  review's H-05 to H-15_ (the severity-2 findings). Turned down: all of H-05 to H-23; the
  Dependabot PRs #399 to #406; planning ROADMAP-3.
- **The "three times the return" rule when v1.0's return is zero or below** (sign-off pack).
  Asked twice; the user's words: _"I do not understand the question at all"_, then _"Again no
  context I do not understand the question"_. Not answered. Parked until a partner exists; the
  pack already leaves it to the sign-off meeting. Don't ask again before then.
- **Dependabot PRs #399 to #406.** Chosen: _review and merge_ (each checked for the two-week age
  rule, green CI and breaking changes; held ones reported). Turned down: only the minor updates;
  leave them.
- **Which follow-up issues to create.** Chosen: _usability polish H-16 to H-23_ (one issue each,
  label `ui`) and _tracker drift_ (#15 and #51 closed or unticked as the code shows; an issue for
  the branch-protection mismatch). Turned down: ROADMAP-3's 30 tasks (held until the user approves
  the roadmap). Recording them starts no work.

## 2026-11-24

- **UI 1 and UI 2's draft PRs** (#408: engineers' Home warnings and Shopfloor placement; #409:
  demo pages labelled and the copilot-off wording; review H-01 to H-04). Chosen: _review and
  merge both_. Turned down: only #408; close both.
- **Lead prompt adopted.** The user pasted the lead (product manager) prompt; its rules are in
  [lead.md](lead.md#how-the-lead-works). Among them: creating issues never starts work, the lead
  asks which to start; one question at a time, with a recommendation; times in the user's time
  zone.
- **Child sessions.** The user pasted how to run child sessions (create, message, watch, stop,
  one check-in). No task was named with it.

## 2026-11-18

- **Paperwork to draft** (question: which should I do, several allowed). Chosen: all four:
  sign-off pack (T12.02/T6.02), retrospective and next roadmap (T6.11), risk review and metrics
  (T0.02/T0.01), usability study kit (U1.01/U6.07). Merged as #398, #394, #395, #396.
- **"Continue tasks"** (the user's message) after every code task was merged.

## 2026-11-17

- **picomatch advisory GHSA-fc5q-39xc-vjpf** (no fixed release; build and test tools only).
  Chosen: _dated exception_ (an allowlist entry with a reason and a review date, 2026-12-15).
  Turned down: merge with the check red; wait for a picomatch fix. Done in #392.
- **German names of Home's Customise buttons.** Chosen: _verb form_, "Nach oben verschieben:
  {card}" and "Nach unten verschieben: {card}". Turned down: "Nach oben: {card}". Done in #392.
- **"Do you know how to ask questions?"** The user's reminder to ask through the question tool
  (not prose), as asked before.

## 2026-10-18

- **First release.** Chosen: _tag v1.0.0 now_. Turned down: tag v1.0.0 and v1.1.0; prepare
  only. Released as v1.0.0 through the Release workflow run by hand (#381, #383).
- **"Please do not delegate tasks to me which can be done by agents."** (the user's words)
- **"Continue with the issue list."** (the user's words)

## Before 2026-10-18

Recorded from the conversation's summary, not from the user's words verbatim:

- Short, direct answers. Questions through the question tool, with previews and a recommended
  option.
- "Do not stop. When 1 issue is done move to next." (Since 2026-11-24 the lead prompt says the
  lead asks which work to start; see above.)
- Merge the lead's own PRs when CI is green and review findings are addressed; self-review each
  PR.
- `index.html` must work from `file://`; no empty space on ultrawide screens.
- Never commit proxy or sandbox certificates or credentials; example.com emails only; the edge
  agent is read-only toward the plant and Tiles never writes to a PLC; no model IDs in commits,
  PRs or code; new dependencies at least two weeks old.
- Sample plants: die casting first, then battery cells, graphene film and biologics ("Biologics
  (Recommended)" chosen for the fourth).

## Waiting for the user

