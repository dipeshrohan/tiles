# The Azure module's plan, with a mock provider: no subscription needed (terraform test).

mock_provider "azurerm" {
  # Ids as Azure gives them: the provider parses them.
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-tiles-eu1" }
  }
  mock_resource "azurerm_log_analytics_workspace" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-tiles-eu1/providers/Microsoft.OperationalInsights/workspaces/log-tiles-eu1" }
  }
  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-tiles-eu1/providers/Microsoft.ContainerService/managedClusters/aks-tiles-eu1"
      kube_config = [{
        host                   = "https://aks-tiles-eu1.hcp.westeurope.azmk8s.io:443"
        cluster_ca_certificate = "Y2E="
      }]
    }
  }
  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-tiles-eu1/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-tiles-eu1"
      principal_id = "00000000-0000-0000-0000-000000000005"
      client_id    = "00000000-0000-0000-0000-000000000004"
    }
  }
  mock_resource "azurerm_storage_container" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-tiles-eu1/providers/Microsoft.Storage/storageAccounts/tileseu1bk000000/blobServices/default/containers/pgbackrest" }
  }
  mock_resource "azurerm_storage_account" {
    defaults = { id = "/subscriptions/00000000-0000-0000-0000-000000000002/resourceGroups/rg-tiles-eu1/providers/Microsoft.Storage/storageAccounts/tileseu1bk000000" }
  }
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-0000-0000-000000000001"
      subscription_id = "00000000-0000-0000-0000-000000000002"
    }
  }
}

variables {
  name                            = "tiles-eu1"
  location                        = "westeurope"
  admin_group_object_ids          = ["00000000-0000-0000-0000-000000000003"]
  api_server_authorized_ip_ranges = ["203.0.113.0/24"]
}

run "a_locked_down_cluster" {
  command = apply

  assert {
    condition     = azurerm_kubernetes_cluster.tiles.local_account_disabled && azurerm_kubernetes_cluster.tiles.azure_active_directory_role_based_access_control[0].azure_rbac_enabled
    error_message = "Sign-in through Entra ID only, with Azure RBAC."
  }
  assert {
    condition     = azurerm_kubernetes_cluster.tiles.api_server_access_profile[0].authorized_ip_ranges == toset(["203.0.113.0/24"])
    error_message = "The API server is reachable from the given ranges only."
  }
  assert {
    condition     = azurerm_kubernetes_cluster.tiles.network_profile[0].network_policy == "cilium"
    error_message = "NetworkPolicies are enforced (the chart's need it)."
  }
  assert {
    condition     = azurerm_kubernetes_cluster.tiles.network_profile[0].advanced_networking[0].security_enabled
    error_message = "Cilium's DNS proxy is on, for the chart's egress allowlist by host name."
  }
  assert {
    condition     = azurerm_kubernetes_cluster.tiles.oidc_issuer_enabled && azurerm_kubernetes_cluster.tiles.workload_identity_enabled
    error_message = "Workload identity is on."
  }
  assert {
    condition     = azurerm_kubernetes_cluster.tiles.default_node_pool[0].only_critical_addons_enabled
    error_message = "Tiles runs on the workload pool, not the system one."
  }
  assert {
    condition     = azurerm_kubernetes_cluster_node_pool.workload.auto_scaling_enabled && azurerm_kubernetes_cluster_node_pool.workload.min_count == 2 && azurerm_kubernetes_cluster_node_pool.workload.max_count == 6
    error_message = "The workload pool scales between its bounds."
  }
}

run "backups_kept_private_and_recoverable" {
  command = apply

  assert {
    condition     = azurerm_storage_account.backups.min_tls_version == "TLS1_2" && azurerm_storage_account.backups.https_traffic_only_enabled && !azurerm_storage_account.backups.allow_nested_items_to_be_public
    error_message = "Backups only over TLS 1.2+, never public."
  }
  assert {
    condition     = azurerm_storage_account.backups.account_replication_type == "GZRS"
    error_message = "Backups survive the loss of a zone and of the region."
  }
  assert {
    condition     = azurerm_storage_account.backups.blob_properties[0].versioning_enabled && azurerm_storage_account.backups.blob_properties[0].delete_retention_policy[0].days == 35
    error_message = "Overwritten or deleted backup files can be recovered for 35 days."
  }
  assert {
    condition     = azurerm_storage_container.backups.container_access_type == "private"
    error_message = "The backup container is private."
  }
  assert {
    condition     = !azurerm_storage_account.backups.shared_access_key_enabled && azurerm_storage_account.backups.default_to_oauth_authentication
    error_message = "No account keys: Entra ID sign-in only."
  }
  assert {
    condition     = azurerm_role_assignment.backups.scope == azurerm_storage_container.backups.id && azurerm_role_assignment.backups.principal_id == azurerm_user_assigned_identity.kubelet.principal_id && azurerm_kubernetes_cluster.tiles.kubelet_identity[0].object_id == azurerm_user_assigned_identity.kubelet.principal_id
    error_message = "The nodes' identity may write the backups' container, and nothing broader."
  }
  assert {
    condition     = can(regex("^[a-z0-9]{3,24}$", azurerm_storage_account.backups.name))
    error_message = "The storage account's name is valid in Azure."
  }
  assert {
    condition     = azurerm_kubernetes_cluster.tiles.default_node_pool[0].temporary_name_for_rotation != null && azurerm_kubernetes_cluster_node_pool.workload.temporary_name_for_rotation != null
    error_message = "A new VM size rotates the pools through temporary ones, not all at once."
  }
}

run "no_open_api_server" {
  command = plan
  variables {
    api_server_authorized_ip_ranges = ["0.0.0.0/0"]
  }
  expect_failures = [var.api_server_authorized_ip_ranges]
}

run "an_admin_group_is_needed" {
  command = plan
  variables {
    admin_group_object_ids = []
  }
  expect_failures = [var.admin_group_object_ids]
}

run "a_long_name_keeps_the_storage_names_unique_part" {
  command = plan
  variables {
    name = "tilescustomerplanteu1"
  }
  assert {
    condition     = length(azurerm_storage_account.backups.name) <= 24 && can(regex("bk[0-9a-f]{8}$", azurerm_storage_account.backups.name))
    error_message = "All 8 hex of the unique part stay, however long the name."
  }
}

run "a_name_ending_in_a_dash_is_refused" {
  command = plan
  variables {
    name = "tiles-eu-"
  }
  expect_failures = [var.name]
}
