# Tiles' managed cloud, stage 1 of 2 (T5.10): the AKS cluster, its logs and the backup storage
# (../../../modules/azure). Apply it before ../tiles, which installs Tiles on the cluster: a
# provider can't be configured from a cluster made in the same run (plan and destroy would need it
# before it exists, or after it's gone).

terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
  }
  # State in a storage account: encrypted at rest, versioned, readable only by the operators.
  # `terraform init -backend-config=../backend.hcl -backend-config="key=<name>-cluster.tfstate"`.
  backend "azurerm" {
    use_azuread_auth = true
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}

module "cluster" {
  source                          = "../../../modules/azure"
  name                            = var.name
  location                        = var.location
  admin_group_object_ids          = var.admin_group_object_ids
  api_server_authorized_ip_ranges = var.api_server_authorized_ip_ranges
  workload                        = var.workload
  tags                            = var.tags
}
