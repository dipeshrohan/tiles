import asyncio
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tiles_api import store
from tiles_api.main import create_app
from tiles_api.settings import Settings


def test_concurrent_first_requests_share_one_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    created: list[object] = []

    class FakePool:
        def connection(self) -> Any:
            class Ctx:
                def __enter__(self) -> str:
                    return "conn"

                def __exit__(self, *_: object) -> None:
                    return None

            return Ctx()

    def slow_open(_settings: object) -> FakePool:
        time.sleep(0.05)  # widen the race window
        pool = FakePool()
        created.append(pool)
        return pool

    monkeypatch.setattr(store, "open_pool", slow_open)
    state = SimpleNamespace(pool=None, settings=object())
    request = SimpleNamespace(app=SimpleNamespace(state=state))

    def use() -> None:
        conn: object = next(store.get_conn(request, None))  # type: ignore[arg-type]
        assert conn == "conn"

    threads = [threading.Thread(target=use) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(created) == 1
    assert state.pool is created[0]


def test_more_requests_than_connections_wait_their_turn(database_url: str) -> None:
    """Many more requests than connections (the load test, T5.15): they queue for a connection
    without holding worker threads, so every one is answered, and quickly. Before, the threads
    blocked on the pool left none for the requests holding a connection, and all stalled."""
    settings = Settings(_env_file=None, env="test", database_url=database_url, db_pool_max=2, db_wait_seconds=20)
    with TestClient(create_app(settings)) as client:
        started = time.monotonic()
        with ThreadPoolExecutor(max_workers=80) as workers:
            codes = list(workers.map(lambda _: client.get("/sites").status_code, range(240)))
        took = time.monotonic() - started
    assert codes == [200] * 240
    assert took < 15, f"{took:.1f} s"


def test_a_request_that_cant_get_a_connection_in_time_is_told_to_retry(database_url: str) -> None:
    settings = Settings(_env_file=None, env="test", database_url=database_url, db_wait_seconds=0.2)
    app = create_app(settings)
    with TestClient(app) as client:
        loop: asyncio.AbstractEventLoop = client.portal.call(asyncio.get_running_loop)  # type: ignore[union-attr]
        app.state.db_slots = (loop, asyncio.Semaphore(0))  # every connection busy
        res = client.get("/sites")
    assert res.status_code == 503
    assert res.headers["retry-after"] == "2"
    assert res.json()["detail"] == "Tiles is busy: try again in a moment"
