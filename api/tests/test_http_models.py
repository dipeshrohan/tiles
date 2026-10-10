"""Models served over HTTP (T4.15): an organisation registers a model version and its endpoint; its
sites try, run and sweep it like a built-in model, every call checked against the spec."""

import json
import math
import threading
from collections.abc import Callable, Iterator
from datetime import timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, VIEWER, site  # noqa: F401 - site is a fixture
from test_model_runner import CYCLE, SHOTS, T0
from test_onboarding import make_org_admin

from tiles_api import sealed
from tiles_api.main import create_app
from tiles_api.models import remote, runner, store
from tiles_api.models.plunger import PlungerFriction
from tiles_api.models.registry import ModelSpec, Port, registry
from tiles_api.settings import Settings
from tiles_api.store import UNSCOPED


def SETTINGS_OF(api: TestClient) -> Settings:
    settings: Settings = api.app.state.settings  # type: ignore[attr-defined]
    return settings


KEYS = "k1:" + "A" * 43 + "="  # 32 bytes of zeros: a test key
TOKEN = "model-endpoint-secret"  # noqa: S105 - a test token


class Endpoint:
    """A model service on this machine: answers with `reply(request body)`, keeps what it was sent."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.reply: Callable[[dict[str, Any]], tuple[int, bytes, dict[str, str]]] = self.beam
        endpoint = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                endpoint.calls.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                code, data, headers = endpoint.reply(body)
                self.send_response(code)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @staticmethod
    def beam(body: dict[str, Any]) -> tuple[int, bytes, dict[str, str]]:
        """A design model: deflection = load^3 * stiffness factor."""
        p = body["params"]
        return 200, json.dumps({"outputs": {"deflection": [p["load"] ** 3 * p["factor"]]}}).encode(), {}


@pytest.fixture(scope="module")
def endpoint() -> Iterator[Endpoint]:
    e = Endpoint()
    yield e
    e.server.shutdown()
    e.server.server_close()


@pytest.fixture(scope="module")
def api(database_url: str) -> Iterator[TestClient]:
    with TestClient(
        create_app(
            Settings(
                _env_file=None,
                database_url=database_url,
                env="test",
                model_hosts=["127.0.0.1", "localhost"],
                data_keys=KEYS,
            )
        )
    ) as client:
        yield client


@pytest.fixture
def admin(site: str, database_url: str) -> str:  # noqa: F811
    """A site, and admin@example.com an admin of its organisation, which has no HTTP models yet."""
    make_org_admin(database_url, "admin@example.com")
    with psycopg.connect(database_url, options=UNSCOPED) as conn:  # every site's rows
        conn.execute("DELETE FROM design_runs WHERE model_id IN (SELECT id FROM models WHERE source = 'http')")
        conn.execute("DELETE FROM sweeps WHERE model_key LIKE 'beam%'")
        conn.execute("DELETE FROM models WHERE source = 'http'")
    return site


def beam(url: str, **changes: Any) -> dict[str, Any]:
    return {
        "key": "beam-deflection",
        "version": "1.0.0",
        "name": "Beam deflection",
        "kind": "design",
        "domain": "structures",
        "description": "Our FE surrogate",
        "outputs": [{"name": "deflection", "unit": "mm", "per": "window"}],
        "params": [
            {"name": "load", "unit": "kN", "default": 2, "min": 0, "max": 10},
            {"name": "factor", "unit": "mm/kN3", "default": 0.5},
        ],
        "endpoint_url": f"{url}/beam",
        "token": TOKEN,
    } | changes


def test_an_organisation_registers_a_model_and_its_sites_run_it(
    api: TestClient, admin: str, endpoint: Endpoint, database_url: str
) -> None:
    res = api.post("/org/models", headers=ADMIN, json=beam(endpoint.url))
    assert res.status_code == 201, res.text
    shown = res.json()
    assert (shown["has_token"], shown["endpoint_url"], shown["archived_at"]) == (True, f"{endpoint.url}/beam", None)
    assert "token" not in shown and TOKEN not in res.text
    assert [m["key"] for m in api.get("/org/models", headers=ADMIN).json()] == ["beam-deflection"]

    # Every site of the organisation sees it beside the built-in models, and can try it.
    models = {m["key"]: m for m in api.get(f"/sites/{admin}/models", headers=VIEWER).json()}
    assert models["beam-deflection"]["source"] == "http"
    assert models["plunger-friction"]["source"] == "builtin"
    endpoint.calls.clear()
    res = api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={"params": {"load": 3}})
    assert res.status_code == 200, res.text
    assert res.json()["outputs"] == {"deflection": [13.5]}
    # The endpoint got the checked parameters, defaults filled in, and the token.
    [call] = endpoint.calls
    assert call["path"] == "/beam" and call["auth"] == f"Bearer {TOKEN}"
    assert call["body"] == {
        "model": "beam-deflection",
        "version": "1.0.0",
        "inputs": {},
        "params": {"load": 3.0, "factor": 0.5},
    }
    # Parameters out of bounds never reach it.
    res = api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={"params": {"load": 11}})
    assert res.status_code == 422 and len(endpoint.calls) == 1

    # A design run keeps the version and its output, like a built-in model's.
    run = api.post(f"/sites/{admin}/runs", headers=ENG, json={"model": "beam-deflection", "params": {"load": 2}})
    assert run.status_code == 201, run.text
    assert (run.json()["version"], run.json()["output"], run.json()["model_name"]) == (
        "1.0.0",
        {"deflection": 4.0},
        "Beam deflection",
    )
    assert run.json()["units"] == {"load": "kN", "factor": "mm/kN3", "deflection": "mm"}

    with psycopg.connect(database_url) as conn:
        [(stored,)] = conn.execute("SELECT endpoint_token FROM models WHERE key = 'beam-deflection'").fetchall()
        audit = conn.execute(
            "SELECT action, entity_id, site_id, after FROM audit_log WHERE entity_type = 'model'"
            " ORDER BY at DESC LIMIT 1"
        ).fetchone()
    assert stored.startswith(sealed.PREFIX) and TOKEN not in stored  # sealed in the database
    assert audit is not None and audit[:3] == ("model.register", "beam-deflection@1.0.0", None)
    assert audit[3]["token"] is True and TOKEN not in json.dumps(audit[3])


def test_a_sweep_calls_the_endpoint_for_each_point(api: TestClient, admin: str, endpoint: Endpoint) -> None:
    assert api.post("/org/models", headers=ADMIN, json=beam(endpoint.url)).status_code == 201
    body = {"model": "beam-deflection", "params": {}, "x": {"param": "load", "from": 0, "to": 4, "steps": 5}}
    res = api.post(f"/sites/{admin}/sweeps", headers=ENG, json=body)
    assert res.status_code == 202, res.text
    done = api.get(f"/sites/{admin}/sweeps/{res.json()['id']}", headers=ENG).json()
    assert done["status"] == "done", done
    assert done["result"]["grid"] == [[0.0, 0.5, 4.0, 13.5, 32.0]]
    # The endpoint failing fails the sweep, saying why, rather than leaving empty points.
    endpoint.reply = lambda body: (503, b"busy", {})
    try:
        res = api.post(f"/sites/{admin}/sweeps", headers=ENG, json=body | {"params": {"factor": 1}})
        failed = api.get(f"/sites/{admin}/sweeps/{res.json()['id']}", headers=ENG).json()
    finally:
        endpoint.reply = Endpoint.beam
    assert (failed["status"], failed["error"]) == ("failed", "The model's endpoint answered 503")


@pytest.mark.parametrize(
    ("changes", "status", "why"),
    [
        ({"endpoint_url": "https://models.example.com/beam"}, 422, "isn't a model host this deployment allows"),
        ({"endpoint_url": "http://example.com/beam"}, 422, "must be https"),
        ({"endpoint_url": "http://user:pw@127.0.0.1/beam"}, 422, "user name, password"),
        ({"key": "plunger-friction"}, 409, "built-in model's key"),
        ({"version": "1.0"}, 422, "MAJOR.MINOR.PATCH"),
        ({"inputs": [{"name": "x", "unit": "m"}]}, 422, "no inputs"),
        ({"kind": "virtual-sensor"}, 422, "at least one input"),
        ({"params": [{"name": "load", "unit": "kN", "default": 20, "max": 10}]}, 422, "outside"),
    ],
)
def test_registrations_are_checked(
    api: TestClient, admin: str, endpoint: Endpoint, changes: dict[str, Any], status: int, why: str
) -> None:
    res = api.post("/org/models", headers=ADMIN, json=beam(endpoint.url, **changes))
    assert res.status_code == status, res.text
    assert why in json.dumps(res.json())


def test_only_organisation_admins_register_and_a_version_never_changes(
    api: TestClient, admin: str, endpoint: Endpoint
) -> None:
    assert api.post("/org/models", headers=ENG, json=beam(endpoint.url)).status_code == 403
    assert api.get("/org/models", headers=ENG).status_code == 403
    assert api.post("/org/models", headers=ADMIN, json=beam(endpoint.url)).status_code == 201
    again = api.post("/org/models", headers=ADMIN, json=beam(endpoint.url, name="Other"))
    assert (again.status_code, "never changes" in again.json()["detail"]) == (409, True)
    # A new version is the way, and becomes the latest.
    assert api.post("/org/models", headers=ADMIN, json=beam(endpoint.url, version="1.1.0")).status_code == 201
    res = api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={})
    assert res.json()["version"] == "1.1.0"


@pytest.mark.parametrize(
    ("reply", "status", "why"),
    [
        ((500, b"oops", {}), 502, "answered 500"),
        ((302, b"", {"Location": "http://127.0.0.1:1/elsewhere"}), 502, "answered 302"),
        ((200, b"not json", {}), 502, "didn't answer JSON"),
        ((200, b'{"outputs": {"deflection": [NaN]}}', {}), 502, "didn't answer JSON"),
        ((200, b'{"deflection": [1]}', {}), 502, '{"outputs": {...}}'),
        ((200, b'{"outputs": {"deflection": ["1"]}}', {}), 502, "list of numbers or nulls"),
        ((200, b'{"outputs": {"deflection": [true]}}', {}), 502, "list of numbers or nulls"),
        ((200, b'{"outputs": {"deflection": [1, 2]}}', {}), 422, "returned 2 values for deflection, not 1"),
        ((200, b'{"outputs": {"bend": [1]}}', {}), 422, "returned ['bend'], not ['deflection']"),
    ],
)
def test_replies_are_checked_against_the_spec(
    api: TestClient,
    admin: str,
    endpoint: Endpoint,
    reply: tuple[int, bytes, dict[str, str]],
    status: int,
    why: str,
) -> None:
    assert api.post("/org/models", headers=ADMIN, json=beam(endpoint.url)).status_code == 201
    endpoint.reply = lambda body: reply
    try:
        res = api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={})
    finally:
        endpoint.reply = Endpoint.beam
    assert res.status_code == status, res.text
    assert why in res.json()["detail"]


def test_an_endpoint_that_cant_be_reached_is_a_502(api: TestClient, admin: str) -> None:
    gone = beam("http://127.0.0.1:1")  # nothing listens there
    assert api.post("/org/models", headers=ADMIN, json=gone).status_code == 201
    res = api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={})
    assert (res.status_code, res.json()["detail"]) == (502, "The model's endpoint can't be reached (URLError)")
    run = api.post(f"/sites/{admin}/runs", headers=ENG, json={"model": "beam-deflection"})
    assert run.status_code == 502  # and nothing is stored
    assert api.get(f"/sites/{admin}/runs", headers=ENG).json()["total"] == 0


def test_a_model_moves_loses_its_token_and_is_archived(
    api: TestClient, admin: str, endpoint: Endpoint, database_url: str
) -> None:
    assert api.post("/org/models", headers=ADMIN, json=beam("http://127.0.0.1:1")).status_code == 201
    path = "/org/models/beam-deflection/1.0.0"
    moved = api.patch(path, headers=ADMIN, json={"endpoint_url": f"{endpoint.url}/v1", "clear_token": True})
    assert moved.status_code == 200, moved.text
    assert (moved.json()["endpoint_url"], moved.json()["has_token"]) == (f"{endpoint.url}/v1", False)
    assert api.patch(path, headers=ADMIN, json={"endpoint_url": "https://evil.example.com"}).status_code == 422
    assert api.patch(path, headers=ADMIN, json={"token": "t", "clear_token": True}).status_code == 422
    assert api.patch("/org/models/beam-deflection/9.9.9", headers=ADMIN, json={}).status_code == 404
    assert api.patch(path, headers=ENG, json={"archived": True}).status_code == 403
    # A token given for one host isn't sent to another unless someone says so.
    assert api.patch(path, headers=ADMIN, json={"token": "t2"}).json()["has_token"] is True
    elsewhere = {"endpoint_url": f"{endpoint.url.replace('127.0.0.1', 'localhost')}/v2"}
    res = api.patch(path, headers=ADMIN, json=elsewhere)
    assert (res.status_code, "give its token" in res.json()["detail"]) == (422, True)
    assert api.patch(path, headers=ADMIN, json={"endpoint_url": f"{endpoint.url}/v2"}).json()["has_token"] is True
    assert api.patch(path, headers=ADMIN, json={"clear_token": True}).json()["has_token"] is False
    endpoint.calls.clear()
    run = api.post(f"/sites/{admin}/runs", headers=ENG, json={"model": "beam-deflection"})
    assert run.status_code == 201, run.text
    assert endpoint.calls[0]["path"] == "/v2" and endpoint.calls[0]["auth"] is None

    archived = api.patch(path, headers=ADMIN, json={"archived": True})
    assert archived.json()["archived_at"] is not None
    # No new uses; the run made with it still shows, from the version as it was stored.
    assert "beam-deflection" not in [m["key"] for m in api.get(f"/sites/{admin}/models", headers=VIEWER).json()]
    assert api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={}).status_code == 404
    shown = api.get(f"/sites/{admin}/runs/{run.json()['number']}", headers=ENG).json()
    assert (shown["model_name"], shown["output"]) == ("Beam deflection", {"deflection": 4.0})
    restore = api.post(f"/sites/{admin}/runs/{run.json()['number']}/restore", headers=ENG)
    assert restore.status_code == 409
    # What already runs with it (a binding, a queued sweep) keeps going.
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        org = conn.execute("SELECT org_id FROM sites WHERE id = %s", [admin]).fetchone()
        assert org is not None
        with pytest.raises(KeyError):
            store.find(conn, org["org_id"], SETTINGS_OF(api), "beam-deflection", "1.0.0")
        kept = store.find(conn, org["org_id"], SETTINGS_OF(api), "beam-deflection", "1.0.0", archived=True)
    assert kept.spec.version == "1.0.0"
    assert api.get("/org/models", headers=ADMIN).json()[0]["archived_at"] is not None
    # Brought back, it is used again.
    assert api.patch(path, headers=ADMIN, json={"archived": False}).json()["archived_at"] is None
    res = api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={})
    assert res.status_code == 200


def test_endpoints_are_https_on_an_allowed_host() -> None:
    allowed = Settings(_env_file=None, env="production", model_hosts=["Models.Example.com"], data_keys=KEYS)
    assert remote.endpoint_problem("https://models.example.com/v1/run", allowed) is None
    assert remote.endpoint_problem("https://models.example.com:8443/run", allowed) is None
    assert "https" in (remote.endpoint_problem("http://models.example.com/run", allowed) or "")
    assert "https" in (remote.endpoint_problem("http://localhost/run", allowed) or "")  # not in production
    assert "allows" in (remote.endpoint_problem("https://other.example.com/run", allowed) or "")
    assert "#fragment" in (remote.endpoint_problem("https://models.example.com/run#x", allowed) or "")
    assert "isn't a URL" in (remote.endpoint_problem("https://models.example.com:99999999/", allowed) or "")
    none = Settings(_env_file=None, env="test")
    assert "allows no model endpoints" in (remote.endpoint_problem("https://models.example.com/run", none) or "")


def test_an_endpoint_outage_doesnt_skip_windows(database_url: str, site: str) -> None:  # noqa: F811
    """A virtual sensor's window whose endpoint failed is run again next time, not skipped."""
    calls = 0

    def transport(url: str, body: bytes, headers: dict[str, str], timeout: float) -> bytes:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise remote.RemoteError("The model's endpoint answered 503")
        if calls == 4:  # the endpoint refuses that window's inputs: skipped, like a built-in refusal
            raise remote.RemoteError("The model's endpoint answered 422", retry=False)
        sent = json.loads(body)
        out = PlungerFriction().run(sent["inputs"], sent["params"])
        return json.dumps(
            {"outputs": {k: [None if v is None or math.isnan(v) else v for v in vs] for k, vs in out.items()}}
        ).encode()

    settings = Settings(_env_file=None, env="test", model_hosts=["127.0.0.1"])
    model = remote.HttpModel(PlungerFriction.spec, "http://127.0.0.1/pf", None, None, settings, transport)  # type: ignore[arg-type]
    with psycopg.connect(database_url, row_factory=dict_row, options=UNSCOPED) as conn:  # as a job connects
        ids = {}
        for tag in ("v", "ph", "pm", "force", "friction"):
            row = conn.execute(
                "INSERT INTO signals (site_id, tag, source) VALUES (%s, %s, 'manual') RETURNING id", [site, f"h.{tag}"]
            ).fetchone()
            assert row is not None
            ids[tag] = str(row["id"])
        for n, shot in enumerate(SHOTS[:4]):
            p = shot["payload"]
            for key in ("v", "ph", "pm"):
                conn.execute(
                    "INSERT INTO samples (signal_id, at, value)"
                    " SELECT %s, unnest(%s::timestamptz[]), unnest(%s::float8[])",
                    [ids[key], [T0 + n * CYCLE + timedelta(seconds=t) for t in p["t"]], [float(x) for x in p[key]]],
                )
        binding = {
            "inputs": {"t": "@time", "v": ids["v"], "ph": ids["ph"], "pm": ids["pm"]},
            "outputs": {"force": ids["force"], "friction": ids["friction"]},
            "params": {},
            "window_kind": "gap",
            "window_s": 2.0,
            "done_until": None,
        }
        later = T0 + timedelta(days=1)
        first = runner.run_binding(conn, binding, model, now=later)
        # The first window, then the endpoint failed: the run stops there, saying why.
        assert (first.windows, first.failed, first.caught_up) == (1, 0, False), first.error
        assert first.error is not None and first.error.startswith("stopped at the window ending")
        assert first.error.endswith("answered 503")
        assert first.done_until == T0 + timedelta(seconds=SHOTS[0]["payload"]["t"][-1])
        # The second window was not lost; the third is refused and skipped; then the run's share of
        # calls is used up, and the fourth waits for the next run.
        again = runner.run_binding(conn, binding | {"done_until": first.done_until}, model, now=later, remote_windows=2)
        assert (again.windows, again.failed, again.caught_up) == (2, 1, False)
        assert again.error is not None and again.error.endswith("answered 422")
        last = runner.run_binding(conn, binding | {"done_until": again.done_until}, model, now=later)
        assert (last.windows, last.failed, last.caught_up, last.error) == (1, 0, True, None)
        assert calls == 5


def test_tokens_are_resealed_with_a_new_key(api: TestClient, admin: str, endpoint: Endpoint, database_url: str) -> None:
    assert api.post("/org/models", headers=ADMIN, json=beam(endpoint.url)).status_code == 201
    new = sealed.DataKeys.parse(f"{sealed.new_key('k2')},{KEYS}")
    assert new is not None
    with psycopg.connect(database_url, row_factory=dict_row, options=UNSCOPED) as conn:
        result = sealed.reseal(conn, new)
        stored = conn.execute("SELECT org_id, endpoint_token FROM models WHERE key = 'beam-deflection'").fetchone()
    assert stored is not None and result.resealed >= 1 and not result.failed
    assert stored["endpoint_token"].startswith(f"{sealed.PREFIX}k2:")
    context = remote.token_context(stored["org_id"], "beam-deflection", "1.0.0")
    assert new.unseal(stored["endpoint_token"], context) == TOKEN


def test_a_key_an_organisation_registered_stays_its_own(api: TestClient, admin: str, endpoint: Endpoint) -> None:
    """A later release adding a built-in model by the same key doesn't take the organisation's place."""
    assert api.post("/org/models", headers=ADMIN, json=beam(endpoint.url)).status_code == 201

    class Later:
        spec = ModelSpec(
            key="beam-deflection",
            version="1.0.0",
            name="Built-in beam",
            kind="design",
            outputs=(Port("deflection", "mm", per="window"),),
        )

        def run(self, inputs: Any, params: Any) -> Any:
            return {"deflection": [0.0]}

    registry.add(Later())
    try:
        res = api.post(f"/sites/{admin}/models/beam-deflection/evaluate", headers=VIEWER, json={"params": {"load": 2}})
        listed = [m for m in api.get(f"/sites/{admin}/models", headers=VIEWER).json() if m["key"] == "beam-deflection"]
    finally:
        registry._models.pop(("beam-deflection", "1.0.0"))
    assert res.json()["outputs"] == {"deflection": [4.0]}  # the organisation's, from its endpoint
    assert [(m["name"], m["source"]) for m in listed] == [("Beam deflection", "http")]


def test_a_reply_sent_slowly_is_cut_off_at_the_timeout() -> None:
    """urllib's timeout bounds each read; the call as a whole is bounded too."""
    import socket
    import time

    server = socket.create_server(("127.0.0.1", 0))

    def trickle() -> None:
        conn, _ = server.accept()
        with conn:
            conn.recv(65536)
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
            try:
                for _ in range(100):  # a byte every 0.1 s: never quiet for a whole timeout
                    conn.sendall(b" ")
                    time.sleep(0.1)
            except OSError:
                pass  # the client hung up, as it should

    threading.Thread(target=trickle, daemon=True).start()
    url = f"http://127.0.0.1:{server.getsockname()[1]}/"
    began = time.monotonic()
    try:
        with pytest.raises(remote.RemoteError, match="TimeoutError") as e:
            remote.post(url, b"{}", {}, timeout=0.5)
    finally:
        server.close()
    assert time.monotonic() - began < 3 and e.value.retry
