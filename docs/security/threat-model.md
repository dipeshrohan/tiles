# Threat model and IEC 62443 gap list (T5.07)

This covers Tiles as built in October 2026: the edge agent on a plant's network, the Tiles API and its database, the browser app, and the services they call. It is a STRIDE analysis of each part and data flow, then a gap list against IEC 62443 for the edge agent (a component, 62443-4-2) and the whole system (62443-3-3). It is written to share with a partner's IT/OT security team (T3.15), with the [security review pack](partner-review.md) as its cover, and to be reviewed whenever an ADR changes a trust boundary.

Status keys: **Done** (in place, with where), **Partial** and **Gap** (an action, with its task where there is one).

## The system and its trust boundaries

```
 Plant OT network                 │ DMZ / site IT            │ Tiles cloud (or customer-hosted)                │ Third parties
                                  │                          │                                                 │
 PLC / OPC UA server ─┐           │                          │  ┌─────────────┐   ┌──────────────────────┐     │
 MQTT broker ─────────┼─ reads ──▶│ Edge agent ── HTTPS out ─┼─▶│  Tiles API  │──▶│ Postgres + Timescale │     │
 Historian / SQL DB ──┘ (no write)│ (buffer on disk)         │  │  (FastAPI)  │   │ (row security, T5.04)│     │
                                  │                          │  └─────┬───────┘   └──────────────────────┘     │
                                  │                          │        │  ▲                                     │
 Engineers' browsers ─────────────┼──── HTTPS ───────────────┼────────┘  │ tokens (OIDC, PKCE)   ──────────────┼─▶ Identity provider
                                  │                          │  jobs (cron): detect, run models, notify ───────┼─▶ SMTP, Teams webhooks
                                  │                          │  copilot ───────────────────────────────────────┼─▶ Anthropic API
```

The trust boundaries, from the inside out:
- **B1** between the plant's machines and the edge agent;
- **B2** the agent's outbound HTTPS to the API, the only connection crossing the plant's perimeter, opened from inside;
- **B3** browsers to the API;
- **B4** the API to its database;
- **B5** the API and its jobs to third parties: the identity provider, the Anthropic API, SMTP, Teams, organisations' model endpoints and GitHub (to fetch a model's code, T4.15);
- **B6** between sites and organisations within one Tiles database.

## STRIDE by element

### Edge agent (on site)

| Threat | What could happen | Mitigation | Status |
|---|---|---|---|
| **S**poofing the API to the agent | A man in the middle on the plant's network receives readings or feeds commands | TLS is always verified; plain HTTP is refused except to localhost (`config.py`); a site CA can be pinned (`ca_file`). The agent takes no commands, and heartbeat `commands` are always empty | Done |
| **S**poofing an OPC UA server | A rogue server feeds false values | The server certificate is always pinned (`opcua server-cert`, ADR 003) | Done |
| **T**ampering with the machines | The agent writes to a PLC or database | Connectors are read-only by design: OPC UA reads and subscriptions, MQTT subscribe, and SQL queries in a transaction that is always rolled back (`sql.py`). The agent opens no listening port | Done |
| **T**ampering with buffered readings | Someone on the host edits the SQLite buffer before upload | The buffer sits on the host under UID 10001. Readings are unsigned. Host disk encryption and access control are the partner's (runbook) | Partial: sign batches (gap G-E3) |
| **R**epudiation | Unclear which agent sent what | Each agent has its own token; readings record `edge:<agent name>` as their source; registration and revocation are audited | Done |
| **I**nformation disclosure of the token | The token file leaks and someone sends readings as the site | Only a hash is stored server-side; the token comes from a file or an environment variable, and the agent warns when the file can be read by other users (it asks for mode 0600); revoking takes effect immediately; rotation is in [the runbook](../runbooks/secrets-and-encryption.md) | Done |
| **D**enial of service | The plant network or a broker floods the agent; the API is unreachable | The buffer is bounded and survives restarts; backoff on failure; batches of at most 10,000 readings | Done |
| **E**levation of privilege | A bug in a protocol library (asyncua, paho, an ODBC driver) is exploited by a malicious server | Libraries are optional extras, imported only when configured; the image runs as non-root; dependencies are scanned (T5.08) | Partial: sandbox the process (G-E2) |

### Tiles API and jobs

| Threat | What could happen | Mitigation | Status |
|---|---|---|---|
| **S**poofing a user | Forged or replayed tokens; a request with no token naming any user | OIDC tokens are verified (signature through JWKS, issuer, audience, expiry; `auth.py`); PKCE in the browser. Every request needs a token in production, and wherever sign-in is configured (an OIDC issuer), whatever `TILES_ENV` says; only a local stack with no issuer, or one that opts in with `TILES_DEV_IDENTITY` (refused in production), lets a request without one act as the development user or whoever `X-Tiles-User` names | Done (G-A5) |
| **S**poofing an agent | Guessed tokens | 256-bit random tokens (`secrets.token_urlsafe(32)`), stored and looked up only as their SHA-256 hash | Done |
| **T**ampering across sites | A request on site A reads or writes site B's rows | Every query is scoped by `SiteContext`, and the database enforces it: forced row security, closed when no site is named; readings only through the `site_samples` view and `tiles_store_samples` (T5.04) | Done |
| **T**ampering with history | Ontology commits or the audit log are rewritten | Commits are append-only; the audit log refuses UPDATE, DELETE and TRUNCATE; design runs refuse UPDATE (trigger); every write endpoint audits itself | Done |
| **T**ampering by the copilot | Prompt injection through data (a node label, a document) makes the copilot change things | Tools are read-only transactions. The one writing tool opens a change request that another engineer must approve (T4.09); answers are grounding-checked (T4.03) | Done |
| **R**epudiation | Who changed what | The audit log with actor, request ID and before/after values; JSON logs with request IDs | Done |
| **I**nformation disclosure of credentials | The database leaks Teams webhooks or SMTP secrets | Teams URLs and model endpoint tokens are sealed with AES-256-GCM data keys kept outside the database (T5.06); secrets are `SecretStr` and come from files or a secrets manager; stored credentials are never shown again | Done |
| **I**nformation disclosure to the AI provider | Plant data goes to the Anthropic API | Only tool results the copilot asked for, for the user who asked; the copilot is off until it is configured; the data-processing terms are the customer's decision | Partial: per-site opt-in and a data-classification note (G-A4) |
| **D**enial of service | Floods of requests or huge bodies | Request models bound their lists and strings; the copilot has per-organisation and per-user rate limits and token budgets (T4.07); sweeps run at most two at a time in the API; the API refuses bodies over 25 MB (`TILES_MAX_BODY_BYTES`, also when sent without a length), and the chart's ingress limits each client address to 50 requests a second | Done (G-A1); another ingress controller needs its own rate limit |
| **E**levation of privilege | A viewer writes, or an engineer acts as an admin | Roles are checked per endpoint (`Editor`, `Admin`); the role is re-read for the copilot's writing tool; the API runs as `tiles_app` with no superuser powers | Done |
| **E**levation of privilege through a model's code | A model from GitHub (T4.15) reads secrets, reaches the network or the database, or attacks the host | The code never runs in the API: the sandbox (`tiles-sandbox`) runs each evaluation in a new process, the standard library only, with limits (CPU time, 512 MB, no files written, no new processes, its output capped) and an audit hook refusing sockets, processes, foreign code and files outside the model's directory (a second wall: Python code can work around an audit hook). The boundary is the process and the pod: no network out (a NetworkPolicy whenever the sandbox is on), no service-account token, a read-only filesystem, a non-root user, and only its own token, in the server's environment, which it makes unreadable to the models it runs; a runtime class (gVisor) can give it a kernel of its own. Only organisation admins register a model, at a full commit SHA, and the code kept is the code run | Done; a runtime class is the operator's choice |

### Browser app

| Threat | What could happen | Mitigation | Status |
|---|---|---|---|
| **T**ampering / XSS | Data (tags, notes, node labels) runs as script | Every interpolation goes through `esc()`: a rule in CLAUDE.md and CONTRIBUTING, checked in review (no lint rule enforces it); no runtime dependencies | Partial: no Content-Security-Policy from `server.js` (G-B1) |
| **I**nformation disclosure | Tokens are stolen from storage | Tokens are in sessionStorage, not localStorage, and are refreshed before expiry; a Content-Security-Policy allows scripts from the app's own server only (`server.js`), and the sign-in code never leaves in a referrer | Done (G-B1) |
| **S**poofing / clickjacking | The app is framed by another site | `frame-ancestors 'none'` and `X-Frame-Options: DENY` (`server.js`, tested) | Done (G-B1) |

### Database and backups

| Threat | What could happen | Mitigation | Status |
|---|---|---|---|
| **I**nformation disclosure at rest | A disk or backup is stolen | Credentials sealed in the database (T5.06); volume and backup encryption with KMS ([runbook](../runbooks/secrets-and-encryption.md)) | Partial: the customer's or our deployment must enable it (T5.09, T5.14) |
| **T**ampering | Direct access to the database bypasses the API | Network isolation (internal only); the API's role can't skip row security | Partial: least-privilege jobs role (G-D1) |
| **D**enial of service | The disk fills with readings | Compression after 7 days, retention for 5 years (migration 0004) | Done; monitoring in T5.13 |

## IEC 62443 gap list

### Edge agent as a component (62443-4-2, aiming for SL 2)

| Requirement | Status | Note or action |
|---|---|---|
| CR 1.1 / 1.2 Identification and authentication | Done | A per-agent token toward the API; OPC UA client certificate toward servers |
| CR 1.5 Authenticator management | Partial | Token rotation is documented; there's no expiry (G-E1) |
| CR 2.1 Authorisation enforcement | Done | Read-only connectors; no inbound interface |
| CR 3.1 Communication integrity | Done | TLS for the API and MQTT; OPC UA signed and encrypted by default (Basic256Sha256, SignAndEncrypt); an unsecured session only with `allow_unsecured = true` |
| CR 3.4 Software and information integrity | Partial | The image's dependencies are scanned and it has a CycloneDX SBOM in CI (T5.08); no signature on releases (G-E4) |
| CR 3.9 Protection of audit information | Partial | JSON logs on stderr (journald under systemd); collecting them is the site's |
| CR 4.1 Information confidentiality | Partial | Buffer and token on the host disk (encrypt the disk: [the runbook](../runbooks/secrets-and-encryption.md)) |
| CR 7.1 / 7.2 DoS protection, resource management | Done | Bounded buffer, batch limits, backoff |
| EDR 2.4 Mobile code | Done | None: no plugins and no remote commands |
| EDR 3.12 / 3.13 Provisioning of trust anchors | Done | Pinned OPC UA server certificates; the site CA for the API |
| CR 2.12 Non-repudiation | Partial | Source recorded per reading; batches unsigned (G-E3) |

### The system (62443-3-3, SL 2)

| Requirement | Status | Note or action |
|---|---|---|
| SR 1.1 / 1.2 Human and software identification | Done | OIDC for people, tokens for agents |
| SR 1.3 Account management | Done | Users are made at first sign-in, or provisioned from the customer's directory with SCIM, which also deactivates and deletes them (T5.05, [Entra ID and SCIM](../guides/entra-id.md)) |
| SR 1.7 Password strength | Done | At the identity provider (Entra / Keycloak policy) |
| SR 1.11 Unsuccessful login attempts | Done | At the identity provider |
| SR 2.1 Authorisation enforcement | Done | Roles per endpoint and row security per site |
| SR 2.8 / 2.9 Auditable events, storage | Done | An append-only audit log, JSON request logs; retention is the deployment's (T5.13) |
| SR 3.1 Communication integrity | Partial | TLS at the edge and the browser; `sslmode=verify-full` to the database when remote (runbook); enforce it in Helm (T5.09) |
| SR 3.3 Security functionality verification | Partial | Tests for row security, roles and sealing in CI; a penetration test is T6.07 |
| SR 3.4 Software and information integrity | Partial | Dependency and image scanning with SBOMs (T5.08); signed images (G-S2) |
| SR 4.1 Information confidentiality | Done | Sealed credentials (T5.06); encryption at rest is deployment configuration (T5.09) |
| SR 5.1 Network segmentation | Done | The edge agent connects out only; the plant needs no inbound rule (T5.11 documents the firewall) |
| SR 5.2 Zone boundary protection | Done | Outbound-only design; the API's egress allowlist is documented and enforced by host name with Cilium ([hybrid mode](../hybrid.md), T5.11), or by the deployment's firewall |
| SR 6.1 Audit log accessibility | Done | Admins read it in Settings |
| SR 6.2 Continuous monitoring | Gap | T5.13: OpenTelemetry, alerts for ingest lag and job failures |
| SR 7.1 / 7.2 DoS protection | Done | A body-size cap in the API and a rate limit per client at the ingress (G-A1); the copilot's own limits (T4.07) |
| SR 7.3 / 7.4 Backup, recovery | Partial | T5.14: point-in-time recovery policy and procedure ([runbook](../runbooks/backups.md)), a restore drill in CI; the deployment must run the backups and the monthly drill |
| SR 7.6 Network and security configuration settings | Partial | Settings documented; Helm values with secure defaults (T5.09) |

## Actions

| ID | Action | Where |
|---|---|---|
| G-A1 | A request body-size cap and a general rate limit per token and IP in front of the API (ingress) and in the app for the agent endpoints | Done: `main.BodyLimit` (413 over `TILES_MAX_BODY_BYTES`) and the chart's nginx `limit-rps` |
| G-A4 | Per-site opt-in for the copilot, and a note on what it sends to the AI provider | Follow-up before go-live (T5.01) |
| G-A5 | Fail closed: refuse requests without a token whenever OIDC is configured, not only when `TILES_ENV=production`; the Helm chart sets production | Done: `Settings.dev_identity_on` (`TILES_DEV_IDENTITY` to opt in a local stack, refused in production) |
| G-B1 | Security headers from the web server: a Content-Security-Policy without `unsafe-inline` scripts, `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy` | Done: `securityHeaders` in `server.js` (the API sets `nosniff`, `no-referrer` and a closed policy on its own answers) |
| G-D1 | Jobs connect as their own role, not the migration login | T5.09 |
| G-E1 | Edge tokens expire (with rotation from the UI) | Follow-up |
| G-E2 | Run the agent under systemd sandboxing (or a read-only container) with only outbound network | Done: `edge/deploy/tiles-edge.service` (exposure 1.1, checked in CI), T5.11 |
| G-E3 | Sign reading batches with a per-agent key, so the API can tell they weren't changed on the host | Later; weigh against SL target |
| G-E4 / G-S2 | Sign releases and images (Sigstore cosign) and verify them at install | T6.04 |
| G-S3 | Document and enforce the API's egress allowlist | Done: [hybrid mode](../hybrid.md) lists it; `networkPolicy.egressAllowlist` enforces it with Cilium, T5.11 |

Review this document when an ADR changes a trust boundary, before each release (T6.04), and after the penetration test (T6.07). The [SOC 2 and ISO 27001 readiness plan](compliance-readiness.md) tracks these actions among its controls.
