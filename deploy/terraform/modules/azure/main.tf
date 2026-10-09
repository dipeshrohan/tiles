# Tiles' managed cloud on Azure (T5.10): an AKS cluster to run the chart on (../tiles), its logs,
# and storage for the database's backups (pgBackRest's repository: docs/runbooks/backups.md).
#
# The database is TimescaleDB in the cluster, on premium SSD, rather than Azure's managed
# PostgreSQL: Tiles' readings use TimescaleDB's columnstore and retention policies, which the
# managed service's TimescaleDB (the Apache edition) doesn't have.

data "azurerm_client_config" "current" {}

locals {
  # Storage account names: 3 to 24 lower-case letters and digits, unique across Azure. Up to 14 of
  # the name, "bk", and 8 hex of the subscription and name: never cut short.
  storage_name = "${substr(replace(var.name, "-", ""), 0, 14)}bk${substr(sha256("${data.azurerm_client_config.current.subscription_id}/${var.name}"), 0, 8)}"
  tags         = merge({ "app" = "tiles", "tiles-installation" = var.name }, var.tags)
}

resource "azurerm_resource_group" "tiles" {
  name     = "rg-${var.name}"
  location = var.location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "tiles" {
  name                = "log-${var.name}"
  location            = azurerm_resource_group.tiles.location
  resource_group_name = azurerm_resource_group.tiles.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

# The cluster's identities, ours rather than ones AKS makes: the control plane's, and the nodes'
# (kubelet), which pulls images and, through pgBackRest, writes the database's backups.
resource "azurerm_user_assigned_identity" "control_plane" {
  name                = "id-${var.name}-aks"
  location            = azurerm_resource_group.tiles.location
  resource_group_name = azurerm_resource_group.tiles.name
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "kubelet" {
  name                = "id-${var.name}-nodes"
  location            = azurerm_resource_group.tiles.location
  resource_group_name = azurerm_resource_group.tiles.name
  tags                = local.tags
}

# AKS's control plane assigns the nodes' identity to them.
resource "azurerm_role_assignment" "control_plane_assigns_kubelet" {
  scope                = azurerm_user_assigned_identity.kubelet.id
  role_definition_name = "Managed Identity Operator"
  principal_id         = azurerm_user_assigned_identity.control_plane.principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_kubernetes_cluster" "tiles" {
  name                = "aks-${var.name}"
  location            = azurerm_resource_group.tiles.location
  resource_group_name = azurerm_resource_group.tiles.name
  dns_prefix          = var.name
  kubernetes_version  = var.kubernetes_version
  sku_tier            = "Standard" # the uptime SLA
  tags                = local.tags

  # Patch versions and node images follow by themselves; minor versions are ours to plan.
  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"

  # Sign-in through Entra ID only, with Azure RBAC for who may do what.
  local_account_disabled = true
  azure_active_directory_role_based_access_control {
    azure_rbac_enabled     = true
    tenant_id              = data.azurerm_client_config.current.tenant_id
    admin_group_object_ids = var.admin_group_object_ids
  }
  oidc_issuer_enabled       = true # workload identity, for what runs in the cluster to reach Azure
  workload_identity_enabled = true

  api_server_access_profile {
    authorized_ip_ranges = var.api_server_authorized_ip_ranges
  }

  default_node_pool {
    name                         = "system"
    vm_size                      = var.system_vm_size
    node_count                   = 2
    zones                        = var.zones
    only_critical_addons_enabled = true # Tiles runs on the workload pool
    # A change of VM size or zones rotates the pool through a temporary one, not the cluster.
    temporary_name_for_rotation = "systemtmp"
    upgrade_settings {
      max_surge = "33%"
    }
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.control_plane.id]
  }

  kubelet_identity {
    client_id                 = azurerm_user_assigned_identity.kubelet.client_id
    object_id                 = azurerm_user_assigned_identity.kubelet.principal_id
    user_assigned_identity_id = azurerm_user_assigned_identity.kubelet.id
  }

  # Node pools as declared here (not node auto-provisioning).
  node_provisioning_profile {
    mode = "Manual"
  }

  # The chart's NetworkPolicies need a CNI that enforces them.
  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    load_balancer_sku   = "standard"
    # Advanced Container Networking Services' security: Cilium's DNS proxy, for the chart's
    # egress allowlist by host name (docs/hybrid.md).
    dynamic "advanced_networking" {
      for_each = var.fqdn_policies ? [1] : []
      content {
        security_enabled      = true
        observability_enabled = false
      }
    }
  }

  # An NGINX ingress controller managed by AKS: the chart's ingress uses its class.
  web_app_routing {
    dns_zone_ids = []
  }

  oms_agent {
    log_analytics_workspace_id      = azurerm_log_analytics_workspace.tiles.id
    msi_auth_for_monitoring_enabled = true
  }

  depends_on = [azurerm_role_assignment.control_plane_assigns_kubelet]
}

resource "azurerm_kubernetes_cluster_node_pool" "workload" {
  name                  = "workload"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.tiles.id
  vm_size               = var.workload.vm_size
  mode                  = "User"
  zones                 = var.zones
  auto_scaling_enabled  = true
  min_count             = var.workload.min_count
  max_count             = var.workload.max_count
  tags                  = local.tags
  # A change of VM size rotates the pool through a temporary one, draining its nodes one by one,
  # rather than deleting every node at once.
  temporary_name_for_rotation = "workloadtmp"
  upgrade_settings {
    max_surge = "33%"
  }
}

# The database's backups: pgBackRest's repository (full backups and the WAL archive).
resource "azurerm_storage_account" "backups" {
  name                            = local.storage_name
  location                        = azurerm_resource_group.tiles.location
  resource_group_name             = azurerm_resource_group.tiles.name
  account_tier                    = "Standard"
  account_replication_type        = "GZRS" # zone- and geo-redundant: a region's loss keeps the backups
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  # Entra ID sign-in only: no account keys to leak. pgBackRest signs in as the nodes' identity
  # (repo1-azure-key-type=auto), which may write to its container only (below).
  shared_access_key_enabled       = false
  default_to_oauth_authentication = true
  public_network_access           = "Enabled" # reached from the cluster's egress, with Entra ID only
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = var.backup_retention_days
    }
    container_delete_retention_policy {
      days = var.backup_retention_days
    }
  }
}

resource "azurerm_storage_container" "backups" {
  name                  = "pgbackrest"
  storage_account_id    = azurerm_storage_account.backups.id
  container_access_type = "private"
}

# The nodes' identity (kubelet) may read and write the backups' container, and nothing else in the
# account: pgBackRest in the database pod signs in as it.
resource "azurerm_role_assignment" "backups" {
  scope                = azurerm_storage_container.backups.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.kubelet.principal_id
  principal_type       = "ServicePrincipal"
}
