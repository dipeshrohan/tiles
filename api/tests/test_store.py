import threading
import time
from types import SimpleNamespace
from typing import Any

import pytest

from tiles_api import store


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
        conn: object = next(store.get_conn(request))  # type: ignore[arg-type]
        assert conn == "conn"

    threads = [threading.Thread(target=use) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(created) == 1
    assert state.pool is created[0]
