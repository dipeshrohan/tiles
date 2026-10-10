# Secrets, encryption at rest and key rotation (T5.06)

This runbook says where Tiles' secrets live, how to supply them from a secrets manager, what is encrypted at rest and how, and how to rotate each secret. It applies to the managed cloud and to customer-hosted installs.

## The secrets

| Secret | Where it is used | Where it lives |
|---|---|---|
| Database password | API, jobs, migrations | In `TILES_DATABASE_URL` |
| Data keys | API and jobs, to seal and open credentials stored in the database | `TILES_DATA_KEYS` (never in the database) |
| Anthropic API key | The copilot | `TILES_ANTHROPIC_API_KEY` |
| SMTP password | `tiles-notify` | `TILES_SMTP_PASSWORD` |
| Teams webhook URLs | `tiles-notify` | In the database, sealed with a data key |
| Model endpoint tokens (T4.15) | the API, `tiles-run-models`, `tiles-run-sweeps` | In the database, sealed with a data key; set by organisation admins, never shown again |
| Edge agent tokens | Each edge agent | On the agent's host (the token file, mode 0600); the database keeps only a hash |
| OIDC signing keys | The identity provider signs tokens; the API checks them against its published keys (JWKS) | At the identity provider; the API holds no secret, since the browser signs in with PKCE |

The API never shows a stored credential again: a Teams URL shows only its host, and an agent token is shown once, when it is registered.

## Supplying secrets

Every setting can come from an environment variable or from a file. Point `TILES_SECRETS_DIR` at a directory with one file per setting, named as its variable (`tiles_data_keys`, `TILES_ANTHROPIC_API_KEY`; the case of the name doesn't matter). Environment variables, then `api/.env`, win over the files. That fits any secrets manager that can put a secret in a file:
- **Kubernetes:** a Secret mounted as a volume, or the Secrets Store CSI driver with Vault, AWS Secrets Manager, Azure Key Vault or GCP Secret Manager.
- **Docker / Compose:** `secrets:` mounted at `/run/secrets` (set `TILES_SECRETS_DIR=/run/secrets`).
- **HashiCorp Vault:** a Vault Agent template writing the files.

Never put a secret in the repository, an image or a log. `api/.env` is for development only. Settings that hold secrets are `SecretStr`, so they print as `**********`.

## Encryption at rest

- **Database.** Encrypt the volume Postgres writes to.
  - Managed Postgres: storage encryption with a customer-managed KMS key.
  - Kubernetes: an encrypted StorageClass.
  - Your own hosts: LUKS (dm-crypt) on the data volume.

  Tiles adds no database-level encryption of its own, except for credentials (below), because readings must stay queryable by time.
- **Credentials in the database** are sealed by Tiles with AES-256-GCM (`api/src/tiles_api/sealed.py`) using a data key from `TILES_DATA_KEYS`. Each sealed value is bound to what it is (for example `teams:<site id>`), so it can't be copied to another row. Today this covers the Teams webhook URLs and the tokens of organisations' model endpoints (`model-endpoint:<org>:<key>:<version>`). In production the API won't start without data keys.
- **Backups and WAL archives** must be encrypted too: pgBackRest's repository cipher, or the cloud provider's snapshot encryption with the same KMS key policy as the database. They hold everything the database holds, sealed credentials included; the data keys are not in them.
- **Edge agent buffer.** The SQLite buffer on the agent's host holds readings not yet sent, and the token file holds the agent's token. Put both on an encrypted disk. Keep the token file readable only by the agent's user (UID 10001 in the image).
- **In transit**, everything goes over TLS:
  - edge agents refuse plain HTTP except to localhost;
  - the API runs behind a TLS-terminating proxy;
  - set `sslmode=verify-full` in `TILES_DATABASE_URL` when the database is not on the same host.

## Rotating secrets

### Data keys (`TILES_DATA_KEYS`)

A data key is `id:base64` (32 random bytes). Several can be set at once, separated by commas. The first one seals, and any of them opens.

1. Make a new key: `uv run tiles-rotate-keys --new-key k2` prints `k2:…`. Store it in the secrets manager.
2. Put it first, keeping the old one: `TILES_DATA_KEYS=k2:…,k1:…`. Restart the API and the jobs (`tiles-notify`).
3. Re-seal everything with the new key: `uv run tiles-rotate-keys`. It opens every stored value, re-seals those not sealed with the new key, and seals values stored before keys were set. It prints how many it checked and re-sealed. It names each value that doesn't open, with its site, and exits 1 if there are any.
4. Run it again: it should re-seal 0 and name none. If it names a value, add back the key it names, or set that credential again (Settings → Notifications), before going on.
5. Remove the old key: `TILES_DATA_KEYS=k2:…`. Restart. Keep the old key in the secrets manager, marked retired, until no backup sealed with it remains within the retention period.

If a value doesn't open, the API says which key sealed it ("Sealed with data key k1, which isn't set"), and Settings → Notifications shows the problem so an admin can set the webhook again. Teams messages that can't be opened are held, not given up: they go once the key is back.

### Database password

1. Create the new password for the database role, or a new role with the same grants. On a managed database, use its password rotation.
2. Update `TILES_DATABASE_URL` in the secrets manager.
3. Restart the API, then the jobs. The pool reconnects with the new password.
4. Remove the old password.

Row security doesn't depend on the password: the API works as `tiles_app` either way (T5.04).

### Anthropic API key, SMTP password

Create the new key or password with the provider, update the secret, restart the API or `tiles-notify`, then revoke the old one at the provider.

### Edge agent token

Register a new agent for the same site (Settings → Edge agents) and put its token on the host (`/etc/tiles-edge/token`). Restart the agent, check its heartbeat, then revoke the old agent. A revoked token is refused at once.

### Teams webhook URL

In Teams, create a new Workflows (or incoming) webhook for the channel and set it on the site (Settings → Notifications). Then delete the old one in Teams.

### OIDC signing keys

The identity provider rotates its signing keys. The API fetches the published keys (JWKS) as tokens name them, so nothing changes in Tiles.

## If a secret leaks

1. Rotate it now, as above. For a data key, rotate the key, then also rotate every credential it sealed (the Teams webhooks, and the model endpoints' tokens with their owners): whoever has the key and a copy of the database can open them.
2. Look in the audit log (Settings → Audit log) for what was done with it, and in the API's request logs (each line carries its request ID).
3. Record what happened, when, and what was rotated.
