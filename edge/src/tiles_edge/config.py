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

import hashlib
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


MQTT_FORMATS = ("value", "json", "sparkplug")


@dataclass(frozen=True)
class MqttTopic:
    """One subscription. `value` and `json` topics carry one signal; `sparkplug` topics carry
    many metrics, each mapped to a signal."""

    topic: str  # an MQTT topic; sparkplug topics may use + and # wildcards
    format: str  # one of MQTT_FORMATS
    signal: str | None  # value and json
    value_path: str  # json: where the value is, e.g. "value" or "data.temp"
    time_path: str | None  # json: where the timestamp is (epoch milliseconds or ISO 8601)
    metrics: dict[str, str]  # sparkplug: metric name -> signal


@dataclass(frozen=True)
class MqttConfig:
    name: str
    host: str
    port: int
    tls: bool
    ca_file: Path | None
    client_certificate: Path | None
    client_key: Path | None
    username: str | None
    password_file: Path | None
    client_id: str
    qos: int
    topics: tuple[MqttTopic, ...]

    @property
    def broker(self) -> str:
        return f"{'mqtts' if self.tls else 'mqtt'}://{self.host}:{self.port}"

    @property
    def signals(self) -> list[str]:
        return [t.signal for t in self.topics if t.signal] + [s for t in self.topics for s in t.metrics.values()]


@dataclass(frozen=True)
class Config:
    url: str
    token: str
    ca_file: Path | None
    heartbeat_seconds: int
    timeout_seconds: float
    opcua: tuple[OpcUaConfig, ...] = ()
    mqtt: tuple[MqttConfig, ...] = ()


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


# The heartbeat reports every connector; the Tiles API takes at most this many.
MAX_CONNECTORS = 100


def _opcua(raw: object, base: Path, need_signals: bool) -> tuple[OpcUaConfig, ...]:
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
        # Setting up (browsing for node IDs) comes before there is anything to map.
        if not isinstance(raw_signals, list) or (need_signals and not raw_signals):
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
        _unique([s.node for s in signals], f"{where} node")
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
    return tuple(connectors)


def _signal(value: object, where: str) -> str:
    if not isinstance(value, str) or not SIGNAL_PATTERN.match(value):
        raise ConfigError(
            f"{where}: signal {value!r} must be a Tiles signal ID: lower-case letters, digits, "
            "dot, dash or underscore, e.g. press1.temperature"
        )
    return value


def _topic_filter(topic: str, where: str) -> None:
    """MQTT wildcards: + stands for one whole level, and # only for the whole last level."""
    levels = topic.split("/")
    for i, level in enumerate(levels):
        if ("+" in level and level != "+") or ("#" in level and (level != "#" or i != len(levels) - 1)):
            raise ConfigError(
                f"{where}: topic {topic!r} misplaces a wildcard: + must be a whole level and # the whole last level"
            )


def _mqtt(raw: object, base: Path, need_topics: bool) -> tuple[MqttConfig, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list) or not all(isinstance(t, dict) for t in raw):
        raise ConfigError("[[mqtt]] must be a list of tables (write each broker as [[mqtt]])")
    keys = {
        "name",
        "broker",
        "allow_unsecured",
        "ca_file",
        "client_certificate",
        "client_key",
        "username",
        "password_file",
        "client_id",
        "qos",
        "topics",
    }
    connectors: list[MqttConfig] = []
    for table in raw:
        name = table.get("name")
        if not isinstance(name, str) or not NAME_PATTERN.match(name):
            raise ConfigError("each [[mqtt]] needs a name: letters, digits, dot, dash or underscore; up to 63")
        where = f"[[mqtt]] {name}"
        _known(table, where, keys)
        broker = table.get("broker")
        parts = urlsplit(broker) if isinstance(broker, str) else None
        if parts is None or parts.scheme not in {"mqtts", "mqtt"} or not parts.hostname:
            raise ConfigError(f'{where}: broker must be an mqtts:// address, e.g. "mqtts://broker.plant.local:8883"')
        try:
            port = parts.port or (8883 if parts.scheme == "mqtts" else 1883)
        except ValueError:
            raise ConfigError(f"{where}: broker has an invalid port: {broker!r}") from None
        tls = parts.scheme == "mqtts"
        if not tls and table.get("allow_unsecured") is not True:
            raise ConfigError(
                f"{where}: mqtt:// sends plant data unencrypted; use mqtts://, "
                "or set allow_unsecured = true as well if that is really intended"
            )

        def path(key: str, table: dict[str, Any] = table, where: str = where) -> Path | None:
            value = table.get(key)
            if value is None:
                return None
            if not isinstance(value, str) or not value:
                raise ConfigError(f"{where}: {key} must be a file path")
            return base / value

        ca_file, client_certificate, client_key = path("ca_file"), path("client_certificate"), path("client_key")
        if (client_certificate is None) != (client_key is None):
            raise ConfigError(f"{where}: set client_certificate and client_key together")
        if not tls and (ca_file or client_certificate):
            raise ConfigError(f"{where}: ca_file and client certificates need an mqtts:// broker")
        username = table.get("username")
        if username is not None and (not isinstance(username, str) or not username):
            raise ConfigError(f"{where}: username must be text")
        password_file = path("password_file")
        if (username is None) != (password_file is None):
            raise ConfigError(f"{where}: set username and password_file together")
        if username is not None and not tls:
            raise ConfigError(f"{where}: a username and password need mqtts://; without it they travel in clear")
        # MQTT 3.1.1 brokers need only accept IDs of 1-23 letters and digits: the default fits, and
        # stays the same for this host and connector, so the broker recognises a reconnect.
        default_id = "tiles" + hashlib.sha256(f"{socket.gethostname()}/{name}".encode()).hexdigest()[:18]
        client_id = table.get("client_id", default_id)
        if not isinstance(client_id, str) or not 1 <= len(client_id) <= 128:
            raise ConfigError(f"{where}: client_id must be text, up to 128 characters")
        qos = table.get("qos", 1)
        if qos not in (0, 1) or isinstance(qos, bool):
            raise ConfigError(f"{where}: qos must be 0 or 1")

        raw_topics = table.get("topics", [])
        if not isinstance(raw_topics, list) or (need_topics and not raw_topics):
            raise ConfigError(f"{where}: list what to read as [[mqtt.topics]] with topic, format and signal(s)")
        topics: list[MqttTopic] = []
        for t in raw_topics:
            if not isinstance(t, dict):
                raise ConfigError(f"{where}: each [[mqtt.topics]] must be a table")
            _known(t, f"{where} [[mqtt.topics]]", {"topic", "format", "signal", "value_path", "time_path", "metrics"})
            topic, fmt = t.get("topic"), t.get("format", "json")
            if not isinstance(topic, str) or not topic or len(topic) > 1024 or "\0" in topic:
                raise ConfigError(f'{where}: each topic needs a topic, e.g. topic = "plant/press1/temperature"')
            if fmt not in MQTT_FORMATS:
                raise ConfigError(f"{where}: format must be one of {', '.join(MQTT_FORMATS)}")
            _topic_filter(topic, where)
            wildcard = "+" in topic or "#" in topic
            if fmt == "sparkplug":
                metrics = t.get("metrics")
                if not isinstance(metrics, dict) or not metrics:
                    raise ConfigError(
                        f'{where}: a sparkplug topic needs metrics = {{ "Press1/Temperature" = "press1.temperature" }}'
                    )
                if "signal" in t or "value_path" in t or "time_path" in t:
                    raise ConfigError(f"{where}: a sparkplug topic maps metrics; signal and paths don't apply")
                if not topic.startswith("spBv1.0/"):
                    raise ConfigError(f"{where}: sparkplug topics start with spBv1.0/, e.g. spBv1.0/plant/+/edge-1/#")
                mapped = {str(k): _signal(v, where) for k, v in metrics.items()}
                topics.append(MqttTopic(topic, fmt, None, "value", None, mapped))
                continue
            if wildcard:
                raise ConfigError(
                    f"{where}: topic {topic!r} has a wildcard, but a {fmt} topic carries one signal; "
                    'list each topic, or use format = "sparkplug"'
                )
            if "metrics" in t:
                raise ConfigError(f"{where}: metrics apply to sparkplug topics only")
            for key in ("value_path", "time_path"):
                v = t.get(key)
                if v is not None and (not isinstance(v, str) or not v or fmt == "value"):
                    raise ConfigError(f"{where}: {key} must be a dotted key path, e.g. data.temp (json topics only)")
            value_path, time_path = t.get("value_path", "value"), t.get("time_path")
            topics.append(MqttTopic(topic, fmt, _signal(t.get("signal"), where), value_path, time_path, {}))
        _unique([t.topic for t in topics], f"{where} topic")
        connectors.append(
            MqttConfig(
                name=name,
                host=parts.hostname,
                port=port,
                tls=tls,
                ca_file=ca_file,
                client_certificate=client_certificate,
                client_key=client_key,
                username=username,
                password_file=password_file,
                client_id=client_id,
                qos=qos,
                topics=tuple(topics),
            )
        )
    return tuple(connectors)


def _unique(values: list[str], what: str) -> None:
    seen: set[str] = set()
    for v in values:
        if v in seen:
            raise ConfigError(f"{what} {v!r} appears more than once")
        seen.add(v)


def load(path: Path, env: dict[str, str] | None = None, *, setup: bool = False) -> Config:
    """Reads and checks the config. setup=True is for the connector setup commands, which never
    call Tiles and come before the signal mapping: they need neither the token nor any signals."""
    env = dict(os.environ) if env is None else env
    try:
        data = tomllib.loads(path.read_text())
    except OSError as e:
        raise ConfigError(f"can't read {path}: {e.strerror}") from None
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"{path} is not valid TOML: {e}") from None
    _known(data, "the top level", {"tiles", "agent", "opcua", "mqtt"})
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

    config = Config(
        url=_url(tiles.get("url")),
        token="" if setup else _token(tiles, base, env),
        ca_file=ca_file,
        heartbeat_seconds=heartbeat,
        timeout_seconds=float(timeout),
        opcua=_opcua(data.get("opcua"), base, need_signals=not setup),
        mqtt=_mqtt(data.get("mqtt"), base, need_topics=not setup),
    )
    _connectors(config)
    return config


def _connectors(config: Config) -> None:
    """Checks that hold across all connectors."""
    names = [c.name for c in config.opcua] + [c.name for c in config.mqtt]
    if len(names) > MAX_CONNECTORS:
        raise ConfigError(
            f"at most {MAX_CONNECTORS} connectors per agent (Tiles takes that many in a heartbeat); "
            "split them over several agents"
        )
    _unique(names, "connector name")
    _unique([s.signal for c in config.opcua for s in c.signals] + [s for c in config.mqtt for s in c.signals], "signal")
