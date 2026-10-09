"""The copilot's conversation loop (T4.01), with a scripted stand-in for Claude."""

import json
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

from anthropic.types import Message, TextBlock, ToolUseBlock, Usage

from tiles_api import assistant
from tiles_api.assistant import Event, Tool, ToolError, Turn


class Scripted:
    """Answers each call with the next scripted (texts, turn), and keeps what it was sent."""

    def __init__(self, *script: tuple[list[str], Turn]) -> None:
        self.script = list(script)
        self.calls: list[dict[str, Any]] = []

    def stream(
        self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> Iterator[str | Turn]:
        self.calls.append({"system": system, "messages": [dict(m) for m in messages], "tools": tools})
        texts, turn = self.script.pop(0)
        yield from texts
        yield turn


def text(t: str) -> dict[str, Any]:
    return {"type": "text", "text": t}


def call(name: str, args: dict[str, Any], id_: str = "t1") -> dict[str, Any]:
    return {"type": "tool_use", "id": id_, "name": name, "input": args}


def echo(args: dict[str, Any]) -> Any:
    if args.get("fail"):
        raise ToolError("Nothing found")
    if args.get("crash"):
        raise RuntimeError("bug")
    return {"echo": args.get("say", ""), "long": "x" * args.get("pad", 0)}


TOOLS = [Tool("echo", "Says it back", {"type": "object"}, echo)]
QUESTION = [{"role": "user", "content": [text("Hi?")]}]


def run(model: Scripted, max_rounds: int = 8) -> list[Event]:
    return list(assistant.respond(model, "sys", QUESTION, TOOLS, max_rounds))


def test_a_plain_answer_streams_its_text_and_is_one_message() -> None:
    model = Scripted((["Hel", "lo"], Turn([text("Hello")], "end_turn", {"input_tokens": 5, "output_tokens": 2})))
    events = run(model)
    assert [(e.kind, e.data) for e in events] == [
        ("text", {"text": "Hel"}),
        ("text", {"text": "lo"}),
        ("usage", {"input_tokens": 5, "output_tokens": 2}),
        ("message", {"role": "assistant", "content": [text("Hello")]}),
        ("done", {"stop_reason": "end_turn", "usage": {"input_tokens": 5, "output_tokens": 2}}),
    ]
    assert model.calls[0]["system"] == "sys"
    assert model.calls[0]["tools"] == [
        {"name": "echo", "description": "Says it back", "input_schema": {"type": "object"}}
    ]


def test_tool_calls_run_and_their_results_go_back_to_the_model() -> None:
    model = Scripted(
        (
            ["Let me look."],
            Turn([text("Let me look."), call("echo", {"say": "press 9"})], "tool_use", {"input_tokens": 9}),
        ),
        (["Press 9."], Turn([text("Press 9.")], "end_turn", {"input_tokens": 20, "output_tokens": 3})),
    )
    events = run(model)
    kinds = [e.kind for e in events]
    assert kinds == [
        "text",
        "usage",
        "message",
        "tool_use",
        "tool_result",
        "message",
        "text",
        "usage",
        "message",
        "done",
    ]
    assert events[3].data == {"id": "t1", "name": "echo", "input": {"say": "press 9"}}
    assert events[4].data["is_error"] is False
    result = events[5].data
    assert result["role"] == "user"
    assert json.loads(result["content"][0]["content"]) == {"echo": "press 9", "long": ""}
    assert result["content"][0]["tool_use_id"] == "t1"
    # The second call carries the question, the tool call and its result.
    assert [m["role"] for m in model.calls[1]["messages"]] == ["user", "assistant", "user"]
    assert events[-1].data["usage"] == {"input_tokens": 29, "output_tokens": 3}


def test_failing_unknown_and_long_tools_are_told_to_the_model() -> None:
    model = Scripted(
        (
            [],
            Turn(
                [
                    call("echo", {"fail": True}, "a"),
                    call("nope", {}, "b"),
                    call("echo", {"crash": True}, "c"),
                    call("echo", {"pad": 30_000}, "d"),
                ],
                "tool_use",
            ),
        ),
        ([], Turn([text("Sorry.")], "end_turn")),
    )
    events = run(model)
    results = next(e for e in events if e.kind == "message" and e.data["role"] == "user").data["content"]
    assert [(r["tool_use_id"], r["is_error"]) for r in results] == [("a", True), ("b", True), ("c", True), ("d", False)]
    assert results[0]["content"] == "Nothing found"
    assert results[1]["content"] == "No tool called nope"
    assert results[2]["content"] == "echo failed: the input may not fit it"
    assert len(results[3]["content"]) < 20_100
    assert results[3]["content"].endswith("(cut at 20000 characters: ask for less)")


def test_it_stops_after_too_many_rounds() -> None:
    loop: tuple[list[str], Turn] = ([], Turn([call("echo", {})], "tool_use", {"output_tokens": 1}))
    events = run(Scripted(loop, loop), max_rounds=2)
    assert events[-1] == Event(
        "error", {"detail": "Stopped after 2 rounds of tool calls without an answer", "usage": {"output_tokens": 2}}
    )


def test_the_sdk_adapter_streams_text_and_returns_plain_blocks() -> None:
    final = Message(
        id="msg_1",
        type="message",
        role="assistant",
        model="stand-in",
        content=[
            TextBlock(type="text", text="Checking."),
            ToolUseBlock(type="tool_use", id="t9", name="echo", input={"say": "x"}),
        ],
        stop_reason="tool_use",
        stop_sequence=None,
        usage=Usage(input_tokens=11, output_tokens=4),
    )
    sent: dict[str, Any] = {}

    class Stream:
        text_stream = iter(["Check", "ing."])

        def __enter__(self) -> "Stream":
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def get_final_message(self) -> Message:
            return final

    def stream(**kwargs: Any) -> Stream:
        sent.update(kwargs)
        return Stream()

    client = SimpleNamespace(messages=SimpleNamespace(stream=stream))
    out = list(assistant.AnthropicModel(client, "stand-in", 512).stream(system="s", messages=[], tools=[]))
    assert out[:2] == ["Check", "ing."]
    assert out[2] == Turn(
        [text("Checking."), call("echo", {"say": "x"}, "t9")], "tool_use", {"input_tokens": 11, "output_tokens": 4}
    )
    assert (sent["model"], sent["max_tokens"], sent["system"]) == ("stand-in", 512, "s")


def test_empty_answers_and_unrun_tool_calls_are_not_kept() -> None:
    # An empty answer after tools (it happens) isn't stored: the Messages API refuses empty messages.
    model = Scripted(
        ([], Turn([call("echo", {})], "tool_use")),
        ([], Turn([text(" ")], "end_turn")),
    )
    stored = [e.data for e in run(model) if e.kind == "message"]
    assert [m["role"] for m in stored] == ["assistant", "user"]
    # A turn cut short (max_tokens) mid tool call: the call never runs, so it isn't kept.
    cut = Scripted(([], Turn([text("Let me check"), call("echo", {})], "max_tokens")))
    events = run(cut)
    assert [e.data for e in events if e.kind == "message"] == [{"role": "assistant", "content": [text("Let me check")]}]
    assert not [e for e in events if e.kind == "tool_use"]
    assert events[-1].data["stop_reason"] == "max_tokens"


def test_a_broken_off_history_is_repaired_wherever_it_broke() -> None:
    def msg(role: str, *content: dict[str, Any]) -> dict[str, Any]:
        return {"role": role, "content": list(content)}

    result = {"type": "tool_result", "tool_use_id": "t1", "content": "{}"}
    history = [
        msg("user", text("First?")),
        msg("assistant", text("Looking."), call("echo", {})),  # its result was never stored
        msg("user", text("Second?")),
        msg("assistant"),  # empty
        msg("user", result),  # a result whose call isn't before it
        msg("assistant", call("echo", {}, "t2")),
        msg("user", {"type": "tool_result", "tool_use_id": "t2", "content": "{}"}),
        msg("assistant", text("Done.")),
    ]
    assert assistant.repaired(history) == [
        msg("user", text("First?")),
        msg("assistant", text("Looking.")),
        msg("user", text("Second?")),
        msg("assistant", call("echo", {}, "t2")),
        msg("user", {"type": "tool_result", "tool_use_id": "t2", "content": "{}"}),
        msg("assistant", text("Done.")),
    ]
    # Two questions in a row (the first answer broke off) are joined into one message.
    assert assistant.repaired([msg("user", text("a")), msg("user", text("b"))]) == [msg("user", text("a"), text("b"))]
