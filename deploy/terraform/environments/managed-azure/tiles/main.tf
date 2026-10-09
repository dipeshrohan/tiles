# Tiles' managed cloud, stage 2 of 2 (T5.10): Tiles on the cluster ../cluster made
# (../../../modules/tiles), read here as it exists. The database is TimescaleDB in the cluster, on
# zone-redundant premium SSD. Give the secrets as TF_VAR_… in the pipeline, and keep the state in
# the encrypted backend below: unless existing_secret is set, it holds the data key.

terraform {
  required_version = ">= 1.9"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.7"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 3.3"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 3.2"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
  backend "azurerm" {
    use_azuread_auth = true
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}

# The cluster as stage 1 left it (modules/azure names it after `name`).
data "azurerm_kubernetes_cluster" "tiles" {
  name                = "aks-${var.name}"
  resource_group_name = "rg-${var.name}"
}

# It has no local accounts: sign in to it through Entra ID with kubelogin, as whoever runs
# Terraform (az login, or the pipeline's workload identity).
locals {
  kube = {
    host                   = data.azurerm_kubernetes_cluster.tiles.kube_config[0].host
    cluster_ca_certificate = base64decode(data.azurerm_kubernetes_cluster.tiles.kube_config[0].cluster_ca_certificate)
    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "kubelogin"
      args        = ["get-token", "--login", var.kubelogin_mode, "--server-id", "6dae42f8-4368-4678-94ff-3960e28e3630"]
    }
  }
}

provider "kubernetes" {
  host                   = local.kube.host
  cluster_ca_certificate = local.kube.cluster_ca_certificate
  exec {
    api_version = local.kube.exec.api_version
    command     = local.kube.exec.command
    args        = local.kube.exec.args
  }
}

provider "helm" {
  kubernetes = local.kube
}

# Zone-redundant premium SSD (AKS's managed-csi-premium is zonal: a zone's loss would strand the
# database). Retain: deleting the claim keeps the disk.
resource "kubernetes_storage_class_v1" "database" {
  metadata {
    name = "tiles-premium-zrs"
  }
  storage_provisioner    = "disk.csi.azure.com"
  reclaim_policy         = "Retain"
  volume_binding_mode    = "WaitForFirstConsumer"
  allow_volume_expansion = true
  parameters = {
    skuName = "Premium_ZRS"
  }
}

module "tiles" {
  source    = "../../../modules/tiles"
  image_tag = var.image_tag
  url       = var.url
  api_url   = var.api_url
  oidc      = var.oidc
  database_storage = {
    size          = var.database_size
    storage_class = kubernetes_storage_class_v1.database.metadata[0].name
  }
  existing_secret  = var.existing_secret
  database_bundled = var.existing_secret == null ? null : true
  redis_bundled    = var.existing_secret == null ? null : true
  data_keys        = var.data_keys
  ingress = {
    class_name = "webapprouting.kubernetes.azure.com" # AKS's managed NGINX
    tls_secret = var.tls_secret
  }
  smtp              = var.smtp
  smtp_password     = var.smtp_password
  copilot_model     = var.copilot_model
  anthropic_api_key = var.anthropic_api_key
  monitoring        = var.monitoring
}
