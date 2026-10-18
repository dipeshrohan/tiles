"""Loads the sample plant into a Tiles site through the API, as a site's own data would arrive:
- the plant model, imported and committed;
- readings, by imports;
- the MES's unplanned stops and scrap, as event streams;
- the signal catalogue;
- planned codes and stops;
- documents;
- the batch tables its manifest names (the die-casting plant's X-ray results).

The readings and batch tables under `generated/` come from `tiles-sample-plant generate <plant> --all`;
without them they are left out, and everything else still loads. A plant's copilot question set is
asked with `tiles-evaluate --cases data/sample-plants/<plant>/copilot/questions.csv --site …
--as …` once the plant is loaded without a time shift.

`--shift-to-now` moves every time on by whole weeks, so that the year ends in the week before
today: the copilot's and the pages' default windows ("the last 30 days") then find it. Weekdays
and shifts stay as they were, but the question set's dates no longer hold.
"""

import csv
import gzip
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

BATCH = 10_000  # readings a request (POST …/imports/{id}/samples takes at most 10,000)
ROWS = 5_000  # batch-table rows a request


# An httpx-shaped client: the API's TestClient, or HttpClient below (get, post, patch and put with
# json=, params=, content= and headers=, answering with status_code, text, content and json()).
Client = Any
Response = Any


class LoadError(RuntimeError):
    """A request the API refused."""


@dataclass
class _Reply:
    status_code: int
    content: bytes

    @property
    def text(self) -> str:
        return self.content.decode("utf-8", "replace")

    def json(self) -> Any:
        return json.loads(self.content)


class HttpClient:
    """The few calls the loader makes, over HTTP with the standard library (TestClient's shape)."""

    def __init__(self, base: str) -> None:
        self.base = base.rstrip("/")
        host = urllib.parse.urlsplit(self.base).hostname or ""
        local = host in ("localhost", "127.0.0.1", "::1")
        # The system's proxy settings, but never a proxy for an API on this machine.
        self.opener = urllib.request.build_opener(*([urllib.request.ProxyHandler({})] if local else []))

    def _call(
        self,
        method: str,
        url: str,
        json_body: Any = None,
        params: dict[str, Any] | None = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
    ) -> _Reply:
        full = self.base + url
        if params:
            full += "?" + urllib.parse.urlencode(params)
        data = content
        head = dict(headers or {})
        if json_body is not None:
            data = json.dumps(json_body).encode()
            head["Content-Type"] = "application/json"
        req = urllib.request.Request(full, data=data, method=method, headers=head)  # noqa: S310 - the API's own address
        try:
            with self.opener.open(req, timeout=300) as res:
                return _Reply(res.status, res.read())
        except urllib.error.HTTPError as e:
            return _Reply(e.code, e.read())
        except urllib.error.URLError as e:
            raise LoadError(f"Can't reach the API at {self.base}: {e.reason}") from e

    def get(self, url: str, **kw: Any) -> _Reply:
        return self._call("GET", url, params=kw.get("params"), headers=kw.get("headers"))

    def post(self, url: str, **kw: Any) -> _Reply:
        return self._call("POST", url, kw.get("json"), kw.get("params"), kw.get("content"), kw.get("headers"))

    def patch(self, url: str, **kw: Any) -> _Reply:
        return self._call("PATCH", url, kw.get("json"), kw.get("params"), None, kw.get("headers"))

    def put(self, url: str, **kw: Any) -> _Reply:
        return self._call("PUT", url, kw.get("json"), kw.get("params"), None, kw.get("headers"))


def _ok(res: Response, what: str) -> Any:
    if res.status_code >= 300:
        raise LoadError(f"{what}: {res.status_code} {res.text[:300]}")
    return res.json() if res.content else None


def year_end(root: Path) -> datetime:
    """When the plant's year ends (its manifest's `to`)."""
    return datetime.fromisoformat(json.loads((root / "manifest.json").read_text())["to"])


def shift_to_now(now: datetime, end: datetime) -> timedelta:
    """Whole weeks that move a year ending at `end` to the last week before `now`."""
    weeks = math.floor((now - end) / timedelta(weeks=1))
    return timedelta(weeks=max(0, weeks))


def planned_codes(root: Path) -> list[str]:
    """The MES's planned-downtime codes (mes/reason-codes.csv)."""
    with (root / "mes" / "reason-codes.csv").open(encoding="utf-8") as f:
        return [r["code"] for r in csv.DictReader(f) if r["kind"] == "downtime" and r["planned"] == "yes"]


def _at(text: str, shift: timedelta) -> str:
    return (datetime.fromisoformat(text.replace("Z", "+00:00")) + shift).isoformat()


def _key(asset: str) -> str:
    return asset.lower().replace("-", "")


Reading = tuple[str, str, float | str]  # tag, time (ISO), value


def historian_readings(root: Path, keep: Callable[[str, str], bool] | None = None) -> Iterator[Reading]:
    """The historian export and the shot curves, file by file (`keep(tag, time)` narrows them)."""
    files = sorted((root / "generated" / "historian").glob("*/*.csv.gz")) + sorted(
        (root / "generated" / "traces").glob("*.csv.gz")
    )
    for path in files:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if keep is None or keep(row["tag"], row["timestamp"]):
                    yield row["tag"], row["timestamp"], float(row["value"])


def event_readings(root: Path) -> Iterator[Reading]:
    """The MES's unplanned stops (each at its start, its code the value) and its scrapped parts."""
    with (root / "mes" / "stops.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["planned"] != "yes":
                yield f"mes.{_key(row['asset'])}.downtime", row["start"], row["code"]
    if not (root / "mes" / "scrap.csv").exists():  # a plant that scraps batches, not parts
        return
    with (root / "mes" / "scrap.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            yield f"mes.{_key(row['asset'])}.scrap", row["time"], row["code"]


@dataclass
class Loader:
    api: Client
    site: str
    who: dict[str, str]  # the engineer's headers
    shift: timedelta = timedelta(0)
    say: Callable[[str], None] = lambda _m: None
    has: set[str] | None = None  # the site's batch tables, once asked

    def url(self, path: str) -> str:
        return f"/sites/{self.site}{path}"

    def ontology(self, root: Path) -> None:
        content = (root / "plant" / "ontology.json").read_text(encoding="utf-8")
        body = {"format": "json", "content": content, "mode": "merge", "name": "ontology.json"}
        out = _ok(self.api.post(self.url("/ontology/import"), json=body, headers=self.who), "the plant model")
        if out["total"]:
            _ok(
                self.api.post(
                    self.url("/ontology/commits"),
                    json={"message": "The Kesselbach plant model (sample plant)"},
                    headers=self.who,
                ),
                "the plant model's commit",
            )
        self.say(f"Plant model: {out['total']} changes")

    def readings(self, name: str, readings: Iterable[Reading]) -> int:
        """One import of the readings, in batches; how many were new."""
        imp = _ok(self.api.post(self.url("/imports"), json={"name": name}, headers=self.who), f"import {name}")
        stored = 0
        batch: list[dict[str, Any]] = []

        def send() -> None:
            nonlocal stored
            out = _ok(
                self.api.post(self.url(f"/imports/{imp['id']}/samples"), json={"samples": batch}, headers=self.who),
                f"readings of {name}",
            )
            stored += out["stored"]
            batch.clear()

        for tag, at, value in readings:
            batch.append({"signal": tag, "at": _at(at, self.shift), "value": value})
            if len(batch) >= BATCH:
                send()
        if batch:
            send()
        _ok(self.api.post(self.url(f"/imports/{imp['id']}/finish"), headers=self.who), f"finishing {name}")
        self.say(f"{name}: {stored:,} new readings")
        return stored

    def signals(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        offset = 0
        while True:
            page = _ok(
                self.api.get(self.url("/signals"), params={"limit": 500, "offset": offset}, headers=self.who),
                "the signals",
            )
            for s in page["signals"]:
                out[s["tag"]] = s
            if len(page["signals"]) < 500:
                return out
            offset += 500

    def catalogue(self, root: Path) -> int:
        """Describes each signal that has readings as the tag list says, linked to its Signal node."""
        have = self.signals()
        nodes = {
            n["props"].get("tag"): n["id"]
            for n in json.loads((root / "plant" / "ontology.json").read_text())["nodes"]
            if n["type"] == "Signal"
        }
        done = 0
        with (root / "plant" / "tags.csv").open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                signal = have.get(row["tag"])
                if signal is None:
                    continue
                change: dict[str, Any] = {"description": row["description"]}
                for name in ("unit", "asset", "event_kind", "wear_direction"):
                    if row[name]:
                        change[name] = row[name]
                for name in ("sample_rate_hz", "range_min", "range_max", "stuck_after_s", "wear_limit"):
                    if row[name]:
                        change[name] = float(row[name])
                if row["tag"] in nodes:
                    change["node_id"] = nodes[row["tag"]]
                _ok(
                    self.api.patch(self.url(f"/signals/{signal['id']}"), json=change, headers=self.who),
                    f"signal {row['tag']}",
                )
                done += 1
        self.say(f"Signal catalogue: {done} signals described")
        return done

    def planned(self, root: Path) -> int:
        """The planned codes, and each planned stop the site doesn't have yet (by asset and start)."""
        _ok(
            self.api.put(self.url("/planned-codes"), json={"codes": planned_codes(root)}, headers=self.who),
            "the planned codes",
        )
        known: dict[str, set[tuple[str | None, float]]] = {}  # a month's stops on the site

        def have(month: datetime) -> set[tuple[str | None, float]]:
            key = month.strftime("%Y-%m")
            if key not in known:
                nxt = (month.replace(day=28) + timedelta(days=4)).replace(day=1)
                got = _ok(
                    self.api.get(
                        self.url("/planned-stops"),
                        params={"since": month.isoformat(), "until": nxt.isoformat()},
                        headers=self.who,
                    ),
                    "the planned stops",
                )
                known[key] = {(p["asset"], datetime.fromisoformat(p["starts_at"]).timestamp()) for p in got["stops"]}
            return known[key]

        n = 0
        with (root / "calendar" / "planned-stops.csv").open(encoding="utf-8") as f:
            for row in csv.DictReader(f):
                starts = datetime.fromisoformat(row["start"]) + self.shift
                asset = row["asset"] or None
                if (asset, starts.timestamp()) in have(starts.replace(day=1, hour=0, minute=0, second=0)):
                    continue
                body = {
                    "asset": asset,
                    "starts_at": starts.isoformat(),
                    "ends_at": _at(row["end"], self.shift),
                    "reason": row["reason"],
                }
                _ok(self.api.post(self.url("/planned-stops"), json=body, headers=self.who), "a planned stop")
                n += 1
        self.say(f"Planned stops: {n} new")
        return n

    def documents(self, root: Path) -> int:
        """Each document the site doesn't have yet (by title)."""
        titles = {d["title"] for d in _ok(self.api.get(self.url("/documents"), headers=self.who), "the documents")}
        n = 0
        for path in sorted((root / "documents").glob("*.md")):
            text = path.read_text(encoding="utf-8")
            title = text.splitlines()[0].removeprefix("# ")[:200]
            if title in titles:
                continue
            _ok(
                self.api.post(
                    self.url("/documents"),
                    params={"title": title, "filename": path.name},
                    content=text.encode(),
                    headers={**self.who, "Content-Type": "text/markdown"},
                ),
                f"document {path.name}",
            )
            n += 1
        self.say(f"Documents: {n} new")
        return n

    def dataset(self, name: str, description: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        if self.has is None:
            self.has = {d["name"] for d in _ok(self.api.get(self.url("/datasets"), headers=self.who), "the datasets")}
        if name in self.has:  # loaded before: a load can be run again after it stopped
            self.say(f"{name}: there already")
            return
        columns = [{"name": k, "kind": "text" if isinstance(v, str) else "number"} for k, v in rows[0].items()]
        d = _ok(
            self.api.post(
                self.url("/datasets"),
                json={"name": name, "description": description, "columns": columns},
                headers=self.who,
            ),
            f"dataset {name}",
        )
        for i in range(0, len(rows), ROWS):
            _ok(
                self.api.post(
                    self.url(f"/datasets/{d['id']}/rows"), json={"rows": rows[i : i + ROWS]}, headers=self.who
                ),
                f"rows of {name}",
            )
        self.say(f"{name}: {len(rows):,} rows")

    def tables(self, root: Path) -> int:
        """The batch tables the manifest names (`tables`: file, name, description, text columns)
        whose files were generated."""
        n = 0
        for path, t in json.loads((root / "manifest.json").read_text()).get("tables", {}).items():
            if not (root / path).exists():
                continue
            text = set(t["text"])
            with gzip.open(root / path, "rt", encoding="utf-8") as f:
                rows = [{k: (v if k in text else float(v)) for k, v in r.items()} for r in csv.DictReader(f)]
            self.dataset(t["name"], t["description"], rows)
            n += 1
        return n


def load(
    api: Client,
    site: str,
    who: dict[str, str],
    root: Path,
    *,
    shift: timedelta = timedelta(0),
    readings: bool = True,
    say: Callable[[str], None] = print,
) -> None:
    """Loads everything there is under `root` into the site."""
    ld = Loader(api, site, who, shift, say)
    ld.ontology(root)
    if readings and (root / "generated" / "historian").exists():
        ld.readings("historian export (sample plant)", historian_readings(root))
    ld.readings("MES stops and scrap (sample plant)", event_readings(root))
    ld.catalogue(root)
    ld.planned(root)
    ld.documents(root)
    if readings:
        ld.tables(root)


def main(args: Any) -> None:
    try:
        _main(args)
    except LoadError as e:
        print(e, file=sys.stderr)
        sys.exit(1)


def _main(args: Any) -> None:
    api = HttpClient(args.api)
    who = {"Authorization": f"Bearer {args.token}"} if args.token else {"X-Tiles-User": getattr(args, "as")}
    shift = shift_to_now(datetime.now(UTC), year_end(args.root)) if args.shift_to_now else timedelta(0)
    load(api, args.site, who, args.root, shift=shift, readings=not args.no_readings)


__all__ = [
    "HttpClient",
    "LoadError",
    "Loader",
    "event_readings",
    "historian_readings",
    "load",
    "planned_codes",
    "shift_to_now",
    "year_end",
]
