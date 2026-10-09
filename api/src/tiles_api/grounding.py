"""Grounding rules for the copilot (T4.03), pure: an answer may only state facts the tools
returned, cites the results it uses, and declines when nothing supports one.

Every tool result is labelled `[n]` when it is made (numbered through the conversation), and the
model cites the results a sentence rests on as `[n]`. `check` then holds the answer to them:
- it cites at least one result, unless it declines (says DECLINE) or only asks the user something
  back (a question with no numbers or names in it: "Which press do you mean?");
- every result it cites exists;
- every number in it is one the cited results hold (as shown, rounded to the digits the answer
  gives, as a percentage of a fraction, or as a count of a list), or one the question gave;
- every `code` span (a tag, a node, a dataset) appears in the cited results or the question.

This can't tell whether a sentence without numbers or names says what its result says; it catches
the claims that matter most on a plant (values, counts, times, tags) and every uncited answer.
"""

import json
import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any

DECLINE = "I can't answer that from the site's data"

_LABEL = re.compile(r"^\[(\d+)\] ")
_CITE = re.compile(r"\[(\d+)\]")
_CODE = re.compile(r"`([^`\n]{1,200})`")
# A number standing on its own: not part of a tag (press9, W-03), a citation ([3]) or a decimal's tail.
_NUMBER = re.compile(r"(?<![\w.\-/:#\[,])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(%?)(?![\w\]])")
_ANY_NUMBER = re.compile(r"-?\d+(?:\.\d+)?")
_LIST_MARKER = re.compile(r"(?m)^\s*\d+[.)]\s")


def label(n: int, name: str, args: dict[str, Any], out: str) -> str:
    """A tool result as the model reads it: its number, the tool and its input, then what it gave."""
    return f"[{n}] {name} {json.dumps(args, ensure_ascii=False, default=str)}\n{out}"


def labelled(messages: list[dict[str, Any]]) -> dict[int, str]:
    """The labelled tool results in a conversation, by number."""
    out: dict[int, str] = {}
    for m in messages:
        if m.get("role") != "user" or not isinstance(m.get("content"), list):
            continue
        for b in m["content"]:
            text = b.get("content") if b.get("type") == "tool_result" else None
            match = _LABEL.match(text) if isinstance(text, str) else None
            if match:
                out[int(match.group(1))] = text  # type: ignore[assignment]
    return out


def next_label(messages: list[dict[str, Any]]) -> int:
    return max(labelled(messages), default=0) + 1


def text_of(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if b.get("type") == "text")


def _facts(text: str) -> set[float]:
    """The numbers a result holds: in its JSON (values, numbers inside strings such as times, the
    lengths of lists) or, if it isn't JSON, anywhere in its text."""
    numbers: set[float] = set()
    body = text.split("\n", 1)[1] if "\n" in text else text

    def walk(v: Any) -> None:
        if isinstance(v, bool):
            return
        if isinstance(v, int | float):
            if math.isfinite(v):
                numbers.add(float(v))
        elif isinstance(v, str):
            numbers.update(float(x) for x in _ANY_NUMBER.findall(v.replace(",", "")))
        elif isinstance(v, list):
            numbers.add(float(len(v)))
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(k)
                walk(x)

    try:
        walk(json.loads(body))
    except ValueError:
        numbers.update(float(x) for x in _ANY_NUMBER.findall(body.replace(",", "")))
    numbers.update(float(x) for x in _ANY_NUMBER.findall(text.split("\n", 1)[0]))  # the input
    return numbers


def _shown(token: str) -> tuple[float, int]:
    """A number as the answer writes it, and its digits after the point."""
    plain = token.replace(",", "")
    return float(plain), len(plain.split(".", 1)[1]) if "." in plain else 0


def _supports(value: float, decimals: int, percent: bool, facts: set[float]) -> bool:
    for f in facts:
        for candidate in (f, f * 100) if percent else (f, f * 100, f / 100):
            if round(candidate, decimals) == value or round(abs(candidate), decimals) == abs(value):
                return True
            # A whole number rounded further ("about 1,800" for 1,784.5): to its trailing zeros.
            zeros = len(str(int(abs(value)))) - len(str(int(abs(value))).rstrip("0")) if value else 0
            if decimals == 0 and zeros and round(abs(candidate), -zeros) == abs(value):
                return True
    return False


@dataclass
class Grounding:
    grounded: bool
    declined: bool
    cited: list[int] = field(default_factory=list)
    unknown_citations: list[int] = field(default_factory=list)
    unsupported_numbers: list[str] = field(default_factory=list)
    unsupported_names: list[str] = field(default_factory=list)
    uncited: bool = False

    def problems(self) -> str:
        out = []
        if self.uncited:
            out.append("it cites no tool result")
        if self.unknown_citations:
            out.append(f"it cites results that don't exist: {', '.join(f'[{n}]' for n in self.unknown_citations)}")
        if self.unsupported_numbers:
            out.append(f"no cited result holds {', '.join(self.unsupported_numbers)}")
        if self.unsupported_names:
            out.append(f"no cited result names {', '.join(f'`{n}`' for n in self.unsupported_names)}")
        return "; ".join(out)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def check(answer: str, question: str, messages: list[dict[str, Any]]) -> Grounding:
    """Holds `answer` to the tool results of the conversation `messages` it cites."""
    results = labelled(messages)
    declined = DECLINE.lower() in answer.replace("\u2019", "'").lower()
    cited = sorted({int(n) for n in _CITE.findall(answer)})
    unknown = [n for n in cited if n not in results]
    sources = [results[n] for n in cited if n in results]
    facts: set[float] = set()
    for s in sources:
        facts |= _facts(s)
    facts.update(float(x) for x in _ANY_NUMBER.findall(question.replace(",", "")))
    body = _LIST_MARKER.sub("", _CITE.sub("", answer))
    body_no_code = _CODE.sub("", body)
    numbers = []
    for token, pct in _NUMBER.findall(body_no_code):
        value, decimals = _shown(token)
        if not _supports(value, decimals, bool(pct), facts):
            numbers.append(token + pct)
    haystack = "\n".join([*sources, question]).lower()
    names = [n for n in _CODE.findall(body) if n.strip().lower() not in haystack]
    asks_back = (
        body.rstrip().endswith("?") and not numbers and not _CODE.findall(body) and not _NUMBER.findall(body_no_code)
    )
    uncited = not cited and not declined and not asks_back
    grounded = not (uncited or unknown or numbers or names)
    return Grounding(grounded, declined, cited, unknown, sorted(set(numbers), key=numbers.index), names, uncited)
