output "namespace" {
  description = "Where Tiles runs."
  value       = var.namespace
}

output "release_name" {
  description = "The Helm release."
  value       = helm_release.tiles.name
}

output "secret_name" {
  description = "The Secret holding Tiles' settings. Back it up: its tiles_data_keys open the sealed credentials."
  value       = local.secret_name
}

output "url" {
  description = "Where people open Tiles."
  value       = var.url
}

output "api_url" {
  description = "Where browsers and edge agents reach the API."
  value       = var.api_url
}

output "settings_revision" {
  description = "A fingerprint of the settings in the Secret (empty with existing_secret): it changes when one does."
  value       = local.revision
}
