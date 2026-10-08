"""Typed configuration, read from TILES_* environment variables or api/.env."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TILES_", env_file=".env", extra="ignore")

    env: Literal["development", "test", "production"] = "development"
    log_level: str = "INFO"
    host: str = "127.0.0.1"
    port: int = 8000
    cors_origins: list[str] = ["http://localhost:5173"]
    database_url: str = "postgresql://tiles:tiles-dev@localhost:5432/tiles"
    redis_url: str = "redis://localhost:6379/0"
    # Seconds each readiness check may take before it counts as unavailable.
    ready_timeout: float = 2.0
    db_pool_max: int = 10
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
    smtp_password: str | None = None
    smtp_from: str = "Tiles <tiles@example.com>"
    app_url: str = "http://localhost:5173"


@lru_cache
def get_settings() -> Settings:
    return Settings()
