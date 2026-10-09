"""The copilot's conversation loop (T4.01), with a scripted stand-in for Claude."""

import json
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

from anthropic.types import Message, TextBlock, ToolUseBlock, Usage

from tiles_api import assistant, grounding
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
    # A question back states nothing, so it needs no citation.
    model = Scripted(
        (["Which ", "press?"], Turn([text("Which press?")], "end_turn", {"input_tokens": 5, "output_tokens": 2}))
    )
    events = run(model)
    report = {
        "grounded": True,
        "declined": False,
        "cited": [],
        "unknown_citations": [],
        "unsupported_numbers": [],
        "unsupported_names": [],
        "uncited": False,
    }
    assert [(e.kind, e.data) for e in events] == [
        ("text", {"text": "Which "}),
        ("text", {"text": "press?"}),
        ("usage", {"input_tokens": 5, "output_tokens": 2}),
        ("message", {"role": "assistant", "content": [text("Which press?")], "meta": {"grounding": report}}),
        ("grounding", report),
        ("done", {"stop_reason": "end_turn", "usage": {"input_tokens": 5, "output_tokens": 2}, "grounded": True}),
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
        (["Press 9 [1]."], Turn([text("Press 9 [1].")], "end_turn", {"input_tokens": 20, "output_tokens": 3})),
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
        "grounding",
        "done",
    ]
    assert events[3].data == {"id": "t1", "name": "echo", "input": {"say": "press 9"}, "n": 1}
    assert events[4].data["is_error"] is False
    result = events[5].data
    assert result["role"] == "user"
    # Each result is numbered for citing, with its tool and input, then what it gave.
    head, body = result["content"][0]["content"].split("\n", 1)
    assert head == '[1] echo {"say": "press 9"}'
    assert json.loads(body) == {"echo": "press 9", "long": ""}
    assert events[-2].data["grounded"] is True
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
        ([], Turn([text("I can't answer that from the site's data.")], "end_turn")),
    )
    events = run(model)
    results = next(e for e in events if e.kind == "message" and e.data["role"] == "user").data["content"]
    assert [(r["tool_use_id"], r["is_error"]) for r in results] == [("a", True), ("b", True), ("c", True), ("d", False)]
    assert results[0]["content"] == '[1] echo {"fail": true}\nNothing found'
    assert results[1]["content"] == "[2] nope {}\nNo tool called nope"
    assert results[2]["content"] == '[3] echo {"crash": true}\necho failed: the input may not fit it'
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
        usage=Usage(input_tokens=11, output_tokens=4, cache_creation_input_tokens=300, cache_read_input_tokens=2000),
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
    history = [{"role": "user", "content": [text("Hi")]}]
    tools = [{"name": "a", "description": "", "input_schema": {}}, {"name": "b", "description": "", "input_schema": {}}]
    out = list(assistant.AnthropicModel(client, "stand-in", 512).stream(system="s", messages=history, tools=tools))
    assert out[:2] == ["Check", "ing."]
    usage = {
        "input_tokens": 11,
        "output_tokens": 4,
        "cache_creation_input_tokens": 300,
        "cache_read_input_tokens": 2000,
    }
    assert out[2] == Turn([text("Checking."), call("echo", {"say": "x"}, "t9")], "tool_use", usage)
    assert (sent["model"], sent["max_tokens"]) == ("stand-in", 512)
    # The prompt is cached (T4.07): the tools, the system prompt, and the conversation to its end.
    ephemeral = {"type": "ephemeral"}
    assert sent["system"] == [{"type": "text", "text": "s", "cache_control": ephemeral}]
    assert sent["tools"] == [tools[0], tools[1] | {"cache_control": ephemeral}]
    assert sent["messages"] == [{"role": "user", "content": [text("Hi") | {"cache_control": ephemeral}]}]
    assert history == [{"role": "user", "content": [text("Hi")]}]  # what is stored is untouched
    assert "cache_control" not in tools[1]


def test_cache_breakpoints_without_tools_or_messages() -> None:
    system, tools, messages = assistant.cached("s", [], [])
    assert system == [{"type": "text", "text": "s", "cache_control": {"type": "ephemeral"}}]
    assert (tools, messages) == ([], [])


def test_billed_tokens_count_cache_reads_a_tenth() -> None:
    assert assistant.billed({}) == 0
    usage = {
        "input_tokens": 100,
        "output_tokens": 20,
        "cache_creation_input_tokens": 1000,
        "cache_read_input_tokens": 5009,
    }
    assert assistant.billed(usage) == 100 + 20 + 1000 + 500


def test_a_question_stops_at_its_token_budget() -> None:
    # Each tool round costs 600 billed tokens; with a budget of 1,000 the third call is never made.
    rounds: list[tuple[list[str], Turn]] = [
        ([], Turn([call("echo", {"say": str(i)}, f"t{i}")], "tool_use", {"input_tokens": 600})) for i in range(3)
    ]
    model = Scripted(*rounds)
    events = list(assistant.respond(model, "s", [{"role": "user", "content": [text("Go")]}], TOOLS, budget=1000))
    assert len(model.calls) == 2
    last = events[-1]
    assert last.kind == "error" and last.data["over_budget"] is True
    assert "budget of 1,000 tokens" in last.data["detail"]
    assert last.data["usage"] == {"input_tokens": 1200}
    # Without a budget it goes on.
    model = Scripted(*rounds, ([], Turn([text(grounding.DECLINE + ".")], "end_turn")))
    list(assistant.respond(model, "s", [{"role": "user", "content": [text("Go")]}], TOOLS))
    assert len(model.calls) == 4


def test_empty_answers_and_unrun_tool_calls_are_not_kept() -> None:
    # An empty answer after tools (it happens) isn't stored: the Messages API refuses empty messages.
    model = Scripted(
        ([], Turn([call("echo", {})], "tool_use")),
        ([], Turn([text(" ")], "end_turn")),
    )
    stored = [e.data for e in run(model) if e.kind == "message"]
    assert [m["role"] for m in stored] == ["assistant", "user"]
    # A turn cut short (max_tokens) mid tool call: the call never runs, so it isn't kept.
    cut = Scripted(([], Turn([text("Which press do you mean?"), call("echo", {})], "max_tokens")))
    events = run(cut)
    assert [e.data["content"] for e in events if e.kind == "message"] == [[text("Which press do you mean?")]]
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


def test_a_long_reason_for_not_answering_is_cut_short() -> None:
    def wordy(_args: dict[str, Any]) -> Any:
        raise ToolError("x" * 50_000)

    model = Scripted(
        ([], Turn([call("wordy", {})], "tool_use")),
        ([], Turn([text("I can't answer that from the site's data.")], "end_turn")),
    )
    events = list(assistant.respond(model, "s", QUESTION, [Tool("wordy", "", {"type": "object"}, wordy)]))
    result = next(e for e in events if e.kind == "message" and e.data["role"] == "user").data["content"][0]
    assert len(result["content"].split("\n", 1)[1]) == assistant.MAX_TOOL_ERROR
