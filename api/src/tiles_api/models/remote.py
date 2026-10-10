"""Models served over HTTP (T4.15): an organisation's model version whose numbers come from its own
service. Tiles keeps the spec (registered once, never changed) and calls the endpoint with the
inputs and parameters the registry has already checked; the reply is checked against the spec in
turn (`registry.evaluate`). No code of the model's runs in Tiles.

The call is a POST of JSON:

    {"model": "<key>", "version": "1.2.0", "inputs": {"<name>": [numbers…]}, "params": {"<name>": number}}

with `Authorization: Bearer <token>` when the model has one, and the reply is

    {"outputs": {"<name>": [numbers or null…]}}

Endpoints are https on a host the deployment allows (`TILES_MODEL_HOSTS`, which the chart's
egress allowlist also opens); outside production, http to localhost is accepted too, for trying a
model on your machine. Redirects aren't followed, replies are capped in size and every call has a
timeout.
"""

import http.client
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Any

from tiles_api import sealed
from tiles_api.models.registry import ModelError, ModelSpec, Param, Port
from tiles_api.settings import Settings

SOURCE = "http"
MAX_REPLY_BYTES = 32 * 1024 * 1024
LOCAL_HOSTS = ("localhost", "127.0.0.1", "::1")


class RemoteError(ModelError):
    """The endpoint couldn't be reached, or answered with something that isn't a reply.

    `retry`: the endpoint (or its settings) failed, not these inputs: unreachable, timed out, a
    server error, busy (408, 429), redirected, or a token that doesn't open. A binding stops and runs
    that window again later. Otherwise the endpoint refused these inputs (another 4xx) or answered
    them with something that isn't a reply: that window, or sweep point, is skipped like one a
    built-in model refuses.
    """

    def __init__(self, message: str, *, retry: bool = True, status: int | None = None) -> None:
        super().__init__(message)
        self.retry = retry
        self.status = status  # the HTTP status the endpoint answered, if it answered


def endpoint_problem(url: str, settings: Settings) -> str | None:
    """Why `url` can't be a model endpoint here, or None."""
    try:
        parts = urllib.parse.urlsplit(url)
        port = parts.port
    except ValueError:
        return "The endpoint isn't a URL"
    host = (parts.hostname or "").lower()
    local = settings.env != "production" and host in LOCAL_HOSTS
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        return "A model endpoint must be https"
    if parts.username is not None or parts.password is not None or parts.fragment:
        return "A model endpoint can't hold a user name, password or #fragment (give a token instead)"
    if port is not None and not 0 < port < 65536:
        return "The endpoint's port isn't valid"
    allowed = {h.lower().strip() for h in settings.model_hosts if h.strip()}
    if host not in allowed:
        if not allowed:
            return "This deployment allows no model endpoints: its operator lists hosts in TILES_MODEL_HOSTS"
        return f"{host or 'That host'} isn't a model host this deployment allows (TILES_MODEL_HOSTS)"
    return None


token_context = sealed.model_token_context  # what an endpoint's token is sealed as


def spec_of(row: Mapping[str, Any]) -> ModelSpec:
    """A model version's spec from its `models` row (as ModelSpec.as_json stored it)."""
    body = row["spec"]
    return ModelSpec(
        key=row["key"],
        version=row["version"],
        name=row["name"],
        kind=row["kind"],
        domain=row["domain"],
        description=body.get("description", ""),
        inputs=tuple(Port(**p) for p in body.get("inputs", [])),
        outputs=tuple(Port(**p) for p in body.get("outputs", [])),
        params=tuple(Param(**p) for p in body.get("params", [])),
    )


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: http.client.HTTPMessage,
        newurl: str,
    ) -> None:
        raise urllib.error.HTTPError(req.full_url, code, f"redirected ({code}), which isn't followed", headers, fp)


_opener = urllib.request.build_opener(_NoRedirect)

# (url, body, headers, timeout) -> reply body; tests and other transports replace it.
Post = Callable[[str, bytes, dict[str, str], float], bytes]


def post(url: str, body: bytes, headers: dict[str, str], timeout: float) -> bytes:
    """The reply's body. `timeout` bounds the whole call (urllib's bounds each socket operation, so
    a reply sent slowly is cut off once the time is up)."""
    deadline = time.monotonic() + timeout
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")  # noqa: S310 - checked endpoint
    try:
        with _opener.open(req, timeout=timeout) as res:
            parts: list[bytes] = []
            size = 0
            while chunk := res.read1(64 * 1024):  # what has come, so the deadline is checked as it trickles
                parts.append(chunk)
                size += len(chunk)
                if size > MAX_REPLY_BYTES:
                    raise RemoteError("The model's endpoint answered more than 32 MB", retry=False)
                if time.monotonic() > deadline:
                    raise TimeoutError
    except urllib.error.HTTPError as e:
        why = _detail(e)
        busy = e.code >= 500 or e.code in (408, 429) or 300 <= e.code < 400
        raise RemoteError(
            f"The model's endpoint answered {e.code}" + (f": {why}" if why else ""), retry=busy, status=e.code
        ) from None
    except (OSError, http.client.HTTPException) as e:  # unreachable, refused, timed out, cut off
        raise RemoteError(f"The model's endpoint can't be reached ({type(e).__name__})") from None
    return b"".join(parts)


def _detail(e: urllib.error.HTTPError) -> str:
    """The `detail` of an error answered as JSON ({"detail": "…"}, as FastAPI and the sandbox give
    it), shortened; nothing otherwise."""
    try:
        body = e.read(4096) if 400 <= e.code < 500 else b""
        found = json.loads(body) if body else None
    except (OSError, ValueError, http.client.HTTPException):
        found = None
    finally:
        e.close()
    why = found.get("detail") if isinstance(found, dict) else None
    return " ".join(why.split())[:300] if isinstance(why, str) else ""


def outputs_of(reply: bytes) -> dict[str, list[float | None]]:
    """The outputs in a reply, `{"outputs": {"<name>": [numbers or null…]}}`, or a RemoteError."""
    try:
        found = json.loads(reply, parse_constant=_refuse_constant)
    except ValueError as e:  # not JSON (or NaN, Infinity)
        raise RemoteError(f"The model's endpoint didn't answer JSON: {e}", retry=False) from None
    outputs = found.get("outputs") if isinstance(found, dict) else None
    if not isinstance(outputs, dict):
        raise RemoteError('The model\'s endpoint must answer {"outputs": {...}}', retry=False)
    result: dict[str, list[float | None]] = {}
    for name, values in outputs.items():
        if not isinstance(values, list) or not all(
            v is None or (isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)) for v in values
        ):
            raise RemoteError(f"The model's endpoint must give {name} as a list of numbers or nulls", retry=False)
        result[str(name)] = [None if v is None else float(v) for v in values]
    return result


def _refuse_constant(name: str) -> None:
    raise ValueError(f"{name} isn't a number JSON allows")


class HttpModel:
    """A model version whose `run` asks its endpoint. Built per use from the `models` row of an
    organisation (`org_id`); its token, as stored (sealed), is opened only to make a call."""

    def __init__(
        self,
        spec: ModelSpec,
        url: str,
        sealed_token: str | None,
        org_id: uuid.UUID,
        settings: Settings,
        transport: Post | None = None,
    ) -> None:
        self.spec = spec
        self.url = url
        self.sealed_token = sealed_token
        self.org_id = org_id
        self.settings = settings
        self.transport = transport or post

    def token(self) -> str | None:
        if self.sealed_token is None:
            return None
        context = token_context(self.org_id, self.spec.key, self.spec.version)
        try:
            return sealed.unseal(sealed.keys_of(self.settings), self.sealed_token, context)
        except sealed.SealError as e:
            raise RemoteError(f"The model's endpoint token doesn't open: {e}") from None

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, list[float | None]]:
        problem = endpoint_problem(self.url, self.settings)  # checked when set; again before each call
        if problem:
            raise RemoteError(problem)
        body = json.dumps(
            {
                "model": self.spec.key,
                "version": self.spec.version,
                "inputs": {k: list(v) for k, v in inputs.items()},
                "params": dict(params),
            },
            allow_nan=False,
        ).encode()
        headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "tiles-api"}
        token = self.token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return outputs_of(self.transport(self.url, body, headers, self.settings.model_timeout))
