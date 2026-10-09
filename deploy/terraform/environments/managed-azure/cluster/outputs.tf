output "cluster" {
  description = "The AKS cluster: az aks get-credentials -g <resource_group> -n <name>, then kubelogin."
  value = {
    resource_group = module.cluster.resource_group_name
    name           = module.cluster.cluster_name
  }
}

output "backup_storage" {
  description = "pgBackRest's repository for the database's backups (repo1-azure-key-type=auto)."
  value       = module.cluster.backup_storage
}

output "oidc_issuer_url" {
  description = "The cluster's OIDC issuer, for workload identity federation."
  value       = module.cluster.oidc_issuer_url
}
