"""Command line: `tiles-edge run` (the service), `tiles-edge check` (test the config and the connections)
and `tiles-edge opcua …` (set up OPC UA connectors)."""

import argparse
import asyncio
import json
import signal
import sys
from pathlib import Path
from types import FrameType
from typing import NoReturn

from tiles_edge import __version__, connectors, logs
from tiles_edge.agent import Agent, Connector
from tiles_edge.client import RejectedError, TilesClient, TransientError
from tiles_edge.config import Config, ConfigError, OpcUaConfig, load
from tiles_edge.samples import MemoryBuffer

DEFAULT_CONFIG = "/etc/tiles-edge/tiles-edge.toml"

# Exit codes, for service managers and scripts.
OK, UNREACHABLE, CONFIG, REJECTED, CONNECTOR = 0, 1, 2, 3, 4


def _common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("-c", "--config", type=Path, default=Path(DEFAULT_CONFIG), help=f"default {DEFAULT_CONFIG}")
    parser.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tiles-edge", description=__doc__)
    parser.add_argument("--version", action="version", version=f"tiles-edge {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, text in (
        ("run", "run the agent until stopped (SIGTERM or Ctrl-C)"),
        ("check", "check the config file, send one heartbeat and try each connector once"),
    ):
        _common(commands.add_parser(name, help=text, description=text))

    opcua = commands.add_parser("opcua", help="set up OPC UA connectors", description="Set up OPC UA connectors.")
    steps = opcua.add_subparsers(dest="step", required=True)
    for name, text in (
        ("cert", "create this agent's application certificate and key, then give the certificate to plant IT"),
        ("server-cert", "show the server's certificate and its fingerprint; with --save FINGERPRINT, pin it"),
        ("browse", "list the server's nodes, to find the ones to map to signals"),
    ):
        step = steps.add_parser(name, help=text, description=text)
        _common(step)
        step.add_argument("--connector", help="the [[opcua]] name (needed when there are several)")
        if name == "server-cert":
            step.add_argument(
                "--save",
                metavar="FINGERPRINT",
                help="pin the certificate, but only if its SHA-256 fingerprint is this one "
                "(the one you checked with the server's admin)",
            )
        if name == "browse":
            step.add_argument("--node", help="start here instead of the Objects folder, e.g. ns=2;s=Press1")
            step.add_argument("--depth", type=int, default=2, help="levels to show (default 2)")
    return parser


def _fail(message: str, code: int) -> int:
    print(f"tiles-edge: {message}", file=sys.stderr)
    return code


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    logs.configure(args.log_level)
    try:
        # Setting up a connector never talks to Tiles and comes before the signal mapping.
        config = load(args.config, setup=args.command == "opcua")
        if args.command == "opcua":
            return _opcua(args, config)
        buffer = MemoryBuffer()
        agent = Agent(config, TilesClient(config), connectors=connectors.build(config, buffer))
    except ConfigError as e:
        return _fail(f"{args.config}: {e}", CONFIG)

    if args.command == "check":
        # Try the connectors first, so the heartbeat reports what was just found
        # rather than replacing the running service's statuses with nothing.
        kinds = {c.name: "opcua" for c in config.opcua} | {c.name: "mqtt" for c in config.mqtt}
        found: dict[str, tuple[str, str]] = {}
        for c in config.opcua:
            reason = _try_connector(c)
            found[c.name] = ("ok", f"connected to {c.endpoint}") if reason == "ok" else ("down", reason)
        if config.mqtt:
            from tiles_edge.mqtt import MqttConnector

            found |= {c.name: MqttConnector(c, MemoryBuffer()).try_once() for c in config.mqtt}
        results = {name: "ok" if state == "ok" else detail for name, (state, detail) in found.items()}
        checked: list[Connector] = [_Checked(name, kinds[name], *found[name]) for name in found]
        try:
            answer = Agent(config, agent.client, connectors=checked).heartbeat()
        except TransientError as e:
            return _fail(str(e), UNREACHABLE)
        except RejectedError as e:
            return _fail(str(e), REJECTED)
        print(
            json.dumps(
                {"ok": all(r == "ok" for r in results.values()), "agent_id": answer.get("agent_id")}
                | {"site_id": answer.get("site_id"), "connectors": results}
            )
        )
        return OK if all(r == "ok" for r in results.values()) else CONNECTOR

    def stop(signum: int, frame: FrameType | None) -> None:
        agent.stop.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    return agent.run()


class _Checked:
    """A connector's result from `check`, reported in check's heartbeat."""

    def __init__(self, name: str, kind: str, state: str, detail: str) -> None:
        self.name = name
        self.kind = kind
        self.state = state
        self.detail = detail

    def start(self) -> None:
        pass

    def stop(self, timeout: float = 10) -> None:
        pass

    def status(self) -> dict[str, str]:
        detail = f"{self.detail} (tiles-edge check)"
        return {"name": self.name, "kind": self.kind, "status": self.state, "detail": detail[:500]}


def _try_connector(config: OpcUaConfig) -> str:
    """Connects once and disconnects: "ok", or why not."""
    from tiles_edge import opcua

    async def attempt() -> None:
        client = await opcua.connect(config)
        await client.disconnect()

    try:
        asyncio.run(attempt())
    except opcua.ConnectorError as e:
        return str(e)
    except Exception as e:
        return opcua.explain(e)
    return "ok"


def _normal(fingerprint: str) -> str:
    return "".join(c for c in fingerprint.upper() if c in "0123456789ABCDEF")


def _pick(config: Config, name: str | None) -> OpcUaConfig:
    names = [c.name for c in config.opcua]
    if not names:
        raise ConfigError("there is no [[opcua]] connector in the config")
    if name is None:
        if len(names) > 1:
            raise ConfigError(f"choose one with --connector: {', '.join(names)}")
        return config.opcua[0]
    for c in config.opcua:
        if c.name == name:
            return c
    raise ConfigError(f"no [[opcua]] named {name!r}; there are: {', '.join(names)}")


def _opcua(args: argparse.Namespace, config: Config) -> int:
    connectors.build(config, MemoryBuffer())  # checks the extra is installed
    from tiles_edge import opcua

    target = _pick(config, args.connector)
    try:
        if args.step == "cert":
            cert = asyncio.run(opcua.make_certificate(target))
            print(f"Certificate: {target.certificate}\nPrivate key: {target.private_key} (keep it on this machine)")
            print(f"Application URI: {target.application_uri}\nSHA-256 fingerprint: {opcua.fingerprint(cert)}")
            print("Add the certificate to the OPC UA server's trusted certificates, then check the fingerprint there.")
        elif args.step == "server-cert":
            cert = asyncio.run(opcua.presented_certificate(target))
            print(f"Server certificate for {target.endpoint} ({target.security}):")
            print(f"  subject: {cert.subject.rfc4514_string()}")
            print(f"  valid: {cert.not_valid_before_utc:%Y-%m-%d} to {cert.not_valid_after_utc:%Y-%m-%d}")
            print(f"  SHA-256 fingerprint: {opcua.fingerprint(cert)}")
            if args.save:
                if target.server_certificate is None:
                    raise ConfigError(f"[[opcua]] {target.name}: set server_certificate to say where to save it")
                # Pin only the certificate that was checked: this fetch is unauthenticated, so
                # it could differ from the one shown earlier.
                if _normal(args.save) != _normal(opcua.fingerprint(cert)):
                    raise opcua.ConnectorError(
                        "the server now presents a different certificate from the fingerprint given; "
                        "nothing was pinned. Check with the server's admin before trying again."
                    )
                opcua.save_certificate(cert, target.server_certificate)
                print(f"Pinned: saved to {target.server_certificate}.")
            else:
                print(
                    "Compare the fingerprint with the one the server's admin sees. If it matches, pin it with:\n"
                    f"  tiles-edge opcua server-cert -c {args.config} --connector {target.name} "
                    f"--save {opcua.fingerprint(cert)}"
                )
        else:
            entries = asyncio.run(opcua.browse(target, args.node, max(1, args.depth)))
            for e in entries:
                kind = f"{e.node_class} {e.data_type}".strip()
                print(f"{'  ' * e.depth}{e.name}  [{kind}]  {e.node}")
            if not entries:
                print("(no child nodes)")
    except opcua.ConnectorError as e:
        return _fail(f"{target.name}: {e}", CONNECTOR)
    except ConfigError as e:
        return _fail(str(e), CONFIG)
    except Exception as e:
        return _fail(f"{target.name}: {opcua.explain(e)}", CONNECTOR)
    return OK


def entry() -> NoReturn:
    """Exits with main()'s code. Zipapps call their entry point without passing on its return value."""
    sys.exit(main())
