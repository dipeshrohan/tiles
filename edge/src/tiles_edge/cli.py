"""Command line: `tiles-edge run` (the service) and `tiles-edge check` (test the config and the connection)."""

import argparse
import json
import signal
import sys
from pathlib import Path
from types import FrameType
from typing import NoReturn

from tiles_edge import __version__, logs
from tiles_edge.agent import Agent
from tiles_edge.client import RejectedError, TilesClient, TransientError
from tiles_edge.config import ConfigError, load

DEFAULT_CONFIG = "/etc/tiles-edge/tiles-edge.toml"

# Exit codes, for service managers and scripts.
OK, UNREACHABLE, CONFIG, REJECTED = 0, 1, 2, 3


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tiles-edge", description=__doc__)
    parser.add_argument("--version", action="version", version=f"tiles-edge {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (
        ("run", "run the agent until stopped (SIGTERM or Ctrl-C)"),
        ("check", "check the config file and send one heartbeat"),
    ):
        command = commands.add_parser(name, help=text, description=text)
        command.add_argument(
            "-c", "--config", type=Path, default=Path(DEFAULT_CONFIG), help=f"default {DEFAULT_CONFIG}"
        )
        command.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logs.configure(args.log_level)
    try:
        config = load(args.config)
    except ConfigError as e:
        print(f"tiles-edge: {args.config}: {e}", file=sys.stderr)
        return CONFIG
    agent = Agent(config, TilesClient(config))

    if args.command == "check":
        try:
            answer = agent.heartbeat()
        except TransientError as e:
            print(f"tiles-edge: {e}", file=sys.stderr)
            return UNREACHABLE
        except RejectedError as e:
            print(f"tiles-edge: {e}", file=sys.stderr)
            return REJECTED
        print(json.dumps({"ok": True, "agent_id": answer.get("agent_id"), "site_id": answer.get("site_id")}))
        return OK

    def stop(signum: int, frame: FrameType | None) -> None:
        agent.stop.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    return agent.run()


def entry() -> NoReturn:
    """Exits with main()'s code. Zipapps call their entry point without passing on its return value."""
    sys.exit(main())
