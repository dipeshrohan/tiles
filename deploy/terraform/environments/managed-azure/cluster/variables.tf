variable "subscription_id" {
  description = "The Azure subscription to install into."
  type        = string
}

variable "name" {
  description = "This installation's short name, e.g. tiles-eu1 (the same in ../tiles)."
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
