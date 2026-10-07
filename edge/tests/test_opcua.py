"""OPC UA connector (T2.02) against a real asyncua server, secured with certificates."""

import asyncio
import dataclasses
import json
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeTiles, write_config
from opcua_server import AGENT_URI, Certs, TestServer, make_certs

from tiles_edge import opcua
from tiles_edge.cli import main
from tiles_edge.config import ConfigError, OpcUaConfig, OpcUaSignal, load
from tiles_edge.samples import MemoryBuffer


@pytest.fixture(scope="module")
def certs(tmp_path_factory: pytest.TempPathFactory) -> Certs:
    return asyncio.run(make_certs(tmp_path_factory.mktemp("opcua")))


@pytest.fixture
def server(certs: Certs) -> Iterator[TestServer]:
    s = TestServer(certs).start()
    yield s
    s.stop()


def connector_config(server: TestServer, certs: Certs, **changes: Any) -> OpcUaConfig:
    base = OpcUaConfig(
        name="press-line",
        endpoint=server.endpoint,
        security="Basic256Sha256-SignAndEncrypt",
        certificate=certs.agent_cert,
        private_key=certs.agent_key,
        server_certificate=certs.server_cert,
        application_uri=AGENT_URI,
        username=None,
        password_file=None,
        publishing_interval_ms=50,
        signals=(
            OpcUaSignal(server.node("Temperature"), "press1.temperature"),
            OpcUaSignal(server.node("Running"), "press1.running"),
        ),
    )
    return dataclasses.replace(base, **changes)


def wait_for(check: Callable[[], bool], seconds: float = 15) -> None:
    deadline = time.monotonic() + seconds
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.05)


def running(config: OpcUaConfig, buffer: MemoryBuffer) -> opcua.OpcUaConnector:
    connector = opcua.OpcUaConnector(config, buffer, max_retry_seconds=0.5)
    connector.start()
    return connector


def test_values_arrive_as_samples_over_an_encrypted_session(server: TestServer, certs: Certs) -> None:
    buffer = MemoryBuffer()
    connector = running(connector_config(server, certs), buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        assert connector.status()["detail"].startswith(f"subscribed to 2 nodes at {server.endpoint}")
        wait_for(lambda: len(buffer) >= 2)  # the initial value of each node
        server.write("Temperature", 23.25)
        wait_for(lambda: any(s.value == 23.25 for s in list(buffer._samples)))
        samples = buffer.take()
        assert {s.signal for s in samples} == {"press1.temperature", "press1.running"}
        latest = next(s for s in samples if s.value == 23.25)
        assert (latest.signal, latest.quality) == ("press1.temperature", "good")
        assert latest.at.tzinfo is not None
        assert [s.value for s in samples if s.signal == "press1.running"] == [True]
    finally:
        connector.stop()
    assert connector.status()["status"] == "down"
    assert connector.status()["detail"].startswith("stopped")


def test_a_server_whose_certificate_is_not_the_pinned_one_is_refused(server: TestServer, certs: Certs) -> None:
    buffer = MemoryBuffer()
    connector = running(connector_config(server, certs, server_certificate=certs.other_cert), buffer)
    try:
        wait_for(lambda: "not the pinned one" in connector.status()["detail"])
        assert connector.status()["status"] == "down"
        assert len(buffer) == 0
    finally:
        connector.stop()


def test_a_server_that_doesnt_trust_the_agent_is_reported(certs: Certs) -> None:
    server = TestServer(certs, trust_agent=False).start()
    connector = running(connector_config(server, certs), MemoryBuffer())
    try:
        wait_for(lambda: connector.status()["detail"] != "not started; 0 samples", 20)
        wait_for(lambda: connector.status()["status"] == "down" and "server" in connector.status()["detail"], 20)
    finally:
        connector.stop()
        server.stop()


def test_missing_agent_certificate_says_how_to_make_one(server: TestServer, certs: Certs, tmp_path: Path) -> None:
    connector = running(connector_config(server, certs, certificate=tmp_path / "none.der"), MemoryBuffer())
    try:
        wait_for(lambda: "run `tiles-edge opcua cert`" in connector.status()["detail"])
    finally:
        connector.stop()


def test_unknown_nodes_make_the_connector_degraded(server: TestServer, certs: Certs) -> None:
    signals = (OpcUaSignal(server.node("Temperature"), "a"), OpcUaSignal("ns=2;s=Nope", "b"))
    connector = running(connector_config(server, certs, signals=signals), MemoryBuffer())
    try:
        wait_for(lambda: connector.status()["status"] == "degraded")
        assert "subscribed to 1 of 2 nodes; failed: ns=2;s=Nope (BadNodeIdUnknown)" in connector.status()["detail"]
    finally:
        connector.stop()


def test_arrays_are_skipped_and_counted(server: TestServer, certs: Certs) -> None:
    signals = (OpcUaSignal(server.node("Profile"), "press1.profile"),)
    buffer = MemoryBuffer()
    connector = running(connector_config(server, certs, signals=signals), buffer)
    try:
        wait_for(lambda: connector.skipped >= 1)
        assert len(buffer) == 0
        assert "1 unsupported values skipped" in connector.status()["detail"]
    finally:
        connector.stop()


def test_it_reconnects_when_the_server_comes_back(certs: Certs) -> None:
    server = TestServer(certs).start()
    buffer = MemoryBuffer()
    connector = running(connector_config(server, certs), buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        server.stop()
        wait_for(lambda: connector.status()["status"] == "down", 20)
        server = TestServer(certs, port=server.port).start()
        wait_for(lambda: connector.status()["status"] == "ok", 30)
        buffer.take()
        server.write("Temperature", 99.5)
        wait_for(lambda: any(s.value == 99.5 for s in list(buffer._samples)))
    finally:
        connector.stop()
        server.stop()


def test_an_unsecured_server_works_only_when_allowed(certs: Certs) -> None:
    server = TestServer(certs, secured=False).start()
    buffer = MemoryBuffer()
    unsecured = connector_config(
        server, certs, security="None", certificate=None, private_key=None, server_certificate=None
    )
    connector = running(unsecured, buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        wait_for(lambda: len(buffer) >= 2)
    finally:
        connector.stop()
        server.stop()


def test_a_secured_connector_wont_settle_for_an_unsecured_server(certs: Certs) -> None:
    server = TestServer(certs, secured=False).start()
    connector = running(connector_config(server, certs), MemoryBuffer())
    try:
        wait_for(lambda: "doesn't offer Basic256Sha256-SignAndEncrypt" in connector.status()["detail"])
    finally:
        connector.stop()
        server.stop()


# ---- the setup commands -------------------------------------------------------------------------


def config_file(folder: Path, server: TestServer, certs: Certs, *, extra: str = "", pin: Path | None = None) -> Path:
    opc = f"""
[[opcua]]
name = "press-line"
endpoint = "{server.endpoint}"
certificate = "agent/agent.der"
private_key = "agent/agent.pem"
server_certificate = "{pin or folder / "server.der"}"
application_uri = "{AGENT_URI}"
{extra}
[[opcua.signals]]
node = "{server.node("Temperature")}"
signal = "press1.temperature"
"""
    path = write_config(folder, "https://tiles.example.com")
    path.write_text(path.read_text() + opc)
    return path


def test_cert_creates_the_agent_certificate(
    server: TestServer, certs: Certs, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = config_file(tmp_path, server, certs)
    assert main(["opcua", "cert", "-c", str(path)]) == 0
    out = capsys.readouterr().out
    assert (tmp_path / "agent" / "agent.der").is_file() and (tmp_path / "agent" / "agent.pem").is_file()
    assert (tmp_path / "agent" / "agent.pem").stat().st_mode & 0o777 == 0o600
    cert = opcua._read_cert(tmp_path / "agent" / "agent.der", "")
    assert f"SHA-256 fingerprint: {opcua.fingerprint(cert)}" in out
    assert f"Application URI: {AGENT_URI}" in out
    # Running it again keeps the same certificate (plant IT has already trusted it).
    assert main(["opcua", "cert", "-c", str(path)]) == 0
    assert opcua.fingerprint(opcua._read_cert(tmp_path / "agent" / "agent.der", "")) == opcua.fingerprint(cert)


def test_server_cert_shows_then_pins_the_servers_certificate(
    server: TestServer, certs: Certs, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = config_file(tmp_path, server, certs)
    expected = opcua.fingerprint(opcua._read_cert(certs.server_cert, ""))
    assert main(["opcua", "server-cert", "-c", str(path)]) == 0
    assert f"SHA-256 fingerprint: {expected}" in capsys.readouterr().out
    assert not (tmp_path / "server.der").exists()  # shown, not pinned
    assert main(["opcua", "server-cert", "-c", str(path), "--save"]) == 0
    assert opcua.fingerprint(opcua._read_cert(tmp_path / "server.der", "")) == expected


def test_browse_lists_nodes_with_their_ids(
    server: TestServer, certs: Certs, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    (tmp_path / "agent").mkdir()
    (tmp_path / "agent" / "agent.der").write_bytes(certs.agent_cert.read_bytes())
    (tmp_path / "agent" / "agent.pem").write_bytes(certs.agent_key.read_bytes())
    path = config_file(tmp_path, server, certs, pin=certs.server_cert)
    assert main(["opcua", "browse", "-c", str(path)]) == 0
    out = capsys.readouterr().out
    assert f"Press1  [Object]  ns={server.ns};s=Press1" in out
    assert f"  Temperature  [Variable Double]  {server.node('Temperature')}" in out
    assert main(["opcua", "browse", "-c", str(path), "--node", f"ns={server.ns};s=Press1", "--depth", "1"]) == 0
    assert "Running  [Variable Boolean]" in capsys.readouterr().out


def test_check_tries_each_connector(
    server: TestServer, certs: Certs, tiles: FakeTiles, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    path = config_file(tmp_path, server, certs, pin=certs.other_cert)
    path.write_text(path.read_text().replace('url = "https://tiles.example.com"', f'url = "{tiles.url}"'))
    assert main(["opcua", "cert", "-c", str(path)]) == 0  # an agent certificate the server doesn't trust...
    capsys.readouterr()
    assert main(["check", "-c", str(path)]) == 4  # ...and a pin that doesn't match
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False
    assert "not the pinned one" in out["connectors"]["press-line"]


def test_the_commands_pick_a_connector_by_name(
    certs: Certs, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    server = TestServer(certs)  # not started: these fail before connecting
    path = config_file(tmp_path, server, certs)
    assert main(["opcua", "browse", "-c", str(path), "--connector", "nope"]) == 2
    assert "no [[opcua]] named 'nope'; there are: press-line" in capsys.readouterr().err
    (tmp_path / "plain").mkdir()
    plain = write_config(tmp_path / "plain", "https://tiles.example.com")
    assert main(["opcua", "browse", "-c", str(plain)]) == 2
    assert "there is no [[opcua]] connector" in capsys.readouterr().err


def test_opcua_commands_dont_need_the_agent_token(server: TestServer, certs: Certs, tmp_path: Path) -> None:
    path = config_file(tmp_path, server, certs)
    (tmp_path / "token").unlink()
    with pytest.raises(ConfigError, match=r"can.t read the token file"):
        load(path, env={})
    assert main(["opcua", "cert", "-c", str(path)]) == 0
