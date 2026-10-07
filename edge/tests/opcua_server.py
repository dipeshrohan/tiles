"""A real OPC UA server (asyncua) on a free local port, run on its own thread for the tests."""

import asyncio
import socket
import threading
from collections.abc import Coroutine
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from asyncua import ua
from asyncua.crypto import cert_gen
from asyncua.crypto.truststore import TrustStore
from asyncua.crypto.validator import CertificateValidator, CertificateValidatorOptions
from asyncua.server.server import Server
from cryptography.x509.oid import ExtendedKeyUsageOID

AGENT_URI = "urn:tiles-edge:test"


@dataclass(frozen=True)
class Certs:
    folder: Path
    server_cert: Path
    server_key: Path
    agent_cert: Path
    agent_key: Path
    other_cert: Path  # a certificate that belongs to no one here


async def make_certs(folder: Path) -> Certs:
    host = socket.gethostname()
    pairs = {}
    for name, uri, use in (
        ("server", "urn:tiles:test-server", ExtendedKeyUsageOID.SERVER_AUTH),
        ("agent", AGENT_URI, ExtendedKeyUsageOID.CLIENT_AUTH),
        ("other", "urn:tiles:other", ExtendedKeyUsageOID.SERVER_AUTH),
    ):
        key, cert = folder / f"{name}.pem", folder / f"{name}.der"
        await cert_gen.setup_self_signed_certificate(key, cert, uri, host, [use], {})
        pairs[name] = (cert, key)
    return Certs(
        folder,
        pairs["server"][0],
        pairs["server"][1],
        pairs["agent"][0],
        pairs["agent"][1],
        pairs["other"][0],
    )


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


class TestServer:
    """Press1.Temperature (Double), Press1.Running (Boolean) and Press1.Profile (an array, unsupported)."""

    __test__ = False  # not a pytest class

    def __init__(self, certs: Certs, *, secured: bool = True, trust_agent: bool = True, port: int | None = None):
        self.certs = certs
        self.secured = secured
        self.trust_agent = trust_agent
        self.port = port or free_port()
        self.endpoint = f"opc.tcp://127.0.0.1:{self.port}/tiles-test"
        self.ns = 2
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._server: Server | None = None
        self._vars: dict[str, Any] = {}

    def node(self, name: str) -> str:
        return f"ns={self.ns};s=Press1.{name}"

    def _call[T](self, coro: Coroutine[Any, Any, T]) -> T:
        assert self._loop is not None, "start() the server first"
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(15)

    def start(self) -> "TestServer":
        # The loop is made here, so a server that is never started leaves nothing open.
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()
        self._call(self._start())
        return self

    async def _start(self) -> None:
        server = Server()
        await server.init()
        server.set_endpoint(self.endpoint)
        if self.secured:
            server.set_security_policy([ua.SecurityPolicyType.Basic256Sha256_SignAndEncrypt])
            await server.load_certificate(str(self.certs.server_cert))
            await server.load_private_key(str(self.certs.server_key))
            trusted = self.certs.folder / ("trusted" if self.trust_agent else "trusted-none")
            trusted.mkdir(exist_ok=True)
            # Trust the agent, or (an empty store isn't allowed) only an unrelated certificate.
            trusted_cert = self.certs.agent_cert if self.trust_agent else self.certs.other_cert
            (trusted / "trusted.der").write_bytes(trusted_cert.read_bytes())
            store = TrustStore([trusted], [])
            await store.load()
            options = CertificateValidatorOptions.TRUSTED_VALIDATION | CertificateValidatorOptions.PEER_CLIENT
            server.set_certificate_validator(CertificateValidator(options, store))
        else:
            server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
        self.ns = await server.register_namespace("urn:tiles:test")
        press = await server.nodes.objects.add_object(ua.NodeId.from_string(f"ns={self.ns};s=Press1"), "Press1")
        self._vars["Temperature"] = await press.add_variable(
            ua.NodeId.from_string(f"ns={self.ns};s=Press1.Temperature"), "Temperature", 20.5
        )
        self._vars["Running"] = await press.add_variable(
            ua.NodeId.from_string(f"ns={self.ns};s=Press1.Running"), "Running", True
        )
        self._vars["Profile"] = await press.add_variable(
            ua.NodeId.from_string(f"ns={self.ns};s=Press1.Profile"), "Profile", [1.0, 2.0]
        )
        await server.start()
        self._server = server

    def write(self, name: str, value: Any) -> None:
        self._call(self._vars[name].write_value(value))

    def stop(self) -> None:
        if self._loop is None or self._thread is None:
            return
        if self._server:
            self._call(self._server.stop())
            self._server = None
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(10)
        self._loop.close()
        self._loop = self._thread = None
