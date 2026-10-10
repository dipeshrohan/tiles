"""The copilot's evaluation (T4.06): every case in cases.json asked of the copilot, as a person on
the site would ask it, on the plant in plant.py, scored on three things:

- **accuracy:** the answer states the case's facts (or declines, when that is the right answer) and
  none of what it must not say;
- **grounding:** the answer kept is grounded (grounding.py): every number and name it states is in a
  tool result it cites. An ungrounded answer is an unsupported claim;
- **tool choice:** it called the tools the case names.

The gate (`Thresholds`): accuracy at least 85% and no unsupported claims, with tool choice at least
90%. `tiles-evaluate` (a development tool: run it with `uv run`, which has the test client) runs it
against Claude (TILES_ANTHROPIC_API_KEY, TILES_COPILOT_MODEL) on a new site in the database it is
given, and exits 1 under the gate; tests run it with a scripted model.
"""

import argparse
import json
import re
import sys
import uuid
from collections.abc import Iterator, Sequence
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import TYPE_CHECKING, Any

import psycopg
from psycopg.rows import dict_row

from tiles_api import assistant, copilot_tools, grounding
from tiles_api.api_ontology import SiteContext
from tiles_api.evaluation import plant
from tiles_api.identity import User, ensure_org
from tiles_api.settings import Settings, get_settings
from tiles_api.store import UNSCOPED, one

if TYPE_CHECKING:  # the test client needs httpx, a development dependency: evaluating is a developer's job
    from fastapi.testclient import TestClient

EVALUATOR = {"X-Tiles-User": "copilot-evaluation@example.com"}
# A number standing alone: not inside a name (DC-02), a time (14:15), a date (2026-10-15) or a path.
NUMBER = re.compile(r"(?<![\w.\-:/])\d[\d,]*(?:\.\d+)?(?![\w]|[\-:/]\d)")
CITATION = re.compile(r"\[\d+\]")


@dataclass(frozen=True)
class Case:
    id: str
    question: str
    tools: tuple[str, ...] = ()
    facts: tuple[str | tuple[str, ...], ...] = ()  # a tuple: any one of its alternatives
    absent: tuple[str, ...] = ()
    decline: bool = False


@dataclass
class Result:
    """What the copilot did with a case, and how it scored."""

    case: str
    answer: str = ""
    tools: list[str] = field(default_factory=list)
    grounded: bool = False
    declined: bool = False
    error: str | None = None
    correct: bool = False
    right_tools: bool = False
    scores_tools: bool = True  # whether its case names tools (a decline names none: not scored)
    missing: list[str] = field(default_factory=list)  # facts not stated, or "decline"
    wrong: list[str] = field(default_factory=list)  # what it said but must not
    problems: str = ""  # the grounding check's, when it wasn't grounded


@dataclass(frozen=True)
class Thresholds:
    accuracy: float = 0.85
    unsupported: int = 0
    tool_choice: float = 0.90


@dataclass
class Summary:
    results: list[Result]
    thresholds: Thresholds

    @property
    def accuracy(self) -> float:
        return sum(r.correct for r in self.results) / len(self.results) if self.results else 0.0

    @property
    def unsupported(self) -> int:
        """Answers kept that state what no cited tool result holds (an empty answer states nothing)."""
        return sum(1 for r in self.results if r.error is None and r.answer.strip() and not r.grounded)

    @property
    def tool_choice(self) -> float:
        """Of the cases that name tools, the share that called them all."""
        scored = [r for r in self.results if r.scores_tools]
        return sum(r.right_tools for r in scored) / len(scored) if scored else 1.0

    @property
    def passed(self) -> bool:
        t = self.thresholds
        return self.accuracy >= t.accuracy and self.unsupported <= t.unsupported and self.tool_choice >= t.tool_choice


def cases(path: str | Path | None = None) -> list[Case]:
    """The evaluation set: cases.json beside this module, or another file in its form."""
    text = Path(path).read_text() if path else resources.files(__package__).joinpath("cases.json").read_text()
    out = []
    for c in json.loads(text)["cases"]:
        facts = tuple(tuple(f) if isinstance(f, list) else f for f in c.get("facts", []))
        out.append(
            Case(
                c["id"],
                c["question"],
                tuple(c.get("tools", [])),
                facts,
                tuple(c.get("absent", [])),
                c.get("decline", False),
            )
        )
    if len({c.id for c in out}) != len(out):
        raise ValueError("Case ids must be unique")
    return out


def _numbers(text: str) -> list[float]:
    """The numbers an answer states, leaving out its citations ([1])."""
    return [float(n.replace(",", "").rstrip(",")) for n in NUMBER.findall(CITATION.sub(" ", text)) if n.strip(",")]


def states(answer: str, fact: str) -> bool:
    """Whether `answer` states `fact`: a number within 0.5% (thousands separators allowed), or the
    words, whatever their case."""
    plain = fact.replace(",", "")
    try:
        want = float(plain)
    except ValueError:
        return fact.lower() in answer.lower()
    return any(abs(n - want) <= abs(want) * 0.005 + 1e-9 for n in _numbers(answer))


def score(case: Case, result: Result) -> Result:
    """Fills in how `result` scored on `case`."""
    result.scores_tools = bool(case.tools)
    result.right_tools = set(case.tools) <= set(result.tools)
    if result.error is not None:
        result.missing = ["an answer"]
        return result
    for fact in case.facts:
        options = fact if isinstance(fact, tuple) else (fact,)
        if not any(states(result.answer, f) for f in options):
            result.missing.append(" or ".join(options))
    if case.decline and not result.declined:
        result.missing.append("decline")
    if not case.decline and result.declined:
        result.wrong.append("declined")
    result.wrong += [a for a in case.absent if a.lower() in result.answer.lower()]
    result.correct = not result.missing and not result.wrong
    return result


def ask(
    model: assistant.Model,
    case: Case,
    tools: Sequence[assistant.Tool],
    system: str,
    rounds: int = 8,
    budget: int = 0,
) -> Result:
    """Asks the copilot one case's question, as a new conversation, and scores the answer. A failure
    (the model's API down, say) is that case's error, not the evaluation's end."""
    result = Result(case.id)
    history: list[dict[str, Any]] = [{"role": "user", "content": [{"type": "text", "text": case.question}]}]
    try:
        _ask(model, history, tools, system, rounds, budget, result)
    except Exception as e:
        result.error = f"{type(e).__name__}: {e}"[:300]
    return score(case, result)


def _ask(
    model: assistant.Model,
    history: list[dict[str, Any]],
    tools: Sequence[assistant.Tool],
    system: str,
    rounds: int,
    budget: int,
    result: Result,
) -> None:
    for event in assistant.respond(model, system, history, tools, rounds, budget):
        if event.kind == "tool_use":
            result.tools.append(event.data["name"])
        elif event.kind == "message" and event.data.get("role") == "assistant" and "meta" in event.data:
            result.answer = grounding.text_of(event.data)
        elif event.kind == "grounding":
            result.grounded = bool(event.data["grounded"])
            result.declined = bool(event.data["declined"])
            if not result.grounded:
                result.problems = grounding.Grounding(**event.data).problems()
        elif event.kind == "error":
            result.error = str(event.data.get("detail"))


def run(
    model: assistant.Model,
    api: "TestClient",
    database_url: str,
    selected: Sequence[Case],
    thresholds: Thresholds | None = None,
    now: datetime | None = None,
    workers: int = 4,
) -> Summary:
    """Loads the plant into a new site of the `copilot-evaluation` organisation, then asks every
    case (`workers` at a time) as an engineer there, with the copilot's own tools and limits."""
    site, org, org_id, name = _site(database_url)
    me = api.get(f"/sites/{site}/me", headers=EVALUATOR)  # the evaluator joins the site
    if me.status_code != 200 or me.json().get("role") not in ("engineer", "admin"):
        raise plant.PlantError(f"The evaluator can't work on the evaluation site: {me.status_code} {me.text[:200]}")
    plant.load(api, str(site), EVALUATOR, now or datetime.now(UTC))
    user = User(uuid.UUID(me.json()["user_id"]), "Copilot evaluation", EVALUATOR["X-Tiles-User"], me.json()["role"])

    @contextmanager
    def open_ctx() -> Iterator[SiteContext]:
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            yield SiteContext(conn, site, org_id, user)

    # As api_copilot asks: an engineer's tools (proposals too), the rounds and the token budget.
    settings = api.app.state.settings  # type: ignore[attr-defined]
    tools = copilot_tools.tools_for(open_ctx, can_propose=True, conversation_id=uuid.uuid4())
    system = assistant.SYSTEM.format(site=name, org=org, decline=grounding.DECLINE)
    rounds, budget = settings.copilot_max_rounds, settings.copilot_question_tokens
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(lambda c: ask(model, c, tools, system, rounds, budget), selected))
    return Summary(results, thresholds or Thresholds())


def _site(database_url: str) -> tuple[uuid.UUID, str, uuid.UUID, str]:
    """A new site, so each evaluation starts from the plant alone."""
    name = f"Evaluation {datetime.now(UTC):%Y-%m-%d %H:%M}"
    with psycopg.connect(database_url, row_factory=dict_row, options=UNSCOPED) as conn:
        org_id = ensure_org(conn, "copilot-evaluation")
        org = one(conn.execute("SELECT name FROM orgs WHERE id = %s", [org_id]).fetchone())["name"]
        site = one(
            conn.execute(
                "INSERT INTO sites (org_id, slug, name) VALUES (%s, %s, %s) RETURNING id",
                [org_id, f"eval-{uuid.uuid4().hex[:10]}", name],
            ).fetchone()
        )["id"]
    return site, org, org_id, name


def report(summary: Summary) -> str:
    """The evaluation as Markdown: the scores against the gate, then each case."""
    t = summary.thresholds
    lines = [
        f"# Copilot evaluation: {'passed' if summary.passed else 'FAILED'}",
        "",
        "| Measure | Score | Gate |",
        "| --- | --- | --- |",
        f"| Accuracy | {summary.accuracy:.0%} | at least {t.accuracy:.0%} |",
        f"| Unsupported claims | {summary.unsupported} | at most {t.unsupported} |",
        f"| Tool choice | {summary.tool_choice:.0%} | at least {t.tool_choice:.0%} |",
        "",
        "| Case | Correct | Grounded | Tools | What was wrong |",
        "| --- | --- | --- | --- | --- |",
    ]
    for r in summary.results:
        why = "; ".join(
            [*(f"missing {m}" for m in r.missing), *(f"said {w}" for w in r.wrong)]
            + ([r.problems] if r.problems else [])
            + ([r.error] if r.error else [])
        )
        tools = ", ".join(r.tools) or "none"
        lines.append(
            f"| {r.case} | {'yes' if r.correct else 'no'} | {'yes' if r.grounded else 'no'} | {tools} |"
            f" {why.replace('|', '/')} |"
        )
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> None:
    """tiles-evaluate: asks the copilot every case of the evaluation set on a new site loaded with
    the evaluation plant, prints the report, and exits 1 under the gate."""
    parser = argparse.ArgumentParser(prog="tiles-evaluate", description=main.__doc__)
    parser.add_argument("--cases", help="another evaluation set, in cases.json's form")
    parser.add_argument("--only", nargs="*", help="these cases only (their ids)")
    parser.add_argument("--report", help="also write the report (Markdown) here")
    parser.add_argument("--json", help="also write each case's result (JSON) here")
    parser.add_argument("--workers", type=int, default=4, help="cases asked at once (4)")
    args = parser.parse_args(argv)
    settings = get_settings()
    key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_api_key else ""
    if not key or not settings.copilot_model:
        print("Set TILES_ANTHROPIC_API_KEY and TILES_COPILOT_MODEL to evaluate the copilot", file=sys.stderr)
        sys.exit(2)
    import anthropic
    from fastapi.testclient import TestClient

    from tiles_api.main import create_app

    model = assistant.AnthropicModel(
        anthropic.Anthropic(api_key=key, max_retries=3, timeout=120),
        settings.copilot_model,
        settings.copilot_max_tokens,
    )
    selected = [c for c in cases(args.cases) if not args.only or c.id in args.only]
    url = settings.database_url.get_secret_value()
    app_settings = Settings(_env_file=None, database_url=url, env="test", data_keys=settings.data_keys)
    with TestClient(create_app(app_settings)) as api:
        summary = run(model, api, url, selected, workers=args.workers)
    text = report(summary)
    print(text)
    if args.report:
        Path(args.report).write_text(text)
    if args.json:
        Path(args.json).write_text(json.dumps([asdict(r) for r in summary.results], indent=2))
    sys.exit(0 if summary.passed else 1)
