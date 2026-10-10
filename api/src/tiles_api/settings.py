"""Typed configuration, read from TILES_* environment variables or api/.env, and from files in
TILES_SECRETS_DIR (T5.06): a secret manager's mounted secrets (Docker or Kubernetes secrets, a
Vault agent), one file per setting, named as its variable (`tiles_data_keys`, any case)."""

import os
from functools import lru_cache
from typing import Literal, Self

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TILES_", env_file=".env", extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    host: str = "127.0.0.1"
    port: int = 8000
    # API processes (T5.15): each has its own pool of `db_pool_max` connections, so the database
    # sees up to workers x db_pool_max of them per API instance.
    workers: int = Field(default=1, ge=1, le=64)
    cors_origins: list[str] = ["http://localhost:5173"]
    database_url: SecretStr = SecretStr("postgresql://tiles:tiles-dev@localhost:5432/tiles")  # holds a password
    redis_url: str = "redis://localhost:6379/0"
    # Seconds each readiness check may take before it counts as unavailable.
    ready_timeout: float = 2.0
    db_pool_max: int = 10
    db_wait_seconds: float = 10.0  # a request waits this long for a connection, then gets a 503
    db_side_pool_max: int = 4  # connections for streaming copilot answers and sweeps (store.side_pool)
    # Single sign-on (OpenID Connect). Off when oidc_issuer is unset.
    # oidc_issuer must match the tokens' `iss` claim (the URL browsers use).
    oidc_issuer: str | None = None
    # Where the API fetches signing keys; discovered from the issuer if unset.
    # Set it when the API reaches the provider by another address (Compose).
    oidc_jwks_url: str | None = None
    # Tokens must name this audience; the browser signs in as oidc_client_id.
    oidc_audience: str = "tiles-api"
    oidc_client_id: str = "tiles-web"
    # Organisation for users whose token carries no `tiles_org` claim.
    oidc_default_org: str = "demo"
    # Outside production, requests without a token act as this user, or as
    # the email in an X-Tiles-User header. Never in production.
    dev_user_email: str = "demo@example.com"
    dev_user_name: str = "Demo User"
    # Notifications (T3.09). Email goes out by SMTP when smtp_host is set; links point at app_url.
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_starttls: bool = True
    smtp_user: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from: str = "Tiles <tiles@example.com>"
    app_url: str = "http://localhost:5173"
    # Data keys that seal credentials stored in the database (T5.06, sealed.py): `id:base64key`,
    # comma-separated, the first sealing. Required in production. `tiles-rotate-keys --new-key ID`
    # makes one.
    data_keys: SecretStr | None = None
    # Models served over HTTP (T4.15, models/remote.py): the hosts an organisation may register a
    # model endpoint on, as a JSON list (e.g. ["models.example.com"]); none, and none can be. The
    # chart's egress allowlist takes them too. Each call may take `model_timeout` seconds.
    model_hosts: list[str] = []
    model_timeout: float = Field(default=10.0, gt=0, le=120)
    # The copilot (T4.01): Claude through the Anthropic API. Off until both are set; the model is a
    # current Claude model ID from Anthropic's documentation.
    anthropic_api_key: SecretStr | None = None
    copilot_model: str | None = None
    copilot_max_tokens: int = 2048  # per model call
    copilot_max_rounds: int = 8  # model calls per question (each tool round is one)
    # Cost controls (T4.07), in billed tokens: input, cache writes and output count in full, cache
    # reads a tenth (copilot_usage.billed). 0 turns a limit off.
    copilot_question_tokens: int = 200_000  # one question stops calling the model past this
    copilot_org_daily_tokens: int = 5_000_000  # an organisation's questions wait for the next UTC day
    copilot_org_questions_per_minute: int = 30
    copilot_user_questions_per_minute: int = 6

    @model_validator(mode="after")
    def _keys(self) -> Self:
        from tiles_api.sealed import DataKeys

        keys = DataKeys.parse(self.data_keys.get_secret_value() if self.data_keys else None)  # malformed: refused
        if keys is None and self.env == "production":
            raise ValueError(
                "Set TILES_DATA_KEYS in production: credentials stored in the database are sealed with it"
                " (tiles-rotate-keys --new-key k1 makes one)"
            )
        return self


@lru_cache
def get_settings() -> Settings:
    secrets = os.environ.get("TILES_SECRETS_DIR")
    return Settings(_secrets_dir=secrets) if secrets else Settings()
