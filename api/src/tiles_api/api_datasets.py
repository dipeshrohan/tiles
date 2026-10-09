"""Datasets and the correlation finder over HTTP (T3.11). Engineers upload a batch table (columns,
then rows in batches, as file imports do); anyone on the site may ask which of its variables
separate the failed batches from the good ones (correlate.py).
"""

import math
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, model_validator

from tiles_api import correlate
from tiles_api.api_ontology import Ctx, Editor, SiteContext

router = APIRouter(tags=["datasets"])

MAX_COLUMNS = 200
MAX_ROWS = 200_000  # per dataset
MAX_BATCH = 5_000  # rows per request
MAX_WORK = 2_000_000  # rows x variables one correlation may read
MAX_SEGMENTS = 50
NAME = r"^\S(.*\S)?$"
Value = StrictFloat | StrictInt | StrictBool | Annotated[StrictStr, Field(max_length=1000)] | None


class Column(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=100, pattern=NAME)]
    kind: Literal["number", "text", "bool"]


class DatasetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(min_length=1, max_length=200, pattern=NAME)]
    description: Annotated[str, Field(max_length=2000)] = ""
    columns: Annotated[list[Column], Field(min_length=1, max_length=MAX_COLUMNS)]

    @model_validator(mode="after")
    def _unique(self) -> "DatasetIn":
        names = [c.name for c in self.columns]
        if len(set(names)) != len(names):
            raise ValueError("Each column needs its own name")
        return self


class Dataset(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    columns: list[Column]
    row_count: int
    created_by: str | None
    created_at: datetime


class DatasetDetail(Dataset):
    preview: list[dict[str, Any]]  # the first 20 rows


class RowsIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    rows: Annotated[list[dict[str, Value]], Field(min_length=1, max_length=MAX_BATCH)]


class RowsOut(BaseModel):
    received: int
    row_count: int


class CorrelateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    outcome: Annotated[str, Field(min_length=1, max_length=200)]  # the column that says whether a batch failed
    # The outcome values that mean failed (NG); for a true/false column, true unless given.
    ng_values: Annotated[list[Value], Field(min_length=1, max_length=100)] | None = None
    variables: Annotated[list[str], Field(min_length=1, max_length=MAX_COLUMNS)] | None = None  # default: all numbers
    # A column whose values are the segments (material, line, shift…).
    split: Annotated[str, Field(min_length=1, max_length=200)] | None = None

    @model_validator(mode="after")
    def _split_apart(self) -> "CorrelateIn":
        if self.split is not None and self.split == self.outcome:
            raise ValueError("Split by another column than the outcome")
        return self


class FindingOut(BaseModel):
    segment: str
    variable: str
    ng_mean: float | None
    ok_mean: float | None
    ng_count: int
    ok_count: int
    effect: float  # Cohen's d, NG minus OK
    ci_low: float | None  # its 95% confidence interval
    ci_high: float | None
    clear: bool  # the interval leaves out 0
    r: float


class Explanation(BaseModel):
    segment: str
    variable: str
    text: str


class CorrelateOut(BaseModel):
    rows: int  # with an outcome
    ng: int
    ok: int
    findings: list[FindingOut]  # by |d|, largest first
    explanations: list[Explanation]  # per segment, its strongest clear effect that is large (|d| >= 0.8)


DATASETS = """
SELECT d.id, d.name, d.description, d.columns, d.row_count, u.name AS created_by, d.created_at
FROM datasets d LEFT JOIN users u ON u.id = d.created_by WHERE d.site_id = %s
"""


def find_dataset(ctx: SiteContext, dataset_id: uuid.UUID, lock: bool = False) -> dict[str, Any]:
    if lock:
        ctx.conn.execute("SELECT 1 FROM datasets WHERE id = %s AND site_id = %s FOR UPDATE", [dataset_id, ctx.site_id])
    row = ctx.conn.execute(DATASETS + " AND d.id = %s", [ctx.site_id, dataset_id]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such dataset")
    return row


@router.get("/sites/{site_id}/datasets", response_model=list[Dataset])
def list_datasets(ctx: Ctx) -> list[dict[str, Any]]:
    """The site's datasets (batch tables), by name, with their columns and row counts."""
    return ctx.conn.execute(DATASETS + " ORDER BY d.name", [ctx.site_id]).fetchall()


@router.post("/sites/{site_id}/datasets", response_model=Dataset, status_code=status.HTTP_201_CREATED)
def create_dataset(ctx: Editor, body: DatasetIn) -> dict[str, Any]:
    """Start a dataset with its columns; send its rows next."""
    row = ctx.conn.execute(
        """
        INSERT INTO datasets (site_id, name, description, columns, created_by) VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (site_id, name) DO NOTHING RETURNING id
        """,
        [ctx.site_id, body.name, body.description, Jsonb([c.model_dump() for c in body.columns]), ctx.user.id],
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"A dataset is already called {body.name}")
    ctx.audit("dataset.create", "dataset", str(row["id"]), after={"name": body.name, "columns": len(body.columns)})
    return find_dataset(ctx, row["id"])


@router.get("/sites/{site_id}/datasets/{dataset_id}", response_model=DatasetDetail)
def get_dataset(ctx: Ctx, dataset_id: uuid.UUID) -> dict[str, Any]:
    """A dataset with its columns and its first 20 rows."""
    d = find_dataset(ctx, dataset_id)
    preview = ctx.conn.execute(
        "SELECT row FROM dataset_rows WHERE dataset_id = %s ORDER BY i LIMIT 20", [dataset_id]
    ).fetchall()
    return d | {"preview": [r["row"] for r in preview]}


def _fits(kind: str, value: Any) -> bool:
    if value is None:
        return True
    if kind == "number":
        return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)
    return isinstance(value, str) if kind == "text" else isinstance(value, bool)


def _check(columns: list[dict[str, str]], rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Each row as stored: every column, missing ones null; 422 for a value of the wrong kind."""
    kinds = {c["name"]: c["kind"] for c in columns}
    out = []
    for n, row in enumerate(rows, start=1):
        unknown = row.keys() - kinds.keys()
        if unknown:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, f"Row {n}: no column {sorted(unknown)[0]!r} in this dataset"
            )
        for name, value in row.items():
            if not _fits(kinds[name], value):
                must = {"number": "a number", "text": "text", "bool": "true or false"}[kinds[name]]
                raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"Row {n}: {name} must be {must}")
        out.append({name: row.get(name) for name in kinds})
    return out


@router.post("/sites/{site_id}/datasets/{dataset_id}/rows", response_model=RowsOut)
def add_rows(ctx: Editor, dataset_id: uuid.UUID, body: RowsIn) -> dict[str, Any]:
    """Append a batch of rows (at most 5,000), in order."""
    d = find_dataset(ctx, dataset_id, lock=True)
    if d["row_count"] + len(body.rows) > MAX_ROWS:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"A dataset holds at most {MAX_ROWS} rows")
    rows = _check(d["columns"], body.rows)
    first = d["row_count"]
    ctx.conn.execute(
        """
        INSERT INTO dataset_rows (dataset_id, i, row)
        SELECT %s, %s + n - 1, r FROM unnest(%s::jsonb[]) WITH ORDINALITY AS t(r, n)
        """,
        [dataset_id, first, [Jsonb(r) for r in rows]],
    )
    count = first + len(rows)
    ctx.conn.execute("UPDATE datasets SET row_count = %s WHERE id = %s", [count, dataset_id])
    ctx.audit("dataset.rows", "dataset", str(dataset_id), after={"rows": len(rows), "row_count": count})
    return {"received": len(rows), "row_count": count}


@router.delete("/sites/{site_id}/datasets/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dataset(ctx: Editor, dataset_id: uuid.UUID) -> None:
    """Delete a dataset and its rows (engineers and admins)."""
    d = find_dataset(ctx, dataset_id, lock=True)
    ctx.conn.execute("DELETE FROM datasets WHERE id = %s", [dataset_id])
    ctx.audit("dataset.delete", "dataset", str(dataset_id), before={"name": d["name"], "row_count": d["row_count"]})


def _same(a: Any, b: Any) -> bool:
    """Whether an outcome value is one of the NG values: numbers by value, others exactly."""
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, int | float) and isinstance(b, int | float):
        return float(a) == float(b)
    return bool(a == b)


def _text(f: correlate.Finding, split: bool) -> str:
    where = f"{f.segment}: " if split else ""
    direction = "higher" if f.effect > 0 else "lower"
    return (
        f"{where}failed batches ran {f.variable} {direction} "
        f"({f.ng_mean:.4g} vs {f.ok_mean:.4g} in good ones; d = {f.effect:.2f}, "
        f"95% CI {f.ci_low:.2f} to {f.ci_high:.2f})."
    )


@router.post("/sites/{site_id}/datasets/{dataset_id}/correlate", response_model=CorrelateOut)
def correlate_dataset(
    ctx: Ctx,
    dataset_id: uuid.UUID,
    body: CorrelateIn,
    min_effect: Annotated[float, Query(ge=0, le=10)] = 0.8,
) -> dict[str, Any]:
    """Which variables separate the failed batches from the good ones: Cohen's d with its 95%
    confidence interval and r, per segment of `split` if given, largest effect first."""
    return run(ctx, find_dataset(ctx, dataset_id), body, min_effect)


def run(ctx: SiteContext, d: dict[str, Any], body: CorrelateIn, min_effect: float = 0.8) -> dict[str, Any]:
    """The correlation of a dataset (`find_dataset`), as `POST …/correlate` answers it (saved
    insights keep one as their evidence)."""
    dataset_id = d["id"]
    kinds = {c["name"]: c["kind"] for c in d["columns"]}
    for name in [body.outcome, *([body.split] if body.split else []), *(body.variables or [])]:
        if name not in kinds:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"No column {name!r} in this dataset")
    if body.ng_values is None and kinds[body.outcome] != "bool":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"Say which values of {body.outcome} mean a failed batch (ng_values)"
        )
    ng_values = body.ng_values if body.ng_values is not None else [True]
    variables = body.variables or [
        name for name, kind in kinds.items() if kind == "number" and name not in (body.outcome, body.split)
    ]
    if not variables:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "This dataset has no number columns to compare")
    if not_numbers := [v for v in variables if kinds[v] != "number"]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{not_numbers[0]} is not a number column")
    if d["row_count"] * len(variables) > MAX_WORK:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{d['row_count']} rows x {len(variables)} variables is too much at once: choose fewer variables",
        )
    needed = list(dict.fromkeys([body.outcome, *([body.split] if body.split else []), *variables]))
    rows = [
        r["row"]
        for r in ctx.conn.execute(
            """
            SELECT (SELECT jsonb_object_agg(k, d.row -> k) FROM unnest(%s::text[]) AS k) AS row
            FROM dataset_rows d WHERE d.dataset_id = %s ORDER BY d.i
            """,
            [needed, dataset_id],
        )
    ]
    if body.split and len({correlate.segment_of(r.get(body.split)) for r in rows}) > MAX_SEGMENTS:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, f"{body.split} has more than {MAX_SEGMENTS} values to split by"
        )

    def is_ng(value: Any) -> bool:
        return any(_same(value, ng) for ng in ng_values)

    findings = correlate.find(rows, variables, is_ng, body.outcome, body.split)
    judged = correlate.judged(rows, body.outcome)
    ng = sum(1 for r in judged if is_ng(r[body.outcome]))
    top: dict[str, correlate.Finding] = {}
    for f in findings:  # largest first: each segment's first clear, large effect
        if f.clear and abs(f.effect) >= min_effect:
            top.setdefault(f.segment, f)
    explanations = [
        {"segment": f.segment, "variable": f.variable, "text": _text(f, bool(body.split))} for f in top.values()
    ]

    def finite(x: float) -> float | None:
        return x if math.isfinite(x) else None

    return {
        "rows": len(judged),
        "ng": ng,
        "ok": len(judged) - ng,
        "findings": [
            {
                "segment": f.segment,
                "variable": f.variable,
                "ng_mean": finite(f.ng_mean),
                "ok_mean": finite(f.ok_mean),
                "ng_count": f.ng_count,
                "ok_count": f.ok_count,
                "effect": f.effect,
                "ci_low": f.ci_low,
                "ci_high": f.ci_high,
                "clear": f.clear,
                "r": f.r,
            }
            for f in findings
        ],
        "explanations": explanations,
    }
