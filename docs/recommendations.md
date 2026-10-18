# Setpoint recommendations

Month 11 of [ROADMAP-2](ROADMAP-2.md) suggests settings that avoid scrap and stops, for people to
apply. A recommendation (T11.02, [#350](https://github.com/dipeshrohan/tiles/issues/350)) is a sweep
of a process model over the line's live state, within limits engineers set per parameter (the
guard rails, T11.04, [#352](https://github.com/dipeshrohan/tiles/issues/352)). An engineer other
than its proposer approves it; the line applies it by hand. **Tiles never writes to a PLC**: a
recommendation is a record people act on, and nothing in Tiles sends a setpoint anywhere.

## Contents

- [Limits](#limits)
- [Making a recommendation](#making-a-recommendation)
- [Approving and applying](#approving-and-applying)
- [The guard rails](#the-guard-rails)
- [On the Plant page](#on-the-plant-page)
- [The API](#the-api)

## Limits

Engineers set a minimum and a maximum for each parameter a recommendation may change, per model:
the die temperature set point between 222 and 242 °C, say. A limit lies within the model's own
bounds (its spec), its minimum at most its maximum. A parameter without a limit is never
recommended. Setting and removing a limit is audited (`recommendation.limit`,
`recommendation.limit_remove`).

## Making a recommendation

An engineer names the model (a design model, such as the process model `die-porosity`,
[process-model.md](process-model.md)), the output to lower (its `scrap_chance`), the one or two
parameters to set and the machine (its asset). The line's state is each parameter's value from, in
turn:

1. the model's default;
2. the value given;
3. a signal's readings: their median over the hour before the time asked (now by default). A signal
   with no reading in that hour is refused: the state is never guessed.

The settable parameters then take 11 values each (2 to 41), evenly from their limit's minimum to
its maximum, and their current value when it is inside the limits; every point is evaluated (at
most 441). The point that lowers the output most is proposed; of points as good, the nearest to the
current setting, so nothing moves that needn't. When nothing inside the limits beats the current
setting, no recommendation is made.

A recommendation keeps, as they were: the state it was swept on, each signal's tag, latest reading
and count, the limits, the model's version and what it expected now and at the proposal. It is
numbered per site and audited (`recommendation.propose`, with the points evaluated).

## Approving and applying

Proposed → approved → applied, or proposed → rejected:

- **Approve:** an engineer other than its proposer, after checking it against the limits as they
  are then (`recommendation.approve`).
- **Reject:** any engineer, its proposer too (withdrawing it), with a note
  (`recommendation.reject`).
- **Applied:** once the line has set it by hand, an engineer says so, with the time (not before
  its approval) and a note (`recommendation.applied`). What followed against what was expected is
  T11.03.

## The guard rails

No recommendation outside a limit is ever kept or approved:

- the sweep only tries values inside the limits;
- its proposal is checked against them again before it is kept;
- approving checks it against the limits as they are at that moment (locked while it does): a limit
  tightened or removed since the sweep refuses the approval (`recommendation.outside_limit`,
  `recommendation.no_limit`), and the recommendation stays proposed for someone to reject.

`api/tests/test_recommendations.py` refuses each of these.

## On the Plant page

A machine's page has a **Setpoint recommendations** card (`js/views/recommendations.ts`, logic in
`js/lib/recommendations.ts`): the machine's recommendations, open ones first, each with what it
changes, within which limit, and what the model expected; engineers set the limits, ask for one
(the state typed or read from the machine's linked signals), approve someone else's, reject or
withdraw one and mark an approved one as applied. The [user guide](guides/user.md#setpoint-recommendations)
says how.

## The API

| Endpoint | Who | What |
| --- | --- | --- |
| `GET /sites/{id}/recommendation-limits` | any member | the limits, with each parameter's unit |
| `PUT /sites/{id}/recommendation-limits/{model}/{param}` | engineers | set a limit (`min`, `max`) |
| `DELETE /sites/{id}/recommendation-limits/{model}/{param}` | engineers | remove one |
| `POST /sites/{id}/recommendations` | engineers | sweep and propose (`model`, `objective`, `settable`, `state`, `signals`, `at`, `steps`, `asset`) |
| `GET /sites/{id}/recommendations` | any member | open ones (`show`: open, all, or a status; `asset`) |
| `GET /sites/{id}/recommendations/{n}` | any member | one |
| `POST /sites/{id}/recommendations/{n}/approve` | engineers, not its proposer | approve |
| `POST /sites/{id}/recommendations/{n}/reject` | engineers | reject |
| `POST /sites/{id}/recommendations/{n}/applied` | engineers | the line applied it |

The code is `api/src/tiles_api/api_recommendations.py` (migration 0044), with the sweep and the
guard rail in `recommend.py`; [the API reference](guides/api.md) has each endpoint.
