# Where and how Tiles runs. Secrets are sensitive variables: give them from your secret manager
# (TF_VAR_… in the pipeline), never in a .tfvars file in git. They end up in Terraform's state as
# well, so keep the state in an encrypted backend that few can read; or set existing_secret and
# keep secrets out of Terraform altogether.

variable "namespace" {
  description = "Kubernetes namespace for Tiles."
  type        = string
  default     = "tiles"
}

variable "create_namespace" {
  description = "Create the namespace (false: it exists already)."
  type        = bool
  default     = true
}

variable "release_name" {
  description = "Helm release name; resources are named after it."
  type        = string
  default     = "tiles"
}

variable "chart" {
  description = "The Tiles chart: a path (default: this repository's deploy/helm/tiles) or a packaged chart's URL from a release."
  type        = string
  default     = null
}

variable "chart_version" {
  description = "The chart's version, when `chart` names a chart in a repository."
  type        = string
  default     = null
}

variable "env" {
  description = "development, test or production. Production refuses the dev identity and needs sign-in."
  type        = string
  default     = "production"
  validation {
    condition     = contains(["development", "test", "production"], var.env)
    error_message = "env is development, test or production."
  }
}

variable "image_tag" {
  description = "The release of Tiles to run (`1.2.3`), or `sha-<commit>`. Production runs a pinned one."
  type        = string
  validation {
    condition     = var.env != "production" || !contains(["main", "latest", ""], var.image_tag)
    error_message = "In production, pin image_tag to a release (1.2.3) or a commit (sha-…), not a moving tag."
  }
}

variable "url" {
  description = "Where people open the app, e.g. https://tiles.example.com (an origin: no path)."
  type        = string
  validation {
    condition     = can(regex("^https?://[^/\\s]+$", var.url))
    error_message = "url is an http(s) origin without a path."
  }
}

variable "api_url" {
  description = "Where browsers and edge agents reach the API, e.g. https://api.tiles.example.com."
  type        = string
  validation {
    condition     = can(regex("^https?://[^/\\s]+$", var.api_url))
    error_message = "api_url is an http(s) origin without a path."
  }
}

variable "oidc" {
  description = "Single sign-on: the identity provider's issuer, and the API's audience and the app's client id there."
  type = object({
    issuer      = string
    audience    = optional(string, "tiles-api")
    client_id   = optional(string, "tiles-web")
    default_org = optional(string, "demo")
  })
  validation {
    condition     = can(regex("^https://", var.oidc.issuer))
    error_message = "oidc.issuer is the identity provider's https URL."
  }
}

variable "existing_secret" {
  description = "A Secret you manage (External Secrets, Vault) with the tiles_* keys. Set, Terraform makes none: give no secrets here, and say whether the database and Redis are the chart's (database_bundled, redis_bundled)."
  type        = string
  default     = null
  validation {
    condition = var.existing_secret == null || nonsensitive(
      var.database_url == null && var.redis_url == null && var.data_keys == null && var.smtp_password == null && var.anthropic_api_key == null
    )
    error_message = "With existing_secret, every secret comes from it: don't give database_url, redis_url, data_keys, smtp_password or anthropic_api_key too."
  }
  validation {
    condition     = var.existing_secret == null || (var.database_bundled != null && var.redis_bundled != null)
    error_message = "With existing_secret, set database_bundled and redis_bundled: false when your Secret has tiles_database_url (tiles_redis_url), true for the chart's own."
  }
}

variable "database_bundled" {
  description = "Run the chart's database pod. Null: when database_url isn't given."
  type        = bool
  default     = null
  validation {
    condition     = var.database_bundled != true || nonsensitive(var.database_url == null)
    error_message = "database_bundled = true and a database_url: choose one."
  }
}

variable "redis_bundled" {
  description = "Run the chart's Redis pod. Null: when redis_url isn't given."
  type        = bool
  default     = null
  validation {
    condition     = var.redis_bundled != true || nonsensitive(var.redis_url == null)
    error_message = "redis_bundled = true and a redis_url: choose one."
  }
}

variable "database_url" {
  description = "PostgreSQL with TimescaleDB (postgresql://…, sslmode=require). Null: the chart's single TimescaleDB pod."
  type        = string
  default     = null
  sensitive   = true
}

variable "database_storage" {
  description = "The bundled database's volume: size and storage class (empty: the cluster's default)."
  type = object({
    size          = optional(string, "50Gi")
    storage_class = optional(string, "")
  })
  default = {}
}

variable "redis_url" {
  description = "Redis (rediss://…). Null: the chart's Redis pod."
  type        = string
  default     = null
  sensitive   = true
}

variable "data_keys" {
  description = "TILES_DATA_KEYS (id:base64key, comma-separated). Null: one key is generated and kept in state."
  type        = string
  default     = null
  sensitive   = true
}

variable "data_key_id" {
  description = "The generated data key's id."
  type        = string
  default     = "k1"
  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,32}$", var.data_key_id))
    error_message = "A key id is 1 to 32 letters, digits, - or _."
  }
}

variable "smtp" {
  description = "E-mail for notifications (empty host: off)."
  type = object({
    host     = optional(string, "")
    port     = optional(number, 587)
    starttls = optional(bool, true)
    user     = optional(string, "")
    from     = optional(string, "Tiles <tiles@example.com>")
  })
  default = {}
}

variable "smtp_password" {
  description = "The SMTP user's password."
  type        = string
  default     = null
  sensitive   = true
}

variable "copilot_model" {
  description = "TILES_COPILOT_MODEL. The copilot is off unless this and anthropic_api_key are set."
  type        = string
  default     = ""
}

variable "anthropic_api_key" {
  description = "The copilot's API key."
  type        = string
  default     = null
  sensitive   = true
}

variable "ingress" {
  description = "An Ingress for both hosts (from url and api_url), on your controller."
  type = object({
    enabled     = optional(bool, true)
    class_name  = optional(string, "")
    tls_secret  = optional(string, "")
    annotations = optional(map(string), { "nginx.ingress.kubernetes.io/proxy-body-size" = "16m" })
  })
  default = {}
}

variable "replicas" {
  description = "API and web pods, and processes per API pod (docs/load-test.md sizes them)."
  type = object({
    api         = optional(number, 2)
    api_workers = optional(number, 2)
    web         = optional(number, 2)
  })
  default = {}
}

variable "monitoring" {
  description = "OTLP endpoint of an OpenTelemetry Collector, and the PrometheusRule and Grafana dashboard (deploy/monitoring)."
  type = object({
    otlp_endpoint     = optional(string, "")
    prometheus_rule   = optional(bool, false)
    grafana_dashboard = optional(bool, false)
  })
  default = {}
}

variable "extra_values" {
  description = "More chart values, merged over the module's (see deploy/helm/tiles/values.yaml)."
  type        = any
  default     = {}
}
