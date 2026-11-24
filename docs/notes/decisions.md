# Decisions

Every answer the user gave the lead, dated, with the options they turned down. Only the user's
own words or chosen options go here; the lead's recommendations are marked as such. Correct a
wrong entry the same day and say so.

## 2026-11-24

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

- The rule for "three times the return" when v1.0's return is zero or negative
  ([sign-off.md](../pilot/sign-off.md)). Lead's recommendation: the ratio when v1.0 is above zero,
  else a minimum amount agreed with the partner beforehand.
- Which follow-up issues to create: the usability review's 14, the tracker drift, ROADMAP-3's 30.
- Whether UI 1 and UI 2 (fixes for review findings H-01 to H-04) go on: the lead started them on
  2026-11-24 before the lead prompt arrived, without the user choosing that work.
- The user's time zone.
- The lead's own context is past 80 %: a fresh lead from these notes, or `/compact`.
