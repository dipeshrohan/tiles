output "resource_group_name" {
  description = "The resource group holding the installation."
  value       = azurerm_resource_group.tiles.name
}

output "cluster_name" {
  description = "The AKS cluster."
  value       = azurerm_kubernetes_cluster.tiles.name
}

output "cluster_id" {
  description = "The AKS cluster's resource id (for role assignments)."
  value       = azurerm_kubernetes_cluster.tiles.id
}

output "kubernetes_host" {
  description = "The cluster's API server."
  value       = azurerm_kubernetes_cluster.tiles.kube_config[0].host
  sensitive   = true
}

output "kubernetes_ca_certificate" {
  description = "The cluster's CA certificate (PEM)."
  value       = base64decode(azurerm_kubernetes_cluster.tiles.kube_config[0].cluster_ca_certificate)
  sensitive   = true
}

output "oidc_issuer_url" {
  description = "The cluster's OIDC issuer, for workload identity federation."
  value       = azurerm_kubernetes_cluster.tiles.oidc_issuer_url
}

output "ingress_class" {
  description = "The ingress class of AKS's managed NGINX."
  value       = "webapprouting.kubernetes.azure.com"
}


output "backup_storage" {
  description = "Where pgBackRest keeps the database's backups."
  value = {
    account   = azurerm_storage_account.backups.name
    container = azurerm_storage_container.backups.name
  }
}
