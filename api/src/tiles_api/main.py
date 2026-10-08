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
from pydantic import BaseModel

from tiles_api import readiness
from tiles_api.api_agents import router as agents_router
from tiles_api.api_auth import router as auth_router
from tiles_api.api_detectors import router as detectors_router
from tiles_api.api_imports import router as imports_router
from tiles_api.api_members import router as members_router
from tiles_api.api_model_bindings import router as bindings_router
from tiles_api.api_models import router as models_router
from tiles_api.api_ontology import router as ontology_router
from tiles_api.api_ontology_io import router as ontology_io_router
from tiles_api.api_reviews import router as reviews_router
from tiles_api.api_samples import router as samples_router
from tiles_api.api_series import router as series_router
from tiles_api.api_signals import router as signals_router
from tiles_api.api_suggest import router as suggest_router
from tiles_api.logging import configure_logging, new_request_id, request_id_var
from tiles_api.settings import Settings, get_settings
from tiles_api.store import close_pool

log = logging.getLogger("tiles_api")

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

    @app.middleware("http")
    async def request_context(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        request_id = new_request_id(request.headers.get("x-request-id"))
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            # Answer here rather than re-raising, so a failed request keeps its
            # request ID header and completion log like any other.
            log.exception("request failed", extra={"method": request.method, "path": request.url.path})
            response = JSONResponse({"detail": "Internal Server Error"}, status_code=500)
        finally:
            request_id_var.reset(token)
        response.headers["X-Request-ID"] = request_id
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
    app.include_router(models_router)
    app.include_router(bindings_router)
    app.include_router(detectors_router)
    app.include_router(reviews_router)
    app.include_router(agents_router)
    app.include_router(samples_router)
    app.include_router(imports_router)
    app.include_router(suggest_router)  # before signals: /signals/suggestions is not a signal id
    app.include_router(signals_router)
    app.include_router(series_router)
    return app


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "tiles_api.main:create_app",
        factory=True,
        host=settings.host,
        port=settings.port,
        log_config=None,
    )
