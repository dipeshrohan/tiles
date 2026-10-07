"""Sparkplug B decoding (T2.03), against payloads built byte by byte."""

import gzip
import zlib
from datetime import UTC, datetime

import pytest
from sparkplug_encode import field, metric, payload

from tiles_edge import sparkplug as sp


def test_scalar_types_decode() -> None:
    raw = payload(
        metric("i8", datatype=sp.INT8, value=-5),
        metric("i32", datatype=sp.INT32, value=-70000),
        metric("i64", datatype=sp.INT64, value=-(2**40)),
        metric("u16", datatype=sp.UINT16, value=65000),
        metric("u64", datatype=sp.UINT64, value=2**60),
        metric("f", datatype=sp.FLOAT, value=1.5),
        metric("d", datatype=sp.DOUBLE, value=21.25),
        metric("b", datatype=sp.BOOLEAN, value=True),
        metric("s", datatype=sp.STRING, value="running"),
        metric("t", datatype=sp.DATETIME, value=1_760_000_000_000),
        timestamp_ms=1_760_000_000_000,
    )
    stamp, metrics = sp.decode(raw)
    assert stamp == datetime.fromtimestamp(1_760_000_000, UTC)
    assert {m.name: m.value for m in metrics} == {
        "i8": -5,
        "i32": -70000,
        "i64": -(2**40),
        "u16": 65000,
        "u64": 2**60,
        "f": 1.5,
        "d": 21.25,
        "b": True,
        "s": "running",
        "t": "2025-10-09T08:53:20+00:00",
    }
    assert all(m.timestamp == stamp for m in metrics)  # no own timestamp: the payload's


def test_nulls_and_unsupported_types_have_no_value() -> None:
    dataset = field(1, 2, b"ds") + field(4, 0, 16) + field(17, 2, b"\x08\x01")
    _, metrics = sp.decode(payload(metric("n", datatype=sp.DOUBLE, value=None), dataset))
    assert [(m.name, m.value) for m in metrics] == [("n", None), ("ds", None)]


def test_a_metric_keeps_its_own_timestamp() -> None:
    _, [m] = sp.decode(payload(metric("d", value=1.0, timestamp_ms=1_000), timestamp_ms=2_000))
    assert m.timestamp == datetime.fromtimestamp(1, UTC)


@pytest.mark.parametrize("raw", [b"\x12\x05abc", b"\x08", b"\x0b", b"\x11\x01\x02"])
def test_broken_payloads_are_refused(raw: bytes) -> None:
    with pytest.raises(sp.SparkplugError):
        sp.decode(raw)


def test_topics() -> None:
    t = sp.parse_topic("spBv1.0/plant/DDATA/edge-1/press-1")
    assert (t.group, t.message_type, t.edge_node, t.device) == ("plant", "DDATA", "edge-1", "press-1")
    assert sp.parse_topic("spBv1.0/plant/NDATA/edge-1").device is None
    state = sp.parse_topic("spBv1.0/STATE/scada-1")
    assert (state.message_type, state.edge_node) == ("STATE", "scada-1")
    for bad in ("spBv1.0/plant", "spAv1.0/a/b/c", "spBv1.0/a/b/c/d/e"):
        with pytest.raises(sp.SparkplugError):
            sp.parse_topic(bad)


def test_aliases_come_from_the_birth_and_go_with_the_death() -> None:
    book = sp.AliasBook()
    birth = sp.parse_topic("spBv1.0/plant/DBIRTH/edge-1/press-1")
    data = sp.parse_topic("spBv1.0/plant/DDATA/edge-1/press-1")
    other = sp.parse_topic("spBv1.0/plant/DDATA/edge-1/press-2")
    _, born = sp.decode(payload(metric("Press1/Temperature", alias=7, value=20.0)))
    book.learn(birth, born)
    _, [by_alias] = sp.decode(payload(metric(alias=7, value=21.0)))
    assert book.name(data, by_alias) == "Press1/Temperature"
    assert book.name(other, by_alias) is None  # aliases belong to one device
    book.learn(sp.parse_topic("spBv1.0/plant/DDEATH/edge-1/press-1"), [])
    assert book.name(data, by_alias) is None


def compressed(inner: bytes, algorithm: str | None) -> bytes:
    body = gzip.compress(inner) if algorithm == "GZIP" else zlib.compress(inner)
    metrics = [metric("algorithm", datatype=sp.STRING, value=algorithm)] if algorithm else []
    return payload(*metrics) + field(4, 2, sp.COMPRESSED_UUID) + field(5, 2, body)


@pytest.mark.parametrize("algorithm", ["GZIP", "DEFLATE", None])  # None: DEFLATE is the default
def test_compressed_payloads_are_unpacked(algorithm: str | None) -> None:
    inner = payload(metric("Press1/Current", value=4.5), timestamp_ms=1_000)
    stamp, [m] = sp.decode(compressed(inner, algorithm))
    assert (m.name, m.value, stamp) == ("Press1/Current", 4.5, datetime.fromtimestamp(1, UTC))


def test_compressed_payloads_are_checked() -> None:
    with pytest.raises(sp.SparkplugError, match="unsupported compression 'LZ4'"):
        sp.decode(compressed(payload(), "LZ4"))
    with pytest.raises(sp.SparkplugError, match="can't uncompress"):
        sp.decode(payload() + field(4, 2, sp.COMPRESSED_UUID) + field(5, 2, b"not deflate"))
    with pytest.raises(sp.SparkplugError, match="without a body"):
        sp.decode(field(4, 2, sp.COMPRESSED_UUID))
    bomb = zlib.compress(b"\0" * (sp.MAX_UNCOMPRESSED + 1))  # small packed, too big unpacked
    with pytest.raises(sp.SparkplugError, match="larger than 16 MiB"):
        sp.decode(payload() + field(4, 2, sp.COMPRESSED_UUID) + field(5, 2, bomb))
    twice = compressed(compressed(payload(), None), None)
    with pytest.raises(sp.SparkplugError, match="inside a compressed payload"):
        sp.decode(twice)
