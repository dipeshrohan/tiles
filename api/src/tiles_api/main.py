"""FastAPI application factory and entry point."""

import logging
import math
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from importlib.metadata import version
from typing import Any, Literal

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from opentelemetry import trace
from pydantic import BaseModel
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from tiles_api import readiness, telemetry
from tiles_api.api_agents import router as agents_router
from tiles_api.api_apps import router as apps_router
from tiles_api.api_auth import router as auth_router
from tiles_api.api_backtest import router as backtest_router
from tiles_api.api_copilot import router as copilot_router
from tiles_api.api_datasets import router as datasets_router
from tiles_api.api_detectors import router as detectors_router
from tiles_api.api_documents import router as documents_router
from tiles_api.api_imports import router as imports_router
from tiles_api.api_insights import router as insights_router
from tiles_api.api_members import router as members_router
from tiles_api.api_model_bindings import router as bindings_router
from tiles_api.api_models import router as models_router
from tiles_api.api_notifications import router as notifications_router
from tiles_api.api_ontology import router as ontology_router
from tiles_api.api_ontology_io import router as ontology_io_router
from tiles_api.api_org_models import router as org_models_router
from tiles_api.api_performance import router as performance_router
from tiles_api.api_reviews import router as reviews_router
from tiles_api.api_runs import router as runs_router
from tiles_api.api_samples import router as samples_router
from tiles_api.api_series import router as series_router
from tiles_api.api_signals import router as signals_router
from tiles_api.api_sites import router as sites_router
from tiles_api.api_suggest import router as suggest_router
from tiles_api.api_sweeps import router as sweeps_router
from tiles_api.api_warnings import router as warnings_router
from tiles_api.api_wear import router as wear_router
from tiles_api.logging import configure_logging, new_request_id, request_id_var
from tiles_api.org_sign_in import router as org_sign_in_router
from tiles_api.scim import ScimError, error_response
from tiles_api.scim import router as scim_router
from tiles_api.settings import Settings, get_settings
from tiles_api.store import close_pool

log = logging.getLogger("tiles_api")
DOCS_PATHS = ("/docs", "/redoc", "/openapi.json")


class BodyTooLarge(Exception):
    """A body sent without a Content-Length went past the limit while it was read."""


def _caused_by(error: BaseException, kind: type[BaseException]) -> bool:
    """Whether `error` is `kind`, or was raised from one, or holds one (an ExceptionGroup)."""
    seen: set[int] = set()
    todo = [error]
    while todo:
        e = todo.pop()
        if id(e) in seen:
            continue
        seen.add(id(e))
        if isinstance(e, kind):
            return True
        if isinstance(e, BaseExceptionGroup):
            todo.extend(e.exceptions)
        todo.extend(x for x in (e.__cause__, e.__context__) if x is not None)
    return False


class BodyLimit:
    """Refuses a request body larger than `limit` bytes with 413 (threat model G-A1): at once when its
    Content-Length says so, or as it arrives when it is sent without one."""

    def __init__(self, app: ASGIApp, limit: int) -> None:
        self.app = app
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        length = dict(scope["headers"]).get(b"content-length")
        too_large = JSONResponse({"detail": f"The request is larger than {self.limit // (1024 * 1024)} MB"}, 413)
        if length is not None:
            try:
                declared = int(length)
            except ValueError:
                await JSONResponse({"detail": "Content-Length must be a number"}, 400)(scope, receive, send)
                return
            if declared > self.limit:
                await too_large(scope, receive, send)
                return
        seen = 0
        started = False

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > self.limit:
                    raise BodyTooLarge
            return message

        async def sending(message: Message) -> None:
            nonlocal started
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, counted, sending)
        except BodyTooLarge:
            if not started:
                await too_large(scope, receive, send)


VERSION = version("tiles-api")


class Health(BaseModel):
    status: Literal["ok"]
    version: str
    env: str


class Ready(BaseModel):
    status: Literal["ok", "unavailable"]
    checks: dict[str, readiness.CheckResult]


def _finite(value: Any) -> Any:
    """JSON can't carry NaN or infinity: name them instead (a validation error echoes the input)."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    return value


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        yield
        close_pool(app.state)

    app = FastAPI(title="Tiles API", version=VERSION, lifespan=lifespan)
    app.state.settings = settings
    app.state.pool = None
    app.state.db_slots = None  # store.db_slot
    app.state.side_pool = None  # store.side_pool
    app.state.verifiers = None  # auth.verifiers: the token verifiers, made on first use
    app.state.copilot_model = None  # tests set a stand-in for Claude
    app.state.copilot_client = None

    @app.middleware("http")
    async def request_context(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        request_id = new_request_id(request.headers.get("x-request-id"))
        token = request_id_var.set(request_id)
        trace.get_current_span().set_attribute("tiles.request_id", request_id)  # traces meet the logs
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception as e:
            if _caused_by(e, BodyTooLarge):  # read past BodyLimit's limit (G-A1); Starlette wraps it
                response = JSONResponse(
                    {"detail": f"The request is larger than {settings.max_body_bytes // (1024 * 1024)} MB"}, 413
                )
            else:
                # Answer here rather than re-raising, so a failed request keeps its
                # request ID header and completion log like any other.
                log.exception("request failed", extra={"method": request.method, "path": request.url.path})
                response = JSONResponse({"detail": "Internal Server Error"}, status_code=500)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = request_id
        # Security headers (G-B1): nothing here is a page to frame or a script to run, but the
        # interactive docs, and a document's file, which sets its own (sandbox).
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        if not request.url.path.startswith(DOCS_PATHS):
            response.headers.setdefault("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        log.info(
            "request",
            extra={
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": round((time.perf_counter() - started) * 1000, 2),
            },
        )
        return response

    # The body limit (G-A1) inside CORS, so a browser sees its 413.
    app.add_middleware(BodyLimit, limit=settings.max_body_bytes)
    # Added after the request-context middleware so it wraps it and also
    # decorates the 500 responses produced there.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request: Request, exc: RequestValidationError) -> JSONResponse:
        """FastAPI's own answer, except that a NaN in the request doesn't turn it into a 500."""
        return JSONResponse({"detail": _finite(jsonable_encoder(exc.errors()))}, status_code=422)

    @app.get("/health", response_model=Health, tags=["meta"])
    def health() -> Health:
        """Liveness: the process is up. Does not touch dependencies."""
        return Health(status="ok", version=VERSION, env=settings.env)

    @app.get("/ready", response_model=Ready, tags=["meta"], responses={503: {"model": Ready}})
    def ready() -> JSONResponse:
        """Readiness: the database and Redis are reachable. 503 if either is not."""
        checks = readiness.run_checks(settings)
        ok = all(result == "ok" for result in checks.values())
        body = Ready(status="ok" if ok else "unavailable", checks=checks)
        return JSONResponse(body.model_dump(), status_code=200 if ok else 503)

    app.include_router(auth_router)
    app.include_router(ontology_router)
    app.include_router(ontology_io_router)
    app.include_router(members_router)
    app.include_router(sites_router)
    app.include_router(org_sign_in_router)
    app.include_router(scim_router)
    app.include_router(apps_router)
    app.include_router(documents_router)
    app.add_exception_handler(ScimError, error_response)
    app.include_router(models_router)
    app.include_router(org_models_router)
    app.include_router(bindings_router)
    app.include_router(detectors_router)
    app.include_router(backtest_router)
    app.include_router(warnings_router)
    app.include_router(notifications_router)
    app.include_router(performance_router)
    app.include_router(datasets_router)
    app.include_router(reviews_router)
    app.include_router(agents_router)
    app.include_router(samples_router)
    app.include_router(imports_router)
    app.include_router(suggest_router)  # before signals: /signals/suggestions is not a signal id
    app.include_router(signals_router)
    app.include_router(series_router)
    app.include_router(wear_router)
    app.include_router(insights_router)
    app.include_router(runs_router)
    app.include_router(sweeps_router)
    app.include_router(copilot_router)
    telemetry.instrument(app, settings)
    return app


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "tiles_api.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        workers=settings.workers,
        log_config=None,
    )
