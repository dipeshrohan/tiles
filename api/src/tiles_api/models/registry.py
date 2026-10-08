"""The model registry (T3.01): models are registered in code with their inputs, outputs,
parameters and version, and run through one checked entry point.

A model is a class with a `spec` (what it takes and gives, and the bounds of its
parameters) and a `run` method on equal-length input series. Register it with
`@register` (or `Registry.add`); `evaluate` checks the inputs and parameters
against the spec, fills in defaults, runs the model and checks what it returns.
A published version never changes: a new behaviour is a new version, so runs
(and the derived signals of T3.03) always say which version made them.
"""

import hashlib
import json
import math
import re
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from typing import Any, ClassVar, Literal, Protocol

Kind = Literal["virtual-sensor", "design"]
KEY = re.compile(r"^[a-z][a-z0-9-]{1,62}$")
VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
NAME = re.compile(r"^[a-z][a-z0-9_]{0,62}$")
MAX_POINTS = 1_000_000  # values per input series in one evaluation


class ModelError(ValueError):
    """Inputs or parameters that don't fit a model's spec, or a model that broke its own spec."""


@dataclass(frozen=True)
class Port:
    """An input or output series. An output is one value per input sample (`sample`), or one
    value for the whole window evaluated (`window`: a shot, a batch)."""

    name: str
    unit: str
    description: str = ""
    per: Literal["sample", "window"] = "sample"


@dataclass(frozen=True)
class Param:
    """A number the model is tuned with, between `min` and `max` when given."""

    name: str
    unit: str
    default: float
    min: float | None = None
    max: float | None = None
    description: str = ""


@dataclass(frozen=True)
class ModelSpec:
    key: str  # stable name, e.g. "plunger-friction"
    version: str  # MAJOR.MINOR.PATCH; a published version never changes
    name: str
    kind: Kind
    domain: str = ""
    description: str = ""
    inputs: tuple[Port, ...] = ()
    outputs: tuple[Port, ...] = ()
    params: tuple[Param, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        problems = []
        if not KEY.match(self.key):
            problems.append(f"key {self.key!r} must be lower-case letters, digits and dashes")
        if not VERSION.match(self.version):
            problems.append(f"version {self.version!r} must be MAJOR.MINOR.PATCH")
        if self.kind not in ("virtual-sensor", "design"):
            problems.append(f"kind {self.kind!r} must be virtual-sensor or design")
        if not self.outputs:
            problems.append("a model needs at least one output")
        for group, ports in (("input", self.inputs), ("output", self.outputs), ("param", self.params)):
            names = [p.name for p in ports]
            for n in names:
                if not NAME.match(n):
                    problems.append(f"{group} name {n!r} must be lower-case letters, digits and underscores")
            if len(set(names)) != len(names):
                problems.append(f"{group} names must be unique")
        for p in self.params:
            low = -math.inf if p.min is None else p.min
            high = math.inf if p.max is None else p.max
            if not (math.isfinite(p.default) and low <= p.default <= high):
                problems.append(f"param {p.name}: default {p.default} is outside [{p.min}, {p.max}]")
        if problems:
            raise ModelError(f"Model {self.key} {self.version}: " + "; ".join(problems))

    def as_json(self) -> dict[str, Any]:
        """What is stored in `models.spec` (and compared, to keep a version from changing)."""
        body = asdict(self)
        for k in ("key", "version", "name", "kind", "domain"):
            body.pop(k)
        result: dict[str, Any] = json.loads(json.dumps(body))  # as stored: lists, not tuples
        return result

    def fingerprint(self) -> str:
        """A hash of everything the spec says, for models/published.json (a published version's
        fingerprint never changes)."""
        body = {"key": self.key, "version": self.version, "name": self.name, "kind": self.kind}
        body |= {"domain": self.domain, **self.as_json()}
        return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def version_key(version: str) -> tuple[int, ...]:
    return tuple(int(part) for part in version.split("."))


class Model(Protocol):
    spec: ClassVar[ModelSpec]

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, list[float | None]]:
        """Outputs as long as the inputs (or one value each, for a model without inputs); None (or
        NaN) where a value can't be computed."""
        ...


class Registry:
    def __init__(self) -> None:
        self._models: dict[tuple[str, str], Model] = {}

    def add(self, model: Model) -> Model:
        spec = model.spec
        existing = self._models.get((spec.key, spec.version))
        if existing is not None and existing.spec != spec:
            raise ModelError(f"Model {spec.key} {spec.version} is registered twice with different specs")
        self._models[(spec.key, spec.version)] = model
        return model

    def all(self) -> list[Model]:
        return sorted(self._models.values(), key=lambda m: (m.spec.key, version_key(m.spec.version)))

    def get(self, key: str, version: str | None = None) -> Model:
        """A model by key, its latest version unless one is named."""
        if version is not None:
            found = self._models.get((key, version))
        else:
            versions = [m for (k, _), m in self._models.items() if k == key]
            found = max(versions, key=lambda m: version_key(m.spec.version)) if versions else None
        if found is None:
            raise KeyError(f"No model {key}" + (f" version {version}" if version else ""))
        return found


registry = Registry()


def register[M: type](cls: M) -> M:
    """Class decorator: registers one instance of the model in the default registry."""
    registry.add(cls())
    return cls


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _params(spec: ModelSpec, params: Mapping[str, Any] | None, problems: list[str]) -> dict[str, float]:
    given = dict(params or {})
    unknown = sorted(set(given) - {p.name for p in spec.params})
    if unknown:
        problems.append(f"unknown param(s): {', '.join(unknown)}")
    values_by_name: dict[str, float] = {}
    for p in spec.params:
        value = _number(given.get(p.name, p.default))
        if value is None:
            problems.append(f"param {p.name} must be a finite number")
            continue
        if (p.min is not None and value < p.min) or (p.max is not None and value > p.max):
            problems.append(f"param {p.name} = {value:g} is outside [{p.min}, {p.max}]")
        values_by_name[p.name] = value
    return values_by_name


def check_params(spec: ModelSpec, params: Mapping[str, Any] | None) -> dict[str, float]:
    """The parameters with defaults filled in, or a ModelError naming each one out of place."""
    problems: list[str] = []
    values = _params(spec, params, problems)
    if problems:
        raise ModelError("; ".join(problems))
    return values


def evaluate(
    model: Model, inputs: Mapping[str, Sequence[Any]], params: Mapping[str, Any] | None = None
) -> dict[str, list[float | None]]:
    """Run `model` after checking its inputs and parameters against its spec.

    Every declared input must be given, as finite numbers, all of one length;
    parameters not given take their defaults and must lie within their bounds;
    names the spec doesn't know are refused. The outputs are checked too.
    """
    spec = model.spec
    problems: list[str] = []
    unknown = sorted(set(inputs) - {p.name for p in spec.inputs})
    if unknown:
        problems.append(f"unknown input(s): {', '.join(unknown)}")
    series: dict[str, list[float]] = {}
    for port in spec.inputs:
        raw = inputs.get(port.name)
        if raw is None:
            problems.append(f"missing input {port.name}")
            continue
        if len(raw) > MAX_POINTS:
            problems.append(f"input {port.name} has more than {MAX_POINTS} values")
            continue
        values = [_number(v) for v in raw]
        if any(v is None for v in values):
            problems.append(f"input {port.name} must be finite numbers")
            continue
        series[port.name] = [v for v in values if v is not None]
    lengths = {len(v) for v in series.values()}
    if len(lengths) > 1:
        problems.append("inputs must all be the same length")
    values_by_name = _params(spec, params, problems)
    if problems:
        raise ModelError("; ".join(problems))

    try:
        out = model.run(series, values_by_name)
    except (ArithmeticError, ValueError) as e:  # bad numbers for this model, e.g. a series too short
        raise ModelError(f"Model {spec.key} {spec.version} can't run on these inputs: {e}") from e
    expected = {p.name for p in spec.outputs}
    if set(out) != expected:
        raise ModelError(f"Model {spec.key} {spec.version} returned {sorted(out)}, not {sorted(expected)}")
    length = next(iter(lengths), 1)
    for port in spec.outputs:
        want = length if port.per == "sample" else 1
        if len(out[port.name]) != want:
            raise ModelError(
                f"Model {spec.key} {spec.version} returned {len(out[port.name])} values for {port.name}, not {want}"
            )
    return {name: [None if v is None else _number(v) for v in values] for name, values in out.items()}
