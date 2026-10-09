"""Grounding rules (T4.03): an answer is held to the tool results it cites."""

import json
from typing import Any

from tiles_api import assistant, grounding
from tiles_api.assistant import Tool, Turn

RESULT = {
    "tag": "w03.cathode_power",
    "unit": "W",
    "baseline": 1619.6148,
    "last": 1784.5417,
    "change": 0.10183,
    "hours_to_limit": 17.62,
    "end": "2026-09-05T06:00:00Z",
    "signals": [{"tag": "a"}, {"tag": "b"}, {"tag": "c"}],
}


def conversation(*results: Any) -> list[dict[str, Any]]:
    blocks = [
        {"type": "tool_result", "tool_use_id": f"t{n}", "content": grounding.label(n, "wear_check", {"tag": "w03"}, r)}
        for n, r in enumerate(results, 1)
    ]
    return [
        {"role": "user", "content": [{"type": "text", "text": "Is it wearing?"}]},
        {"role": "user", "content": blocks},
    ]


def check(answer: str, question: str = "Is it wearing?") -> grounding.Grounding:
    return grounding.check(answer, question, conversation(json.dumps(RESULT), "No dataset 'x'"))


def test_results_are_numbered_through_the_conversation() -> None:
    messages = conversation("{}", "{}")
    assert sorted(grounding.labelled(messages)) == [1, 2]
    assert grounding.next_label(messages) == 3
    assert grounding.next_label([]) == 1
    assert grounding.label(4, "events", {"kind": "warnings"}, "[]") == '[4] events {"kind": "warnings"}\n[]'


def test_numbers_as_the_results_give_them_rounded_or_counted() -> None:
    report = check(
        "`w03.cathode_power` is at 1,785 W against a baseline of 1,619.6 W [1], up 10.2% [1]. "
        "It reaches the limit in about 18 h [1]; about 1,800 W now [1]. "
        "3 signals match [1], the last reading at 06:00 on 5 Sept 2026 [1]."
    )
    assert report.as_dict() == {
        "grounded": True,
        "declined": False,
        "cited": [1],
        "unknown_citations": [],
        "unsupported_numbers": [],
        "unsupported_names": [],
        "uncited": False,
    }


def test_numbers_and_names_no_cited_result_holds_are_named() -> None:
    report = check("Power is 1,900 W [1], 12% up [1]; `w03.anode_power` is fine [1], see [7].")
    assert report.grounded is False
    assert report.unsupported_numbers == ["1,900", "12%"]
    assert report.unsupported_names == ["w03.anode_power"]
    assert report.unknown_citations == [7]
    assert report.problems() == (
        "it cites results that don't exist: [7]; no cited result holds 1,900, 12%; "
        "no cited result names `w03.anode_power`"
    )
    # A fact from a result it doesn't cite isn't supported: the citation must point at it.
    assert check("Power is 1,785 W [2].").unsupported_numbers == ["1,785"]


def test_numbers_inside_tags_lists_and_citations_are_not_claims() -> None:
    report = check("Welder W-03 on press9 [1]:\n1. `w03.cathode_power` [1]\n2) rising [1]")
    assert (report.grounded, report.unsupported_numbers) == (True, [])
    # The question's own numbers can be said back.
    assert check("Over the last 48 hours it rose [1].", "Did it rise in 48 hours?").grounded


def test_an_answer_must_cite_decline_or_ask_back() -> None:
    assert check("The welder is fine.").as_dict()["uncited"] is True
    assert check("The welder is fine.").problems() == "it cites no tool result"
    declined = check("I can\u2019t answer that from the site's data: no dataset named x [2].")
    assert (declined.grounded, declined.declined) == (True, True)
    assert check("I can't answer that from the site's data.").grounded
    assert check("Which welder do you mean?").grounded
    assert not check("Is it the one at 1,900 W?").grounded  # a question that states a number isn't asking back


def test_an_unsupported_answer_is_withdrawn_and_answered_again_once() -> None:
    class Model:
        def __init__(self, *answers: str) -> None:
            self.answers = list(answers)
            self.calls: list[list[dict[str, Any]]] = []

        def stream(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Any:
            self.calls.append([dict(m) for m in messages])
            if len(self.calls) == 1:
                yield Turn([{"type": "tool_use", "id": "t1", "name": "wear", "input": {}}], "tool_use")
                return
            text = self.answers.pop(0)
            yield text
            yield Turn([{"type": "text", "text": text}], "end_turn")

    tools = [Tool("wear", "", {"type": "object"}, lambda _a: RESULT)]
    question = [{"role": "user", "content": [{"type": "text", "text": "Is it wearing?"}]}]

    model = Model("It is at 1,900 W.", "It is at 1,785 W [1].")
    events = list(assistant.respond(model, "s", question, tools))
    kinds = [e.kind for e in events]
    assert kinds.count("retract") == 1
    retract = next(e for e in events if e.kind == "retract")
    assert retract.data == {"reason": "it cites no tool result; no cited result holds 1,900"}
    # The model is told what was wrong; the withdrawn answer isn't stored.
    note = model.calls[2][-1]["content"][0]["text"]
    assert note.startswith("(Tiles) That answer can't be shown: it cites no tool result; no cited result holds 1,900.")
    stored = [e.data for e in events if e.kind == "message"]
    assert [m["role"] for m in stored] == ["assistant", "user", "assistant"]
    assert stored[-1]["content"] == [{"type": "text", "text": "It is at 1,785 W [1]."}]
    assert stored[-1]["meta"]["grounding"]["grounded"] is True
    assert events[-1].data["grounded"] is True

    # Still unsupported after one try: kept, with the report saying so (the user is warned).
    stubborn = Model("It is at 1,900 W.", "It is at 1,950 W [1].")
    events = list(assistant.respond(stubborn, "s", question, tools))
    assert [e.kind for e in events].count("retract") == 1
    last = [e.data for e in events if e.kind == "message"][-1]
    assert last["meta"]["grounding"]["unsupported_numbers"] == ["1,950"]
    assert events[-1].data["grounded"] is False


def test_review_cases_values_signs_rounding_and_ranges() -> None:
    # A unit right after a number doesn't hide it; a range's end is checked.
    assert check("Power is 1900W [1].").unsupported_numbers == ["1900"]
    assert check("It reaches it in 18h [1].").grounded
    assert check("Between 7-11 signals [1].").unsupported_numbers == ["7", "11"]
    # A minus sign must be in the result; a fraction isn't a hundredth of a fact; "about" stays close.
    assert check("It changed by -1,785 W [1].").unsupported_numbers == ["-1,785"]
    assert check("It is 0.18 [1].").unsupported_numbers == ["0.18"]
    assert check("About 1,700 W [1].").unsupported_numbers == ["1,700"]  # 1,619.6 and 1,784.5 round elsewhere
    assert check("About 1,800 W [1].").grounded
    # Rounded half up, as people round.
    half = grounding.check("About 17 h [1], 2.68 [1].", "?", conversation(json.dumps({"hours": 16.5, "x": 2.675})))
    assert half.grounded, half.unsupported_numbers


def test_review_cases_a_result_number_isnt_a_fact_and_lines_starting_with_values() -> None:
    labelled = grounding.label(3, "events", {"kind": "warnings"}, json.dumps({"warnings": [{"id": "a"}]}))
    three = [{"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t3", "content": labelled}]}]
    # Citing [3] doesn't make 3 a fact; the result holds one warning.
    assert grounding.check("3 warnings are open [3].", "?", three).unsupported_numbers == ["3"]
    assert grounding.check("1 warning is open [3].", "?", three).grounded
    # A wrapped line that starts with a value is still checked (only short list numbers are markers).
    assert check("Oil temperature is\n1900. That is high [1].").unsupported_numbers == ["1900"]


def test_review_cases_names_are_whole_and_asking_back_states_nothing() -> None:
    assert check("`w03.cathode` is wearing [1].").unsupported_names == ["w03.cathode"]
    assert check("`w03.cathode_power` is wearing [1].").grounded
    tag = grounding.check("`PLC1\\Temp` is 41 [1].", "?", conversation(json.dumps({"tag": "PLC1\\Temp", "v": 41})))
    assert tag.grounded, tag.unsupported_names
    # A question back is one short sentence; claims before a question still need citations.
    assert not check("Press 9 is overheating because its filter is clogged. Want me to check the others?").grounded
    # A decline starts with the phrase; mentioning it later doesn't excuse the rest.
    assert not check("The welder is failing; I can't answer that from the site's data.").grounded


def test_a_withdrawn_last_round_still_gets_its_second_try() -> None:
    class Model:
        def __init__(self) -> None:
            self.answers = ["It is at 1,900 W.", "I can't answer that from the site's data."]

        def stream(self, *, system: str, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> Any:
            text = self.answers.pop(0)
            yield Turn([{"type": "text", "text": text}], "end_turn")

    events = list(assistant.respond(Model(), "s", [{"role": "user", "content": "Is it wearing?"}], [], max_rounds=1))
    assert [e.kind for e in events] == ["usage", "retract", "usage", "message", "grounding", "done"]
    assert events[-1].data["grounded"] is True
