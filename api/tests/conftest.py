import pytest
from fastapi.testclient import TestClient

from tiles_api.main import create_app
from tiles_api.settings import Settings


@pytest.fixture
def settings() -> Settings:
    return Settings(env="test", log_level="INFO", cors_origins=["http://localhost:5173"])


@pytest.fixture
def client(settings: Settings) -> TestClient:
    return TestClient(create_app(settings))
