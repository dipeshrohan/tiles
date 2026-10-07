"""The agent's single configuration file (TOML).

    [tiles]
    url = "https://tiles.example.com"      # the Tiles API; HTTPS unless it is this machine
    token_file = "/etc/tiles-edge/token"   # or set TILES_EDGE_TOKEN
    ca_file = "/etc/tiles-edge/ca.pem"     # optional: trust this CA too (e.g. a TLS-inspecting proxy)

    [agent]
    heartbeat_seconds = 30

Relative paths are resolved against the config file's folder.
"""

import os
import ssl
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

TOKEN_ENV = "TILES_EDGE_TOKEN"  # noqa: S105 - the variable's name, not a secret
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


class ConfigError(Exception):
    """The configuration is missing, unreadable or invalid. The message says which and how to fix it."""


@dataclass(frozen=True)
class Config:
    url: str
    token: str
    ca_file: Path | None
    heartbeat_seconds: int
    timeout_seconds: float


def _table(data: dict[str, Any], name: str) -> dict[str, Any]:
    table = data.get(name, {})
    if not isinstance(table, dict):
        raise ConfigError(f"[{name}] must be a table")
    return table


def _known(table: dict[str, Any], name: str, keys: set[str]) -> None:
    unknown = sorted(set(table) - keys)
    if unknown:
        raise ConfigError(f"unknown setting(s) in [{name}]: {', '.join(unknown)}")


def _url(raw: object) -> str:
    if not isinstance(raw, str) or not raw:
        raise ConfigError('[tiles] url is required, e.g. url = "https://tiles.example.com"')
    parts = urlsplit(raw)
    try:
        parts.port  # noqa: B018 - urlsplit checks the port only when it is read
    except ValueError:
        raise ConfigError(f"[tiles] url has an invalid port: {raw!r}") from None
    if parts.scheme not in {"https", "http"} or not parts.hostname:
        raise ConfigError(f"[tiles] url must be an http(s) URL, not {raw!r}")
    if parts.scheme == "http" and parts.hostname not in LOCAL_HOSTS:
        raise ConfigError(
            "[tiles] url must use https: the agent only sends plant data over TLS "
            "(plain http is allowed for localhost, for development)"
        )
    if parts.query or parts.fragment:
        raise ConfigError("[tiles] url must not have a query or fragment")
    return raw.rstrip("/")


def _token(tiles: dict[str, Any], base: Path, env: dict[str, str]) -> str:
    if env.get(TOKEN_ENV):
        token = env[TOKEN_ENV]
    elif "token_file" in tiles:
        path = base / str(tiles["token_file"])
        try:
            token = path.read_text().strip()
        except PermissionError:
            raise ConfigError(
                f"can't read the token file {path}: permission denied for this user (uid {os.getuid()}); "
                "give it the file (chown) or set TILES_EDGE_TOKEN instead"
            ) from None
        except OSError as e:
            raise ConfigError(f"can't read the token file {path}: {e.strerror}") from None
    else:
        raise ConfigError(f"no agent token: set [tiles] token_file or the {TOKEN_ENV} environment variable")
    if not token.startswith("tla_"):
        raise ConfigError("the agent token should start with tla_; register the agent in Tiles to get one")
    return token


def load(path: Path, env: dict[str, str] | None = None) -> Config:
    env = dict(os.environ) if env is None else env
    try:
        data = tomllib.loads(path.read_text())
    except OSError as e:
        raise ConfigError(f"can't read {path}: {e.strerror}") from None
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path} is not valid TOML: {e}") from None
    _known(data, "top level", {"tiles", "agent"})
    tiles, agent = _table(data, "tiles"), _table(data, "agent")
    _known(tiles, "tiles", {"url", "token_file", "ca_file", "timeout_seconds"})
    _known(agent, "agent", {"heartbeat_seconds"})
    base = path.parent

    ca_file = None
    if tiles.get("ca_file"):
        ca_file = base / str(tiles["ca_file"])
        if not ca_file.is_file():
            raise ConfigError(f"[tiles] ca_file {ca_file} doesn't exist")
        try:
            ssl.create_default_context().load_verify_locations(cafile=str(ca_file))
        except (ssl.SSLError, OSError) as e:
            raise ConfigError(f"[tiles] ca_file {ca_file} holds no usable PEM certificate: {e}") from None

    heartbeat = agent.get("heartbeat_seconds", 30)
    if not isinstance(heartbeat, int) or isinstance(heartbeat, bool) or not 5 <= heartbeat <= 3600:
        raise ConfigError("[agent] heartbeat_seconds must be a whole number from 5 to 3600")
    timeout = tiles.get("timeout_seconds", 10)
    if not isinstance(timeout, int | float) or isinstance(timeout, bool) or not 1 <= timeout <= 120:
        raise ConfigError("[tiles] timeout_seconds must be a number from 1 to 120")

    return Config(
        url=_url(tiles.get("url")),
        token=_token(tiles, base, env),
        ca_file=ca_file,
        heartbeat_seconds=heartbeat,
        timeout_seconds=float(timeout),
    )
