# API reference

The Tiles API serves the browser app, edge agents and your own integrations. This reference is
generated from the code (`tiles-apidoc`, T6.05); the machine-readable description is
[openapi.json](openapi.json), and a running API shows it interactively at `/docs`.

## Conventions

- **Addresses.** Every path below is relative to the API's address (for example
  `https://api.tiles.example.com`). Most live under a site: `/sites/{site_id}/…`; `GET /sites`
  lists the sites you can see.
- **Signing in.** Send the access token from your OpenID Connect provider as
  `Authorization: Bearer <token>`. Outside production, a request without a token acts as a
  development user (`X-Tiles-User: someone@example.com` picks which).
- **Who may call.** Each endpoint says who may call it:
  - *anyone*: no sign-in;
  - *signed in*: any user;
  - *site member*: any role on the site, viewer and up;
  - *engineer* or *admin*: that role on the site or above. Organisation admins are admins of
    every site.
  - *edge agent*: an agent's own token, `Authorization: Bearer tla_…`.

  Some endpoints narrow this further (only an insight's author, a review's named reviewer); their
  description says so, and anyone else gets a `403`.
- **Bodies** are JSON, with times in ISO 8601 with a time zone. Unknown fields are refused.
- **Errors** answer with a status and `{"detail": "…"}`, in words meant for people:
  - `401`: sign in;
  - `403`: your role isn't enough;
  - `404`: no such thing on this site;
  - `409`: a conflict, for example a newer commit;
  - `422`: an invalid request, with each problem listed;
  - `503`: busy or unreachable. `Retry-After` says when to try again.
- **Lists** take `limit` and `offset` where they can be long.
- **Request ids.** Every answer carries `X-Request-ID`; quote it when you report a problem.
  You may send your own.
- **Changes** follow [semantic versioning](../releasing.md): within a major version, endpoints
  and fields are only added.

## Endpoints by area

[apps](#apps) · [auth](#auth) · [copilot](#copilot) · [datasets](#datasets) · [detection](#detection) · [documents](#documents) · [edge agents](#edge-agents) · [imports](#imports) · [insights](#insights) · [members](#members) · [meta](#meta) · [models](#models) · [notifications](#notifications) · [ontology](#ontology) · [organisation sign-in](#organisation-sign-in) · [provisioning](#provisioning) · [reviews](#reviews) · [runs](#runs) · [signals](#signals) · [sites](#sites) · [sweeps](#sweeps) · [warnings](#warnings)

## apps

### `GET /app-templates`

**Who:** signed in. **Answers:** 200.

The templates an app can be made from, with their settings (what the form asks).

### `GET /sites/{site_id}/apps`

**Who:** site member. **Answers:** 200, 422.

The site's apps, by number.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/apps`

**Who:** engineer. **Answers:** 201, 422.

Makes an app from a template's current version: 422 with what to fix if the settings don't fit it.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** AppIn (see [openapi.json](openapi.json)).

### `PUT /sites/{site_id}/apps/{number}`

**Who:** engineer. **Answers:** 200, 422.

Renames an app or changes its settings, for the template version it was made with.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** AppUpdate (see [openapi.json](openapi.json)).

### `DELETE /sites/{site_id}/apps/{number}`

**Who:** engineer. **Answers:** 204, 422.

Archives an app: it leaves the list, and its number isn't reused.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/apps/{number}/result`

**Who:** site member. **Answers:** 200, 422.

Runs the app on its signal's readings now: its status, in words, and the chart.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

## auth

### `GET /auth/config`

**Who:** anyone. **Answers:** 200, 422.

How the browser signs in here: the OpenID Connect issuer and client, and whether requests without a token act as the development user (anywhere but production). With `?org=<slug>`, that organisation's own identity provider (T5.05): 404 if it has none.

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

### `GET /me`

**Who:** signed in. **Answers:** 200.

Who the request is from: email, name, organisation, and whether it signed in through the identity provider (`oidc`) or is the development user (`dev`).

## copilot

### `GET /sites/{site_id}/copilot`

**Who:** site member. **Answers:** 200, 422.

Whether the copilot is set up on this API (an Anthropic API key and a model are configured), and whether this site's admins have turned it on.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/copilot/conversations`

**Who:** site member. **Answers:** 200, 422.

Your conversations on this site, the latest first.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/copilot/conversations`

**Who:** site member. **Answers:** 201, 422.

Start a conversation with the copilot on this site; it is yours alone.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** ConversationIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/copilot/conversations/{conversation_id}`

**Who:** site member. **Answers:** 200, 422.

One of your conversations, with its messages and the tools the copilot used.

| Parameter | In | Type | Required |
|---|---|---|---|
| `conversation_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `DELETE /sites/{site_id}/copilot/conversations/{conversation_id}`

**Who:** site member. **Answers:** 204, 422.

Delete one of your conversations, unless the copilot is still answering in it (409).

| Parameter | In | Type | Required |
|---|---|---|---|
| `conversation_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/copilot/conversations/{conversation_id}/messages`

**Who:** site member. **Answers:** 200, 422.

Ask a question in the conversation; the answer streams back as server-sent events.

| Parameter | In | Type | Required |
|---|---|---|---|
| `conversation_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** AskIn (see [openapi.json](openapi.json)).

### `PUT /sites/{site_id}/copilot/conversations/{conversation_id}/messages/{seq}/feedback`

**Who:** site member. **Answers:** 200, 422.

Rate one of your answers up or down, with a comment; your site's admins read it, with the question and the answer, to improve the copilot.

| Parameter | In | Type | Required |
|---|---|---|---|
| `conversation_id` | path | uuid | yes |
| `seq` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** Feedback (see [openapi.json](openapi.json)).

### `DELETE /sites/{site_id}/copilot/conversations/{conversation_id}/messages/{seq}/feedback`

**Who:** site member. **Answers:** 204, 422.

Withdraw your rating of an answer.

| Parameter | In | Type | Required |
|---|---|---|---|
| `conversation_id` | path | uuid | yes |
| `seq` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/copilot/feedback`

**Who:** admin. **Answers:** 200, 422.

The site's rated answers, newest first, with their question (admins).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `rating` | query | `up` \| `down` | no |
| `limit` | query | integer | no |

### `PUT /sites/{site_id}/copilot/policy`

**Who:** admin. **Answers:** 200, 422.

Turn the copilot on or off for this site (admins). On, each question and the tool results the copilot reads to answer it (the site's data, as the user who asked may see it) go to the AI provider.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_copilot__PolicyIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/copilot/usage`

**Who:** admin. **Answers:** 200, 422.

The site's copilot usage by UTC day and by user, with the limits and today's budget (admins).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `days` | query | integer | no |

## datasets

### `GET /sites/{site_id}/datasets`

**Who:** site member. **Answers:** 200, 422.

The site's datasets (batch tables), by name, with their columns and row counts.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/datasets`

**Who:** engineer. **Answers:** 201, 422.

Start a dataset with its columns; send its rows next.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** DatasetIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/datasets/{dataset_id}`

**Who:** site member. **Answers:** 200, 422.

A dataset with its columns and its first 20 rows.

| Parameter | In | Type | Required |
|---|---|---|---|
| `dataset_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `DELETE /sites/{site_id}/datasets/{dataset_id}`

**Who:** engineer. **Answers:** 204, 422.

Delete a dataset and its rows (engineers and admins).

| Parameter | In | Type | Required |
|---|---|---|---|
| `dataset_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/datasets/{dataset_id}/correlate`

**Who:** site member. **Answers:** 200, 422.

Which variables separate the failed batches from the good ones: Cohen's d with its 95% confidence interval and r, per segment of `split` if given, largest effect first.

| Parameter | In | Type | Required |
|---|---|---|---|
| `dataset_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |
| `min_effect` | query | number | no |

**Body:** CorrelateIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/datasets/{dataset_id}/rows`

**Who:** engineer. **Answers:** 200, 422.

Append a batch of rows (at most 5,000), in order.

| Parameter | In | Type | Required |
|---|---|---|---|
| `dataset_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** RowsIn (see [openapi.json](openapi.json)).

## detection

### `POST /sites/{site_id}/backtest`

**Who:** engineer. **Answers:** 200, 422.

Replay a signal's history with each combination of detection settings and score the warnings against the events given: recall, precision, false warnings per day and warning time, best first.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** BacktestIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/detectors`

**Who:** site member. **Answers:** 200, 422.

The site's detectors, by name, with their settings and state.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/detectors`

**Who:** engineer. **Answers:** 201, 422.

Watch a signal: warn when it leaves its rolling baseline by `k` robust spreads for `persist` readings in a row. It starts with the signal's stored history.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** DetectorIn (see [openapi.json](openapi.json)).

### `PATCH /sites/{site_id}/detectors/{detector_id}`

**Who:** engineer. **Answers:** 200, 422.

Set (or clear, with null) the asset the detector watches, to match its warnings to that asset's events (T3.10).

| Parameter | In | Type | Required |
|---|---|---|---|
| `detector_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** DetectorPatch (see [openapi.json](openapi.json)).

### `DELETE /sites/{site_id}/detectors/{detector_id}`

**Who:** engineer. **Answers:** 204, 422.

Stop the detector. Its warnings stay; one still open ends now, since nothing will update it.

| Parameter | In | Type | Required |
|---|---|---|---|
| `detector_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/detectors/{detector_id}/run`

**Who:** engineer. **Answers:** 200, 422.

Run the detector on one batch of its new readings now (`caught_up`: nothing more waiting).

| Parameter | In | Type | Required |
|---|---|---|---|
| `detector_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

## documents

### `GET /sites/{site_id}/documents`

**Who:** site member. **Answers:** 200, 422.

The site's documents, newest first.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/documents`

**Who:** engineer. **Answers:** 201, 422.

Uploads a document: the body is the file (Content-Type `application/pdf`, `text/plain` or `text/markdown`, up to 20 MB). Its text is read page by page and indexed for search; 422 says why a file can't be read (encrypted, a scan without text, not UTF-8…).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `title` | query | string | yes |
| `filename` | query | string | no |
| `language` | query | string | no |

### `GET /sites/{site_id}/documents/search`

**Who:** site member. **Answers:** 200, 422.

The passages that match best, each with its document and page to cite. The query is read as a web search: words (stemmed: "valves" finds "valve"), "quoted phrases", OR, and -words to leave out.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `q` | query | string | yes |
| `limit` | query | integer | no |

### `DELETE /sites/{site_id}/documents/{number}`

**Who:** engineer. **Answers:** 204, 422.

Archives a document: it leaves the list and search; its number isn't reused.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/documents/{number}/file`

**Who:** site member. **Answers:** 200, 422.

The file as it was uploaded (a PDF opens at a page with `#page=N`).

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

## edge agents

### `POST /agent/heartbeat`

**Who:** edge agent. **Answers:** 200, 422.

Called by an edge agent every `heartbeat_seconds`, with its own token.

**Body:** HeartbeatIn (see [openapi.json](openapi.json)).

### `POST /agent/samples`

**Who:** edge agent. **Answers:** 200, 422.

Stores a batch of readings from an edge agent (at most 10,000), skipping ones already stored.

**Body:** SamplesIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/agents`

**Who:** site member. **Answers:** 200, 422.

The site's edge agents (not revoked ones) and whether each is online.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/agents`

**Who:** admin. **Answers:** 201, 422.

Register an agent (admins only). The answer holds its token, which is never shown again.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** AgentIn (see [openapi.json](openapi.json)).

### `DELETE /sites/{site_id}/agents/{agent_id}`

**Who:** admin. **Answers:** 204, 422.

Revoke an agent (admins only): its token stops working at once.

| Parameter | In | Type | Required |
|---|---|---|---|
| `agent_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

## imports

### `GET /sites/{site_id}/imports`

**Who:** site member. **Answers:** 200, 422.

The site's imports, newest first (the last 100).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/imports`

**Who:** engineer. **Answers:** 201, 422.

Starts an import (engineers and admins). Its readings follow in batches.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_imports__ImportIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/imports/{import_id}/finish`

**Who:** engineer. **Answers:** 200, 422.

Marks the import done; its counts are final.

| Parameter | In | Type | Required |
|---|---|---|---|
| `import_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/imports/{import_id}/samples`

**Who:** engineer. **Answers:** 200, 422.

One batch of an import's readings (at most 10,000). All or nothing: one invalid reading and the batch is refused (422), naming it.

| Parameter | In | Type | Required |
|---|---|---|---|
| `import_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** SamplesIn (see [openapi.json](openapi.json)).

## insights

### `GET /sites/{site_id}/insights`

**Who:** site member. **Answers:** 200, 422.

The site's insights, newest first; only those in one status if given.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `status` | query | `proposed` \| `accepted` \| `rejected` | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

### `POST /sites/{site_id}/insights`

**Who:** engineer. **Answers:** 201, 422.

Save a finding: its evidence is computed from `source` now and kept as it is. It waits for another engineer to accept or reject it.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** InsightIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/insights/{number}`

**Who:** site member. **Answers:** 200, 422.

A saved insight by its number: the finding, its query, the evidence kept with it, the proposed actions and its review.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `PATCH /sites/{site_id}/insights/{number}`

**Who:** engineer. **Answers:** 200, 422.

Change the title, summary or actions while it waits for review (its author, or an admin). The query and evidence stay: a different finding is a new insight.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** InsightEdit (see [openapi.json](openapi.json)).

### `DELETE /sites/{site_id}/insights/{number}`

**Who:** engineer. **Answers:** 204, 422.

Delete an insight (its author, or an admin).

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/insights/{number}/reopen`

**Who:** engineer. **Answers:** 200, 422.

Back to waiting for review (its author, or an admin), e.g. to revise a rejected one.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/insights/{number}/review`

**Who:** engineer. **Answers:** 200, 422.

Accept or reject it: another engineer than its author; rejecting says why.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_insights__ReviewIn (see [openapi.json](openapi.json)).

## members

### `GET /sites/{site_id}/audit`

**Who:** admin. **Answers:** 200, 422.

Every change on this site, newest first (admins only).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

### `GET /sites/{site_id}/me`

**Who:** site member. **Answers:** 200, 422.

Your membership of this site (joining it on first visit), including your role.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/members`

**Who:** site member. **Answers:** 200, 422.

The site's members (everyone who has signed in to it) and their roles. Organisation admins are admins of every site, listed here or not.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `PUT /sites/{site_id}/members/{user_id}`

**Who:** admin. **Answers:** 200, 422.

Change a member's role on this site (admins only; not your own).

| Parameter | In | Type | Required |
|---|---|---|---|
| `user_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** RoleIn (see [openapi.json](openapi.json)).

## meta

### `GET /health`

**Who:** anyone. **Answers:** 200.

Liveness: the process is up. Does not touch dependencies.

### `GET /ready`

**Who:** anyone. **Answers:** 200, 503.

Readiness: the database and Redis are reachable. 503 if either is not.

## models

### `GET /org/models`

**Who:** organisation admin. **Answers:** 200, 422.

Your organisation's own models, over HTTP and from GitHub, archived ones too, by key then version (never their tokens or code).

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

### `POST /org/models`

**Who:** organisation admin. **Answers:** 201, 422.

Register a model version computed by your endpoint: its spec (inputs, outputs, bounded parameters) and the https address Tiles posts each evaluation to. The host must be one the deployment allows (`TILES_MODEL_HOSTS`). A design model takes no inputs; a virtual sensor at least one. 409 if the version exists already: a version never changes, so give a new one.

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

**Body:** HttpModelIn (see [openapi.json](openapi.json)).

### `POST /org/models/github`

**Who:** organisation admin. **Answers:** 201, 422.

Register a model version from a GitHub repository at a full commit SHA: the directory (`path`) holds `tiles-model.json` (the spec, and the `entry` file, `model.py` unless named) and the Python files, whose `run(inputs, params)` the sandbox calls (the standard library only). The code is fetched once and kept, with its SHA-256; a private repository's token is used for that and not kept. Needs the deployment's sandbox (`TILES_SANDBOX_URL`).

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

**Body:** GithubModelIn (see [openapi.json](openapi.json)).

### `PATCH /org/models/{key}/{version}`

**Who:** organisation admin. **Answers:** 200, 422.

Archive a model version (or bring it back); for one over HTTP, also move its endpoint or set or clear its token. Its spec, and a GitHub model's code, never change.

| Parameter | In | Type | Required |
|---|---|---|---|
| `key` | path | string | yes |
| `version` | path | string | yes |
| `org` | query | string | no |

**Body:** ModelChange (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/model-bindings`

**Who:** site member. **Answers:** 200, 422.

The site's model bindings, with how their last run went.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/model-bindings`

**Who:** engineer. **Answers:** 201, 422.

Bind a model version to the site's signals. Its outputs become new signals, <name>.<output>, from source model:<key>@<version>; the runner fills them from then on, starting with the history already stored.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** BindingIn (see [openapi.json](openapi.json)).

### `DELETE /sites/{site_id}/model-bindings/{binding_id}`

**Who:** engineer. **Answers:** 204, 422.

Stop running the binding. What it computed stays; its derived signals keep their readings.

| Parameter | In | Type | Required |
|---|---|---|---|
| `binding_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/model-bindings/{binding_id}/run`

**Who:** engineer. **Answers:** 200, 422.

Run the binding on its new data now (one batch of readings: `caught_up` says whether more is left, for the next call or the scheduled runs).

| Parameter | In | Type | Required |
|---|---|---|---|
| `binding_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/models`

**Who:** site member. **Answers:** 200, 422.

Every model version the site can use, by key then version: the built-in ones, then its organisation's own served over HTTP.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/models/{key}`

**Who:** site member. **Answers:** 200, 422.

A model's versions, newest first.

| Parameter | In | Type | Required |
|---|---|---|---|
| `key` | path | string | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/models/{key}/evaluate`

**Who:** site member. **Answers:** 200, 422.

Run a model on the input series given (all one length) and its parameters (defaults if left out). Nothing is stored: this is for trying a model; the runner (T3.03) writes derived signals. A model served over HTTP whose endpoint fails gives 502.

| Parameter | In | Type | Required |
|---|---|---|---|
| `key` | path | string | yes |
| `site_id` | path | uuid | yes |

**Body:** EvaluateIn (see [openapi.json](openapi.json)).

## notifications

### `GET /sites/{site_id}/notifications`

**Who:** admin. **Answers:** 200, 422.

What was sent, what waits (to be retried, with why, if it failed), and what was given up, newest first (admins).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `state` | query | `all` \| `pending` \| `sent` \| `failed` | no |
| `limit` | query | integer | no |

### `GET /sites/{site_id}/notifications/preferences`

**Who:** site member. **Answers:** 200, 422.

Which warnings reach you by email. Until you choose: those assigned to you, not every new one. Like any change to a site, choosing needs engineer or above, and so does receiving them.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `PUT /sites/{site_id}/notifications/preferences`

**Who:** engineer. **Answers:** 200, 422.

Choose which warnings you are told about on this site: those raised, those assigned to you, or both.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** PreferencesIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/notifications/teams`

**Who:** admin. **Answers:** 200, 422.

The site's Teams channel, which hears of every new warning (admins).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `PUT /sites/{site_id}/notifications/teams`

**Who:** admin. **Answers:** 200, 422.

Point the site at a Teams channel's webhook (Workflows, or an incoming webhook), or remove it. The URL is a credential: it is stored sealed (T5.06) and never shown again.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** TeamsIn (see [openapi.json](openapi.json)).

## ontology

### `GET /sites/{site_id}/ontology/commits`

**Who:** site member. **Answers:** 200, 422.

Commit history, newest first.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

### `POST /sites/{site_id}/ontology/commits`

**Who:** engineer. **Answers:** 201, 422.

Commit your staged changes.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** CommitIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/ontology/commits/{commit_id}/revert`

**Who:** engineer. **Answers:** 201, 422.

Undo a commit by committing its inverse operations.

| Parameter | In | Type | Required |
|---|---|---|---|
| `commit_id` | path | string | yes |
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/ontology/export`

**Who:** site member. **Answers:** 200, 422.

The committed ontology as a file: JSON (nodes, edges and where it came from) or CSV (one table).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `format` | query | `json` \| `csv` | no |

### `GET /sites/{site_id}/ontology/graph`

**Who:** site member. **Answers:** 200, 422.

The committed graph (`head`), or head plus your staged changes (`working`).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `view` | query | `head` \| `working` | no |

### `GET /sites/{site_id}/ontology/health`

**Who:** site member. **Answers:** 200, 422.

Health check: dangling or duplicate relationships, orphans and missing required properties. Scores the committed graph by default; `view=working` includes your staged changes.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `view` | query | `head` \| `working` | no |

### `POST /sites/{site_id}/ontology/import`

**Who:** engineer. **Answers:** 200, 422.

Plan the changes that bring the committed ontology to the file's, and stage them (unless `dry_run`). `merge` adds and sets; `replace` also removes what the file doesn't have. You then commit them, or send them for review, like any staged change. Needs no staged changes of your own. Pass the preview's `commit` as `expect_commit` to stage only what the preview showed.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_ontology_io__ImportIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/ontology/staged`

**Who:** site member. **Answers:** 200, 422.

Your staged changes to the ontology, not yet committed (each person stages their own).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/ontology/staged`

**Who:** engineer. **Answers:** 201, 422.

Stage one change. It is checked against your working graph; returns all your staged ops.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** any (see [openapi.json](openapi.json)).

### `DELETE /sites/{site_id}/ontology/staged`

**Who:** site member. **Answers:** 204, 422.

Throw away your staged changes. Open to every member, so a user demoted to viewer can drop old work.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/ontology/staged/batch`

**Who:** engineer. **Answers:** 201, 422.

Stage several changes, all or none (e.g. a node and its relationship). Returns all your staged ops.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** list of any (see [openapi.json](openapi.json)).

## organisation sign-in

### `GET /org`

**Who:** signed in. **Answers:** 200, 422.

Your organisation, and whether you are its admin (an organisation admin, or someone whose sign-in grants admin). The development identity names one with `?org=`, or gets the only one.

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

### `GET /org/identity-provider`

**Who:** organisation admin. **Answers:** 200, 422.

Your organisation's identity provider, or null when it signs in through this deployment's.

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

### `PUT /org/identity-provider`

**Who:** organisation admin. **Answers:** 200, 422.

Sets your organisation's identity provider. A new issuer is pending until you sign in through it as yourself (the same email): that shows your organisation controls it, so no organisation can take another's. Then its tokens sign in to your organisation only. Turning `enforced` on needs it confirmed and you signed in through it (409 otherwise), so a provider that doesn't work can't lock everyone out; then no other sign-in reaches your organisation.

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

**Body:** ProviderIn (see [openapi.json](openapi.json)).

### `DELETE /org/identity-provider`

**Who:** organisation admin. **Answers:** 204, 422.

Removes your organisation's identity provider: its tokens stop working at once (each request checks), and people sign in through this deployment's issuer again.

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

### `GET /org/scim-tokens`

**Who:** organisation admin. **Answers:** 200, 422.

Your organisation's SCIM tokens, newest first (never the tokens themselves).

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

### `POST /org/scim-tokens`

**Who:** organisation admin. **Answers:** 201, 422.

A token for your identity provider's SCIM client (`/scim/v2`), which then creates, updates and deactivates your organisation's users. It is shown once; only its hash is kept.

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

**Body:** ScimTokenIn (see [openapi.json](openapi.json)).

### `DELETE /org/scim-tokens/{token_id}`

**Who:** organisation admin. **Answers:** 204, 422.

Revokes a SCIM token: it stops working at once.

| Parameter | In | Type | Required |
|---|---|---|---|
| `token_id` | path | uuid | yes |
| `org` | query | string | no |

## provisioning

### `GET /scim/v2/ResourceTypes`

**Who:** anyone. **Answers:** 200.

The resources: users only.

### `GET /scim/v2/ServiceProviderConfig`

**Who:** anyone. **Answers:** 200.

What this SCIM service supports (public, as RFC 7644 allows).

### `GET /scim/v2/Users`

**Who:** SCIM token. **Answers:** 200, 422.

The organisation's users, with `filter=userName eq "…"` (or `externalId`, `emails.value`), `startIndex` (from 1) and `count` (up to 200).

| Parameter | In | Type | Required |
|---|---|---|---|
| `filter` | query | string | no |
| `startIndex` | query | integer | no |
| `count` | query | integer | no |

### `POST /scim/v2/Users`

**Who:** SCIM token. **Answers:** 201, 422.

Creates a user (they sign in later, and are linked by email). A user deleted before comes back with their history; 409 if the email or externalId is an existing user's.

### `GET /scim/v2/Users/{user_id}`

**Who:** SCIM token. **Answers:** 200, 422.

One user.

| Parameter | In | Type | Required |
|---|---|---|---|
| `user_id` | path | string | yes |

### `PUT /scim/v2/Users/{user_id}`

**Who:** SCIM token. **Answers:** 200, 422.

Replaces a user's attributes (those Tiles keeps).

| Parameter | In | Type | Required |
|---|---|---|---|
| `user_id` | path | string | yes |

### `PATCH /scim/v2/Users/{user_id}`

**Who:** SCIM token. **Answers:** 200, 422.

Changes a user with `Operations` (`add`, `replace`; `remove` of `externalId`), by path or by a value object without one, as Entra ID sends them.

| Parameter | In | Type | Required |
|---|---|---|---|
| `user_id` | path | string | yes |

### `DELETE /scim/v2/Users/{user_id}`

**Who:** SCIM token. **Answers:** 204, 422.

Deletes a user: they can't sign in, their site memberships end, and SCIM no longer finds them. What they did stays in the history, under their name.

| Parameter | In | Type | Required |
|---|---|---|---|
| `user_id` | path | string | yes |

## reviews

### `GET /sites/{site_id}/ontology/review-policy`

**Who:** site member. **Answers:** 200, 422.

Whether every ontology change on this site needs a review.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `PUT /sites/{site_id}/ontology/review-policy`

**Who:** admin. **Answers:** 200, 422.

Require (or stop requiring) a review for every ontology change on this site (admins).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_reviews__PolicyIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/ontology/reviews`

**Who:** site member. **Answers:** 200, 422.

Change requests, newest first: open ones (default), closed ones (approved, rejected, withdrawn) or all.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `state` | query | `open` \| `closed` \| `all` | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

### `POST /sites/{site_id}/ontology/reviews`

**Who:** engineer. **Answers:** 201, 422.

Send your staged changes (or the revert of a commit) for review. Your staged changes move into the request.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_reviews__ReviewIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/ontology/reviews/{number}`

**Who:** site member. **Answers:** 200, 422.

A change request with its ops, its comments and, while open, whether it still applies.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/ontology/reviews/{number}/approve`

**Who:** engineer. **Answers:** 200, 422.

Approve a change request: its ops are committed, with its author as author and you as reviewer. Not its author; its named reviewer if it has one, any engineer otherwise, or an admin.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** DecisionIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/ontology/reviews/{number}/comments`

**Who:** engineer. **Answers:** 200, 422.

Comment on a change request.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_reviews__CommentIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/ontology/reviews/{number}/reject`

**Who:** engineer. **Answers:** 200, 422.

Reject a change request, saying why. Nothing is committed; its author can rework it. Not its author; its named reviewer if it has one, any engineer otherwise, or an admin.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** DecisionIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/ontology/reviews/{number}/rework`

**Who:** engineer. **Answers:** 200, 422.

Take your change request back into your staged changes, to change and send again. An open request is withdrawn; a rejected or withdrawn one stays as it is. A revert is not staged (sent again it would no longer be a revert): an open one is only withdrawn, and a closed one is requested again from the history.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

## runs

### `GET /sites/{site_id}/design-projects`

**Who:** site member. **Answers:** 200, 422.

The site's design projects, the one with the latest run first (T4.14).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/design-projects`

**Who:** engineer. **Answers:** 201, 422.

Start a design project on this site; its name must be new on the site.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** ProjectIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/runs`

**Who:** site member. **Answers:** 200, 422.

The site's runs, the latest first; of one model (a registry key or the browser's id) and one project if named.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `model` | query | string | no |
| `project` | query | uuid | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

### `POST /sites/{site_id}/runs`

**Who:** engineer. **Answers:** 201, 422.

Run a registered design model with these parameters and keep the result, computed here, as the site's next numbered run, in a project and after a parent run if given.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** RunIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/runs/compare`

**Who:** site member. **Answers:** 200, 422.

What changed from run `a` to run `b` (of one model, in any versions).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `a` | query | integer | yes |
| `b` | query | integer | yes |

### `GET /sites/{site_id}/runs/{number}`

**Who:** site member. **Answers:** 200, 422.

A run by its number, with its inputs, results and lineage (the runs it was changed from).

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/runs/{number}/audit`

**Who:** site member. **Answers:** 200, 422.

Run `number`'s audit record, as JSON to keep (T4.13).

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `GET /sites/{site_id}/runs/{number}/audit.pdf`

**Who:** site member. **Answers:** 200, 422.

Run `number`'s audit record as a PDF report (T4.13).

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/runs/{number}/restore`

**Who:** engineer. **Answers:** 201, 422.

Run `number`'s version and parameters again, as a new run after its model's latest run in its project.

| Parameter | In | Type | Required |
|---|---|---|---|
| `number` | path | integer | yes |
| `site_id` | path | uuid | yes |

**Body:** RestoreIn (see [openapi.json](openapi.json)).

## signals

### `GET /sites/{site_id}/signals`

**Who:** site member. **Answers:** 200, 422.

The site's signals in tag order. `q` searches tags, descriptions and linked node labels; `source` keeps those from edge agents, imports or entered by hand; `linked` those (not) mapped to an ontology node; `quality` those whose latest check gave that badge (or that are unchecked).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `q` | query | string | no |
| `source` | query | `` \| `edge` \| `import` \| `manual` | no |
| `linked` | query | `` \| `yes` \| `no` | no |
| `quality` | query | `` \| `good` \| `warn` \| `bad` \| `unknown` \| `unchecked` | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

### `POST /sites/{site_id}/signals/quality`

**Who:** engineer. **Answers:** 200, 422.

Checks the quality of the site's signals (all, or those listed) over the `hours` up to each one's latest reading, and stores each report as the signal's latest (engineers and admins). Audited. A site of more than MAX_CHECK signals is checked whole with `tiles-check-quality`, not in a request.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** QualityCheckIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/signals/suggestions`

**Who:** site member. **Answers:** 200, 422.

For each tag no ontology node is linked to: the node to link, or the Signal node to create (with the ops to stage), with a score and the reasons.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `limit` | query | integer | no |

### `GET /sites/{site_id}/signals/{signal_id}`

**Who:** site member. **Answers:** 200, 422.

One of the site's signals, with its settings, latest reading and data quality.

| Parameter | In | Type | Required |
|---|---|---|---|
| `signal_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `PATCH /sites/{site_id}/signals/{signal_id}`

**Who:** engineer. **Answers:** 200, 422.

Sets a signal's unit, sample rate, description or ontology link (engineers and admins). A link must name a Signal node of the committed ontology that no other tag is linked to.

| Parameter | In | Type | Required |
|---|---|---|---|
| `signal_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** SignalPatch (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/signals/{signal_id}/series`

**Who:** site member. **Answers:** 200, 422.

A signal's readings from `from` (included) to `to` (excluded): as they are when there are at most `points`, otherwise in at most `points` buckets with their average, minimum and maximum.

| Parameter | In | Type | Required |
|---|---|---|---|
| `signal_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |
| `from` | query | date-time | yes |
| `to` | query | date-time | yes |
| `points` | query | integer | no |

### `POST /sites/{site_id}/signals/{signal_id}/wear-check`

**Who:** site member. **Answers:** 200, 422.

Has the signal's level moved from its baseline (a wearing tool's), how fast, and when does it reach `limit`? The baseline is `baseline_hours` before the last `recent_hours` up to `end`.

| Parameter | In | Type | Required |
|---|---|---|---|
| `signal_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** WearIn (see [openapi.json](openapi.json)).

## sites

### `GET /sites`

**Who:** signed in. **Answers:** 200.

Sites in your organisation (every site for the dev identity).

### `POST /sites`

**Who:** organisation admin. **Answers:** 201, 422.

Creates a site in your organisation, with you as its admin. Its slug must be new in the organisation (409 otherwise).

| Parameter | In | Type | Required |
|---|---|---|---|
| `org` | query | string | no |

**Body:** NewSite (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/onboarding`

**Who:** site member. **Answers:** 200, 422.

How far the site is set up, step by step: created, its plant outlined in the ontology, an edge agent that has called in, tags mapped to Signal nodes, and a machine with mapped signals (the first dashboard to open).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

## sweeps

### `GET /sites/{site_id}/sweeps`

**Who:** site member. **Answers:** 200, 422.

The site's latest sweeps, without their results.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `limit` | query | integer | no |

### `POST /sites/{site_id}/sweeps`

**Who:** engineer. **Answers:** 202, 422.

Start a sweep (202: it runs in the background), or answer from an identical one's result (200).

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |

**Body:** SweepIn (see [openapi.json](openapi.json)).

### `GET /sites/{site_id}/sweeps/{sweep_id}`

**Who:** site member. **Answers:** 200, 422.

A sweep's progress (`done` of `total` points), and its result once done.

| Parameter | In | Type | Required |
|---|---|---|---|
| `sweep_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/sweeps/{sweep_id}/cancel`

**Who:** engineer. **Answers:** 200, 422.

Stop a sweep: one still queued at once, a running one after the chunk it is on.

| Parameter | In | Type | Required |
|---|---|---|---|
| `sweep_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

## warnings

### `GET /sites/{site_id}/performance`

**Who:** site member. **Answers:** 200, 422.

The last `days`: each detector's warnings scored against its asset's events (an event caught when a warning started within `horizon_hours` before it), with what people resolved them as. `codes` (repeatable) counts only those events, e.g. the downtime codes the detectors target.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `days` | query | number | no |
| `horizon_hours` | query | number | no |
| `codes` | query | list of string | no |

### `GET /sites/{site_id}/warnings`

**Who:** site member. **Answers:** 200, 422.

The site's warnings, newest first. `state`: the signal still out (open) or back (ended). `status`: raised (nobody has looked yet), acknowledged, resolved, or unresolved (either of the first two). `assignee`: me, none (unassigned), or a user's id.

| Parameter | In | Type | Required |
|---|---|---|---|
| `site_id` | path | uuid | yes |
| `state` | query | `open` \| `ended` \| `all` | no |
| `status` | query | `raised` \| `acknowledged` \| `resolved` \| `unresolved` \| `all` | no |
| `assignee` | query | string | no |
| `outcome` | query | `true_alarm` \| `false_alarm` \| `unknown` | no |
| `signal_id` | query | uuid | no |
| `limit` | query | integer | no |
| `offset` | query | integer | no |

### `GET /sites/{site_id}/warnings/{warning_id}`

**Who:** site member. **Answers:** 200, 422.

One warning, with its detector's settings and its activity.

| Parameter | In | Type | Required |
|---|---|---|---|
| `warning_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

### `POST /sites/{site_id}/warnings/{warning_id}/acknowledge`

**Who:** engineer. **Answers:** 200, 422.

Say someone is looking at it.

| Parameter | In | Type | Required |
|---|---|---|---|
| `warning_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** NoteIn (see [openapi.json](openapi.json)).

### `PUT /sites/{site_id}/warnings/{warning_id}/assignee`

**Who:** engineer. **Answers:** 200, 422.

Assign it to an engineer or admin of the site (acknowledging it, if nobody had), or unassign it (`user_id` null). Assigning it to whom it is already assigned only keeps the note, as a comment.

| Parameter | In | Type | Required |
|---|---|---|---|
| `warning_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** AssignIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/warnings/{warning_id}/comments`

**Who:** engineer. **Answers:** 201, 422.

Add a note to its activity, whatever its status (without waiting on its other steps).

| Parameter | In | Type | Required |
|---|---|---|---|
| `warning_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** tiles_api__api_warnings__CommentIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/warnings/{warning_id}/reopen`

**Who:** engineer. **Answers:** 200, 422.

Undo a resolution (it stays acknowledged, and assigned).

| Parameter | In | Type | Required |
|---|---|---|---|
| `warning_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** NoteIn (see [openapi.json](openapi.json)).

### `POST /sites/{site_id}/warnings/{warning_id}/resolve`

**Who:** engineer. **Answers:** 200, 422.

Close it with its outcome: a true alarm, a false alarm, or unknown (acknowledging it, if nobody had). Its signal may still be out.

| Parameter | In | Type | Required |
|---|---|---|---|
| `warning_id` | path | uuid | yes |
| `site_id` | path | uuid | yes |

**Body:** ResolveIn (see [openapi.json](openapi.json)).
