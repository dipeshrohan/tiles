# Tiles on a Kubernetes cluster the customer runs (T5.10): the reference install for a site that
# keeps everything in its own data centre. Only Tiles itself (../../modules/tiles): the cluster,
# its ingress controller, certificates and backups are the customer's. See ../../README.md.

terraform {
  required_version = ">= 1.9"
  required_providers {
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
  # Keep the state somewhere encrypted and private: it holds the generated data key. Replace this
  # with your backend (S3, azurerm, gcs, a Terraform server's).
  backend "local" {}
}

provider "kubernetes" {
  config_path    = var.kubeconfig
  config_context = var.kube_context
}

provider "helm" {
  kubernetes = {
    config_path    = var.kubeconfig
    config_context = var.kube_context
  }
}

module "tiles" {
  source    = "../../modules/tiles"
  namespace = var.namespace
  image_tag = var.image_tag
  url       = var.url
  api_url   = var.api_url
  oidc      = var.oidc
  # Your own TimescaleDB, or (null) the chart's single database pod on your storage class.
  database_url = var.database_url
  database_storage = {
    size          = var.database_size
    storage_class = var.storage_class
  }
  existing_secret = var.existing_secret
  ingress = {
    class_name = var.ingress_class
    tls_secret = var.tls_secret
  }
  smtp          = var.smtp
  smtp_password = var.smtp_password
  monitoring    = var.monitoring
}
