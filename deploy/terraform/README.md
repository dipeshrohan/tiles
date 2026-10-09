# Terraform for Tiles (T5.10)

Two modules, and two environments that use them:

| Directory | What it is |
|---|---|
| [modules/tiles](modules/tiles) | Tiles on any Kubernetes cluster: the [Helm chart](../helm/tiles), and the Secret it reads its settings from |
| [modules/azure](modules/azure) | Tiles' managed cloud on Azure: an AKS cluster, its logs, and storage for the database's backups |
| [environments/managed-azure](environments/managed-azure) | One managed installation: both modules together |
| [environments/customer-hosted](environments/customer-hosted) | The reference install on a cluster the customer runs: the `tiles` module only |

Terraform 1.9 or later (CI uses 1.16.3). The providers are pinned in each environment's `.terraform.lock.hcl`.

## The two ways to run Tiles

**Managed (Azure).** Tiles runs it for the customer, one installation per region or customer.

- **The cluster:** AKS with Entra ID sign-in only, Azure RBAC and no local accounts. Its API server is reachable from named ranges only. NetworkPolicies are enforced (Cilium), and patch versions and node images upgrade by themselves.
- **Node pools:** a system pool, and an autoscaling pool for Tiles.
- **Ingress:** AKS's managed NGINX (the web app routing add-on).
- **Logs:** a Log Analytics workspace.
- **Backups:** a zone- and geo-redundant storage account, versioned with 35 days of soft delete, for pgBackRest ([backups](../../docs/runbooks/backups.md)).

**Customer-hosted.** Everything stays in the customer's data centre: their cluster, ingress controller, certificates, identity provider and backups. Tiles reaches nothing outside unless they configure it to (mail, the copilot, a collector).

### The database

The database is **TimescaleDB in the cluster**, on premium SSD, in both cases unless you give `database_url`. Azure's managed PostgreSQL offers only TimescaleDB's Apache edition, which lacks the columnstore and retention policies that Tiles' readings use (migration 0004). A TimescaleDB service that has them works too: pass its URL as `database_url`, for example Timescale's cloud or your own server.

Back the database up with pgBackRest, as the [backup runbook](../../docs/runbooks/backups.md) describes. The Azure module creates its repository: `backup_storage` among the outputs.

## Secrets

The sensitive variables are `database_url`, `redis_url`, `data_keys`, `smtp_password` and `anthropic_api_key`.

- **Give them from your secret store** as `TF_VAR_…` in the pipeline, never in a `.tfvars` file in git.
- **They end up in Terraform's state,** and so does the data key the module generates when you give none. Keep the state in an encrypted backend that only the operators can read. The managed environment uses an Azure storage account with Entra ID sign-in (`backend.hcl.example`).
- **To keep secrets out of Terraform altogether,** create the Secret yourself, with External Secrets or Vault, under the `tiles_*` keys the [chart](../helm/tiles/README.md) lists. Then set `existing_secret`: the module makes no Secret and generates no key.
- **Back up the Secret** (output `settings_secret`). Its `tiles_data_keys` opens the credentials Tiles seals; without it they are lost ([secrets and encryption](../../docs/runbooks/secrets-and-encryption.md)).

A change to any secret restarts the API, which reads its settings as it starts: the chart gets a fingerprint of them, never the values.

## Use

```sh
cd environments/managed-azure          # or customer-hosted
cp terraform.tfvars.example terraform.tfvars    # and edit it
cp backend.hcl.example backend.hcl              # managed only: where the state goes
terraform init -backend-config=backend.hcl
export TF_VAR_smtp_password=…          # from your secret store
terraform plan -out tiles.plan
terraform apply tiles.plan
```

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
  - which keys the Secret holds, and that no secret reaches the chart's values;
  - a generated or given data key, and a given Secret;
  - the restart fingerprint;
  - refusing a moving tag, a URL with a path, and sign-in without https.
- **the `azure` module:**
  - the cluster's sign-in, API server ranges, network policy, workload identity and node pools;
  - the backups' TLS, redundancy, versioning, retention and privacy;
  - refusing an open API server or no admin group.

Locally:

```sh
terraform -chdir=modules/tiles init -backend=false && terraform -chdir=modules/tiles test
terraform -chdir=modules/azure init -backend=false && terraform -chdir=modules/azure test
```
