variable "kubeconfig" {
  description = "The kubeconfig to reach the cluster with."
  type        = string
  default     = "~/.kube/config"
}

variable "kube_context" {
  description = "Its context for the cluster (null: the current one)."
  type        = string
  default     = null
}

variable "namespace" {
  description = "Kubernetes namespace for Tiles."
  type        = string
  default     = "tiles"
}

variable "image_tag" {
  description = "The Tiles release to run, e.g. 1.2.3."
  type        = string
}

variable "images" {
  description = "Your mirror of Tiles' images, if the cluster can't reach ghcr.io, and the Secrets to pull with."
  type = object({
    registry     = optional(string, "ghcr.io/dipeshrohan")
    pull_policy  = optional(string, "IfNotPresent")
    pull_secrets = optional(list(string), [])
  })
  default = {}
}

variable "url" {
  description = "Where people open Tiles, e.g. https://tiles.plant.example.com."
  type        = string
}

variable "api_url" {
  description = "Where browsers and edge agents reach the API, e.g. https://tiles-api.plant.example.com."
  type        = string
}

variable "oidc" {
  description = "Single sign-on: your identity provider (Entra ID, Keycloak, ADFS…)."
  type = object({
    issuer      = string
    audience    = optional(string, "tiles-api")
    client_id   = optional(string, "tiles-web")
    default_org = optional(string, "demo")
  })
}

variable "existing_secret" {
  description = "A Secret you manage with the tiles_* keys; set, Terraform makes none (and keeps no secrets in state)."
  type        = string
  default     = null
}

variable "database_bundled" {
  description = "Run the chart's database pod. Null: unless database_url is given. Set it with existing_secret."
  type        = bool
  default     = null
}

variable "redis_bundled" {
  description = "Run the chart's Redis pod. Null: unless redis_url is given. Set it with existing_secret."
  type        = bool
  default     = null
}

variable "redis_url" {
  description = "Your Redis (rediss://…, TF_VAR_redis_url); null: the chart's Redis pod."
  type        = string
  default     = null
  sensitive   = true
}

variable "data_keys" {
  description = "TILES_DATA_KEYS to rotate to: the new key first, then the old ones (TF_VAR_data_keys). Null: the generated one."
  type        = string
  default     = null
  sensitive   = true
}

variable "database_url" {
  description = "Your PostgreSQL with TimescaleDB 2.x (TF_VAR_database_url); null: the chart's database pod."
  type        = string
  default     = null
  sensitive   = true
}

variable "database_size" {
  description = "The bundled database's volume size."
  type        = string
  default     = "200Gi"
}

variable "storage_class" {
  description = "Storage class for the bundled database (empty: the cluster's default). Use SSDs."
  type        = string
  default     = ""
}

variable "ingress_enabled" {
  description = "Expose Tiles through an Ingress on your controller (false: you route to the tiles-web and tiles-api Services yourself)."
  type        = bool
  default     = true
}

variable "ingress_class" {
  description = "Your ingress controller's class, e.g. nginx."
  type        = string
  default     = "nginx"
}

variable "tls_secret" {
  description = "A Secret in the namespace with the certificate for both hosts."
  type        = string
  default     = "tiles-tls"
}

variable "smtp" {
  description = "Your mail relay, for notifications."
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
  description = "The SMTP user's password (TF_VAR_smtp_password)."
  type        = string
  default     = null
  sensitive   = true
}

variable "monitoring" {
  description = "Your OpenTelemetry Collector, and the alert rules and dashboard."
  type = object({
    otlp_endpoint     = optional(string, "")
    prometheus_rule   = optional(bool, false)
    grafana_dashboard = optional(bool, false)
  })
  default = {}
}
