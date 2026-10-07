"""Builds Sparkplug B payloads for the tests (the protobuf wire format, by hand)."""

import struct

from tiles_edge import sparkplug as sp


def varint(n: int) -> bytes:
    n &= (1 << 64) - 1
    out = bytearray()
    while True:
        byte, n = n & 0x7F, n >> 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field(number: int, wire: int, value: int | bytes) -> bytes:
    key = varint(number << 3 | wire)
    if wire == 0:
        assert isinstance(value, int)
        return key + varint(value)
    assert isinstance(value, bytes)
    return key + (varint(len(value)) + value if wire == 2 else value)


def metric(
    name: str | None = None,
    *,
    alias: int | None = None,
    datatype: int = sp.DOUBLE,
    value: float | int | bool | str | None = None,
    timestamp_ms: int | None = None,
) -> bytes:
    out = b""
    if name is not None:
        out += field(1, 2, name.encode())
    if alias is not None:
        out += field(2, 0, alias)
    if timestamp_ms is not None:
        out += field(3, 0, timestamp_ms)
    out += field(4, 0, datatype)
    if value is None:
        return out + field(7, 0, 1)
    if datatype in (sp.INT8, sp.INT16, sp.INT32, sp.UINT8, sp.UINT16, sp.UINT32):
        assert isinstance(value, int)
        out += field(10, 0, value & 0xFFFFFFFF)
    elif datatype in (sp.INT64, sp.UINT64, sp.DATETIME):
        assert isinstance(value, int)
        out += field(11, 0, value)
    elif datatype == sp.FLOAT:
        assert isinstance(value, float)
        out += field(12, 5, struct.pack("<f", value))
    elif datatype == sp.DOUBLE:
        assert isinstance(value, float)
        out += field(13, 1, struct.pack("<d", value))
    elif datatype == sp.BOOLEAN:
        out += field(14, 0, int(bool(value)))
    elif datatype in (sp.STRING, sp.TEXT):
        assert isinstance(value, str)
        out += field(15, 2, value.encode())
    return out


def payload(*metrics: bytes, timestamp_ms: int | None = None, seq: int = 0) -> bytes:
    out = field(1, 0, timestamp_ms) if timestamp_ms is not None else b""
    out += b"".join(field(2, 2, m) for m in metrics)
    return out + field(3, 0, seq)
