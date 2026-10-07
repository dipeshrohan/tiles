"""A real MQTT broker (amqtt) on a free local port, over TLS, run on its own thread for the tests."""

import asyncio
import socket
import threading
import time
from collections.abc import Coroutine
from pathlib import Path
from typing import Any

import paho.mqtt.client as paho
from amqtt.broker import Broker
from paho.mqtt.enums import CallbackAPIVersion


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port: int = s.getsockname()[1]
        return port


class TestBroker:
    __test__ = False  # not a pytest class

    def __init__(self, cert: Path, key: Path, *, tls: bool = True, port: int | None = None) -> None:
        self.cert, self.key, self.tls = cert, key, tls
        self.port = port or free_port()
        self.url = f"{'mqtts' if tls else 'mqtt'}://localhost:{self.port}"
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._broker: Broker | None = None

    def _call[T](self, coro: Coroutine[Any, Any, T]) -> T:
        assert self._loop is not None
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(15)

    def start(self) -> "TestBroker":
        listener: dict[str, Any] = {"type": "tcp", "bind": f"127.0.0.1:{self.port}"}
        if self.tls:
            listener |= {"ssl": True, "certfile": str(self.cert), "keyfile": str(self.key)}
        config = {
            "listeners": {"default": listener},
            "plugins": {"amqtt.plugins.authentication.AnonymousAuthPlugin": {"allow_anonymous": True}},
        }
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._thread.start()

        async def start() -> Broker:
            broker = Broker(config)
            await broker.start()
            return broker

        self._broker = self._call(start())
        return self

    def publish(self, topic: str, payload: bytes, retain: bool = False) -> None:
        """Publishes as another client would, over the same TLS listener."""
        client = paho.Client(CallbackAPIVersion.VERSION2, client_id=f"publisher-{time.monotonic_ns()}")
        if self.tls:
            client.tls_set(ca_certs=str(self.cert))
        client.connect("localhost", self.port)
        client.loop_start()
        try:
            client.publish(topic, payload, qos=1, retain=retain).wait_for_publish(10)
        finally:
            client.disconnect()
            client.loop_stop()

    def stop(self) -> None:
        if self._loop is None or self._thread is None:
            return
        if self._broker is not None:
            self._call(self._broker.shutdown())
            self._broker = None
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(10)
        self._loop.close()
        self._loop = self._thread = None
