"""The copilot's evaluation (T4.06): its scoring, its plant, and its cases, each answerable from what
the tools give on that plant (an oracle model asks the right tools and states the case's facts,
citing them; the grounding check then proves each fact is in a tool result)."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_agents import api  # noqa: F401 - a fixture

from tiles_api import evaluation, grounding
from tiles_api.assistant import Turn
from tiles_api.evaluation import Case, Result, Summary, Thresholds
from tiles_api.settings import Settings

# The tool calls that answer each case (what a good copilot would ask).
PLANS: dict[str, list[tuple[str, dict[str, Any]]]] = {
    "machines-on-line": [("graph_query", {"node": "Line 2"})],
    "plc-protocol": [("graph_query", {"node": "PLC DC-02"})],
    "machine-vendor": [("graph_query", {"node": "DC-01 die-casting cell"})],
    "ontology-problems": [("ontology_health", {})],
    "signal-count": [("site_overview", {})],
    "signal-unit": [("find_signals", {"query": "shot_speed"})],
    "last-pressure": [("time_series", {"tag": "dc01.hydraulic_pressure"})],
    "peak-pressure": [("time_series", {"tag": "dc01.hydraulic_pressure"})],
    "mean-speed": [("time_series", {"tag": "dc01.shot_speed"})],
    "die-temperature-trend": [("wear_check", {"tag": "dc02.die_temperature", "baseline_hours": 48})],
    "open-warnings": [("events", {})],
    "warning-signal": [("events", {})],
    "downtime-codes": [("events", {"kind": "events", "asset": "DC-01"})],
    "sop-plunger-tip": [("search_documents", {"query": "replace plunger tip"})],
    "sop-pressure-range": [("search_documents", {"query": "hydraulic pressure start-up"})],
}


class Oracle:
    """Calls a case's planned tools, then states its facts (each as the tool result put it, so a
    fact the tools don't give is caught by grounding), citing the results; declines the rest."""

    def __init__(self, cases: list[Case], lie: str | None = None) -> None:
        self.by_question = {c.question: c for c in cases}
        self.lie = lie  # a case whose answer gets a number no tool gave

    def stream(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Iterator[Turn]:
        question = grounding.text_of(messages[0])
        case = self.by_question[question]
        plan = PLANS.get(case.id, [])
        if len(messages) == 1 and plan:
            calls = [
                {"type": "tool_use", "id": f"t{n}", "name": name, "input": args} for n, (name, args) in enumerate(plan)
            ]
            yield Turn(calls, "tool_use")
            return
        if not plan:
            yield Turn([{"type": "text", "text": f"{grounding.DECLINE}."}], "end_turn")
            return
        results = " ".join(str(b.get("content")) for b in messages[-1]["content"] if b.get("type") == "tool_result")
        said = []
        for fact in case.facts:
            options = fact if isinstance(fact, tuple) else (fact,)
            said.append(next((o for o in options if o.lower() in results.lower()), options[0]))
        if case.id == self.lie:
            said.append("9,999 bar")
        yield Turn([{"type": "text", "text": "From the site's data: " + ", ".join(said) + " [1]."}], "end_turn")


def test_facts_are_stated_as_numbers_or_words() -> None:
    assert evaluation.states("The tip is replaced after 20,000 shots.", "20000")
    assert evaluation.states("about 152.0 bar", "152")
    assert evaluation.states("152.6 bar", "152")  # within 0.5%
    assert not evaluation.states("153 bar", "152")
    assert not evaluation.states("version 1152", "152")  # whole numbers only
    # Not a number of the answer's own: a citation, part of a name, a time or a date.
    assert not evaluation.states("Warnings are open on DC-02 [1]", "2")
    assert not evaluation.states("It was raised at 14:15 on 2026-10-15 [2]", "15")
    assert not evaluation.states("See [5].", "5")
    assert evaluation.states("It went to 15 kN at 14:15 [1]", "15")
    assert evaluation.states("Protocol: mqtt", "MQTT")
    assert not evaluation.states("OPC UA", "MQTT")


def test_a_case_is_scored_on_its_facts_tools_and_declining() -> None:
    case = Case("c", "q", ("events",), ("2", ("rising", "wear")), ("DC-03",))
    good = evaluation.score(case, Result("c", answer="2 warnings, wear on DC-02 [1]", tools=["events"], grounded=True))
    assert (good.correct, good.right_tools, good.missing, good.wrong) == (True, True, [], [])
    bad = evaluation.score(case, Result("c", answer="3 warnings on DC-03", tools=["find_signals"]))
    assert (bad.correct, bad.right_tools) == (False, False)
    assert bad.missing == ["2", "rising or wear"] and bad.wrong == ["DC-03"]
    decline = Case("d", "q", decline=True)
    assert evaluation.score(decline, Result("d", answer="It is 5", grounded=True)).missing == ["decline"]
    assert evaluation.score(decline, Result("d", declined=True, grounded=True)).correct
    # Declining what should be answered is wrong; an error is never correct.
    assert evaluation.score(case, Result("c", declined=True)).wrong == ["declined"]
    assert evaluation.score(case, Result("c", error="Stopped after 8 rounds")).missing == ["an answer"]


def test_what_counts_as_tool_choice_and_an_unsupported_claim() -> None:
    decline = Case("d", "q", decline=True)
    erred = evaluation.score(Case("c", "q", ("events",), ("2",)), Result("c", tools=["events"], error="Stopped"))
    assert (erred.right_tools, erred.correct) == (True, False)  # the right tools, though it never answered
    results = [evaluation.score(decline, Result("d", tools=["find_signals"], declined=True, grounded=True)), erred]
    summary = Summary(results, Thresholds())
    assert summary.tool_choice == 1.0  # a decline names no tools: not scored
    empty = Summary([Result("e", answer="", grounded=False)], Thresholds())
    assert empty.unsupported == 0  # an empty answer claims nothing


class Broken:
    def stream(self, **_kwargs: Any) -> Iterator[Turn]:
        raise ConnectionError("overloaded")


def test_a_case_that_fails_is_that_cases_error() -> None:
    result = evaluation.ask(Broken(), Case("c", "q", ("events",), ("2",)), [], "system")
    assert (result.error, result.correct) == ("ConnectionError: overloaded", False)


def test_the_gate() -> None:
    def summary(correct: int, ungrounded: int, tools: int, n: int = 20) -> Summary:
        results = [
            Result(str(i), answer="x", correct=i < correct, grounded=i >= ungrounded, right_tools=i < tools)
            for i in range(n)
        ]
        return Summary(results, Thresholds())

    assert summary(17, 0, 18).passed  # 85% correct, no unsupported claims, 90% tool choice
    assert not summary(16, 0, 20).passed
    assert not summary(20, 1, 20).passed  # one unsupported claim fails it
    assert not summary(20, 0, 17).passed
    assert summary(20, 0, 20).unsupported == 0


def test_the_cases_are_well_formed() -> None:
    cases = evaluation.cases()
    assert len(cases) >= 15 and len({c.id for c in cases}) == len(cases)
    assert {c.id for c in cases if not c.decline} == set(PLANS)  # every answerable case has a plan here
    assert all(c.facts for c in cases if not c.decline) and all(not c.facts for c in cases if c.decline)


def test_every_case_is_answerable_from_the_plant(api: TestClient, database_url: str) -> None:  # noqa: F811
    cases = evaluation.cases()
    summary = evaluation.run(Oracle(cases), api, database_url, cases)
    failed = [
        (r.case, r.missing, r.wrong, r.problems, r.error) for r in summary.results if not r.correct or not r.grounded
    ]
    assert failed == []
    assert (summary.accuracy, summary.unsupported, summary.tool_choice, summary.passed) == (1.0, 0, 1.0, True)
    assert evaluation.report(summary).startswith("# Copilot evaluation: passed")


def test_an_unsupported_claim_fails_the_gate(api: TestClient, database_url: str) -> None:  # noqa: F811
    cases = [c for c in evaluation.cases() if c.id in ("last-pressure", "unknown-machine")]
    summary = evaluation.run(Oracle(cases, lie="last-pressure"), api, database_url, cases)
    lied = next(r for r in summary.results if r.case == "last-pressure")
    # Withdrawn and asked again once (grounding.py), the oracle says the same: the answer kept is
    # ungrounded, an unsupported claim.
    assert (lied.grounded, "9999" in lied.problems.replace(",", "")) == (False, True)
    assert (summary.unsupported, summary.passed) == (1, False)
    text = evaluation.report(summary)
    assert text.startswith("# Copilot evaluation: FAILED") and "| Unsupported claims | 1 | at most 0 |" in text


def test_the_command_needs_the_copilots_settings(monkeypatch: pytest.MonkeyPatch, capsys: Any) -> None:
    monkeypatch.delenv("TILES_ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setattr(evaluation, "get_settings", lambda: Settings(_env_file=None))
    with pytest.raises(SystemExit) as e:
        evaluation.main([])
    assert e.value.code == 2 and "TILES_ANTHROPIC_API_KEY" in capsys.readouterr().err


def test_the_cases_file_is_json_in_the_documented_form() -> None:
    raw = json.loads((Path(evaluation.__file__).parent / "cases.json").read_text())
    assert set(raw) == {"about", "cases"}
    allowed = {"id", "question", "tools", "facts", "absent", "decline"}
    assert all(set(c) <= allowed for c in raw["cases"])
