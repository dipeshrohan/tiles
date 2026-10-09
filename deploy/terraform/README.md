# Terraform for Tiles (T5.10)

Two modules, and two environments that use them:

| Directory | What it is |
|---|---|
| [modules/tiles](modules/tiles) | Tiles on any Kubernetes cluster: the [Helm chart](../helm/tiles), and the Secret it reads its settings from |
| [modules/azure](modules/azure) | Tiles' managed cloud on Azure: an AKS cluster, its logs, and storage for the database's backups |
| [environments/managed-azure](environments/managed-azure) | One managed installation, in two stages: `cluster`, then `tiles` on it |
| [environments/customer-hosted](environments/customer-hosted) | The reference install on a cluster the customer runs: the `tiles` module only |

Terraform 1.9 or later (CI uses 1.16.3). The providers are pinned in each environment's `.terraform.lock.hcl`.

## The two ways to run Tiles

**Managed (Azure).** Tiles runs it for the customer, one installation per region or customer.

- **The cluster:** AKS with Entra ID sign-in only, Azure RBAC and no local accounts. Its API server is reachable from named ranges only. NetworkPolicies are enforced (Cilium), and patch versions and node images upgrade by themselves.
- **Node pools:** a system pool, and an autoscaling pool for Tiles.
- **Ingress:** AKS's managed NGINX (the web app routing add-on).
- **Logs:** a Log Analytics workspace.
- **Backups:** a zone- and geo-redundant storage account, versioned with 35 days of soft delete, for pgBackRest ([backups](../../docs/runbooks/backups.md)). It takes no account keys: pgBackRest signs in as the nodes' identity (`repo1-azure-key-type=auto`), which may write to the backups' container and nothing else in the account.
- **Identities:** the cluster's identities are user-assigned ones the module makes: the control plane's and the nodes'.
- **Node pool changes:** a new VM size rotates a pool through a temporary one, draining its nodes, rather than deleting them all at once.
- **Two stages:** the cluster first (`managed-azure/cluster`), then Tiles on it (`managed-azure/tiles`, which reads the cluster as it exists). A provider configured from a cluster made in the same run couldn't plan the first install, nor destroy cleanly.

**Customer-hosted.** Everything stays in the customer's data centre: their cluster, ingress controller, certificates, identity provider and backups. Tiles reaches nothing outside unless they configure it to (mail, the copilot, a collector).

### The database

The database is **TimescaleDB in the cluster** in both cases, unless you give `database_url`. On Azure it is on zone-redundant premium SSD (`tiles-premium-zrs`, which keeps the disk if its claim is deleted): AKS's own premium class is zonal, so the loss of a zone would strand the database. Azure's managed PostgreSQL offers only TimescaleDB's Apache edition, which lacks the columnstore and retention policies that Tiles' readings use (migration 0004). A TimescaleDB service that has them works too: pass its URL as `database_url`, for example Timescale's cloud or your own server.

Back the database up with pgBackRest, as the [backup runbook](../../docs/runbooks/backups.md) describes. The Azure module creates its repository: `backup_storage` among the outputs.

## Secrets

The sensitive variables are `database_url`, `redis_url`, `data_keys`, `smtp_password` and `anthropic_api_key`.

- **Give them from your secret store** as `TF_VAR_…` in the pipeline, never in a `.tfvars` file in git.
- **They end up in Terraform's state,** and so does the data key the module generates when you give none. Keep the state in an encrypted backend that only the operators can read. The managed environment uses an Azure storage account with Entra ID sign-in (`backend.hcl.example`).
- **To keep secrets out of Terraform altogether,** create the Secret yourself, with External Secrets or Vault, under the `tiles_*` keys the [chart](../helm/tiles/README.md) lists. Then set `existing_secret`, and `database_bundled` and `redis_bundled`: `false` when your Secret holds `tiles_database_url` (or `tiles_redis_url`), `true` for the chart's own pod. The module then makes no Secret and generates no key, and refuses any secret given to it.
- **The generated data key is never destroyed by Terraform** (`prevent_destroy`). To move to `existing_secret` or to your own `data_keys`:
  1. Copy the key into the new place, keeping it after the new key for rotation.
  2. Back up the Secret.
  3. Drop the key from Terraform's care: `terraform state rm 'module.tiles.random_bytes.data_key[0]'`.
  4. Apply.
  5. Run `tiles-rotate-keys` to reseal under the new key.
- **Back up the Secret** (output `settings_secret`). Its `tiles_data_keys` opens the credentials Tiles seals; without it they are lost ([secrets and encryption](../../docs/runbooks/secrets-and-encryption.md)).

A change to any secret restarts the API, which reads its settings as it starts: the chart gets a fingerprint of them, never the values.

## Use

Customer-hosted:

```sh
cd environments/customer-hosted
cp terraform.tfvars.example terraform.tfvars    # and edit it; replace the local backend with yours
terraform init
export TF_VAR_smtp_password=…          # from your secret store
terraform plan -out tiles.plan && terraform apply tiles.plan
```

Managed, in two stages that share the backend:

```sh
cd environments/managed-azure
cp backend.hcl.example backend.hcl              # where the state goes
cd cluster
cp terraform.tfvars.example terraform.tfvars    # and edit it
terraform init -backend-config=../backend.hcl -backend-config="key=tiles-eu1-cluster.tfstate"
terraform plan -out cluster.plan && terraform apply cluster.plan
cd ../tiles
cp terraform.tfvars.example terraform.tfvars    # the same name and subscription
terraform init -backend-config=../backend.hcl -backend-config="key=tiles-eu1-tiles.tfstate"
terraform plan -out tiles.plan && terraform apply tiles.plan
```

Upgrades, and changes to Tiles, are the `tiles` stage alone. To take an installation down, destroy `tiles` first, then `cluster`.

- **Sign-in for the managed cluster.** It has no local accounts: Terraform signs in to it through [kubelogin](https://azure.github.io/kubelogin/). Use `kubelogin_mode = "azurecli"` after `az login`, or `workloadidentity` in a pipeline. The pipeline's identity needs *Azure Kubernetes Service RBAC Cluster Admin* on the cluster, and its egress must be in `api_server_authorized_ip_ranges`.
- **Upgrade** by changing `image_tag` to the new release and applying. The chart's API pods migrate the database as they start. Take a backup first; the [releasing guide](../../docs/releasing.md) explains rolling back.
- **Production refuses a moving `image_tag`** (`main`, `latest`): pin a release (`1.2.3`) or a commit (`sha-…`).
- **The namespace enforces the restricted Pod Security Standard.** Every pod of the chart meets it, and CI's cluster test enforces the same.

## Checks

CI's "Terraform modules" job runs, for every module and environment:

- `terraform fmt -check`;
- `init` and `validate`;
- `terraform test` (the tests in each module's `tests/`, with mock providers: no cloud account or cluster needed);
- `trivy config` for misconfiguration.

The tests cover:

- **the `tiles` module:**
  - the chart's database and Redis, or yours;
  - which keys the Secret holds, and that no secret reaches the chart's values, which stay readable in the plan;
  - a generated or given data key;
  - a given Secret, with the database and Redis as asked, refusing secrets given alongside it;
  - the restart fingerprint;
  - refusing a moving tag, a URL with a path, sign-in without https, and both a bundled database and a URL.
- **the `azure` module:**
  - the cluster's sign-in, API server ranges, network policy, workload identity, identities and node pool rotation;
  - the backups' TLS, redundancy, versioning, retention, privacy, keyless access and the nodes' role on their container only;
  - storage names that keep their unique part;
  - refusing an open API server, no admin group, or a name the cluster's DNS prefix can't take.

Locally:

```sh
terraform -chdir=modules/tiles init -backend=false && terraform -chdir=modules/tiles test
terraform -chdir=modules/azure init -backend=false && terraform -chdir=modules/azure test
```
