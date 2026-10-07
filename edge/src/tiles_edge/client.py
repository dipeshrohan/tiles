"""Outbound calls to the Tiles API. The agent only ever connects out; it listens on nothing."""

import json
import ssl
import urllib.error
import urllib.request
from typing import Any

from tiles_edge import __version__
from tiles_edge.config import Config


class TransientError(Exception):
    """Tiles couldn't be reached or is busy: try again later."""


class RejectedError(Exception):
    """Tiles refused the agent (unknown or revoked token, or a bad request): retrying won't help."""


def ssl_context(config: Config) -> ssl.SSLContext:
    """The system's trusted CAs plus, if configured, ca_file. Certificates are always verified."""
    context = ssl.create_default_context()
    if config.ca_file:
        context.load_verify_locations(cafile=str(config.ca_file))
    return context


class TilesClient:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._context = ssl_context(config) if config.url.startswith("https:") else None
        # build_opener keeps urllib's proxy support (HTTPS_PROXY, NO_PROXY): a
        # plant's outbound proxy is often the only way out.
        self._opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=self._context))

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(  # noqa: S310 - the URL's scheme is checked in config (https, or http to localhost)
            self._config.url + path,
            data=json.dumps(body).encode(),
            method="POST",
            headers={
                "Authorization": f"Bearer {self._config.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": f"tiles-edge/{__version__}",
            },
        )
        try:
            with self._opener.open(request, timeout=self._config.timeout_seconds) as response:
                answer: dict[str, Any] = json.loads(response.read())
                return answer
        except urllib.error.HTTPError as e:
            detail = _detail(e)
            if e.code == 429 or e.code >= 500:
                raise TransientError(f"Tiles answered {e.code}: {detail}") from None
            raise RejectedError(f"Tiles answered {e.code}: {detail}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, ssl.SSLError) as e:
            reason = getattr(e, "reason", e)
            raise TransientError(f"can't reach {self._config.url}: {reason}") from None
        except ValueError as e:  # not JSON
            raise TransientError(f"Tiles sent an unreadable answer: {e}") from None


def _detail(e: urllib.error.HTTPError) -> str:
    try:
        body = json.loads(e.read())
        return str(body.get("detail", body)) if isinstance(body, dict) else str(body)
    except (ValueError, OSError):
        return e.reason if isinstance(e.reason, str) else str(e.reason)
