# The tiles module's plan, with mock providers: no cluster needed (terraform test).

mock_provider "helm" {}
mock_provider "kubernetes" {}
mock_provider "random" {
  mock_resource "random_bytes" {
    defaults = { base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
  }
}

variables {
  image_tag = "1.2.3"
  url       = "https://tiles.example.com"
  api_url   = "https://api.tiles.example.com"
  oidc      = { issuer = "https://idp.example.com/realms/tiles" }
}

# The generated key is never destroyed (prevent_destroy), so the runs that make one only plan.
run "bundled_database_and_a_generated_key" {
  command = plan
  override_resource {
    target          = random_bytes.data_key
    override_during = plan
    values          = { base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
  }

  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).database.bundled && yamldecode(helm_release.tiles.values[0]).redis.bundled
    error_message = "Without database_url and redis_url, the chart's own run."
  }
  assert {
    condition     = nonsensitive(join(",", sort(keys(kubernetes_secret_v1.settings[0].data)))) == "tiles_data_keys"
    error_message = "The Secret holds the data key only (the chart makes the bundled database's)."
  }
  assert {
    condition     = startswith(nonsensitive(kubernetes_secret_v1.settings[0].data.tiles_data_keys), "k1:")
    error_message = "The generated key is id:base64key, with the default id."
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).secrets.existingSecret == "tiles-settings" && !yamldecode(helm_release.tiles.values[0]).secrets.generateDataKey
    error_message = "The chart reads the module's Secret, and makes no key of its own."
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).images.api.tag == "1.2.3" && yamldecode(helm_release.tiles.values[0]).env == "production"
    error_message = "The pinned release runs in production."
  }
  assert {
    condition     = kubernetes_namespace_v1.tiles[0].metadata[0].labels["pod-security.kubernetes.io/enforce"] == "restricted"
    error_message = "The namespace enforces the restricted Pod Security Standard."
  }
  assert {
    condition     = helm_release.tiles.atomic && helm_release.tiles.wait
    error_message = "A failed upgrade rolls back."
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).images.api.repository == "ghcr.io/dipeshrohan/tiles-api" && yamldecode(helm_release.tiles.values[0]).images.web.repository == "ghcr.io/dipeshrohan/tiles-web"
    error_message = "The images come from the published registry by default."
  }
  assert {
    condition     = !issensitive(helm_release.tiles.values[0])
    error_message = "The chart's values are readable in the plan (they hold no secret)."
  }
}

run "external_database_redis_and_mail" {
  command = apply
  variables {
    database_url     = "postgresql://tiles:secret@db.example.com:5432/tiles?sslmode=require"
    redis_url        = "rediss://:secret@redis.example.com:6380/0"
    data_keys        = "k2:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=,k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    smtp             = { host = "smtp.example.com", user = "tiles" }
    smtp_password    = "mail-secret"
    create_namespace = false
  }

  assert {
    condition     = !yamldecode(helm_release.tiles.values[0]).database.bundled && !yamldecode(helm_release.tiles.values[0]).redis.bundled
    error_message = "Given URLs, the chart's database and Redis are off."
  }
  assert {
    condition     = nonsensitive(join(",", sort(keys(kubernetes_secret_v1.settings[0].data)))) == "tiles_data_keys,tiles_database_url,tiles_redis_url,tiles_smtp_password"
    error_message = "Every secret given is in the Secret, and nothing else."
  }
  assert {
    condition     = nonsensitive(kubernetes_secret_v1.settings[0].data.tiles_data_keys) == var.data_keys
    error_message = "Given data keys are used as they are (no key generated)."
  }
  assert {
    condition     = length(random_bytes.data_key) == 0 && length(kubernetes_namespace_v1.tiles) == 0
    error_message = "No key generated, and the existing namespace is used."
  }
  assert {
    condition     = !strcontains(helm_release.tiles.values[0], "secret@")
    error_message = "No secret reaches the chart's values: only the Secret holds them."
  }
}

run "a_fingerprint_of_the_settings" {
  command = apply
  variables {
    data_keys     = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    smtp_password = "first"
  }
  assert {
    condition     = length(output.settings_revision) == 12 && yamldecode(helm_release.tiles.values[0]).secrets.revision == output.settings_revision
    error_message = "The chart's revision is a short fingerprint of the settings."
  }
}

run "a_changed_secret_restarts_the_api" {
  command = apply
  variables {
    data_keys     = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    smtp_password = "second"
  }
  assert {
    condition     = output.settings_revision != run.a_fingerprint_of_the_settings.settings_revision
    error_message = "A new password gives the chart a new revision, which restarts the API."
  }
}

run "an_existing_secret_keeps_secrets_out_of_terraform" {
  command = apply
  variables {
    existing_secret  = "tiles-from-vault"
    database_bundled = false
    redis_bundled    = true
  }
  assert {
    condition     = length(kubernetes_secret_v1.settings) == 0 && length(random_bytes.data_key) == 0
    error_message = "With existing_secret, Terraform makes no Secret and no key."
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).secrets.existingSecret == "tiles-from-vault" && !yamldecode(helm_release.tiles.values[0]).database.bundled && yamldecode(helm_release.tiles.values[0]).redis.bundled
    error_message = "The chart reads the given Secret, with the database and Redis as asked."
  }
}

run "an_existing_secret_with_the_bundled_database" {
  command = plan
  variables {
    existing_secret  = "tiles-from-vault"
    database_bundled = true
    redis_bundled    = true
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).database.bundled
    error_message = "Your own Secret, and the chart's database pod."
  }
}

run "an_existing_secret_needs_no_secrets_here" {
  command = plan
  variables {
    existing_secret  = "tiles-from-vault"
    database_bundled = false
    redis_bundled    = true
    database_url     = "postgresql://ignored"
  }
  expect_failures = [var.existing_secret]
}

run "an_existing_secret_says_where_the_database_is" {
  command = plan
  variables {
    existing_secret = "tiles-from-vault"
  }
  expect_failures = [var.existing_secret]
}

run "a_bundled_database_or_a_url_not_both" {
  command = plan
  variables {
    database_bundled = true
    database_url     = "postgresql://db.example.com/tiles"
    data_keys        = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  }
  expect_failures = [var.database_bundled]
}

run "production_runs_a_pinned_release" {
  command = plan
  variables {
    image_tag = "main"
  }
  expect_failures = [var.image_tag]
}

run "urls_are_origins" {
  command = plan
  variables {
    api_url = "https://tiles.example.com/api"
  }
  expect_failures = [var.api_url]
}

run "sign_in_is_https" {
  command = plan
  variables {
    oidc = { issuer = "http://idp.example.com" }
  }
  expect_failures = [var.oidc]
}

run "images_from_a_mirror" {
  command = plan
  variables {
    data_keys = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    images    = { registry = "registry.plant.example.com/tiles/", pull_secrets = ["plant-registry"] }
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).images.api.repository == "registry.plant.example.com/tiles/tiles-api"
    error_message = "A mirror's images, without a doubled slash."
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).imagePullSecrets == [{ name = "plant-registry" }]
    error_message = "Pulled with the given Secret."
  }
  assert {
    condition     = !can(yamldecode(helm_release.tiles.values[0]).database.image) && !can(yamldecode(helm_release.tiles.values[0]).redis.image)
    error_message = "Without overrides, the chart's database and Redis images."
  }
}

run "the_database_and_redis_from_the_mirror_too" {
  command = plan
  variables {
    data_keys = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    images = {
      registry = "registry.plant.example.com/tiles"
      database = "registry.plant.example.com/tiles/timescaledb:2.30.2-pg17"
      redis    = "registry.plant.example.com/tiles/redis:7.4-alpine"
    }
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).database.image == "registry.plant.example.com/tiles/timescaledb:2.30.2-pg17" && yamldecode(helm_release.tiles.values[0]).database.bundled
    error_message = "The bundled database's image from the mirror."
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).redis.image == "registry.plant.example.com/tiles/redis:7.4-alpine"
    error_message = "Redis's image from the mirror."
  }
}

run "images_given_as_null_take_the_defaults" {
  command = plan
  variables {
    data_keys = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    images    = null
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).images.api.repository == "ghcr.io/dipeshrohan/tiles-api"
    error_message = "An environment passing null gets the module's defaults (one source of them)."
  }
}

run "a_namespace_made_beforehand_is_labelled" {
  command = plan
  variables {
    data_keys        = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    create_namespace = false
  }
  assert {
    condition     = length(kubernetes_namespace_v1.tiles) == 0 && kubernetes_labels.namespace[0].labels["pod-security.kubernetes.io/enforce"] == "restricted"
    error_message = "Terraform labels the namespace it didn't make."
  }
}

run "null_image_settings_take_the_defaults" {
  command = plan
  variables {
    data_keys = "k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    # As an environment passes them: attributes it wasn't given are null.
    images = { registry = "", pull_policy = "Never", pull_secrets = null, database = null, redis = null }
  }
  assert {
    condition     = yamldecode(helm_release.tiles.values[0]).imagePullSecrets == [] && yamldecode(helm_release.tiles.values[0]).images.api.repository == "tiles-api"
    error_message = "Null pull_secrets is none; an empty registry is the cluster's own images."
  }
}
