# Tiles Helm chart

The chart installs Tiles on Kubernetes 1.27 or later (T5.09):

- the API, which applies database migrations as each pod starts (one pod at a time);
- its scheduled jobs, as CronJobs;
- the web app;
- for evaluation, a database and Redis.

The images come from GitHub's container registry. The [Images workflow](../../../.github/workflows/images.yml) publishes `ghcr.io/dipeshrohan/tiles-api`, `tiles-web` and `tiles-edge` on every push to `main` (tags `main` and `sha-…`) and for every version tag (`1.2.3`). The chart installs `main` by default; in production, pin a release or a commit (`images.api.tag`, `images.web.tag`).

## Try it

```sh
helm install tiles deploy/helm/tiles \
  --set url=https://tiles.example.com --set apiUrl=https://api.tiles.example.com \
  --set oidc.issuer=https://idp.example.com/realms/tiles \
  --set ingress.enabled=true --set ingress.className=nginx --set ingress.tlsSecret=tiles-tls
```

- **Addresses:** people open `url`, and their browsers reach the API at `apiUrl`. With the ingress, these must be two different host names, because each takes every path of its host. The web app opens `apiUrl` by default; the server writes it into the page.
- **Sign-in:** at your OIDC provider, add `url` as a redirect URI and a web origin of the `tiles-web` client (the [API settings](../../../api/README.md) list the `oidc.*` options).
- **Production mode** (`env: production`, the default): the dev identity is refused, so the API needs `oidc.issuer`. Production also needs data keys.
- **Bad settings fail early:** `helm install` refuses settings that can't work before it creates anything, for example production without an issuer, or an address that isn't an http(s) origin.

## Production

The bundled database is one pod with one volume. It has no replica, no point-in-time recovery and no tuning. For production:

1. **Database:** use a managed PostgreSQL 17 with the TimescaleDB extension and backups (T5.14). The login needs to create a role, because migration 0024 adds `tiles_app` for row security.
2. **Secrets:** create a Secret from your secret manager (External Secrets, Vault, Sealed Secrets). Each key is a setting's variable name in lower case:

   | Key | Holds |
   | --- | --- |
   | `tiles_database_url` | `postgresql://…` (required without the bundled database) |
   | `tiles_redis_url` | required without the bundled Redis |
   | `tiles_data_keys` | the keys that seal stored credentials (`id:base64`; see the [secrets runbook](../../../docs/runbooks/secrets-and-encryption.md)) |
   | `tiles_smtp_password` | for e-mail notifications |
   | `tiles_anthropic_api_key` | for the copilot, with `copilot.model` |

3. **Install:**

   ```sh
   helm install tiles deploy/helm/tiles -f my-values.yaml \
     --set database.bundled=false --set redis.bundled=false \
     --set secrets.existingSecret=tiles --set secrets.generateDataKey=false
   ```

The API and the jobs read the Secret as files (`TILES_SECRETS_DIR`), never as environment variables. Values in `values.yaml` aren't secret.

- **When your Secret has `tiles_data_keys`:** set `secrets.generateDataKey=false`. Otherwise the generated key is mounted at the same path, and one of the two hides the other.
- **After changing the Secret** (a new database password, a new data key to rotate to): change `secrets.revision` in the same `helm upgrade` to restart the API, which reads its settings once, at start. The jobs read them on every run.
- **With `helm template` or a GitOps tool (Argo CD, Flux's post-rendering):** the generated Secret can't work, because it keeps its values by reading itself back at upgrade (`lookup`), and those tools render without the cluster. Every render would make a new password and data key. Use your own Secret for everything (`secrets.generateDataKey=false`) and an external database.

### What the chart sets up for safety

- **Containers:**
  - not root;
  - a read-only root filesystem, with `/tmp` in memory;
  - no Linux capabilities;
  - the runtime's default seccomp profile;
  - no service-account token.
- **Network policies** (they need a CNI that enforces them):
  - the database and Redis accept only the API and the jobs;
  - Tiles pods accept traffic only on their own HTTP ports.
- **The generated Secret** `<release>-generated` holds the bundled database's password and, with `secrets.generateDataKey`, a data key:
  - it is made once, and an upgrade reads it back;
  - uninstalling keeps it, as it keeps the database volume;
  - **back it up**: without the data key, sealed credentials can't be opened.
- **Rollouts:** the API restarts when its settings change. With more than one replica, the API and the web app each have a PodDisruptionBudget.

## Jobs

Each job is a CronJob that runs one command over every site, then exits. A run that overlaps the next one makes that next run wait (`concurrencyPolicy: Forbid`).

| Job | Command | Default schedule (UTC) |
| --- | --- | --- |
| `checkQuality` | `tiles-check-quality` | every 15 minutes |
| `runModels` | `tiles-run-models` | every 5 minutes |
| `detect` | `tiles-detect` | every 5 minutes |
| `notify` | `tiles-notify` | every minute |
| `runSweeps` | `tiles-run-sweeps` | every 2 minutes |

To run a job now: `kubectl create job check-now --from=cronjob/tiles-check-quality`.

## Checks

The CI job **Helm chart on Kubernetes**:

1. lints the chart;
2. validates three renderings with kubeconform;
3. checks that bad settings are refused;
4. installs the chart on a kind cluster with production settings;
5. checks `/ready`, the sign-in requirement and the web app's API address;
6. runs two jobs to completion;
7. upgrades the release, and checks that the generated Secret is unchanged.
