variable "name" {
  description = "A short name for this Tiles installation (e.g. tiles-eu1): resources are named after it."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.name))
    error_message = "name is 3 to 21 lower-case letters, digits and dashes, starting with a letter."
  }
}

variable "location" {
  description = "The Azure region, e.g. westeurope."
  type        = string
}

variable "tags" {
  description = "Tags on every resource."
  type        = map(string)
  default     = {}
}

variable "kubernetes_version" {
  description = "AKS version (null: the region's default). Patch versions follow automatically."
  type        = string
  default     = null
}

variable "admin_group_object_ids" {
  description = "Entra ID groups whose members administer the cluster (Azure RBAC; there are no local accounts)."
  type        = list(string)
  validation {
    condition     = length(var.admin_group_object_ids) > 0
    error_message = "Name at least one admin group: the cluster has no local accounts to fall back on."
  }
}

variable "api_server_authorized_ip_ranges" {
  description = "Where the cluster's API server may be reached from (CIDRs): your offices and CI."
  type        = list(string)
  validation {
    condition     = length(var.api_server_authorized_ip_ranges) > 0 && !contains(var.api_server_authorized_ip_ranges, "0.0.0.0/0")
    error_message = "Limit the API server to known ranges, not 0.0.0.0/0."
  }
}

variable "system_vm_size" {
  description = "VM size of the system node pool (cluster add-ons)."
  type        = string
  default     = "Standard_D2s_v5"
}

variable "workload" {
  description = "The node pool Tiles runs on: VM size and autoscaling bounds. 4 cores per API pod with 2 workers met the load test (docs/load-test.md)."
  type = object({
    vm_size   = optional(string, "Standard_D4s_v5")
    min_count = optional(number, 2)
    max_count = optional(number, 6)
  })
  default = {}
  validation {
    condition     = var.workload.min_count >= 1 && var.workload.max_count >= var.workload.min_count
    error_message = "workload needs 1 <= min_count <= max_count."
  }
}

variable "zones" {
  description = "Availability zones for the nodes (empty in a region without zones)."
  type        = list(string)
  default     = ["1", "2", "3"]
}

variable "log_retention_days" {
  description = "How long the cluster's logs are kept."
  type        = number
  default     = 30
}

variable "backup_retention_days" {
  description = "How long deleted or overwritten backup files can be recovered (35 days of point-in-time recovery: docs/runbooks/backups.md)."
  type        = number
  default     = 35
}
