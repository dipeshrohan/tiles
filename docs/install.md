# Installing Tiles on your own cluster (T5.12)

This guide installs Tiles in your data centre, on a Kubernetes cluster you run, with the customer-hosted Terraform in [deploy/terraform](../deploy/terraform/README.md). Plan on half a day, once the items in [Before you start](#before-you-start) are ready.

CI follows this guide on a new, empty cluster on every change: the **Install dry run** job. It shows that the guide's commands work as written. See [The dry run](#the-dry-run) for what it covers.

- **Without Terraform:** the [Helm chart](../deploy/helm/tiles/README.md) alone installs the same thing.
- **For Tiles' managed cloud instead:** see `environments/managed-azure` in the Terraform.

## What you install

```
  people's browsers ──https──▶ ingress ──▶ tiles-web   (the app)
                              │       └──▶ tiles-api   (the API) ──▶ TimescaleDB, Redis
  edge agents on site ──https─┘                        └── CronJobs: checks, models, detectors, notifications
```

- **In one namespace:**
  - the API (two pods by default), which migrates the database as it starts;
  - the web app;
  - five scheduled jobs;
  - unless you bring your own: one TimescaleDB pod with its volume, and Redis.
- **Ingress:** the app and the API each get a host name of their own, through your ingress controller.
- **Edge agents:** they run on the plant network and only connect out, to the API's host.

The [admin guide](guides/admin.md#1-architecture-at-a-glance) explains each part.

## Before you start

| You need | Notes |
|---|---|
| **Kubernetes 1.27 or later** | The pods meet the *restricted* Pod Security Standard, and the namespace enforces it. |
| **A CNI that enforces NetworkPolicy** | Calico, Cilium, or another. The chart limits who may reach the database, Redis and the API. |
| **An ingress controller** | NGINX, or another. Raise its request body limit to 16 MB (the chart sets NGINX's): agents send up to 10,000 readings at once. |
| **A storage class on SSDs** | For the database. With `Retain`, deleting the claim keeps the disk. |
| **Two host names and a certificate for both** | For example `tiles.plant.example.com` (the app) and `tiles-api.plant.example.com` (the API). Either create the `tiles` namespace and the certificate's Secret (`tls_secret`) before you install, and set `create_namespace = false`: Terraform then labels your namespace. Or let Terraform create the namespace, and have cert-manager issue the certificate into it. |
| **An OpenID Connect provider** | Entra ID, Keycloak, ADFS… See [Sign-in](#1-sign-in). |
| **Capacity** | For one site's plant (10,000 readings a second, 50 people): two API pods of up to 1 CPU and 1.5 GB each, and a database with 4 CPUs, 16 GB and fast SSDs. Storage: about 850 GB for the readings' first, uncompressed week, then 8 GB a day. [The load test](load-test.md) has the details. Smaller plants need proportionally less. |
| **The images** | From `ghcr.io/dipeshrohan`, or your mirror of them (see [Images](#2-images)). |
| **Terraform 1.9 or later, and a kubeconfig** | For someone allowed to create namespaces, Secrets and the chart's resources. |
| **A place for the Terraform state** | Encrypted, and readable by the operators only: it holds the data key unless you bring your own Secret. |
| **Somewhere to keep backups** | Object storage for pgBackRest (S3-compatible or Azure), and a copy of the settings Secret. |
| **A mail relay** (optional) | For notifications. |

**Firewall rules.**

- **Inbound to the ingress, on 443:** from people's browsers, and from each edge agent.
- **Outbound from the cluster:**
  - to your identity provider (its signing keys);
  - to the mail relay;
  - to the image registry, unless you mirror the images;
  - optionally, to the copilot's API and your OpenTelemetry Collector.
- **Nothing reaches into the plant network:** agents only connect out. The [admin guide](guides/admin.md#firewall-rules) lists the agents' side.

## 1. Sign-in

Register Tiles with your identity provider as the [admin guide](guides/admin.md#configure-the-identity-provider) describes. In short:

1. **The app:** a public client, `tiles-web`, with PKCE. Its redirect URI is the app's address (`https://tiles.plant.example.com/*`).
2. **The API:** an audience, `tiles-api`, which access tokens carry, with the `email` claim.
3. **Roles:** `tiles-viewer`, `tiles-engineer` and `tiles-admin`, given to people. In Entra ID, these are app roles; they arrive in the `roles` claim.
4. **Your organisation:** add a `tiles_org` claim with your organisation's short name, or set `default_org` below.

Note the issuer: for Entra ID, `https://login.microsoftonline.com/<tenant-id>/v2.0`. It must equal the tokens' `iss` exactly.

## 2. Images

If the cluster can reach `ghcr.io` and Docker Hub, skip this step.

Otherwise, copy the release's images into your registry, with the database's and Redis's images unless you bring your own. `--all` keeps every architecture, whatever the copying machine runs. Take the database's and Redis's tags from the chart's `values.yaml` for that release.

```sh
skopeo copy --all docker://ghcr.io/dipeshrohan/tiles-api:0.1.0 docker://registry.plant.example.com/tiles/tiles-api:0.1.0
skopeo copy --all docker://ghcr.io/dipeshrohan/tiles-web:0.1.0 docker://registry.plant.example.com/tiles/tiles-web:0.1.0
skopeo copy --all docker://docker.io/timescale/timescaledb:2.30.2-pg17 docker://registry.plant.example.com/tiles/timescaledb:2.30.2-pg17
skopeo copy --all docker://docker.io/library/redis:7.4-alpine docker://registry.plant.example.com/tiles/redis:7.4-alpine
```

Then add to `terraform.tfvars`:

```hcl
images = {
  registry     = "registry.plant.example.com/tiles"
  pull_secrets = ["plant-registry"]   # if your registry needs credentials: a Secret in the namespace
  database     = "registry.plant.example.com/tiles/timescaledb:2.30.2-pg17"
  redis        = "registry.plant.example.com/tiles/redis:7.4-alpine"
}
```

Releases are listed on GitHub with their notes. Install a release (`0.1.0`), never `main`: production refuses a moving tag.

## 3. Settings

```sh
git clone https://github.com/dipeshrohan/tiles && cd tiles/deploy/terraform/environments/customer-hosted
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`, which starts as:

```hcl
kube_context = "plant-cluster"
image_tag    = "0.1.0"
url          = "https://tiles.plant.example.com"
api_url      = "https://tiles-api.plant.example.com"
oidc = {
  issuer      = "https://login.microsoftonline.com/<tenant-id>/v2.0"
  default_org = "acme"
}
storage_class = "fast-ssd"
database_size = "200Gi"
ingress_class = "nginx"
tls_secret    = "tiles-tls"
smtp = {
  host = "mail.plant.example.com"
  from = "Tiles <tiles@plant.example.com>"
}
```

**Secrets** come from your secret store as environment variables, never in that file:

```sh
export TF_VAR_smtp_password=…        # if the relay needs it
export TF_VAR_database_url=…         # only for your own TimescaleDB (see below)
```

Choices:

- **Your own TimescaleDB** (2.x, with its columnstore and retention policies: not a managed service's Apache edition). Give `database_url`, `postgresql://…?sslmode=require`; the chart then runs no database pod. Its `max_connections` must be above API pods × workers × 14 (with the chart's pool sizes), plus the jobs'.
- **Keeping secrets out of Terraform.** Create the Secret yourself, with External Secrets or Vault, under the keys the chart lists (`tiles_data_keys`, `tiles_database_url`, …). Then set:
  - `existing_secret`, naming it;
  - `database_bundled` and `redis_bundled`: `false` when your Secret holds `tiles_database_url` (or `tiles_redis_url`), `true` for the chart's own pod.
- **The state backend.** Replace `backend "local" {}` in `main.tf` with yours: S3, azurerm, gcs, or a Terraform server.
- **The copilot** (optional). Set `copilot_model` and `TF_VAR_anthropic_api_key`, and open the firewall to the model provider. It sends people's questions, and the data its tools read to answer them, to the provider.

## 4. Install

```sh
terraform init
terraform plan -out tiles.plan      # read it: a namespace, a Secret, the chart
terraform apply tiles.plan
```

Terraform then does the following:

1. Creates the `tiles` namespace, which enforces the restricted Pod Security Standard.
2. Creates the `tiles-settings` Secret, with a newly generated data key and your secrets.
3. Installs the chart. The API's first pod migrates the database: a first install takes a few minutes, and the apply waits for it.

If the chart can't become ready within 15 minutes, the install rolls back; see [Troubleshooting](#troubleshooting).

**Back up the Secret now** (`kubectl -n tiles get secret tiles-settings -o yaml`) to your secret store. Its data key opens the credentials Tiles seals, such as Teams webhooks. Without it they are lost.

## 5. Check it

```sh
kubectl -n tiles get pods                            # api, web, db, redis: Running
curl https://tiles-api.plant.example.com/ready       # {"status":"ok", …}
curl https://tiles-api.plant.example.com/health      # "env":"production", the version
curl -i https://tiles-api.plant.example.com/sites    # 401: sign-in required
```

Then, in a browser:

1. **Open the app's address and sign in.** Settings shows you, your organisation and your role.
2. **Create the first site** as an organisation admin, on **Set up a site**. Making someone an organisation admin is one SQL statement for now, in the [admin guide](guides/admin.md#how-users-and-memberships-are-created). Someone whose sign-in carries `tiles-admin` can create sites without it.
3. **Follow the wizard:**
   - outline the plant;
   - register an edge agent, and install it on site with the config the wizard shows ([edge agent](../edge/README.md));
   - see its first heartbeat;
   - map its tags;
   - open the first dashboard.

## 6. Backups and monitoring

- **Backups.** Set up pgBackRest for the database as the [backup runbook](runbooks/backups.md) describes: full backups, the WAL archive, and a restore drill. With your own TimescaleDB, use its backups.
- **Monitoring** (optional). Point `monitoring.otlp_endpoint` at your OpenTelemetry Collector. Turn on the alert rules and the dashboard if you run the Prometheus Operator and Grafana ([monitoring](../deploy/monitoring/README.md)).

## Upgrading

1. Read the release notes, and take a backup.
2. Change `image_tag` to the new release.
3. Run `terraform plan`, then `terraform apply`. The API's pods migrate the database as they start, one at a time.

[Releasing](releasing.md#rolling-back) explains rolling back: the newer version migrates the database down first.

**Changing a secret.** Change the `TF_VAR_…` and apply. Terraform updates the Secret, and the API restarts to read it; the jobs read it on their next run.

**Rotating the data key.**

1. Make a new key: `kubectl -n tiles exec deploy/tiles-api -- tiles-rotate-keys --new-key k2` prints `k2:…`.
2. Read the current key: `kubectl -n tiles get secret tiles-settings -o jsonpath='{.data.tiles_data_keys}' | base64 -d`.
3. Set `TF_VAR_data_keys` to both, the new one first: `k2:…,k1:…`. Keep the value in your secret store.
4. The first time only, while Terraform still holds the key it generated, let it go. Terraform refuses to destroy that key, so drop it from the state: `terraform state rm 'module.tiles.random_bytes.data_key[0]'`.
5. Run `terraform plan`, then `terraform apply`. The API restarts with both keys.
6. Re-seal everything with the new key: `kubectl -n tiles exec deploy/tiles-api -- tiles-rotate-keys`.

## Uninstalling

`terraform destroy` refuses to destroy the generated data key: losing it loses every sealed credential. When you really mean to remove Tiles:

1. Back up the Secret and the database.
2. Run `terraform state rm 'module.tiles.random_bytes.data_key[0]'`.
3. Run `terraform destroy`.

The database's volume follows its storage class's reclaim policy. With `Retain`, it is kept.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| The apply waits, then rolls back | A pod didn't become ready. Run `kubectl -n tiles get pods` and look at `describe` and `logs` for the one that isn't. |
| `ImagePullBackOff` | The cluster can't reach the registry, or needs `pull_secrets`. See [Images](#2-images). |
| The API pod waits in `Init` | Its `migrate` step is waiting for the database. Look at the logs of the database pod, or check `database_url` and the database's firewall. |
| Pods rejected: *violates PodSecurity "restricted"* | Something extra (a sidecar from a mesh, an agent) was injected. Exclude the namespace from the injection, or make it compliant. |
| `/ready` says `redis` or `db` | That dependency is down, or NetworkPolicy blocks it: the chart's policies need a CNI that enforces them all, with DNS allowed. |
| The browser signs in, then gets 401 | The token's issuer or audience doesn't match. `GET /auth/config` shows what Tiles expects; decode the token to compare. |
| Edge agents get 413 | The ingress's request body limit is too small: 16 MB. |
| A second `terraform plan` shows changes | Something changed outside Terraform (a `kubectl edit`, or a controller adding labels). Apply to put it back, or make the change in Terraform. |

## The dry run

CI's **Install dry run** job follows this guide on a new kind cluster, with the release's images built from the change:

- **Install:** starts from `terraform.tfvars.example`, the file shown in step 3. A unit test (`test/install-guide.test.js`) keeps the two the same. The job overrides only what kind needs (its context, the images built from the change, no ingress controller, a small volume on kind's storage class). Then it runs `terraform init`, `plan` and `apply`.
- **Checks:**
  - the namespace enforces the restricted standard;
  - `/ready` is ok, `/health` says production, and `/sites` wants sign-in;
  - the app points at the API.
- **Re-plan:** a second `plan` must change nothing.
- **A changed secret:** the API restarts, and the data key stays the same.
- **Destroy:** a destroy plan is refused while the data key is in Terraform's care.

The Helm chart's own job runs alongside it on another cluster, enforcing the same standard. It also covers chart upgrades, a scheduled job running to completion, and refusing a lost Secret.
