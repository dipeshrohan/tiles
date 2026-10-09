output "url" {
  description = "Where people open Tiles."
  value       = module.tiles.url
}

output "api_url" {
  description = "Where browsers and edge agents reach the API."
  value       = module.tiles.api_url
}

output "cluster" {
  description = "The AKS cluster: az aks get-credentials -g <resource_group> -n <name>, then kubelogin."
  value = {
    resource_group = module.cluster.resource_group_name
    name           = module.cluster.cluster_name
  }
}

output "backup_storage" {
  description = "pgBackRest's repository for the database's backups."
  value       = module.cluster.backup_storage
}

output "settings_secret" {
  description = "The Secret with Tiles' settings: back it up (its data key opens sealed credentials)."
  value       = module.tiles.secret_name
}
