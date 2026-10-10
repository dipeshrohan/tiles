# Security review pack for a partner's IT and OT teams

This is what to send a design-partner plant's IT and OT security teams when the review starts
(T3.15), and the agenda for the first meeting. It summarises how Tiles connects to the plant, what
data moves where, and how it is protected, and it points to the detailed documents behind each
answer. Send it with the [threat model](threat-model.md) and [hybrid mode](../hybrid.md).

It describes Tiles as built. Where a control is planned rather than in place, it says so and names
the action from the threat model.

## Contents

- [Tiles in one paragraph](#tiles-in-one-paragraph)
- [What connects to what](#what-connects-to-what)
- [The data, end to end](#the-data-end-to-end)
- [Hosting choices](#hosting-choices)
- [Questionnaire quick reference](#questionnaire-quick-reference)
- [Open items](#open-items)
- [The review meeting](#the-review-meeting)

## Tiles in one paragraph

Tiles reads machine data on the plant's network through an edge agent that only ever connects out,
stores it with the plant's model of its lines and machines, and turns it into warnings, analyses and
answers for the plant's engineers. The agent reads only. It never writes to a PLC, a broker or a
database, and it accepts no inbound connections. People sign in with the plant's own identity
provider. Tiles runs in our managed cloud or on the plant's own Kubernetes cluster.

## What connects to what

The diagram and trust boundaries are in the [threat model](threat-model.md#the-system-and-its-trust-boundaries).
The firewall rules, for the plant and for the cloud, are in [hybrid mode](../hybrid.md).

| From | To | Protocol | Opened by | Notes |
| --- | --- | --- | --- | --- |
| Edge agent | PLCs, OPC UA servers | OPC UA (signed and encrypted by default; server certificate pinned) | The agent | Read and subscribe only |
| Edge agent | MQTT broker | MQTT over TLS | The agent | Subscribe only |
| Edge agent | Historian or SQL database | PostgreSQL or SQL Server protocol | The agent | A read-only account; every poll rolled back |
| Edge agent | Tiles API | HTTPS, port 443, through a proxy if needed | The agent | The only connection across the plant's perimeter, opened from inside |
| Engineers' browsers | Tiles (app and API) | HTTPS | The browser | Sign-in with the plant's identity provider (OIDC with PKCE) |
| Tiles API | The plant's identity provider | HTTPS | Tiles | To check sign-in tokens |
| Tiles API | Mail relay, Teams | SMTP with STARTTLS, HTTPS | Tiles | Only if notifications are turned on; Teams only to Microsoft's webhook hosts |
| Tiles API | Anthropic API | HTTPS | Tiles | Only if the copilot is turned on: see [the data](#the-data-end-to-end) |
| Tiles API | Organisations' model endpoints, GitHub | HTTPS | Tiles | Only for models the plant registers itself (T4.15) |

With Cilium, Tiles' own egress is enforced as an allowlist by host name. The model sandbox connects
nowhere at all ([hybrid mode](../hybrid.md#in-the-cloud)).

## The data, end to end

| Data | Where it comes from | Where it is kept | How it is protected | How long |
| --- | --- | --- | --- | --- |
| Machine readings | The edge agent, or file imports | The site's database (TimescaleDB) | TLS in transit; volume and backup encryption at rest ([runbook](../runbooks/secrets-and-encryption.md)); row security per site | 5 years, compressed after 7 days |
| Readings not yet sent | The edge agent | The agent's disk buffer on the plant's host | The host's own disk encryption; the agent's sandbox | Until the API accepts them (bounded) |
| The plant model (ontology), warnings, analyses, documents | People, through the app | The site's database | As above; every change in the audit log | For the contract's term |
| Credentials Tiles keeps (Teams webhooks, model endpoints' tokens) | Admins | The database, sealed (AES-256-GCM) with a data key kept outside it | Never shown again after they are set | Until removed |
| People's identity | The plant's identity provider (or SCIM) | Name, e-mail and role in the database | Deactivated and deleted users can't sign in | Until deleted |
| Copilot questions and answers | People | The asker's own conversations | Visible to the asker only | Until the asker deletes them |
| What the copilot sends to Anthropic | Each question, and the tool results it reads to answer it, for the user who asked | Anthropic, under its commercial terms | TLS; the copilot is off unless configured | Anthropic's API data policy |
| Backups | The database | Encrypted backup storage | Encryption with the same key policy; restore drilled in CI | 35 days of point-in-time recovery ([backups](../runbooks/backups.md)) |

Nothing from the plant goes to any other third party. The copilot is the one place where plant data
leaves Tiles, and it is off until an administrator turns it on.

## Hosting choices

- **Managed cloud:** Tiles runs it on Azure (AKS), in a region the plant chooses. The infrastructure
  is in `deploy/terraform/environments/managed-azure`.
- **The plant's own cluster:** the plant runs Tiles itself on its own Kubernetes cluster, and no
  data leaves its network except what the plant turns on. Follow the [install guide](../install.md).
- **Either way:** the edge agent is the same, and so is the plant's identity provider sign-in.

## Questionnaire quick reference

| Question | Answer | Evidence |
| --- | --- | --- |
| Does anything connect into the OT network? | No. The edge agent connects out only, to one HTTPS host | [Hybrid mode](../hybrid.md) |
| Can Tiles change anything on the machines? | No. The connectors read and subscribe only; SQL polls run read-only and are rolled back | [ADR 003](../adr/003-edge-agent.md) |
| Where should the agent sit (IEC 62443)? | In the DMZ or a conduit zone, reading the listed OT servers, out to the API only | [Hybrid mode](../hybrid.md) |
| How is the agent's host protected? | A systemd unit with sandboxing (exposure 1.1, checked in CI), or a read-only container | `edge/deploy/tiles-edge.service` |
| How do people sign in? | The plant's own identity provider (Entra ID or any OIDC); it can be enforced, with groups mapped to roles and users provisioned by SCIM | [Entra ID guide](../guides/entra-id.md) |
| Who can see a site's data? | Members of that site, by role; the database enforces it with row-level security | [Threat model](threat-model.md#tiles-api-and-jobs) |
| Is there an audit trail? | Every change, with who, when, before and after, and a request ID; the log can't be edited | [Admin guide](../guides/admin.md#the-audit-log) |
| How are secrets handled? | Sealed in the database with a data key outside it, or mounted from a secret store; rotation documented | [Secrets runbook](../runbooks/secrets-and-encryption.md) |
| How are vulnerabilities found? | Dependency and image scanning with SBOMs in CI; a penetration test before v1.0 (T6.07) | [Readiness plan](compliance-readiness.md) |
| Is the AI grounded? | Its answers must cite tool results; numbers and names it can't support are withdrawn; an evaluation gate runs in CI | [ADR 005](../adr/005-ai-copilot.md) |
| Can the plant run its own code in Tiles? | Only in a sandbox with no network and no credentials, or on its own endpoint | [Model-author guide](../guides/model-author.md#11-models-from-github-run-in-the-sandbox) |
| SOC 2 / ISO 27001? | Not certified yet; the controls are mapped with their evidence and a timeline | [Readiness plan](compliance-readiness.md) |

## Open items

These are the gaps the [threat model](threat-model.md#actions) lists. Say so plainly in the review,
with the date each will close:

- **Not certified:** no penetration test yet (T6.07) and no SOC 2 or ISO 27001 certification
  ([timeline](compliance-readiness.md#timeline)).
- **Remaining actions:** the threat model's open actions (security headers, failing closed without a
  token, the jobs' own database role, edge-token expiry, signed images), each with its status
  there.

## The review meeting

About 90 minutes, with the plant's IT security lead, OT lead and network owner, and Tiles' tech
lead.

1. **What Tiles is and does** (10 min): this pack's first sections.
2. **Network** (20 min): where the agent goes, the outbound rule, the proxy. Leave with the agent's
   host and firewall change requested.
3. **Data** (20 min): the table above; residency and hosting; the copilot, on or off.
4. **Identity** (15 min): the identity provider, groups to roles, SCIM.
5. **Their questionnaire** (20 min): answer from the quick reference; note what needs a written
   answer.
6. **Next steps** (5 min): who approves, by when; the open items and their dates.

Record the decisions and the open questions, and add them to the assessment report
([pilot kit](../pilot/assessment.md#the-assessment-report)).
