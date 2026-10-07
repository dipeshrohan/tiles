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
    # Until single sign-on (T1.16), requests act as this user, or as the email
    # in an X-Tiles-User header. Refused when env is "production".
    dev_user_email: str = "demo@example.com"
    dev_user_name: str = "Demo User"


@lru_cache
def get_settings() -> Settings:
    return Settings()
