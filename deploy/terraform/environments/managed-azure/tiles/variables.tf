variable "subscription_id" {
  description = "The Azure subscription the cluster is in."
  type        = string
}

variable "name" {
  description = "This installation's short name, as in ../cluster."
  type        = string
}

variable "kubelogin_mode" {
  description = "How kubelogin signs in to the cluster: azurecli (a person, after az login) or workloadidentity (the pipeline)."
  type        = string
  default     = "azurecli"
}

variable "image_tag" {
  description = "The Tiles release to run, e.g. 1.2.3."
  type        = string
}

variable "url" {
  description = "Where people open Tiles, e.g. https://tiles.example.com."
  type        = string
}

variable "api_url" {
  description = "Where browsers and edge agents reach the API, e.g. https://api.tiles.example.com."
  type        = string
}

variable "oidc" {
  description = "Single sign-on: the customer's identity provider."
  type = object({
    issuer      = string
    audience    = optional(string, "tiles-api")
    client_id   = optional(string, "tiles-web")
    default_org = optional(string, "demo")
  })
}

variable "tls_secret" {
  description = "A Secret in the tiles namespace with the certificate for both hosts (e.g. from cert-manager or Key Vault)."
  type        = string
  default     = "tiles-tls"
}

variable "database_size" {
  description = "The database volume's size; Azure disks grow online. docs/load-test.md sizes it from the reading rate (at 10,000 a second: about 850 GB for the uncompressed first week, then 8 GB a day)."
  type        = string
  default     = "200Gi"
}

variable "existing_secret" {
  description = "A Secret you manage (e.g. from Key Vault through External Secrets) with tiles_data_keys and the other secrets: set, Terraform keeps no secrets."
  type        = string
  default     = null
}

variable "data_keys" {
  description = "TILES_DATA_KEYS to rotate to: the new key first, then the old ones (TF_VAR_data_keys). Null: the generated one."
  type        = string
  default     = null
  sensitive   = true
}

variable "smtp" {
  description = "E-mail for notifications."
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

variable "copilot_model" {
  description = "The copilot's model; off when empty."
  type        = string
  default     = ""
}

variable "anthropic_api_key" {
  description = "The copilot's API key (TF_VAR_anthropic_api_key)."
  type        = string
  default     = null
  sensitive   = true
}

variable "monitoring" {
  description = "OTLP endpoint of the OpenTelemetry Collector, and the alert rules and dashboard."
  type = object({
    otlp_endpoint     = optional(string, "")
    prometheus_rule   = optional(bool, false)
    grafana_dashboard = optional(bool, false)
  })
  default = {}
}
