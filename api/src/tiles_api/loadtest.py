"""The load test (T5.15): edge agents sending readings for many signals, and people browsing.

`tiles-loadtest prepare` (database access, like `tiles-seed`) registers the agents the test sends
as, `load-0` … `load-N`, revoking earlier ones, and writes their tokens to a file. `tiles-loadtest
run` then drives an API:

- agents: each owns `signals / agents` signals (`load.a<agent>.s<signal>`) and sends a reading of
  each `rate` times a second, in a batch every `interval` seconds (split at the API's 10,000);
- users: each repeats a browsing step (searching signals, a signal's last ten minutes or day,
  the warnings, the ontology) with a pause of half a second to a second and a half between.

After a warm-up, it measures for `duration` seconds and writes a Markdown report: readings stored
a second against the target, how late batches went out, and each step's latency. It fails (exit 1)
when the API stores less than 99% of the target, a step's 95th percentile is over `--p95-ms`, or
any request fails.

    tiles-loadtest prepare --agents 10 --out tokens.txt
    tiles-loadtest run --api http://localhost:8000 --tokens tokens.txt --signals 10000 --users 50
"""

import argparse
import http.client
import json
import math
import random
import secrets
import sys
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlsplit

import psycopg
from psycopg.rows import dict_row

from tiles_api.api_agents import TOKEN_PREFIX, token_hash
from tiles_api.api_samples import MAX_BATCH
from tiles_api.settings import get_settings

USER_STEPS = ("signals.search", "signals.page", "series.10min", "series.day", "warnings", "ontology.graph")


# ---- results ----------------------------------------------------------------------------------


def percentile(values: list[float], p: float) -> float:
    """The `p`th percentile (0 to 100) by nearest rank; 0 for no values."""
    if not values:
        return 0.0
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[min(rank, len(ordered)) - 1]


@dataclass
class Step:
    """Latencies (ms) of one kind of request, and its failures."""

    ms: list[float] = field(default_factory=list)
    failures: dict[str, int] = field(default_factory=dict)  # status or error -> count

    def fail(self, why: str) -> None:
        self.failures[why] = self.failures.get(why, 0) + 1


@dataclass
class Results:
    steps: dict[str, Step] = field(default_factory=dict)
    stored: int = 0  # readings the API stored while measuring
    sent: int = 0  # readings in batches the API accepted while measuring
    covered_s: float = 0.0  # seconds of readings those batches held, summed over agents' shares
    late_ms: list[float] = field(default_factory=list)  # how late each batch went out
    lock: threading.Lock = field(default_factory=threading.Lock)

    def step(self, name: str) -> Step:
        with self.lock:
            return self.steps.setdefault(name, Step())


@dataclass(frozen=True)
class Targets:
    readings_per_s: float
    p95_ms: float
    interval_s: float  # an agent's batch interval: a batch later than that means it fell behind


def stored_rate(results: Results) -> float:
    """Readings stored a second of the readings' own time: what the measured batches held (not
    how many batches fell in the window, which its edges would skew)."""
    return results.stored / results.covered_s if results.covered_s else 0.0


def judge(results: Results, targets: Targets, seconds: float) -> list[str]:
    """What missed its target (empty: passed)."""
    problems = []
    rate = stored_rate(results)
    if rate < 0.99 * targets.readings_per_s:
        problems.append(f"stored {rate:,.0f} readings/s, under 99% of {targets.readings_per_s:,.0f}")
    late = percentile(results.late_ms, 95)
    if late > targets.interval_s * 1000:
        problems.append(f"batches went out {late:,.0f} ms late (95th percentile): the API isn't keeping pace")
    for name, step in sorted(results.steps.items()):
        if step.failures:
            problems.append(f"{name}: {sum(step.failures.values())} failed ({_failures(step)})")
        p95 = percentile(step.ms, 95)
        if name != "ingest" and p95 > targets.p95_ms:
            problems.append(f"{name}: 95th percentile {p95:,.0f} ms, over {targets.p95_ms:,.0f} ms")
    return problems


def _failures(step: Step) -> str:
    return ", ".join(f"{why} x{n}" for why, n in sorted(step.failures.items()))


def report(results: Results, targets: Targets, seconds: float, setup: dict[str, Any]) -> str:
    """The run as Markdown."""
    problems = judge(results, targets, seconds)
    lines = [
        "# Tiles load test",
        "",
        " · ".join(f"{k}: {v}" for k, v in setup.items()),
        "",
        f"**{'Passed' if not problems else 'Failed'}** over {seconds:.0f} s measured.",
        "",
        f"- Readings stored: {stored_rate(results):,.0f}/s (target {targets.readings_per_s:,.0f}/s); "
        f"{results.sent:,} sent, {results.stored:,} stored.",
        f"- Batches late: median {percentile(results.late_ms, 50):,.0f} ms, "
        f"95th percentile {percentile(results.late_ms, 95):,.0f} ms, worst {max(results.late_ms, default=0):,.0f} ms.",
        "",
        "| Request | Count | Per second | Median ms | 95th ms | 99th ms | Worst ms | Failed |",
        "|---|---:|---:|---:|---:|---:|---:|---|",
    ]
    for name, step in sorted(results.steps.items()):
        ms = step.ms
        lines.append(
            f"| {name} | {len(ms) + sum(step.failures.values())} | {len(ms) / seconds:.1f} | "
            f"{percentile(ms, 50):,.0f} | {percentile(ms, 95):,.0f} | {percentile(ms, 99):,.0f} | "
            f"{max(ms, default=0):,.0f} | {_failures(step) or '-'} |"
        )
    if problems:
        lines += ["", "## Missed", "", *(f"- {p}" for p in problems)]
    return "\n".join(lines) + "\n"


# ---- what is sent -----------------------------------------------------------------------------


def tag(agent: int, signal: int) -> str:
    return f"load.a{agent}.s{signal}"


def readings(agent: int, signals: int, start: float, seconds: float, rate: float) -> list[dict[str, Any]]:
    """An agent's readings for its `signals` from `start` (epoch seconds) for `seconds`, `rate` a
    second each: a slow sine per signal, so charts and checks see something like a process."""
    out = []
    steps = round(seconds * rate)
    for k in range(steps):
        t = start + k / rate
        at = datetime.fromtimestamp(t, UTC).isoformat()
        for s in range(signals):
            out.append({"signal": tag(agent, s), "at": at, "value": round(50 + 10 * math.sin(t / 60 + s), 3)})
    return out


def batches(items: list[dict[str, Any]], size: int = MAX_BATCH) -> Iterator[list[dict[str, Any]]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


# ---- HTTP -------------------------------------------------------------------------------------


class Http:
    """One kept-alive connection to the API (a thread's own), reconnecting after a failure."""

    def __init__(self, base: str, headers: dict[str, str], timeout: float = 30) -> None:
        parts = urlsplit(base)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError(f"Not an http(s) URL: {base}")
        self.https = parts.scheme == "https"
        self.host = parts.hostname
        self.port = parts.port
        self.prefix = parts.path.rstrip("/")
        self.headers = {"accept": "application/json", **headers}
        self.timeout = timeout
        self.conn: http.client.HTTPConnection | None = None

    def _connect(self) -> http.client.HTTPConnection:
        if self.conn is None:
            cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
            self.conn = cls(self.host, self.port, timeout=self.timeout)
        return self.conn

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None

    def __enter__(self) -> "Http":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any, float]:
        """(status, JSON answer or None, milliseconds); status 0 when the connection failed."""
        payload = json.dumps(body).encode() if body is not None else None
        headers = {**self.headers, **({"content-type": "application/json"} if payload else {})}
        started = time.perf_counter()
        try:
            conn = self._connect()
            conn.request(method, self.prefix + path, body=payload, headers=headers)
            res = conn.getresponse()
            raw = res.read()
            ms = (time.perf_counter() - started) * 1000
            try:
                data = json.loads(raw) if raw else None
            except ValueError:
                data = None
            return res.status, data, ms
        except (OSError, http.client.HTTPException):
            if self.conn is not None:
                self.conn.close()
            self.conn = None
            return 0, None, (time.perf_counter() - started) * 1000


# ---- the run ----------------------------------------------------------------------------------


@dataclass
class Run:
    api: str
    tokens: list[str]
    signals: int
    rate: float
    interval: float
    users: int
    user_headers: Callable[[int], dict[str, str]]
    site: str = ""
    measuring: threading.Event = field(default_factory=threading.Event)
    stop: threading.Event = field(default_factory=threading.Event)
    results: Results = field(default_factory=Results)
    signal_ids: list[str] = field(default_factory=list)

    def per_agent(self, agent: int) -> int:
        share, extra = divmod(self.signals, len(self.tokens))
        return share + (1 if agent < extra else 0)

    def agent(self, index: int) -> None:
        with Http(self.api, {"authorization": f"Bearer {self.tokens[index]}"}) as http_:
            self._agent(index, http_)

    def _agent(self, index: int, http_: Http) -> None:
        n = self.per_agent(index)
        step = self.results.step("ingest")
        # Each agent's batches start a little apart, as real agents' would.
        start = math.floor(time.time()) + index * self.interval / len(self.tokens)
        k = 0
        while not self.stop.is_set():
            due = start + k * self.interval
            wait = due + self.interval - time.time()  # a batch holds readings up to its send time
            if wait > 0 and self.stop.wait(wait):
                return
            late = max(0.0, time.time() - (due + self.interval)) * 1000
            measuring = self.measuring.is_set()
            for batch in batches(readings(index, n, due, self.interval, self.rate)):
                status, data, ms = http_.call("POST", "/agent/samples", {"samples": batch})
                if not measuring:
                    continue
                if status == 200 and isinstance(data, dict):
                    step.ms.append(ms)
                    with self.results.lock:
                        self.results.sent += int(data.get("received", 0))
                        self.results.stored += int(data.get("stored", 0))
                else:
                    step.fail(str(status or "no answer"))
            if measuring:
                with self.results.lock:
                    self.results.late_ms.append(late)
                    # This agent's share of the signals, for `interval` seconds of their time.
                    self.results.covered_s += self.interval * n / self.signals
            k += 1

    def user(self, index: int, seed: int) -> None:
        with Http(self.api, self.user_headers(index)) as http_:
            self._user(http_, random.Random(seed))  # noqa: S311 - choosing what to browse, not security

    def _user(self, http_: Http, rnd: random.Random) -> None:
        site = f"/sites/{self.site}"
        while not self.stop.is_set():
            name = rnd.choice(USER_STEPS)
            now = datetime.now(UTC)
            if name == "signals.search":
                path = f"{site}/signals?" + urlencode({"q": f"load.a{rnd.randrange(len(self.tokens))}.s1", "limit": 50})
            elif name == "signals.page":
                path = f"{site}/signals?" + urlencode(
                    {"limit": 100, "offset": rnd.randrange(max(1, self.signals - 100))}
                )
            elif name in ("series.10min", "series.day"):
                span, points = (timedelta(minutes=10), 1000) if name == "series.10min" else (timedelta(days=1), 500)
                signal = rnd.choice(self.signal_ids)
                path = f"{site}/signals/{signal}/series?" + urlencode(
                    {"from": (now - span).isoformat(), "to": now.isoformat(), "points": points}
                )
            elif name == "warnings":
                path = f"{site}/warnings"
            else:
                path = f"{site}/ontology/graph"
            status, _, ms = http_.call("GET", path)
            if self.measuring.is_set():
                step = self.results.step(name)
                if status == 200:
                    step.ms.append(ms)
                else:
                    step.fail(str(status or "no answer"))
            self.stop.wait(rnd.uniform(0.5, 1.5))

    def find_signals(self, http_: Http, wanted: int = 500, wait_s: float = 120) -> None:
        """Ids of the load signals, once the agents' first batches have made them."""
        deadline = time.time() + wait_s
        while time.time() < deadline:
            status, data, _ = http_.call(
                "GET", f"/sites/{self.site}/signals?" + urlencode({"q": "load.a", "limit": 500})
            )
            if status == 200 and isinstance(data, dict) and data.get("signals"):
                self.signal_ids = [str(s["id"]) for s in data["signals"]][:wanted]
                return
            time.sleep(1)
        raise SystemExit("The load signals didn't appear: are the agents' tokens for this API?")


def run(args: argparse.Namespace) -> int:
    tokens = [t.strip() for t in Path(args.tokens).read_text().splitlines() if t.strip()]
    if not tokens:
        raise SystemExit(f"No agent tokens in {args.tokens}: run `tiles-loadtest prepare` first")
    per_batch = math.ceil(args.signals / len(tokens)) * args.rate * args.interval
    bearer = args.token

    def user_headers(i: int) -> dict[str, str]:
        if bearer:
            return {"authorization": f"Bearer {bearer}"}
        return {"x-tiles-user": f"load-user-{i}@example.com"}  # the dev identity (not in production)

    r = Run(args.api, tokens, args.signals, args.rate, args.interval, args.users, user_headers)
    with Http(args.api, user_headers(0)) as probe:
        return _drive(r, args, probe, per_batch)


def _drive(r: Run, args: argparse.Namespace, probe: Http, per_batch: float) -> int:
    status, sites, _ = probe.call("GET", "/sites")
    if status != 200 or not isinstance(sites, list) or not sites:
        raise SystemExit(f"GET /sites answered {status}: is the API at {args.api}, and are you a member of a site?")
    r.site = args.site or str(sites[0]["id"])
    print(
        f"{len(r.tokens)} agents x {per_batch:,.0f} readings every {args.interval:g} s "
        f"({args.signals:,} signals at {args.rate:g} Hz), {args.users} users; warm-up {args.warmup:g} s",
        file=sys.stderr,
    )
    threads = [threading.Thread(target=r.agent, args=(i,), daemon=True) for i in range(len(r.tokens))]
    for t in threads:
        t.start()
    r.find_signals(probe)
    users = [threading.Thread(target=r.user, args=(i, args.seed + i), daemon=True) for i in range(args.users)]
    for t in users:
        t.start()
    time.sleep(args.warmup)
    r.measuring.set()
    started = time.time()
    time.sleep(args.duration)
    r.measuring.clear()
    seconds = time.time() - started
    r.stop.set()
    for t in threads + users:
        t.join(timeout=60)
    setup = {
        "signals": f"{args.signals:,} at {args.rate:g} Hz",
        "agents": len(r.tokens),
        "batch": f"every {args.interval:g} s",
        "users": args.users,
        "API": args.api,
    }
    targets = Targets(readings_per_s=args.signals * args.rate, p95_ms=args.p95_ms, interval_s=args.interval)
    text = report(r.results, targets, seconds, setup)
    print(text)
    if args.report:
        Path(args.report).write_text(text)
    return 1 if judge(r.results, targets, seconds) else 0


def prepare(args: argparse.Namespace) -> int:
    """Registers the load agents `load-0` … on a site (revoking earlier ones) and writes their tokens."""
    settings = get_settings()
    tokens = [TOKEN_PREFIX + secrets.token_urlsafe(32) for _ in range(args.agents)]
    with psycopg.connect(
        settings.database_url.get_secret_value(), row_factory=dict_row, options="-c tiles.site_id=*"
    ) as conn:
        site = conn.execute(
            "SELECT s.id, s.org_id FROM sites s JOIN orgs o ON o.id = s.org_id"
            " WHERE (%(site)s::uuid IS NULL AND o.slug = 'demo') OR s.id = %(site)s::uuid"
            " ORDER BY s.created_at LIMIT 1",
            {"site": args.site},
        ).fetchone()
        if site is None:
            raise SystemExit("No such site (without --site: the demo site, made by tiles-seed)")
        conn.execute(
            "UPDATE edge_agents SET revoked_at = clock_timestamp()"
            " WHERE site_id = %s AND name LIKE 'load-%%' AND revoked_at IS NULL",
            [site["id"]],
        )
        for i, token in enumerate(tokens):
            conn.execute(
                "INSERT INTO edge_agents (org_id, site_id, name, token_hash) VALUES (%s, %s, %s, %s)",
                [site["org_id"], site["id"], f"load-{i}", token_hash(token)],
            )
    out = Path(args.out)
    out.write_text("\n".join(tokens) + "\n")
    out.chmod(0o600)
    print(f"{args.agents} load agents on site {site['id']}; their tokens are in {out}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> None:
    """`tiles-loadtest`: the load test (T5.15)."""
    parser = argparse.ArgumentParser(prog="tiles-loadtest", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="action", required=True)
    prep = sub.add_parser("prepare", help="register the load agents (needs TILES_DATABASE_URL)")
    prep.add_argument("--agents", type=int, default=10)
    prep.add_argument("--site", type=uuid.UUID, help="the site's id (default: the demo site)")
    prep.add_argument("--out", default="loadtest-tokens.txt", help="where to write their tokens (mode 0600)")
    go = sub.add_parser("run", help="drive the API and report")
    go.add_argument("--api", default="http://localhost:8000")
    go.add_argument("--tokens", default="loadtest-tokens.txt", help="the agents' tokens, one a line")
    go.add_argument("--site", help="the site's id (default: the first the API lists)")
    go.add_argument("--signals", type=int, default=10_000)
    go.add_argument("--rate", type=float, default=1.0, help="readings a second per signal")
    go.add_argument("--interval", type=float, default=5.0, help="seconds between an agent's batches")
    go.add_argument("--users", type=int, default=50)
    go.add_argument("--token", help="a bearer token for the users (default: the dev identity)")
    go.add_argument("--warmup", type=float, default=15.0)
    go.add_argument("--duration", type=float, default=120.0)
    go.add_argument("--p95-ms", type=float, default=1000.0, help="each browsing step's 95th percentile limit")
    go.add_argument("--seed", type=int, default=1)
    go.add_argument("--report", help="also write the Markdown report here")
    args = parser.parse_args(argv)
    sys.exit(prepare(args) if args.action == "prepare" else run(args))
