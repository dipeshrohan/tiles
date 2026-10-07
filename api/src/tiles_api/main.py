"""FastAPI application factory and entry point."""

import logging
import time
from collections.abc import Awaitable, Callable
from importlib.metadata import version
from typing import Literal

import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from tiles_api import readiness
from tiles_api.logging import configure_logging, new_request_id, request_id_var
from tiles_api.settings import Settings, get_settings

log = logging.getLogger("tiles_api")

VERSION = version("tiles-api")


class Health(BaseModel):
    status: Literal["ok"]
    version: str
    env: str


class Ready(BaseModel):
    status: Literal["ok", "unavailable"]
    checks: dict[str, readiness.CheckResult]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(title="Tiles API", version=VERSION)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-ID"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        request_id = new_request_id(request.headers.get("x-request-id"))
        token = request_id_var.set(request_id)
        started = time.perf_counter()
        try:
            response = await call_next(request)
        except Exception:
            log.exception("request failed", extra={"method": request.method, "path": request.url.path})
            raise
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
