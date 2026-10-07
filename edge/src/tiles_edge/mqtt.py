"""MQTT connector (T2.03): subscribe to topics and turn their payloads into Tiles samples.

Needs the mqtt extra (`pip install "tiles-edge[mqtt]"`, which adds paho-mqtt).

Payload formats, per topic:
- `value`: the payload is the value itself: a number, true/false, or text.
- `json`: a JSON object; `value_path` (default "value") and `time_path` (optional)
  are dotted key paths into it. Times are epoch milliseconds or ISO 8601 text.
- `sparkplug`: Sparkplug B (see sparkplug.py); each metric named in `metrics`
  becomes its signal. Aliases are learned from BIRTH messages.

Security: `mqtts://` with the broker's certificate verified (system CAs plus
`ca_file`) and its host name checked; optionally a client certificate, and a
username and password. Plain `mqtt://` only when allow_unsecured is set, and
never with a password.

Each connector runs its own connection loop on a thread, reconnects with a
growing delay, and reports ok, degraded (some topics refused) or down, with
the reason, in every heartbeat.
"""

import contextlib
import json
import logging
import ssl
import threading
import time
from datetime import UTC, datetime
from typing import Any, Literal

import paho.mqtt.client as paho
from paho.mqtt.enums import CallbackAPIVersion, MQTTErrorCode
from paho.mqtt.reasoncodes import ReasonCode

from tiles_edge import sparkplug
from tiles_edge.config import MqttConfig, MqttTopic
from tiles_edge.samples import Sample, SampleSink, Value

log = logging.getLogger("tiles_edge.mqtt")

Status = Literal["ok", "degraded", "down"]


class _ClosingSSLSocket(ssl.SSLSocket):
    """Closes itself when the TLS handshake fails. paho leaves the socket open in that case, so an
    agent retrying against a broker with a bad certificate would leak one socket per attempt."""

    def do_handshake(self, block: bool = False) -> None:
        try:
            super().do_handshake(block)
        except BaseException:
            self.close()
            raise


class ConnectorError(Exception):
    """Something the operator has to fix (a missing file, a refused login). The message says what."""


def _path(data: Any, path: str) -> Any:
    for key in path.split("."):
        if not isinstance(data, dict) or key not in data:
            raise KeyError(path)
        data = data[key]
    return data


def _scalar(raw: Any) -> Value | None:
    return raw if isinstance(raw, bool | int | float | str) else None


def _time(raw: Any) -> datetime:
    """Epoch milliseconds, or ISO 8601 text (a time zone is required; Z is fine)."""
    if isinstance(raw, int | float) and not isinstance(raw, bool):
        return datetime.fromtimestamp(raw / 1000, UTC)
    if isinstance(raw, str):
        at = datetime.fromisoformat(raw)
        if at.tzinfo is None:
            raise ValueError("a timestamp needs a time zone")
        return at.astimezone(UTC)
    raise ValueError("a timestamp is epoch milliseconds or ISO 8601 text")


def _plain(payload: bytes) -> Value:
    """A `value` payload: true/false, a number, or else the text itself."""
    text = payload.decode("utf-8").strip()
    if text.lower() in ("true", "false"):
        return text.lower() == "true"
    try:
        number = float(text)
    except ValueError:
        return text
    return int(number) if number.is_integer() and "." not in text and "e" not in text.lower() else number


class MqttConnector:
    kind = "mqtt"

    def __init__(self, config: MqttConfig, sink: SampleSink, *, max_retry_seconds: float = 60) -> None:
        self.config = config
        self.sink = sink
        self.max_retry_seconds = max_retry_seconds
        self.received = 0  # samples
        self.unreadable = 0  # messages that couldn't be read
        self.awaiting_birth = 0  # Sparkplug metrics sent by an alias whose BIRTH we haven't seen
        self.last_problem = ""
        self._lock = threading.Lock()
        self._state: tuple[Status, str] = ("down", "not started")
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._failures = 0
        self._refused: str | None = None  # why the broker refused the last connection
        self._aliases = sparkplug.AliasBook()
        self._exact = {t.topic: t for t in config.topics if t.format != "sparkplug"}
        self._sparkplug = [t for t in config.topics if t.format == "sparkplug"]

    @property
    def name(self) -> str:
        return self.config.name

    def status(self) -> dict[str, str]:
        with self._lock:
            state, detail = self._state
            counts = f"{self.received} samples"
            if self.awaiting_birth:
                counts += f", {self.awaiting_birth} metrics by alias awaiting their BIRTH"
            if self.unreadable:
                counts += f", {self.unreadable} unreadable messages (last: {self.last_problem})"
        return {"name": self.name, "kind": self.kind, "status": state, "detail": f"{detail}; {counts}"[:500]}

    def _set(self, state: Status, detail: str) -> None:
        with self._lock:
            changed = self._state[0] != state
            self._state = (state, detail)
        if changed:
            log.log(logging.INFO if state == "ok" else logging.WARNING, "connector %s", state,
                    extra={"connector": self.name, "detail": detail})  # fmt: skip

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"mqtt-{self.name}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout)

    # ---- connection -------------------------------------------------------------------------

    def _client(self) -> paho.Client:
        c = self.config
        client = paho.Client(CallbackAPIVersion.VERSION2, client_id=c.client_id, protocol=paho.MQTTv311)
        if c.tls:
            try:
                # The system's CAs plus ca_file; certificate and host name always checked.
                context = ssl.create_default_context()
                context.sslsocket_class = _ClosingSSLSocket
                if c.ca_file:
                    context.load_verify_locations(cafile=str(c.ca_file))
                if c.client_certificate and c.client_key:
                    context.load_cert_chain(str(c.client_certificate), str(c.client_key))
            except (OSError, ssl.SSLError) as e:
                raise ConnectorError(f"can't load the TLS files: {e}") from None
            client.tls_set_context(context)
        if c.username is not None:
            password = None
            if c.password_file is not None:
                try:
                    password = c.password_file.read_text().strip()
                except OSError as e:
                    raise ConnectorError(f"can't read the password file {c.password_file}: {e.strerror}") from None
            client.username_pw_set(c.username, password)
        client.on_connect = self._on_connect
        client.on_subscribe = self._on_subscribe
        client.on_message = self._on_message
        return client

    def _run(self) -> None:
        while not self._stop.is_set():
            client: paho.Client | None = None
            try:
                client = self._client()
                self._refused = None
                client.connect(self.config.host, self.config.port, keepalive=30)
                while not self._stop.is_set():
                    rc = client.loop(timeout=1.0)
                    if rc != MQTTErrorCode.MQTT_ERR_SUCCESS:
                        raise ConnectionError(self._refused or f"connection lost ({paho.error_string(rc)})")
            except ConnectorError as e:
                self._failures += 1
                self._set("down", str(e))
            except Exception as e:  # network, TLS and broker errors: retry
                self._failures += 1
                self._set("down", self._refused or explain(e))
            finally:
                if client is not None:
                    with contextlib.suppress(Exception):
                        client.disconnect()
                        client.loop(timeout=0.1)
            if self._stop.is_set():
                break
            self._stop.wait(min(2.0 ** min(self._failures - 1, 10), self.max_retry_seconds))
        self._set("down", "stopped")

    def _on_connect(self, client: paho.Client, userdata: Any, flags: Any, reason: ReasonCode, props: Any) -> None:
        if reason.is_failure:
            self._refused = f"the broker refused the connection: {reason}"
            return
        # Aliases from before a disconnect may be stale: a node can restart, and change them, while
        # we can't hear its BIRTH. Data sent by alias waits for the next BIRTH instead.
        self._aliases = sparkplug.AliasBook()
        client.subscribe([(t.topic, self.config.qos) for t in self.config.topics])

    def _on_subscribe(
        self, client: paho.Client, userdata: Any, mid: int, reasons: list[ReasonCode], props: Any
    ) -> None:
        topics = [t.topic for t in self.config.topics]
        refused = [f"{topic} ({r})" for topic, r in zip(topics, reasons, strict=False) if r.is_failure]
        # Connected and subscribed: a later outage starts its backoff from 1 s again.
        self._failures = 0
        if not refused:
            self._set("ok", f"subscribed to {len(topics)} topics at {self.config.broker}")
        else:
            state: Status = "down" if len(refused) == len(topics) else "degraded"
            self._set(state, f"subscribed to {len(topics) - len(refused)} of {len(topics)} topics; "
                             f"the broker refused: {', '.join(refused)}")  # fmt: skip

    def try_once(self, timeout: float = 10) -> tuple[Status, str]:
        """Connects, subscribes and disconnects: the status it found and why. For `tiles-edge check`."""
        client: paho.Client | None = None
        try:
            client = self._client()
            client.connect(self.config.host, self.config.port, keepalive=30)
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                rc = client.loop(timeout=0.2)
                if rc != MQTTErrorCode.MQTT_ERR_SUCCESS:
                    return "down", self._refused or f"connection lost ({paho.error_string(rc)})"
                state, detail = self._state
                if detail != "not started":
                    return state, detail
            return "down", "the broker didn't answer the subscription in time"
        except ConnectorError as e:
            return "down", str(e)
        except Exception as e:
            return "down", self._refused or explain(e)
        finally:
            if client is not None:
                with contextlib.suppress(Exception):
                    client.disconnect()

    # ---- messages ---------------------------------------------------------------------------

    def _on_message(self, client: paho.Client, userdata: Any, message: paho.MQTTMessage) -> None:
        try:
            samples = self.read(message.topic, message.payload)
        except Exception as e:  # a bad payload never stops the connector
            with self._lock:
                self.unreadable += 1
                self.last_problem = f"{message.topic}: {e}"[:200]
            return
        for sample in samples:
            self.sink.put(sample)
        with self._lock:
            self.received += len(samples)

    def read(self, topic: str, payload: bytes) -> list[Sample]:
        """The samples in one message. Raises ValueError (or KeyError) when it can't be read."""
        mapped = self._exact.get(topic)
        if mapped is not None:
            return [self._single(mapped, payload)]
        for t in self._sparkplug:
            if paho.topic_matches_sub(t.topic, topic):
                return self._sparkplug_samples(t, topic, payload)
        return []  # a retained or overlapping topic we don't map

    def _single(self, t: MqttTopic, payload: bytes) -> Sample:
        if t.signal is None:  # value and json topics always have one (config)
            raise ValueError("no signal mapped")
        now = datetime.now(UTC)
        if t.format == "value":
            return Sample(t.signal, now, _plain(payload), "good")
        data = json.loads(payload)
        value = _scalar(_path(data, t.value_path))
        if value is None:
            raise ValueError(f"{t.value_path} is not a number, true/false or text")
        at = _time(_path(data, t.time_path)) if t.time_path else now
        return Sample(t.signal, at, value, "good")

    def _sparkplug_samples(self, t: MqttTopic, topic: str, payload: bytes) -> list[Sample]:
        where = sparkplug.parse_topic(topic)
        if where.message_type not in ("NBIRTH", "NDATA", "DBIRTH", "DDATA", "NDEATH", "DDEATH"):
            return []  # commands and STATE carry no measurements
        _, metrics = sparkplug.decode(payload)
        self._aliases.learn(where, metrics)
        samples = []
        for m in metrics:
            name = self._aliases.name(where, m)
            if name is None:
                with self._lock:
                    self.awaiting_birth += 1
                continue
            signal = t.metrics.get(name)
            if signal is None or m.value is None:
                continue
            samples.append(Sample(signal, m.timestamp or datetime.now(UTC), m.value, "good"))
        return samples


def explain(e: BaseException) -> str:
    if isinstance(e, ssl.SSLCertVerificationError):
        return f"the broker's certificate isn't trusted: {e.verify_message}"
    if isinstance(e, ssl.SSLError):
        return f"TLS failed: {e}"
    if isinstance(e, ConnectionRefusedError):
        return "the broker refused the connection (nothing listening on that port?)"
    if isinstance(e, OSError | ConnectionError):
        return f"can't reach the broker: {e}"
    return f"{type(e).__name__}: {e}"
