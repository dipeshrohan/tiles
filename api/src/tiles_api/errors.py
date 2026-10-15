"""Errors with a code the browser can translate (U6.01).

Every error the API answers carries ``code`` next to its English ``detail``: the browser shows the
message ``api.<code>`` from its catalogue (``js/i18n/en.json``) with ``params`` filled in, and the
English ``detail`` only when it has no such message. Raise :class:`Problem`, never a bare
``HTTPException`` (``tests/test_errors.py`` checks, and that every code has its message with the
same params); one the API didn't raise itself (FastAPI's 404 for an unknown path, 405…) gets the
code ``http.<status>``. Validation errors (422 from FastAPI) keep FastAPI's list, whose items carry
Pydantic's ``type`` and ``ctx``, which the browser translates as ``api.field.<type>``.
"""

from collections.abc import Mapping

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

Param = str | int | float


class Problem(HTTPException):
    """An error answer: its status, a stable code, the English words and their params.

    ``message`` is the catalogue's English with the params filled in (an f-string over the same
    values); the code names what went wrong (``warning.not_found``), never how it is worded.
    """

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        headers: Mapping[str, str] | None = None,
        **params: Param,
    ) -> None:
        super().__init__(status_code, message, dict(headers) if headers else None)
        self.code = code
        self.params = params


def body(exc: StarletteHTTPException) -> dict[str, object]:
    if isinstance(exc, Problem):
        return {"detail": exc.detail, "code": exc.code, "params": exc.params}
    return {"detail": exc.detail, "code": f"http.{exc.status_code}", "params": {}}


async def answer(_request: Request, exc: Exception) -> JSONResponse:
    """The error's JSON, with its code, status and headers (registered for HTTP exceptions)."""
    if not isinstance(exc, StarletteHTTPException):  # registered for HTTP exceptions only
        raise exc
    return JSONResponse(body(exc), status_code=exc.status_code, headers=getattr(exc, "headers", None))
