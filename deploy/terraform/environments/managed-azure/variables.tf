variable "subscription_id" {
  description = "The Azure subscription to install into."
  type        = string
}

variable "name" {
  description = "This installation's short name, e.g. tiles-eu1."
  type        = string
}

variable "location" {
  description = "The Azure region, e.g. westeurope."
  type        = string
}

variable "admin_group_object_ids" {
  description = "Entra ID groups that administer the cluster."
  type        = list(string)
}

variable "api_server_authorized_ip_ranges" {
  description = "Where the cluster's API server may be reached from: your offices and the pipeline's egress."
  type        = list(string)
}

variable "kubelogin_mode" {
  description = "How kubelogin signs in to the cluster: azurecli (a person, after az login) or workloadidentity (the pipeline)."
  type        = string
  default     = "azurecli"
}

variable "workload" {
  description = "Tiles' node pool: VM size and autoscaling bounds."
  type = object({
    vm_size   = optional(string, "Standard_D4s_v5")
    min_count = optional(number, 2)
    max_count = optional(number, 6)
  })
  default = {}
}

variable "tags" {
  description = "Tags on every Azure resource."
  type        = map(string)
  default     = {}
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
