"""The copilot's conversation loop (T4.01): Claude with tool use, streamed.

A turn sends the conversation so far, the system prompt and the tools to the model, and streams
its text back as it comes. When the model asks for tools, they run (read-only, as the user who
asked) and their results go back to it; this repeats until it answers, at most `max_rounds`
times. Every message of the exchange (the answer, the tool calls and their results) is returned,
so the next question carries the whole conversation.

The model is behind `Model`, so the loop is tested without the network; `AnthropicModel` is the
real one (the official SDK's streaming helper). It caches the prompt (T4.07): the tools, the system
prompt and the conversation so far are the same at the start of every call of a question, and of
the next question, so each call reads them from the cache and writes only what is new.
"""

import json
import logging
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from tiles_api import grounding

log = logging.getLogger("tiles_api.copilot")

MAX_TOOL_OUTPUT = 20_000  # characters of a tool's result sent back to the model
MAX_TOOL_ERROR = 2_000  # and of a tool's reason for not answering
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")

SYSTEM = """You are the Tiles copilot for {site}, a site of {org}. Tiles holds the plant's ontology
(machines, lines, PLCs, signals and how they connect), its signals' readings, warnings and
analyses. Engineers and operators ask you about their plant.

Rules for every answer:
- State only what the tool results say. Each result starts with its number, like [3], then the tool
  and its input. Cite the result a fact comes from right after the fact, like "Press 9 runs at 42 °C
  [3]." An answer with no citation is not shown.
- Write numbers as the results give them (rounding is fine), and tags, node names and dataset names
  exactly, in backticks, like `press9.oil_temp`.
- If the tools give nothing that answers the question, say "{decline}." and what you looked for.
  Never guess, and never fill a gap from general knowledge about plants.
- Keep answers short and concrete, with units. Times are UTC unless the user says otherwise."""


@dataclass(frozen=True)
class Turn:
    """What the model said in one call: its content blocks (text and tool_use, as the Messages
    API takes them back), why it stopped, and the tokens it used."""

    content: list[dict[str, Any]]
    stop_reason: str | None
    usage: dict[str, int] = field(default_factory=dict)


class Model(Protocol):
    def stream(
        self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> Iterator[str | Turn]:
        """Text deltas as they come, then the whole Turn."""
        ...


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    run: Callable[[dict[str, Any]], Any]  # its input -> a JSON-able result; raises ToolError

    def spec(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "input_schema": self.input_schema}


class ToolError(Exception):
    """A tool could not answer (bad input, nothing found): the model is told why."""


EventKind = Literal["text", "tool_use", "tool_result", "message", "usage", "retract", "grounding", "done", "error"]


@dataclass(frozen=True)
class Event:
    kind: EventKind
    data: dict[str, Any]


def billed(usage: dict[str, int]) -> int:
    """Tokens as they are billed, in input tokens: input, cache writes and output in full, cache
    reads a tenth. Budgets and the usage dashboard count these, so caching is not counted against
    anyone. (Output is dearer per token, but the per-call max_tokens bounds it.)"""
    return (
        usage.get("input_tokens", 0)
        + usage.get("cache_creation_input_tokens", 0)
        + usage.get("output_tokens", 0)
        + usage.get("cache_read_input_tokens", 0) // 10
    )


def _blocks(content: Any, run_tools: bool) -> list[dict[str, Any]]:
    """The content to keep: without empty text (the Messages API refuses it), and without tool
    calls that won't run (a turn cut short by max_tokens), which would have no results."""
    blocks = content if isinstance(content, list) else [{"type": "text", "text": str(content)}]
    return [
        b
        for b in blocks
        if not (b.get("type") == "text" and not str(b.get("text", "")).strip())
        and (run_tools or b.get("type") != "tool_use")
    ]


def repaired(messages: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Stored messages as the Messages API takes them, whatever broke off while they were stored:
    a tool call keeps its place only if the next message has its result (and a result only if the
    message before has its call); empty messages are left out, and messages of one role in a row
    are joined."""
    msgs = [{"role": m["role"], "content": list(m["content"])} for m in messages]
    for i, m in enumerate(msgs):
        nxt = msgs[i + 1] if i + 1 < len(msgs) else None
        prev = msgs[i - 1] if i > 0 else None
        if m["role"] == "assistant":
            answered = {b.get("tool_use_id") for b in (nxt or {}).get("content", []) if b.get("type") == "tool_result"}
            m["content"] = [b for b in m["content"] if b.get("type") != "tool_use" or b.get("id") in answered]
        else:
            asked = {
                b.get("id")
                for b in (prev or {}).get("content", [])
                if prev and prev["role"] == "assistant" and b.get("type") == "tool_use"
            }
            m["content"] = [b for b in m["content"] if b.get("type") != "tool_result" or b.get("tool_use_id") in asked]
    out: list[dict[str, Any]] = []
    for m in msgs:
        if not m["content"]:
            continue
        if out and out[-1]["role"] == m["role"]:
            out[-1]["content"] = out[-1]["content"] + m["content"]
        else:
            out.append(m)
    return out


def _result(tool: Tool | None, name: str, args: dict[str, Any]) -> tuple[str, bool]:
    """A tool's result as the model reads it, and whether it failed."""
    if tool is None:
        return f"No tool called {name}", True
    try:
        out = json.dumps(tool.run(args), default=str, ensure_ascii=False)
    except ToolError as e:
        return str(e)[:MAX_TOOL_ERROR], True
    except Exception:
        log.exception("copilot tool failed", extra={"tool": name})
        return f"{name} failed: the input may not fit it", True
    if len(out) > MAX_TOOL_OUTPUT:
        out = out[:MAX_TOOL_OUTPUT] + f"… (cut at {MAX_TOOL_OUTPUT} characters: ask for less)"
    return out, False


def respond(
    model: Model,
    system: str,
    history: Sequence[dict[str, Any]],
    tools: Sequence[Tool],
    max_rounds: int = 8,
    budget: int = 0,
) -> Iterator[Event]:
    """Streams the answer to the conversation `history` (ending with the user's question).
    `message` events carry each new message to store, in order; `done` (or `error`) comes last.
    Once the question has used `budget` billed tokens (0: no limit), the model is not called again."""
    messages = [dict(m) for m in history]
    by_name = {t.name: t for t in tools}
    specs = [t.spec() for t in tools]
    usage: dict[str, int] = {}
    question = next(
        (grounding.text_of(m) for m in reversed(messages) if m["role"] == "user" and grounding.text_of(m)), ""
    )
    repaired_once = False
    withdrawn: list[str] = []  # why drafts were withdrawn, kept with the answer
    calls_left = max_rounds + 1  # one more for a withdrawn answer's second try
    while calls_left > (0 if repaired_once else 1):
        calls_left -= 1
        if budget and billed(usage) >= budget:
            yield Event(
                "error",
                {
                    "detail": f"This question used its budget of {budget:,} tokens before an answer: "
                    "ask a narrower one",
                    "usage": usage,
                    "over_budget": True,
                },
            )
            return
        turn: Turn | None = None
        for item in model.stream(system=system, messages=messages, tools=specs):
            if isinstance(item, Turn):
                turn = item
            elif item:
                yield Event("text", {"text": item})
        if turn is None:
            yield Event("error", {"detail": "The model returned no message", "usage": usage})
            return
        for k, v in turn.usage.items():
            usage[k] = usage.get(k, 0) + v
        yield Event("usage", dict(turn.usage))
        content = _blocks(turn.content, run_tools=turn.stop_reason == "tool_use")
        calls = [b for b in content if b.get("type") == "tool_use"]
        answer: dict[str, Any] = {"role": "assistant", "content": content}
        if not calls:
            # The final answer: held to the tool results it cites (grounding.py), rewritten once if
            # it states what they don't. The first try isn't kept; the user is told it is withdrawn.
            report = grounding.check(grounding.text_of(answer), question, messages)
            if not report.grounded and not repaired_once and content:
                repaired_once = True
                withdrawn.append(report.problems())
                yield Event("retract", {"reason": report.problems()})
                messages += [answer, {"role": "user", "content": [{"type": "text", "text": _repair(report)}]}]
                continue
            if content:  # an empty answer is left out: the Messages API refuses empty messages
                messages.append(answer)
                meta: dict[str, Any] = {"grounding": report.as_dict()}
                if withdrawn:
                    meta["withdrawn"] = withdrawn
                yield Event("message", answer | {"meta": meta})
            yield Event("grounding", report.as_dict())
            yield Event("done", {"stop_reason": turn.stop_reason, "usage": usage, "grounded": report.grounded})
            return
        messages.append(answer)
        yield Event("message", answer)
        results = []
        first = grounding.next_label(messages)
        for n, call in enumerate(calls, first):
            args = call.get("input") or {}
            yield Event("tool_use", {"id": call["id"], "name": call["name"], "input": args, "n": n})
            out, failed = _result(by_name.get(call["name"]), call["name"], args)
            yield Event(
                "tool_result", {"id": call["id"], "name": call["name"], "is_error": failed, "chars": len(out), "n": n}
            )
            labelled = grounding.label(n, call["name"], args, out)
            results.append({"type": "tool_result", "tool_use_id": call["id"], "content": labelled, "is_error": failed})
        reply = {"role": "user", "content": results}
        messages.append(reply)
        yield Event("message", reply)
    yield Event(
        "error", {"detail": f"Stopped after {max_rounds} rounds of tool calls without an answer", "usage": usage}
    )


def _repair(report: grounding.Grounding) -> str:
    return (
        f"(Tiles) That answer can't be shown: {report.problems()}. Answer again using only the tool results, "
        f"citing each fact's result like [n], or say \"{grounding.DECLINE}.\" if they don't answer the question. "
        "You may call tools again."
    )


EPHEMERAL = {"type": "ephemeral"}


def cached(
    system: str, tools: list[dict[str, Any]], messages: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    """The request with cache breakpoints (T4.07): after the tools and the system prompt (the same
    for every question on a site), and after the last message, so the next call (another tool round,
    or the next question) reads all of it from the cache. Copies: the stored messages are untouched."""
    sys_blocks = [{"type": "text", "text": system, "cache_control": EPHEMERAL}]
    tool_specs = [*tools[:-1], {**tools[-1], "cache_control": EPHEMERAL}] if tools else []
    msgs = list(messages)
    if msgs and isinstance(msgs[-1].get("content"), list) and msgs[-1]["content"]:
        last = msgs[-1]
        blocks = list(last["content"])
        blocks[-1] = {**blocks[-1], "cache_control": EPHEMERAL}
        msgs[-1] = {**last, "content": blocks}
    return sys_blocks, tool_specs, msgs


def _plain(block: Any) -> dict[str, Any]:
    """A response content block as the Messages API takes it back (only the fields it accepts)."""
    if block.type == "text":
        return {"type": "text", "text": block.text}
    if block.type == "tool_use":
        return {"type": "tool_use", "id": block.id, "name": block.name, "input": block.input}
    out: dict[str, Any] = block.model_dump(exclude_none=True)
    return out


class AnthropicModel:
    """The real model: the Messages API, streamed with the official SDK."""

    def __init__(self, client: Any, model: str, max_tokens: int) -> None:
        self.client = client
        self.model = model
        self.max_tokens = max_tokens

    def stream(
        self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> Iterator[str | Turn]:
        sys_blocks, tool_specs, msgs = cached(system, tools, messages)
        with self.client.messages.stream(
            model=self.model, max_tokens=self.max_tokens, system=sys_blocks, messages=msgs, tools=tool_specs
        ) as s:
            yield from s.text_stream
            final = s.get_final_message()
        usage = {k: v for k, v in final.usage.model_dump().items() if isinstance(v, int) and k in USAGE_KEYS}
        yield Turn([_plain(b) for b in final.content], final.stop_reason, usage)
