# One Tiles installation in Tiles' managed cloud (T5.10): an AKS cluster with its logs and backup
# storage (../../modules/azure), and Tiles on it (../../modules/tiles), the database in the
# cluster on premium SSD. Copy terraform.tfvars.example, give the secrets as TF_VAR_… in the
# pipeline, and keep the state in the encrypted backend below: it holds the generated data key.

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
  # State in a storage account: encrypted at rest, versioned, readable only by the operators.
  # Its name and key come with `terraform init -backend-config=backend.hcl`.
  backend "azurerm" {
    use_azuread_auth = true
  }
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}

# The cluster has no local accounts: sign in to it through Entra ID with kubelogin, as whoever runs
# Terraform (az login, or the pipeline's workload identity).
locals {
  kube_exec = {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "kubelogin"
    args        = ["get-token", "--login", var.kubelogin_mode, "--server-id", "6dae42f8-4368-4678-94ff-3960e28e3630"]
  }
}

provider "kubernetes" {
  host                   = module.cluster.kubernetes_host
  cluster_ca_certificate = module.cluster.kubernetes_ca_certificate
  exec {
    api_version = local.kube_exec.api_version
    command     = local.kube_exec.command
    args        = local.kube_exec.args
  }
}

provider "helm" {
  kubernetes = {
    host                   = module.cluster.kubernetes_host
    cluster_ca_certificate = module.cluster.kubernetes_ca_certificate
    exec                   = local.kube_exec
  }
}

module "cluster" {
  source                          = "../../modules/azure"
  name                            = var.name
  location                        = var.location
  admin_group_object_ids          = var.admin_group_object_ids
  api_server_authorized_ip_ranges = var.api_server_authorized_ip_ranges
  workload                        = var.workload
  tags                            = var.tags
}

module "tiles" {
  source    = "../../modules/tiles"
  image_tag = var.image_tag
  url       = var.url
  api_url   = var.api_url
  oidc      = var.oidc
  database_storage = {
    size          = var.database_size
    storage_class = module.cluster.storage_class
  }
  ingress = {
    class_name = module.cluster.ingress_class
    tls_secret = var.tls_secret
  }
  smtp              = var.smtp
  smtp_password     = var.smtp_password
  copilot_model     = var.copilot_model
  anthropic_api_key = var.anthropic_api_key
  monitoring        = var.monitoring
}
