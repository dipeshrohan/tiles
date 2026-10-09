"""Credentials kept in the database, sealed (T5.06): AES-256-GCM with a data key from the settings
(`TILES_DATA_KEYS`), never the key itself in the database.

A sealed value is `tiles:v1:<key id>:<base64 of nonce and ciphertext>`. It is bound to what it is
(`context`, e.g. "teams:<site id>"), so a value copied to another row or column won't open. Keys
are named, so several can be set at once: the first seals, any of them opens. Rotating is adding
a new key first, re-sealing (`tiles-rotate-keys`), then dropping the old one. A value that isn't
sealed (stored before keys were set, or in development without them) reads as it is.
"""

import argparse
import base64
import binascii
import functools
import os
import re
import sys
import uuid
from dataclasses import dataclass

import psycopg
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg.rows import dict_row

from tiles_api.settings import Settings, get_settings
from tiles_api.store import UNSCOPED, Conn

PREFIX = "tiles:v1:"
KEY_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


class SealError(ValueError):
    pass


@dataclass(frozen=True)
class DataKeys:
    keys: tuple[tuple[str, bytes], ...]  # (id, 32-byte key); the first seals

    @classmethod
    def parse(cls, spec: str | None) -> "DataKeys | None":
        """`id:base64key[,id:base64key…]`, as TILES_DATA_KEYS holds them; None when unset."""
        if not spec or not spec.strip():
            return None
        keys: list[tuple[str, bytes]] = []
        for part in spec.split(","):
            kid, _, encoded = part.strip().partition(":")
            if not KEY_ID.match(kid):
                raise SealError(f"A data key's id must be 1 to 32 letters, digits, - or _: got {kid!r}")
            try:
                key = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError):
                raise SealError(f"Data key {kid} isn't base64") from None
            if len(key) != 32:
                raise SealError(f"Data key {kid} must be 32 bytes (AES-256), not {len(key)}")
            if any(k == kid for k, _ in keys):
                raise SealError(f"Data key {kid} is given twice")
            keys.append((kid, key))
        return cls(tuple(keys))

    @property
    def current(self) -> str:
        return self.keys[0][0]

    def seal(self, plaintext: str, context: str) -> str:
        kid, key = self.keys[0]
        nonce = os.urandom(12)
        body = AESGCM(key).encrypt(nonce, plaintext.encode(), context.encode())
        return f"{PREFIX}{kid}:{base64.b64encode(nonce + body).decode()}"

    def unseal(self, value: str, context: str) -> str:
        if not is_sealed(value):
            return value  # stored before keys were set
        kid, _, encoded = value.removeprefix(PREFIX).partition(":")
        key = dict(self.keys).get(kid)
        if key is None:
            raise SealError(f"Sealed with data key {kid}, which isn't set: add it to TILES_DATA_KEYS")
        raw = base64.b64decode(encoded)
        try:
            return AESGCM(key).decrypt(raw[:12], raw[12:], context.encode()).decode()
        except Exception as e:  # InvalidTag: another key's, or another row's
            raise SealError(f"A value sealed with key {kid} doesn't open here (changed, or another row's)") from e

    def needs_resealing(self, value: str) -> bool:
        """Not sealed, or sealed with a key other than the current one."""
        return not is_sealed(value) or not value.removeprefix(PREFIX).startswith(f"{self.current}:")


@functools.lru_cache(maxsize=8)
def _parsed(spec: str | None) -> DataKeys | None:
    return DataKeys.parse(spec)


def keys_of(settings: Settings) -> DataKeys | None:
    """The data keys the settings name (parsed once)."""
    return _parsed(settings.data_keys.get_secret_value() if settings.data_keys else None)


def is_sealed(value: str) -> bool:
    return value.startswith(PREFIX)


def seal(keys: DataKeys | None, plaintext: str, context: str) -> str:
    """Sealed with the current key, or as it is when no keys are set (development)."""
    return keys.seal(plaintext, context) if keys else plaintext


def unseal(keys: DataKeys | None, value: str, context: str) -> str:
    if keys is None:
        if is_sealed(value):
            raise SealError("This value is sealed, but TILES_DATA_KEYS isn't set")
        return value
    return keys.unseal(value, context)


def new_key(kid: str) -> str:
    """A fresh `id:base64key` to add to TILES_DATA_KEYS."""
    if not KEY_ID.match(kid):
        raise SealError("A key id is 1 to 32 letters, digits, - or _")
    return f"{kid}:{base64.b64encode(os.urandom(32)).decode()}"


def main(argv: list[str] | None = None) -> None:
    """tiles-rotate-keys: re-seals every stored credential with the current data key (also seals
    ones stored before keys were set); `--new-key ID` prints a fresh key instead."""
    parser = argparse.ArgumentParser(prog="tiles-rotate-keys", description=main.__doc__)
    parser.add_argument("--new-key", metavar="ID", help="print a new data key with this id, and stop")
    args = parser.parse_args(argv)
    if args.new_key:
        print(new_key(args.new_key))
        return
    settings = get_settings()
    keys = keys_of(settings)
    if keys is None:
        print("TILES_DATA_KEYS isn't set: nothing to seal with", file=sys.stderr)
        sys.exit(2)
    with psycopg.connect(settings.database_url, row_factory=dict_row, options=UNSCOPED) as conn:
        resealed = reseal(conn, keys)
    print(f"{resealed} value(s) sealed with key {keys.current}")


def reseal(conn: Conn, keys: DataKeys) -> int:
    """Re-seals the stored credentials not sealed with the current key; how many. One transaction."""
    rows = conn.execute(
        "SELECT site_id, teams_webhook_url FROM site_notifications WHERE teams_webhook_url IS NOT NULL FOR UPDATE"
    ).fetchall()
    n = 0
    for r in rows:
        value = r["teams_webhook_url"]
        if not keys.needs_resealing(value):
            continue
        context = teams_context(r["site_id"])
        conn.execute(
            "UPDATE site_notifications SET teams_webhook_url = %s WHERE site_id = %s",
            [keys.seal(keys.unseal(value, context), context), r["site_id"]],
        )
        n += 1
    return n


def teams_context(site_id: uuid.UUID | str) -> str:
    """What a site's Teams webhook URL is sealed as."""
    return f"teams:{site_id}"
