output "url" {
  description = "Where people open Tiles."
  value       = module.tiles.url
}

output "api_url" {
  description = "Where browsers and edge agents reach the API."
  value       = module.tiles.api_url
}

output "settings_secret" {
  description = "The Secret with Tiles' settings: back it up (its data key opens sealed credentials)."
  value       = module.tiles.secret_name
}
