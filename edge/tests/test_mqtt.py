"""MQTT connector (T2.03) against a real broker (amqtt) over TLS."""

import dataclasses
import json
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeTiles, write_config
from mqtt_broker import TestBroker
from sparkplug_encode import metric, payload

from tiles_edge import sparkplug as sp
from tiles_edge.cli import main
from tiles_edge.config import ConfigError, MqttConfig, MqttTopic, load
from tiles_edge.mqtt import MqttConnector, _plain
from tiles_edge.samples import MemoryBuffer


@pytest.fixture
def broker(certificate: tuple[Path, Path]) -> Iterator[TestBroker]:
    b = TestBroker(*certificate).start()
    yield b
    b.stop()


def mqtt_config(broker: TestBroker, ca: Path | None, **changes: Any) -> MqttConfig:
    base = MqttConfig(
        name="line-2",
        host="localhost",
        port=broker.port,
        tls=broker.tls,
        ca_file=ca,
        client_certificate=None,
        client_key=None,
        username=None,
        password_file=None,
        client_id=f"tiles-test-{time.monotonic_ns()}",
        qos=1,
        topics=(
            MqttTopic("plant/press1/temperature", "value", "press1.temperature", "value", None, {}),
            MqttTopic("plant/press1/state", "json", "press1.speed", "data.speed", "data.ts", {}),
            MqttTopic(
                "spBv1.0/plant/+/edge-1/#", "sparkplug", None, "value", None, {"Press1/Current": "press1.current"}
            ),
        ),
    )
    return dataclasses.replace(base, **changes)


def wait_for(check: Callable[[], bool], seconds: float = 15) -> None:
    deadline = time.monotonic() + seconds
    while not check():
        assert time.monotonic() < deadline, "timed out"
        time.sleep(0.05)


def running(config: MqttConfig, buffer: MemoryBuffer) -> MqttConnector:
    connector = MqttConnector(config, buffer, max_retry_seconds=0.5)
    connector.start()
    return connector


def values(buffer: MemoryBuffer) -> dict[str, list[Any]]:
    out: dict[str, list[Any]] = {}
    for s in list(buffer._samples):
        out.setdefault(s.signal, []).append(s.value)
    return out


def test_value_json_and_sparkplug_payloads_become_samples(broker: TestBroker, certificate: tuple[Path, Path]) -> None:
    buffer = MemoryBuffer()
    connector = running(mqtt_config(broker, certificate[0]), buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        assert connector.status()["detail"].startswith(f"subscribed to 3 topics at mqtts://localhost:{broker.port}")
        broker.publish("plant/press1/temperature", b"21.5")
        broker.publish("plant/press1/state", json.dumps({"data": {"speed": 120, "ts": 1_760_000_000_000}}).encode())
        broker.publish(
            "spBv1.0/plant/DBIRTH/edge-1/press-1",
            payload(metric("Press1/Current", alias=3, value=4.0), metric("Press1/Other", alias=4, value=1.0)),
        )
        broker.publish("spBv1.0/plant/DDATA/edge-1/press-1", payload(metric(alias=3, value=4.5, timestamp_ms=1_000)))
        wait_for(lambda: len(values(buffer).get("press1.current", [])) == 2)
        wait_for(lambda: "press1.speed" in values(buffer))
        assert values(buffer) == {"press1.temperature": [21.5], "press1.speed": [120], "press1.current": [4.0, 4.5]}
        speed = next(s for s in buffer._samples if s.signal == "press1.speed")
        assert speed.at.timestamp() == 1_760_000_000
        assert "4 samples" in connector.status()["detail"]
    finally:
        connector.stop()
    assert connector.status()["detail"].startswith("stopped")


def test_unreadable_messages_are_counted_not_fatal(broker: TestBroker, certificate: tuple[Path, Path]) -> None:
    buffer = MemoryBuffer()
    connector = running(mqtt_config(broker, certificate[0]), buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        broker.publish("plant/press1/state", b"{not json")
        broker.publish("plant/press1/state", json.dumps({"data": {"speed": [1, 2]}}).encode())
        broker.publish("spBv1.0/plant/DDATA/edge-1/press-1", b"\x12\x05abc")
        wait_for(lambda: connector.unreadable == 3)
        assert connector.status()["status"] == "ok"
        assert "3 unreadable messages (last: spBv1.0/plant/DDATA/edge-1/press-1:" in connector.status()["detail"]
        broker.publish("plant/press1/temperature", b"20")
        wait_for(lambda: values(buffer) == {"press1.temperature": [20]})
    finally:
        connector.stop()


def tls_endpoint(tls_tiles: FakeTiles) -> TestBroker:
    """A TLS listener with the test certificate. The handshake fails before any MQTT is spoken,
    so a plain TLS server will do (and, unlike the test broker, closes failed handshakes cleanly)."""
    endpoint = TestBroker(Path("unused"), Path("unused"))
    endpoint.port = int(tls_tiles.url.rsplit(":", 1)[1])
    return endpoint


def test_a_broker_whose_certificate_isnt_trusted_is_refused(tls_tiles: FakeTiles) -> None:
    connector = running(mqtt_config(tls_endpoint(tls_tiles), None), MemoryBuffer())  # no ca_file: self-signed
    try:
        wait_for(lambda: "certificate isn't trusted" in connector.status()["detail"])
        assert connector.status()["status"] == "down"
    finally:
        connector.stop()


def test_the_brokers_host_name_is_checked(tls_tiles: FakeTiles, certificate: tuple[Path, Path]) -> None:
    # The certificate is for localhost; 127.0.0.1 is the same machine but not the name on it.
    config = mqtt_config(tls_endpoint(tls_tiles), certificate[0], host="127.0.0.1")
    connector = running(config, MemoryBuffer())
    try:
        wait_for(lambda: "certificate isn't trusted" in connector.status()["detail"])
        assert "127.0.0.1" in connector.status()["detail"]
    finally:
        connector.stop()


def test_it_reconnects_when_the_broker_comes_back(certificate: tuple[Path, Path]) -> None:
    broker = TestBroker(*certificate).start()
    buffer = MemoryBuffer()
    connector = running(mqtt_config(broker, certificate[0]), buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        broker.stop()
        wait_for(lambda: connector.status()["status"] == "down", 20)
        wait_for(lambda: connector._failures >= 2, 20)
        broker = TestBroker(*certificate, port=broker.port).start()
        wait_for(lambda: connector.status()["status"] == "ok", 30)
        assert connector._failures == 0
        broker.publish("plant/press1/temperature", b"true")
        wait_for(lambda: values(buffer) == {"press1.temperature": [True]})
    finally:
        connector.stop()
        broker.stop()


def test_plain_mqtt_works_when_allowed(certificate: tuple[Path, Path]) -> None:
    broker = TestBroker(*certificate, tls=False).start()
    buffer = MemoryBuffer()
    connector = running(mqtt_config(broker, None, tls=False), buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        assert "mqtt://localhost" in connector.status()["detail"]
        broker.publish("plant/press1/temperature", b"running")
        wait_for(lambda: values(buffer) == {"press1.temperature": ["running"]})
    finally:
        connector.stop()
        broker.stop()


@pytest.mark.parametrize(
    ("raw", "value"),
    [(b"21.5", 21.5), (b" 7\n", 7), (b"1e3", 1000.0), (b"TRUE", True), (b"false", False), (b"open", "open")],
)
def test_plain_values(raw: bytes, value: object) -> None:
    assert _plain(raw) == value
    assert type(_plain(raw)) is type(value)


def test_aliases_are_forgotten_on_reconnect_until_the_next_birth(certificate: tuple[Path, Path]) -> None:
    broker = TestBroker(*certificate).start()
    buffer = MemoryBuffer()
    connector = running(mqtt_config(broker, certificate[0]), buffer)
    try:
        wait_for(lambda: connector.status()["status"] == "ok")
        broker.publish("spBv1.0/plant/DBIRTH/edge-1/press-1", payload(metric("Press1/Current", alias=3, value=4.0)))
        wait_for(lambda: values(buffer).get("press1.current") == [4.0])
        # The node restarts while we're away and gives alias 3 to another metric...
        broker.stop()
        wait_for(lambda: connector.status()["status"] == "down", 20)
        broker = TestBroker(*certificate, port=broker.port).start()
        wait_for(lambda: connector.status()["status"] == "ok", 30)
        # ...so data by alias waits for a BIRTH heard on this connection.
        broker.publish("spBv1.0/plant/DDATA/edge-1/press-1", payload(metric(alias=3, value=99.0)))
        wait_for(lambda: connector.awaiting_birth == 1)
        assert "1 metrics by alias awaiting their BIRTH" in connector.status()["detail"]
        broker.publish("spBv1.0/plant/DBIRTH/edge-1/press-1", payload(metric("Press1/Current", alias=5, value=5.0)))
        broker.publish("spBv1.0/plant/DDATA/edge-1/press-1", payload(metric(alias=5, value=5.5)))
        wait_for(lambda: values(buffer).get("press1.current") == [4.0, 5.0, 5.5])
    finally:
        connector.stop()
        broker.stop()


def test_a_host_state_message_is_not_unreadable() -> None:
    config = mqtt_config(TestBroker(Path("c"), Path("k")), None)
    config = dataclasses.replace(config, topics=(MqttTopic("spBv1.0/#", "sparkplug", None, "value", None, {"a": "b"}),))
    connector = MqttConnector(config, MemoryBuffer())
    assert connector.read("spBv1.0/STATE/scada-1", b'{"online": true, "timestamp": 1}') == []


def test_sparkplug_ignores_commands_and_unmapped_metrics() -> None:
    connector = MqttConnector(mqtt_config(TestBroker(Path("c"), Path("k")), None), MemoryBuffer())
    assert connector.read("spBv1.0/plant/DCMD/edge-1/press-1", payload(metric("Press1/Current", value=1.0))) == []
    assert connector.read("spBv1.0/plant/DDATA/edge-1/x", payload(metric("Unmapped", value=1.0))) == []
    [sample] = connector.read(
        "spBv1.0/plant/NDATA/edge-1", payload(metric("Press1/Current", datatype=sp.INT32, value=-3))
    )
    assert (sample.signal, sample.value) == ("press1.current", -3)
    assert connector.read("plant/other", b"1") == []  # not mapped


# ---- config and commands ------------------------------------------------------------------------

MQTT = """
[[mqtt]]
name = "line-2"
broker = "{broker}"
{extra}
[[mqtt.topics]]
topic = "plant/press1/temperature"
format = "value"
signal = "press1.temperature"
"""


def with_mqtt(
    tmp_path: Path, broker: str = "mqtts://broker.plant.local", extra: str = "", url: str = "https://tiles.example.com"
) -> Path:
    path = write_config(tmp_path, url)
    path.write_text(path.read_text() + MQTT.format(broker=broker, extra=extra))
    return path


def test_an_mqtt_connector_loads_with_secure_defaults(tmp_path: Path) -> None:
    [c] = load(with_mqtt(tmp_path), env={}).mqtt
    assert (c.host, c.port, c.tls, c.qos, c.broker) == (
        "broker.plant.local",
        8883,
        True,
        1,
        "mqtts://broker.plant.local:8883",
    )
    # MQTT 3.1.1 brokers need only accept 1-23 letters and digits; the default is stable per host and connector.
    assert len(c.client_id) == 23 and c.client_id.isalnum() and c.client_id.startswith("tiles")
    assert load(with_mqtt(tmp_path), env={}).mqtt[0].client_id == c.client_id
    assert c.signals == ["press1.temperature"]


@pytest.mark.parametrize(
    ("broker", "extra", "message"),
    [
        ("mqtt://broker", "", "set allow_unsecured = true"),
        ("mqtt://broker", 'allow_unsecured = true\nusername = "u"\npassword_file = "p"', "need mqtts://"),
        ("mqtt://broker", 'allow_unsecured = true\nca_file = "ca.pem"', "need an mqtts:// broker"),
        ("http://broker", "", "broker must be an mqtts:// address"),
        ("mqtts://broker:x", "", "invalid port"),
        ("mqtts://broker", "qos = 2", "qos must be 0 or 1"),
        ("mqtts://broker", 'client_certificate = "c.pem"', "set client_certificate and client_key together"),
        ("mqtts://broker", 'password_file = "p"', "set username and password_file together"),
        ("mqtts://broker", 'username = "u"', "set username and password_file together"),
    ],
)
def test_mqtt_settings_are_checked(tmp_path: Path, broker: str, extra: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load(with_mqtt(tmp_path, broker, extra), env={})


@pytest.mark.parametrize(
    ("topic", "message"),
    [
        ('topic = "plant/+/temp"\nformat = "json"\nsignal = "a"', "has a wildcard"),
        ('topic = "plant/x"\nformat = "xml"\nsignal = "a"', "format must be one of"),
        ('topic = "plant/x"\nformat = "value"\nsignal = "a"\nvalue_path = "v"', "json topics only"),
        ('topic = "spBv1.0/plant/#"\nformat = "sparkplug"', "needs metrics"),
        ('topic = "plant/#"\nformat = "sparkplug"\nmetrics = { a = "b" }', "start with spBv1.0/"),
        ('topic = "spBv1.0/plant/#/edge-1"\nformat = "sparkplug"\nmetrics = { a = "b" }', "misplaces a wildcard"),
        ('topic = "spBv1.0/plant/D+/edge-1"\nformat = "sparkplug"\nmetrics = { a = "b" }', "misplaces a wildcard"),
        ('topic = "plant/x"\nformat = "json"\nsignal = "Bad Signal"', "must be a Tiles signal ID"),
    ],
)
def test_mqtt_topic_mistakes_are_explained(tmp_path: Path, topic: str, message: str) -> None:
    path = write_config(tmp_path, "https://tiles.example.com")
    path.write_text(path.read_text() + f'[[mqtt]]\nname = "m"\nbroker = "mqtts://b"\n[[mqtt.topics]]\n{topic}\n')
    with pytest.raises(ConfigError, match=message):
        load(path, env={})


def test_signals_are_unique_across_opcua_and_mqtt(tmp_path: Path) -> None:
    from test_config import OPCUA

    path = with_mqtt(tmp_path)
    path.write_text(path.read_text() + OPCUA.format(extra=""))
    with pytest.raises(ConfigError, match=r"signal 'press1\.temperature' appears more than once"):
        load(path, env={})


def test_check_tries_mqtt_connectors(
    broker: TestBroker,
    certificate: tuple[Path, Path],
    tiles: FakeTiles,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = with_mqtt(tmp_path, broker.url, f'ca_file = "{certificate[0]}"', url=tiles.url)
    assert main(["check", "-c", str(path)]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["connectors"] == {"line-2": "ok"}
    [status] = tiles.requests[0]["body"]["connectors"]
    assert (status["name"], status["kind"], status["status"]) == ("line-2", "mqtt", "ok")
    (tmp_path / "x").mkdir()
    unreachable = with_mqtt(tmp_path / "x", "mqtts://localhost:9", url=tiles.url)
    assert main(["check", "-c", str(unreachable)]) == 4
    assert "the broker refused the connection" in json.loads(capsys.readouterr().out)["connectors"]["line-2"]


def test_mqtt_without_the_extra_is_a_config_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import sys

    monkeypatch.setitem(sys.modules, "tiles_edge.mqtt", None)  # as if paho-mqtt weren't installed
    assert main(["run", "-c", str(with_mqtt(tmp_path))]) == 2
    assert 'pip install "tiles-edge[mqtt]"' in capsys.readouterr().err


def test_check_reports_a_degraded_broker_as_degraded(
    tiles: FakeTiles, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    detail = "subscribed to 1 of 2 topics; the broker refused: plant/x (Not authorized)"
    monkeypatch.setattr(MqttConnector, "try_once", lambda self, timeout=10: ("degraded", detail))
    assert main(["check", "-c", str(with_mqtt(tmp_path, url=tiles.url))]) == 4
    assert json.loads(capsys.readouterr().out)["connectors"] == {"line-2": detail}
    [status] = tiles.requests[0]["body"]["connectors"]
    assert (status["status"], status["detail"]) == ("degraded", f"{detail} (tiles-edge check)")
