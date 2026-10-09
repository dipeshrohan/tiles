"""Grounding rules for the copilot (T4.03), pure: an answer may only state facts the tools
returned, cites the results it uses, and declines when nothing supports one.

Every tool result is labelled `[n]` when it is made (numbered through the conversation), and the
model cites the results a sentence rests on as `[n]`. `check` then holds the answer to them:
- it cites at least one result, unless it declines (starts with DECLINE) or is only a short
  question back to the user (one sentence, with no number or name in it);
- every result it cites exists;
- every number in it (a unit may follow it: 1,785 W, 17h) is one a cited result holds: as given,
  rounded half up to the digits the answer shows, rounded to its trailing zeros when that is within
  5% ("about 1,800"), as a percentage of a fraction, or as the count of a list; or one the
  question gave. A number with a minus sign must have it in the result too;
- every `code` span (a tag, a node, a dataset) is a value or key a cited result holds, or a whole
  word of one, or appears in the question.

This can't tell whether a sentence without numbers or names says what its result says; it catches
the claims that matter most on a plant (values, counts, times, tags) and every uncited answer.
"""

import json
import re
from dataclasses import asdict, dataclass, field
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

DECLINE = "I can't answer that from the site's data"

_LABEL = re.compile(r"^\[(\d+)\] ")
_CITE = re.compile(r"\[(\d+)\]")
_CODE = re.compile(r"`([^`\n]{1,200})`")
# A number standing on its own: not inside a tag (press9, W-03, w03.power) or a citation ([3]); a
# unit may follow it (1900W, 17h). A dash after a digit is a range ("5-10"), not a sign.
_NUMBER = re.compile(
    r"(?<![A-Za-z_.\/:#\[,])(?<![A-Za-z_]-)((?<!\d)-)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(%?)(?![\d\]]|\.\d|,\d)"
)
_DIGITS = re.compile(r"\d+(?:\.\d+)?")
_LIST_MARKER = re.compile(r"(?m)^[ \t]*(?:[-*]|\d{1,2}[.)])[ \t]+")
_SENTENCE_END = re.compile(r"[.!?](?:\s|$)")


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
            if match and isinstance(text, str):
                out[int(match.group(1))] = text
    return out


def next_label(messages: list[dict[str, Any]]) -> int:
    return max(labelled(messages), default=0) + 1


def text_of(message: dict[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    return "\n".join(b.get("text", "") for b in content or [] if b.get("type") == "text")


@dataclass
class _Source:
    numbers: set[float] = field(default_factory=set)  # with their signs
    words: set[str] = field(default_factory=set)  # string values and keys, lower case
    text: str = ""  # what isn't JSON, lower case

    def add(self, v: Any) -> None:
        if isinstance(v, bool) or v is None:
            return
        if isinstance(v, int | float):
            self.numbers.add(float(v))
        elif isinstance(v, str):
            self.words.add(v.lower())
            # Numbers inside text (a time's parts, a code): without signs, a dash there separates.
            self.numbers.update(float(x) for x in _DIGITS.findall(v.replace(",", "")))
        elif isinstance(v, list):
            self.numbers.add(float(len(v)))
            for x in v:
                self.add(x)
        elif isinstance(v, dict):
            for k, x in v.items():
                self.add(k)
                self.add(x)


def _source(labelled_text: str) -> _Source:
    """What a labelled result holds: the input it was asked with (not its number or tool name) and
    what it gave."""
    source = _Source()
    header, _, body = labelled_text.partition("\n")
    args = [*header.split(" ", 2), "", ""][2]
    for part in (args, body):
        try:
            source.add(json.loads(part))
        except ValueError:
            source.text += "\n" + part.lower()
            source.numbers.update(float(x) for x in _DIGITS.findall(part.replace(",", "")))
    return source


def _round(x: float, places: int) -> Decimal | None:
    try:
        return Decimal(repr(x)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
    except InvalidOperation:  # inf, nan, or too many digits
        return None


def _candidates(facts: set[float], signed: bool) -> list[float]:
    """The values a shown number may stand for: each fact, and as a percentage of a fraction.
    "down 0.6%" for -0.006 is fine; "-40" needs -40."""
    return [c if signed else abs(c) for f in facts for c in (f, f * 100)]


def _supported(sign: str, token: str, facts: set[float], cache: dict[tuple[int, bool], set[Decimal]]) -> bool:
    plain = token.replace(",", "")
    places = len(plain.split(".", 1)[1]) if "." in plain else 0
    shown = Decimal(sign + plain)
    key = (places, bool(sign))
    if key not in cache:  # every candidate rounded to these places, once per answer
        cache[key] = {r for c in _candidates(facts, bool(sign)) if (r := _round(c, places)) is not None}
    if shown in cache[key]:
        return True
    zeros = len(plain) - len(plain.rstrip("0")) if places == 0 and plain.strip("0") else 0
    return bool(zeros) and any(
        abs(c - float(shown)) <= 0.05 * abs(float(shown)) and _round(c, -zeros) == shown
        for c in _candidates(facts, bool(sign))
    )


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


def _named(name: str, sources: list[_Source], question: str) -> bool:
    n = name.strip().lower()
    whole = re.compile(rf"(?<![\w.]){re.escape(n)}(?![\w.])")
    return any(n in s.words or any(whole.search(w) for w in s.words) or whole.search(s.text) for s in sources) or bool(
        whole.search(question.lower())
    )


def check(answer: str, question: str, messages: list[dict[str, Any]]) -> Grounding:
    """Holds `answer` to the tool results of the conversation `messages` it cites."""
    results = labelled(messages)
    stripped = answer.replace("\u2019", "'").strip()
    declined = stripped.lower().startswith(DECLINE.lower())
    cited = sorted({int(n) for n in _CITE.findall(answer)})
    unknown = [n for n in cited if n not in results]
    sources = [_source(results[n]) for n in cited if n in results]
    facts: set[float] = set()
    for s in sources:
        facts |= s.numbers
    facts.update(float(x) for x in _DIGITS.findall(question.replace(",", "")))
    body = _LIST_MARKER.sub("", _CITE.sub("", answer))
    found = _NUMBER.findall(_CODE.sub("", body))
    cache: dict[tuple[int, bool], set[Decimal]] = {}
    numbers = [sign + token + pct for sign, token, pct in found if not _supported(sign, token, facts, cache)]
    names = [n for n in _CODE.findall(body) if not _named(n, sources, question)]
    asks_back = (
        stripped.endswith("?")
        and len(stripped) <= 200
        and not _SENTENCE_END.search(stripped[:-1])
        and not found
        and not _CODE.search(body)
    )
    uncited = not cited and not declined and not asks_back
    grounded = not (uncited or unknown or numbers or names)
    return Grounding(grounded, declined, cited, unknown, list(dict.fromkeys(numbers)), names, uncited)
