"""Sparkplug B payloads (Eclipse Sparkplug 3.0), decoded with the standard library.

A Sparkplug payload is a protobuf message:

    Payload { uint64 timestamp = 1; repeated Metric metrics = 2; uint64 seq = 3; … }
    Metric  { string name = 1; uint64 alias = 2; uint64 timestamp = 3; uint32 datatype = 4;
              bool is_null = 7; uint32 int_value = 10; uint64 long_value = 11;
              float float_value = 12; double double_value = 13; bool boolean_value = 14;
              string string_value = 15; … }

Only scalar metrics are read (integers, floats, booleans, text and date-times);
datasets, templates, bytes and the like are skipped. Rather than pull in a
protobuf library, this reads the wire format directly: it is small and stable.

Devices may send a metric by alias only once its BIRTH message has named it,
so `AliasBook` remembers each edge node's and device's aliases.
"""

import struct
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal

# Sparkplug data types (the ones read here)
INT8, INT16, INT32, INT64 = 1, 2, 3, 4
UINT8, UINT16, UINT32, UINT64 = 5, 6, 7, 8
FLOAT, DOUBLE, BOOLEAN, STRING, DATETIME, TEXT = 9, 10, 11, 12, 13, 14
SIGNED_BITS = {INT8: 8, INT16: 16, INT32: 32, INT64: 64}

MessageType = Literal["NBIRTH", "NDATA", "NDEATH", "DBIRTH", "DDATA", "DDEATH", "STATE", "NCMD", "DCMD"]


class SparkplugError(ValueError):
    """The payload or topic isn't valid Sparkplug B."""


@dataclass(frozen=True)
class Metric:
    name: str | None  # None when sent by alias only
    alias: int | None
    timestamp: datetime | None
    value: float | int | bool | str | None  # None: null, or a type this reader skips


@dataclass(frozen=True)
class Topic:
    group: str
    message_type: str
    edge_node: str
    device: str | None

    @property
    def source(self) -> tuple[str, str, str | None]:
        """Whose aliases these are: aliases are scoped to an edge node (and its devices)."""
        return (self.group, self.edge_node, self.device)


def parse_topic(topic: str) -> Topic:
    """spBv1.0/<group>/<type>/<edge node>[/<device>], or a host application's spBv1.0/STATE/<host id>."""
    parts = topic.split("/")
    if len(parts) == 3 and parts[0] == "spBv1.0" and parts[1] == "STATE":
        return Topic("", "STATE", parts[2], None)
    if len(parts) not in (4, 5) or parts[0] != "spBv1.0":
        raise SparkplugError(f"not a Sparkplug B topic: {topic}")
    return Topic(parts[1], parts[2], parts[3], parts[4] if len(parts) == 5 else None)


def _varint(data: bytes, i: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        if i >= len(data):
            raise SparkplugError("payload ends inside a number")
        byte = data[i]
        i += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, i
        shift += 7
        if shift > 63:
            raise SparkplugError("number too long")


def _fields(data: bytes) -> list[tuple[int, int, int | bytes]]:
    """(field number, wire type, value) for each field of one protobuf message."""
    out: list[tuple[int, int, int | bytes]] = []
    i = 0
    while i < len(data):
        key, i = _varint(data, i)
        number, wire = key >> 3, key & 7
        value: int | bytes
        if wire == 0:
            value, i = _varint(data, i)
        elif wire == 1:
            if i + 8 > len(data):
                raise SparkplugError("payload ends inside a 64-bit value")
            value, i = data[i : i + 8], i + 8
        elif wire == 2:
            length, i = _varint(data, i)
            if i + length > len(data):
                raise SparkplugError("payload ends inside a field")
            value, i = data[i : i + length], i + length
        elif wire == 5:
            if i + 4 > len(data):
                raise SparkplugError("payload ends inside a 32-bit value")
            value, i = data[i : i + 4], i + 4
        else:
            raise SparkplugError(f"unsupported protobuf wire type {wire}")
        out.append((number, wire, value))
    return out


def _time(ms: int) -> datetime:
    return datetime.fromtimestamp(ms / 1000, UTC)


def _int(f: dict[int, int | bytes], number: int) -> int | None:
    v = f.get(number)
    return v if isinstance(v, int) else None


def _bytes(f: dict[int, int | bytes], number: int) -> bytes | None:
    v = f.get(number)
    return v if isinstance(v, bytes) else None


def _value(datatype: int, f: dict[int, int | bytes]) -> float | int | bool | str | None:
    if datatype in SIGNED_BITS:
        raw = _int(f, 11 if datatype == INT64 else 10)
        if raw is None:
            return None
        bits = SIGNED_BITS[datatype]
        raw &= (1 << bits) - 1
        return raw - (1 << bits) if raw >= 1 << (bits - 1) else raw  # two's complement
    if datatype in (UINT8, UINT16, UINT32):
        return _int(f, 10)
    if datatype == UINT64:
        return _int(f, 11)
    if datatype == DATETIME:
        ms = _int(f, 11)
        return None if ms is None else _time(ms).isoformat()
    if datatype in (FLOAT, DOUBLE):
        raw_bytes = _bytes(f, 12 if datatype == FLOAT else 13)
        if raw_bytes is None or len(raw_bytes) != (4 if datatype == FLOAT else 8):
            return None
        number: float = struct.unpack("<f" if datatype == FLOAT else "<d", raw_bytes)[0]
        return number
    if datatype == BOOLEAN:
        flag = _int(f, 14)
        return None if flag is None else bool(flag)
    if datatype in (STRING, TEXT):
        text = _bytes(f, 15)
        return None if text is None else text.decode("utf-8", errors="replace")
    return None  # datasets, templates, bytes, files…


def _metric(data: bytes, payload_time: datetime | None) -> Metric:
    f: dict[int, int | bytes] = {}
    for number, _, raw in _fields(data):
        f[number] = raw  # protobuf: the last occurrence wins
    name = f.get(1)
    alias = f.get(2)
    stamp = f.get(3)
    datatype = f.get(4)
    is_null = f.get(7)
    value = None if is_null or not isinstance(datatype, int) else _value(datatype, f)
    return Metric(
        name=name.decode("utf-8", errors="replace") if isinstance(name, bytes) else None,
        alias=alias if isinstance(alias, int) else None,
        timestamp=_time(stamp) if isinstance(stamp, int) else payload_time,
        value=value,
    )


COMPRESSED_UUID = b"SPBV1.0_COMPRESSED"
# A compressed payload may not grow beyond this when unpacked (no zip bombs).
MAX_UNCOMPRESSED = 16 * 1024 * 1024


def _uncompress(body: bytes, algorithm: str) -> bytes:
    """Sparkplug 3.0 compression: DEFLATE (the default) or GZIP, at most MAX_UNCOMPRESSED bytes."""
    if algorithm not in ("DEFLATE", "GZIP"):
        raise SparkplugError(f"unsupported compression {algorithm!r}")
    unpacker = zlib.decompressobj(zlib.MAX_WBITS | 16 if algorithm == "GZIP" else zlib.MAX_WBITS)
    try:
        out = unpacker.decompress(body, MAX_UNCOMPRESSED)
    except zlib.error as e:
        raise SparkplugError(f"can't uncompress the payload: {e}") from None
    if unpacker.unconsumed_tail or not unpacker.eof:
        raise SparkplugError("the compressed payload is incomplete or larger than 16 MiB unpacked")
    return out


def decode(payload: bytes, *, _nested: bool = False) -> tuple[datetime | None, list[Metric]]:
    """The payload's timestamp and its metrics. A metric without its own timestamp takes the payload's.
    A compressed payload (uuid SPBV1.0_COMPRESSED, the real payload in `body`) is unpacked first."""
    fields = _fields(payload)
    if any(n == 4 and v == COMPRESSED_UUID for n, _, v in fields):
        if _nested:
            raise SparkplugError("a compressed payload inside a compressed payload")
        body = next((v for n, w, v in fields if n == 5 and w == 2 and isinstance(v, bytes)), None)
        if body is None:
            raise SparkplugError("a compressed payload without a body")
        outer = [_metric(v, None) for n, w, v in fields if n == 2 and w == 2 and isinstance(v, bytes)]
        algorithm = next((m.value for m in outer if m.name == "algorithm"), "DEFLATE")
        return decode(_uncompress(body, str(algorithm).upper()), _nested=True)
    stamp = next((v for n, w, v in fields if n == 1 and w == 0), None)
    payload_time = _time(stamp) if isinstance(stamp, int) else None
    metrics = [_metric(v, payload_time) for n, w, v in fields if n == 2 and w == 2 and isinstance(v, bytes)]
    return payload_time, metrics


class AliasBook:
    """Alias → metric name per edge node or device, learned from NBIRTH and DBIRTH messages."""

    def __init__(self) -> None:
        self._names: dict[tuple[str, str, str | None], dict[int, str]] = {}

    def learn(self, topic: Topic, metrics: list[Metric]) -> None:
        if topic.message_type in ("NBIRTH", "DBIRTH"):
            # A birth replaces whatever was known: aliases may change between sessions.
            self._names[topic.source] = {m.alias: m.name for m in metrics if m.alias is not None and m.name}
        elif topic.message_type in ("NDEATH", "DDEATH"):
            self._names.pop(topic.source, None)

    def name(self, topic: Topic, metric: Metric) -> str | None:
        if metric.name:
            return metric.name
        if metric.alias is None:
            return None
        return self._names.get(topic.source, {}).get(metric.alias)
