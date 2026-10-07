"""The agent's single configuration file (TOML).

    [tiles]
    url = "https://tiles.example.com"      # the Tiles API; HTTPS unless it is this machine
    token_file = "/etc/tiles-edge/token"   # or set TILES_EDGE_TOKEN
    ca_file = "/etc/tiles-edge/ca.pem"     # optional: trust this CA too (e.g. a TLS-inspecting proxy)

    [agent]
    heartbeat_seconds = 30

    [[opcua]]                              # one per OPC UA server (needs tiles-edge[opcua])
    name = "press-line"
    endpoint = "opc.tcp://10.0.0.5:4840"
    security = "Basic256Sha256-SignAndEncrypt"
    certificate = "opcua/agent.der"        # this agent's application certificate and key
    private_key = "opcua/agent.pem"        #   (tiles-edge opcua cert creates them)
    server_certificate = "opcua/server.der"  # the server's, pinned (tiles-edge opcua server-cert)

    [[opcua.signals]]
    node = "ns=2;s=Press1.Temperature"
    signal = "press1.temperature"

Relative paths are resolved against the config file's folder.
"""

import os
import re
import socket
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


# OPC UA security: policy-mode, or None (only with allow_unsecured = true).
OPCUA_POLICIES = ("Basic256Sha256", "Aes128Sha256RsaOaep", "Aes256Sha256RsaPss")
OPCUA_MODES = ("Sign", "SignAndEncrypt")
OPCUA_SECURITY = tuple(f"{p}-{m}" for p in OPCUA_POLICIES for m in OPCUA_MODES)
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$")
# Tiles signal IDs: lower case, e.g. press1.temperature
SIGNAL_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,127}$")


@dataclass(frozen=True)
class OpcUaSignal:
    node: str  # an OPC UA NodeId string, e.g. ns=2;s=Press1.Temperature
    signal: str  # the Tiles signal ID it maps to


@dataclass(frozen=True)
class OpcUaConfig:
    name: str
    endpoint: str
    security: str  # one of OPCUA_SECURITY, or "None"
    certificate: Path | None
    private_key: Path | None
    server_certificate: Path | None
    application_uri: str
    username: str | None
    password_file: Path | None
    publishing_interval_ms: int
    signals: tuple[OpcUaSignal, ...]

    @property
    def secured(self) -> bool:
        return self.security != "None"


@dataclass(frozen=True)
class Config:
    url: str
    token: str
    ca_file: Path | None
    heartbeat_seconds: int
    timeout_seconds: float
    opcua: tuple[OpcUaConfig, ...] = ()


def _table(data: dict[str, Any], name: str) -> dict[str, Any]:
    table = data.get(name, {})
    if not isinstance(table, dict):
        raise ConfigError(f"[{name}] must be a table")
    return table


def _known(table: dict[str, Any], where: str, keys: set[str]) -> None:
    unknown = sorted(set(table) - keys)
    if unknown:
        raise ConfigError(f"unknown setting(s) in {where}: {', '.join(unknown)}")


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


def _opcua(raw: object, base: Path) -> tuple[OpcUaConfig, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or not all(isinstance(t, dict) for t in raw):
        raise ConfigError("[[opcua]] must be a list of tables (write each server as [[opcua]])")
    keys = {
        "name",
        "endpoint",
        "security",
        "allow_unsecured",
        "certificate",
        "private_key",
        "server_certificate",
        "application_uri",
        "username",
        "password_file",
        "publishing_interval_ms",
        "signals",
    }
    connectors: list[OpcUaConfig] = []
    for table in raw:
        name = table.get("name")
        if not isinstance(name, str) or not NAME_PATTERN.match(name):
            raise ConfigError("each [[opcua]] needs a name: letters, digits, dot, dash or underscore; up to 63")
        where = f"[[opcua]] {name}"
        _known(table, where, keys)
        endpoint = table.get("endpoint")
        if not isinstance(endpoint, str) or urlsplit(endpoint).scheme != "opc.tcp" or not urlsplit(endpoint).hostname:
            raise ConfigError(f'{where}: endpoint must be an opc.tcp:// address, e.g. "opc.tcp://10.0.0.5:4840"')
        try:
            urlsplit(endpoint).port  # noqa: B018 - checked only when read
        except ValueError:
            raise ConfigError(f"{where}: endpoint has an invalid port: {endpoint!r}") from None
        security = table.get("security", "Basic256Sha256-SignAndEncrypt")
        if security == "None":
            if table.get("allow_unsecured") is not True:
                raise ConfigError(
                    f'{where}: security = "None" sends plant data unsigned and unencrypted; '
                    "set allow_unsecured = true as well if that is really intended"
                )
        elif security not in OPCUA_SECURITY:
            raise ConfigError(f'{where}: security must be one of {", ".join(OPCUA_SECURITY)}, or "None"')

        def path(key: str, table: dict[str, Any] = table, where: str = where) -> Path | None:
            value = table.get(key)
            if value is None:
                return None
            if not isinstance(value, str) or not value:
                raise ConfigError(f"{where}: {key} must be a file path")
            return base / value

        certificate, private_key, server_certificate = (
            path("certificate"),
            path("private_key"),
            path("server_certificate"),
        )
        if security != "None" and not (certificate and private_key and server_certificate):
            raise ConfigError(
                f"{where}: a secured connection needs certificate, private_key and server_certificate "
                "(the server's certificate is pinned: the agent never trusts whatever the server presents)"
            )
        username = table.get("username")
        if username is not None and (not isinstance(username, str) or not username):
            raise ConfigError(f"{where}: username must be text")
        password_file = path("password_file")
        if (username is None) != (password_file is None):
            raise ConfigError(f"{where}: set username and password_file together")
        if username is not None and security == "None":
            raise ConfigError(
                f"{where}: a username and password need a secured connection; without one they travel in clear"
            )
        interval = table.get("publishing_interval_ms", 1000)
        if not isinstance(interval, int) or isinstance(interval, bool) or not 50 <= interval <= 3_600_000:
            raise ConfigError(f"{where}: publishing_interval_ms must be a whole number from 50 to 3600000")
        app_uri = table.get("application_uri", f"urn:tiles-edge:{socket.gethostname()}")
        if not isinstance(app_uri, str) or not app_uri.startswith("urn:"):
            raise ConfigError(f"{where}: application_uri must be a URN, e.g. urn:tiles-edge:press-line")

        raw_signals = table.get("signals", [])
        if not isinstance(raw_signals, list) or not raw_signals:
            raise ConfigError(f"{where}: list the nodes to read as [[opcua.signals]] with node and signal")
        signals: list[OpcUaSignal] = []
        for s in raw_signals:
            if not isinstance(s, dict):
                raise ConfigError(f"{where}: each [[opcua.signals]] must be a table")
            _known(s, f"{where} [[opcua.signals]]", {"node", "signal"})
            node, signal = s.get("node"), s.get("signal")
            if not isinstance(node, str) or not node:
                raise ConfigError(f'{where}: each signal needs a node, e.g. node = "ns=2;s=Press1.Temperature"')
            if not isinstance(signal, str) or not SIGNAL_PATTERN.match(signal):
                raise ConfigError(
                    f"{where}: signal {signal!r} must be a Tiles signal ID: lower-case letters, digits, "
                    "dot, dash or underscore, e.g. press1.temperature"
                )
            signals.append(OpcUaSignal(node, signal))
        connectors.append(
            OpcUaConfig(
                name=name,
                endpoint=endpoint,
                security=security,
                certificate=certificate,
                private_key=private_key,
                server_certificate=server_certificate,
                application_uri=app_uri,
                username=username,
                password_file=password_file,
                publishing_interval_ms=interval,
                signals=tuple(signals),
            )
        )
    _unique([c.name for c in connectors], "connector name")
    _unique([s.signal for c in connectors for s in c.signals], "signal")
    _unique([f"{c.name} {s.node}" for c in connectors for s in c.signals], "node in one connector")
    return tuple(connectors)


def _unique(values: list[str], what: str) -> None:
    seen: set[str] = set()
    for v in values:
        if v in seen:
            raise ConfigError(f"{what} {v!r} appears more than once")
        seen.add(v)


def load(path: Path, env: dict[str, str] | None = None, *, need_token: bool = True) -> Config:
    """Reads and checks the config. need_token=False is for commands that never call Tiles
    (e.g. browsing an OPC UA server while setting up)."""
    env = dict(os.environ) if env is None else env
    try:
        data = tomllib.loads(path.read_text())
    except OSError as e:
        raise ConfigError(f"can't read {path}: {e.strerror}") from None
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path} is not valid TOML: {e}") from None
    _known(data, "the top level", {"tiles", "agent", "opcua"})
    tiles, agent = _table(data, "tiles"), _table(data, "agent")
    _known(tiles, "[tiles]", {"url", "token_file", "ca_file", "timeout_seconds"})
    _known(agent, "[agent]", {"heartbeat_seconds"})
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
        token=_token(tiles, base, env) if need_token else "",
        ca_file=ca_file,
        heartbeat_seconds=heartbeat,
        timeout_seconds=float(timeout),
        opcua=_opcua(data.get("opcua"), base),
    )
