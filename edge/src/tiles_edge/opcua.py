"""OPC UA connector (T2.02): subscribe to nodes and turn their values into Tiles samples.

Needs the opcua extra (`pip install "tiles-edge[opcua]"`, which adds asyncua).

Security: by default the session is signed and encrypted (Basic256Sha256,
SignAndEncrypt) with this agent's own application certificate. The server's
certificate is pinned: before every connection the agent compares the
certificate the server presents with the configured one and refuses to go on
if they differ, so it never trusts whatever answers on the address. Plant IT
adds the agent's certificate to the server's trust list. `tiles-edge opcua cert`
makes the agent's certificate; `tiles-edge opcua server-cert` shows the
server's fingerprint and saves it once someone has checked it.

Each connector runs its own asyncio loop in a thread, so a slow or dead server
never holds up the heartbeat. It reconnects with a growing delay, and its
status (ok, degraded or down, with a reason) goes out with every heartbeat.
"""

import asyncio
import contextlib
import hashlib
import logging
import socket
import threading
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from asyncua import ua
from asyncua.client.client import Client
from asyncua.common.node import Node
from asyncua.crypto import cert_gen, security_policies
from asyncua.ua.uaerrors import UaStatusCodeError
from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding
from cryptography.x509.oid import ExtendedKeyUsageOID

from tiles_edge.config import OpcUaConfig
from tiles_edge.samples import Quality, Sample, SampleSink, Value

log = logging.getLogger("tiles_edge.opcua")
# asyncua logs every failed handshake with a traceback; our own status says it in one line.
logging.getLogger("asyncua").setLevel(logging.CRITICAL)

Status = Literal["ok", "degraded", "down"]


class ConnectorError(Exception):
    """Something the operator has to fix (a missing file, a certificate mismatch). The message says what."""


def fingerprint(cert: x509.Certificate) -> str:
    """SHA-256 fingerprint as colon-separated hex, the form OPC UA tools display."""
    digest = hashlib.sha256(cert.public_bytes(Encoding.DER)).hexdigest().upper()
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


def save_certificate(cert: x509.Certificate, path: Path) -> None:
    """Writes a certificate as DER, which every OPC UA stack reads."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(cert.public_bytes(Encoding.DER))


def _first_cert(der: bytes) -> x509.Certificate:
    """The leading certificate of a DER blob that may carry the issuer chain after it."""
    if len(der) < 4 or der[0] != 0x30:
        raise ConnectorError("the server sent no usable certificate")
    length_bytes = der[1] & 0x7F if der[1] & 0x80 else 0
    length = int.from_bytes(der[2 : 2 + length_bytes], "big") if length_bytes else der[1]
    return x509.load_der_x509_certificate(der[: 2 + length_bytes + length])


def _read_cert(path: Path, hint: str) -> x509.Certificate:
    try:
        raw = path.read_bytes()
    except OSError as e:
        raise ConnectorError(f"can't read {path}: {e.strerror}; {hint}") from None
    try:
        return x509.load_pem_x509_certificate(raw) if raw.lstrip().startswith(b"-----") else _first_cert(raw)
    except ValueError:
        raise ConnectorError(f"{path} is not a certificate (DER or PEM); {hint}") from None


def _policy(config: OpcUaConfig) -> tuple[type[security_policies.SecurityPolicy], ua.MessageSecurityMode]:
    policy, mode = config.security.split("-")
    return getattr(security_policies, f"SecurityPolicy{policy}"), getattr(ua.MessageSecurityMode, mode)


async def presented_certificate(config: OpcUaConfig, timeout: float = 10) -> x509.Certificate:  # noqa: ASYNC109 - asyncua's own per-request timeout
    """The certificate the server offers for the configured security, read from its endpoint list
    (which servers publish without a session)."""
    client = Client(config.endpoint, timeout=timeout)
    endpoints = await client.connect_and_get_server_endpoints()
    if config.secured:
        policy, mode = _policy(config)
        matching = [e for e in endpoints if e.SecurityPolicyUri == policy.URI and e.SecurityMode == mode]
        if not matching:
            offered = sorted({f"{e.SecurityPolicyUri.rsplit('#', 1)[-1]}-{e.SecurityMode.name}" for e in endpoints})
            raise ConnectorError(f"the server doesn't offer {config.security}; it offers {', '.join(offered)}")
        endpoints = matching
    certs = [e.ServerCertificate for e in endpoints if e.ServerCertificate]
    if not certs:
        raise ConnectorError("the server sent no certificate")
    return _first_cert(certs[0])


async def connect(config: OpcUaConfig, timeout: float = 10) -> Client:  # noqa: ASYNC109 - asyncua's own per-request timeout
    """A connected client, after checking the server's certificate against the pinned one.
    The caller disconnects it."""
    client = Client(config.endpoint, timeout=timeout)
    client.application_uri = config.application_uri
    client.name = client.description = "Tiles edge agent"
    if config.username is not None and config.password_file is not None:
        try:
            password = config.password_file.read_text().strip()
        except OSError as e:
            raise ConnectorError(f"can't read the password file {config.password_file}: {e.strerror}") from None
        client.set_user(config.username)
        client.set_password(password)
    if config.secured:
        if not (config.certificate and config.private_key and config.server_certificate):
            raise ConnectorError("a secured connection needs certificate, private_key and server_certificate")
        make_cert = "run `tiles-edge opcua cert` to create it"
        for path in (config.certificate, config.private_key):
            if not path.is_file():
                raise ConnectorError(f"{path} doesn't exist; {make_cert}")
        pinned = _read_cert(config.server_certificate, "run `tiles-edge opcua server-cert` to fetch and pin it")
        presented = await presented_certificate(config, timeout)
        if fingerprint(presented) != fingerprint(pinned):
            raise ConnectorError(
                f"the server's certificate ({fingerprint(presented)}) is not the pinned one "
                f"({fingerprint(pinned)}); if the server's certificate really changed, pin the new one "
                "with `tiles-edge opcua server-cert`"
            )
        policy, mode = _policy(config)
        await client.set_security(
            policy,
            str(config.certificate),
            str(config.private_key),
            server_certificate=str(config.server_certificate),
            mode=mode,
        )
    await client.connect()
    return client


async def make_certificate(config: OpcUaConfig) -> x509.Certificate:
    """Creates this agent's application certificate and key at the configured paths, unless a
    valid pair is already there. Valid for a year."""
    if not (config.certificate and config.private_key):
        raise ConnectorError(f"[[opcua]] {config.name}: set certificate and private_key first")
    for path in (config.certificate, config.private_key):
        path.parent.mkdir(parents=True, exist_ok=True)
    await cert_gen.setup_self_signed_certificate(
        config.private_key,
        config.certificate,
        config.application_uri,
        socket.gethostname(),
        [ExtendedKeyUsageOID.CLIENT_AUTH],
        {"organizationName": "Tiles edge agent"},
    )
    config.private_key.chmod(0o600)
    return _read_cert(config.certificate, "")


@dataclass(frozen=True)
class BrowseEntry:
    depth: int
    node: str
    name: str
    node_class: str
    data_type: str


async def browse(config: OpcUaConfig, start: str | None, depth: int, limit: int = 2000) -> list[BrowseEntry]:
    """The address space under `start` (default: Objects), `depth` levels deep, at most `limit` nodes."""
    client = await connect(config)
    try:
        root = client.get_node(start) if start else client.nodes.objects
        entries: list[BrowseEntry] = []

        async def walk(node: Node, level: int) -> None:
            for child in await node.get_children():
                if len(entries) >= limit:
                    return
                node_class = await child.read_node_class()
                data_type = ""
                if node_class == ua.NodeClass.Variable:
                    type_id = await child.read_data_type()
                    data_type = (await client.get_node(type_id).read_browse_name()).Name
                name = (await child.read_browse_name()).Name
                entries.append(BrowseEntry(level, child.nodeid.to_string(), name, node_class.name, data_type))
                if level + 1 < depth and node_class == ua.NodeClass.Object:
                    await walk(child, level + 1)

        await walk(root, 0)
        return entries
    finally:
        await client.disconnect()


def _quality(code: ua.StatusCode) -> Quality:
    if code.is_good():
        return "good"
    return "uncertain" if code.is_uncertain() else "bad"


def _value(raw: Any) -> Value | None:
    """Numbers, booleans and text become samples; arrays, structures and the like are skipped."""
    if isinstance(raw, bool | int | float | str):
        return raw
    return None


class OpcUaConnector:
    kind = "opcua"

    def __init__(
        self,
        config: OpcUaConfig,
        sink: SampleSink,
        *,
        max_retry_seconds: float = 60,
        retry_nodes_seconds: float = 30,
    ) -> None:
        self.config = config
        self.sink = sink
        self.max_retry_seconds = max_retry_seconds
        self.retry_nodes_seconds = retry_nodes_seconds
        self._failures = 0  # connection attempts failed in a row
        self._subscribed = 0  # nodes subscribed in the current session
        self.received = 0
        self.skipped = 0  # values of a type Tiles doesn't store (arrays, structures…)
        self._lock = threading.Lock()
        self._state: tuple[Status, str] = ("down", "not started")
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._wake: asyncio.Event | None = None
        self._signals = {s.node: s.signal for s in config.signals}

    @property
    def name(self) -> str:
        return self.config.name

    def status(self) -> dict[str, str]:
        """For the heartbeat: {name, kind, status, detail}."""
        with self._lock:
            state, detail = self._state
            counts = f"{self.received} samples" + (
                f", {self.skipped} unsupported values skipped" if self.skipped else ""
            )
        return {"name": self.name, "kind": self.kind, "status": state, "detail": f"{detail}; {counts}"[:500]}

    def _set(self, state: Status, detail: str) -> None:
        with self._lock:
            changed = self._state[0] != state
            self._state = (state, detail)
        if changed:
            level = logging.INFO if state == "ok" else logging.WARNING
            log.log(level, "connector %s", state, extra={"connector": self.name, "detail": detail})

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"opcua-{self.name}", daemon=True)
        self._thread.start()

    def stop(self, timeout: float = 10) -> None:
        self._stop.set()
        loop, wake = self._loop, self._wake
        if loop and wake:
            loop.call_soon_threadsafe(wake.set)
        if self._thread:
            self._thread.join(timeout)

    def _run(self) -> None:
        asyncio.run(self._main())

    async def _main(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._wake = asyncio.Event()
        while not self._stop.is_set():
            try:
                await self._session()
            except ConnectorError as e:
                self._failures += 1
                self._set("down", str(e))
            except Exception as e:  # network errors, server refusals: retry
                self._failures += 1
                self._set("down", explain(e))
            if self._stop.is_set():
                break
            await self._sleep(min(2.0 ** min(self._failures - 1, 10), self.max_retry_seconds))
        self._set("down", "stopped")

    async def _sleep(self, seconds: float) -> None:
        if self._wake is None:
            return
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._wake.wait(), seconds)

    async def _session(self) -> None:
        client = await connect(self.config)
        self._subscribed = 0
        try:
            subscription = await client.create_subscription(self.config.publishing_interval_ms, _Handler(self))
            pending = [client.get_node(s.node) for s in self.config.signals]
            pending = await self._subscribe(subscription, pending)
            # Connected and subscribed: a later outage starts its backoff from 1 s again.
            self._failures = 0
            last_retry = time.monotonic()
            # Until told to stop, or the server goes away (any request then fails). Nodes that
            # couldn't be subscribed (not there yet, access denied…) are tried again now and then.
            while not self._stop.is_set():
                await self._sleep(1)
                await client.check_connection()
                await client.nodes.server_state.read_value()
                if pending and time.monotonic() - last_retry >= self.retry_nodes_seconds:
                    pending = await self._subscribe(subscription, pending)
                    last_retry = time.monotonic()
        finally:
            with contextlib.suppress(Exception):  # already gone
                await asyncio.wait_for(client.disconnect(), 5)

    async def _subscribe(self, subscription: Any, nodes: list[Node]) -> list[Node]:
        """Subscribes to `nodes`; returns the ones that failed, and sets the status to match."""
        results = await subscription.subscribe_data_change(nodes) if nodes else []
        if not isinstance(results, list):  # asyncua returns a bare handle for a single node
            results = [results]
        pending = [n for n, r in zip(nodes, results, strict=True) if isinstance(r, ua.StatusCode)]
        failed = [
            f"{n.nodeid.to_string()} ({r.name})"
            for n, r in zip(nodes, results, strict=True)
            if isinstance(r, ua.StatusCode)
        ]
        self._subscribed += len(nodes) - len(pending)
        total = len(self.config.signals)
        if not pending:
            self._set("ok", f"subscribed to {total} nodes at {self.config.endpoint}")
        else:
            # Nothing subscribed means no data at all: that is down, not degraded.
            state: Status = "degraded" if self._subscribed else "down"
            self._set(
                state, f"subscribed to {self._subscribed} of {total} nodes; failed (retrying): {', '.join(failed)}"
            )
        return pending

    def on_value(self, node: Node, data: Any) -> None:
        signal = self._signals.get(node.nodeid.to_string())
        if signal is None:
            return
        dv: ua.DataValue = data.monitored_item.Value
        value = _value(dv.Value.Value if dv.Value is not None else None)
        if value is None:
            with self._lock:
                self.skipped += 1
            return
        at = dv.SourceTimestamp or dv.ServerTimestamp or datetime.now(UTC)
        if at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        self.sink.put(Sample(signal, at, value, _quality(dv.StatusCode or ua.StatusCode())))
        with self._lock:
            self.received += 1


class _Handler:
    def __init__(self, connector: OpcUaConnector) -> None:
        self.connector = connector

    def datachange_notification(self, node: Node, val: Any, data: Any) -> None:
        self.connector.on_value(node, data)


def explain(e: BaseException) -> str:
    if isinstance(e, UaStatusCodeError):
        return f"the server refused: {e}"
    if isinstance(e, ConnectionRefusedError | socket.gaierror | OSError):
        return f"can't reach the server: {e}"
    if isinstance(e, TimeoutError):
        return "the server didn't answer in time"
    return f"{type(e).__name__}: {e}"
