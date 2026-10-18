"""What the sample plants' tests share: an oracle copilot that calls each question's plan and
states its facts as the tools put them, and loading what a question set needs into a site."""

import csv
import io
import json
import re
from collections.abc import Iterable, Iterator
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tiles_api import evaluation, grounding
from tiles_api.assistant import Turn
from tiles_api.evaluation import Case
from tiles_api.sample_plant import common
from tiles_api.sample_plant.load import Loader, event_readings

NUMBER = re.compile(r"\d+(?:\.\d+)?(?:[eE][-+]?\d+)?")


def given(fact: str, results: str, numbers: list[str]) -> bool:
    """Whether the tools gave a fact: its words, or a number that rounds to it, as the grounding
    check reads one (83.4999 for 83.5)."""
    if fact.lower() in results.lower():
        return True
    plain = fact.replace(",", "")
    if not re.fullmatch(r"\d+(?:\.\d+)?", plain):
        return False
    places = len(plain.split(".")[1]) if "." in plain else 0
    return any(common.number(float(n), places) == common.number(float(plain), places) for n in numbers)


class Oracle:
    """Calls each question's plan, then states its facts as the tools put them, citing them: a fact
    the tools didn't give is left out, so its question fails."""

    def __init__(self, cases: list[Case], plans: dict[str, list[tuple[str, dict[str, Any]]]]) -> None:
        self.by_question = {c.question: c for c in cases}
        self.plans = plans

    def stream(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Iterator[Turn]:
        case = self.by_question[grounding.text_of(messages[0])]
        plan = self.plans.get(case.id, [])
        if len(messages) == 1 and plan:
            yield Turn(
                [
                    {"type": "tool_use", "id": f"t{n}", "name": name, "input": args}
                    for n, (name, args) in enumerate(plan)
                ],
                "tool_use",
            )
            return
        if not plan:
            yield Turn([{"type": "text", "text": f"{grounding.DECLINE}."}], "end_turn")
            return
        results = " ".join(str(b.get("content")) for b in messages[-1]["content"] if b.get("type") == "tool_result")
        numbers = NUMBER.findall(results)
        said = []
        for fact in case.facts:
            options = fact if isinstance(fact, tuple) else (fact,)
            said += [o for o in options if given(o, results, numbers)][:1]
        yield Turn([{"type": "text", "text": "From the site's data: " + ", ".join(said) + " [1]."}], "end_turn")


def windows(rows: Iterable[dict[str, str]]) -> dict[str, list[tuple[float, float]]]:
    out: dict[str, list[tuple[float, float]]] = {}
    for r in rows:
        for item in filter(None, (x.strip() for x in r["data"].split(";"))):
            tag, span = item.split("@")
            a, b = span.split("/")
            out.setdefault(tag, []).append(
                (datetime.fromisoformat(a).timestamp(), datetime.fromisoformat(b).timestamp())
            )
    return out


def answer_all(
    api: TestClient,
    site: str,
    who: dict[str, str],
    database_url: str,
    out: Path,
    capture: common.Capture,
    tables: dict[str, str],
) -> evaluation.Summary:
    """Loads into the site what the plant's question set reads (the plant model, the readings its
    plans name, the month's MES events, the catalogue, documents, planned stops and the month's batch
    tables, `tables` naming each by its capture key), checks a second load adds nothing, and asks every
    question of the oracle."""
    text = (out / "copilot" / "questions.csv").read_text()
    rows = list(csv.DictReader(io.StringIO(text)))
    plans = {r["id"]: [(name, args) for name, args in json.loads(r["plan"])] for r in rows if r["plan"]}
    loader = Loader(api, site, who)
    loader.ontology(out)
    readings = []
    for tag, spans in windows(rows).items():
        times, values = capture.readings[tag]
        for t, v in zip(times, values, strict=True):
            if any(a - 3600 <= t < b + 3600 for a, b in spans):
                readings.append((tag, common.iso(t), v))
    loader.readings("questions' readings", readings)
    month = [r for r in event_readings(out) if capture.start <= datetime.fromisoformat(r[1]).timestamp() < capture.end]
    loader.readings("the month's MES events", month)
    loader.catalogue(out)
    assert loader.documents(out) > 0 and loader.planned(out) > 0
    assert (loader.documents(out), loader.planned(out)) == (0, 0)  # loaded again: nothing twice
    for key, name in tables.items():
        loader.dataset(name, "", capture.quality[key])
    cases = evaluation.read_csv(text)
    return evaluation.run(
        Oracle(cases, plans), None, database_url, cases, on=evaluation.OnSite(site, who["X-Tiles-User"])
    )
