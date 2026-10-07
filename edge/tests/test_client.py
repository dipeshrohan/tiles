from pathlib import Path

import pytest
from conftest import TOKEN, FakeTiles, write_config

from tiles_edge import __version__
from tiles_edge.client import RejectedError, TilesClient, TransientError
from tiles_edge.config import load


def client(tmp_path: Path, url: str, extra: str = "") -> TilesClient:
    return TilesClient(load(write_config(tmp_path, url, extra), env={}))


def test_posts_json_with_the_agent_token(tmp_path: Path, tiles: FakeTiles) -> None:
    answer = client(tmp_path, tiles.url).post("/agent/heartbeat", {"hello": 1})
    assert answer["agent_id"] == "a-1"
    [request] = tiles.requests
    assert (request["path"], request["body"]) == ("/agent/heartbeat", {"hello": 1})
    assert request["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert request["headers"]["Content-Type"] == "application/json"
    assert request["headers"]["User-Agent"] == f"tiles-edge/{__version__}"


@pytest.mark.parametrize(
    ("status", "error"),
    [(401, RejectedError), (403, RejectedError), (422, RejectedError), (429, TransientError), (503, TransientError)],
)
def test_answers_are_sorted_into_retry_or_give_up(tmp_path: Path, tiles: FakeTiles, status: int, error: type) -> None:
    tiles.answers = [(status, {"detail": "nope"})]
    with pytest.raises(error, match=f"Tiles answered {status}: nope"):
        client(tmp_path, tiles.url).post("/agent/heartbeat", {})


def test_an_unreachable_or_garbled_tiles_is_transient(tmp_path: Path, tiles: FakeTiles) -> None:
    with pytest.raises(TransientError, match="can't reach"):
        client(tmp_path, "http://127.0.0.1:9").post("/agent/heartbeat", {})
    tiles.answers = [(200, b"<html>proxy login</html>")]
    with pytest.raises(TransientError, match="unreadable answer"):
        client(tmp_path, tiles.url).post("/agent/heartbeat", {})


def test_tls_certificates_are_verified(tmp_path: Path, tls_tiles: FakeTiles, certificate: tuple[Path, Path]) -> None:
    # A self-signed certificate isn't trusted by default...
    with pytest.raises(TransientError, match="CERTIFICATE_VERIFY_FAILED"):
        client(tmp_path, tls_tiles.url).post("/agent/heartbeat", {})
    assert tls_tiles.requests == []
    # ...but is once its CA is configured.
    answer = client(tmp_path, tls_tiles.url, f'ca_file = "{certificate[0]}"').post("/agent/heartbeat", {})
    assert answer["agent_id"] == "a-1"
