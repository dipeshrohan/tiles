# Tiles on a Kubernetes cluster (T5.10): the Helm chart (deploy/helm/tiles), and the Secret it
# reads its settings from. The cluster, its ingress controller and the database's backups are the
# caller's (see ../azure for Tiles' managed cloud).

locals {
  chart        = coalesce(var.chart, "${path.module}/../../../helm/tiles")
  secret_name  = coalesce(var.existing_secret, "${var.release_name}-settings")
  make_secret  = var.existing_secret == null
  generate_key = local.make_secret && var.data_keys == null

  # The settings the API and jobs read from files (TILES_SECRETS_DIR), one per key. Absent ones
  # are left out: the bundled database and Redis bring their own.
  settings = local.make_secret ? {
    for k, v in {
      tiles_database_url      = var.database_url
      tiles_redis_url         = var.redis_url
      tiles_data_keys         = local.generate_key ? "${var.data_key_id}:${random_bytes.data_key[0].base64}" : var.data_keys
      tiles_smtp_password     = var.smtp_password
      tiles_anthropic_api_key = var.anthropic_api_key
    } : k => v if v != null
  } : {}

  # A fingerprint of the settings (a hash, not the values): the chart's pods change when one does.
  revision = local.make_secret ? nonsensitive(substr(sha256(jsonencode(local.settings)), 0, 12)) : ""

  values = {
    images = {
      api = { tag = var.image_tag, pullPolicy = "IfNotPresent" }
      web = { tag = var.image_tag, pullPolicy = "IfNotPresent" }
    }
    env    = var.env
    url    = var.url
    apiUrl = var.api_url
    oidc = {
      issuer     = var.oidc.issuer
      audience   = var.oidc.audience
      clientId   = var.oidc.client_id
      defaultOrg = var.oidc.default_org
    }
    secrets = {
      existingSecret = local.secret_name
      # A change to the settings restarts the API, which reads them as it starts.
      revision        = local.revision
      generateDataKey = false # the Secret has tiles_data_keys (generated here, or yours)
    }
    database = {
      bundled      = var.existing_secret == null ? var.database_url == null : false
      storage      = var.database_storage.size
      storageClass = var.database_storage.storage_class
    }
    redis = { bundled = var.existing_secret == null ? var.redis_url == null : false }
    api = {
      replicas = var.replicas.api
      workers  = var.replicas.api_workers
    }
    web     = { replicas = var.replicas.web }
    copilot = { model = var.copilot_model }
    smtp = {
      host     = var.smtp.host
      port     = var.smtp.port
      starttls = var.smtp.starttls
      user     = var.smtp.user
      from     = var.smtp.from
    }
    ingress = {
      enabled     = var.ingress.enabled
      className   = var.ingress.class_name
      tlsSecret   = var.ingress.tls_secret
      annotations = var.ingress.annotations
    }
    monitoring = {
      otlpEndpoint     = var.monitoring.otlp_endpoint
      prometheusRule   = { enabled = var.monitoring.prometheus_rule }
      grafanaDashboard = { enabled = var.monitoring.grafana_dashboard }
    }
  }
}

resource "kubernetes_namespace_v1" "tiles" {
  count = var.create_namespace ? 1 : 0
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/part-of" = "tiles"
      # The pods meet the restricted Pod Security Standard (the chart runs them unprivileged).
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }
}

# One data key, made once and kept in state: it opens the credentials Tiles seals (T5.06), so
# losing it loses them. Rotate by giving data_keys (new key first, old ones after) and running
# tiles-rotate-keys.
resource "random_bytes" "data_key" {
  count  = local.generate_key ? 1 : 0
  length = 32
}

resource "kubernetes_secret_v1" "settings" {
  count = local.make_secret ? 1 : 0
  metadata {
    name      = local.secret_name
    namespace = var.namespace
    labels    = { "app.kubernetes.io/part-of" = "tiles" }
  }
  data       = local.settings
  type       = "Opaque"
  depends_on = [kubernetes_namespace_v1.tiles]
}

resource "helm_release" "tiles" {
  name      = var.release_name
  namespace = var.namespace
  chart     = local.chart
  version   = var.chart_version
  values    = [yamlencode(local.values), yamlencode(var.extra_values)]
  # Migrations run as the API starts: give a first install, and a large upgrade, time.
  timeout         = 900
  wait            = true
  atomic          = true
  cleanup_on_fail = true
  depends_on      = [kubernetes_namespace_v1.tiles, kubernetes_secret_v1.settings]
}
