"""Sample ingest (T2.06): edge agents send readings in batches; they land in the `samples` hypertable.

An agent posts what its buffer holds, oldest first, with its own token. Each
batch is written with one statement (arrays unnested server-side), so a batch
of thousands costs one round trip. A reading Tiles already has (same signal
and time) is skipped: agents send at least once, and resend a batch whose
answer they never saw. Signals are identified by their tag, per site; a tag
seen for the first time is added to the site's signals, with the agent as its
source, and is mapped to the ontology later (T2.08).

A batch is all or nothing: if any reading is invalid, Tiles answers 422 and
stores none. The agent then halves the batch until the bad reading is alone,
and sets only that one aside.
"""

from datetime import timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, Strict, field_validator

from tiles_api import telemetry
from tiles_api.api_agents import calling_agent
from tiles_api.store import DbConn, one

router = APIRouter(tags=["edge agents"])

MAX_BATCH = 10_000
# Readings stamped further ahead than this come from a clock that is wrong.
MAX_AHEAD = timedelta(days=1)

SignalTag = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,127}$")]
# Whole numbers are stored as doubles, which hold every integer up to 2^53 exactly.
EXACT_INTEGERS = 2**53
Reading = (
    Annotated[bool, Strict()]  # first, so true/false stay booleans rather than becoming 1/0
    | Annotated[float, Field(allow_inf_nan=False)]
    | Annotated[str, Field(max_length=1000, pattern=r"^[^\x00]*$")]  # PostgreSQL text can't hold NUL
)


class SampleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    signal: SignalTag
    at: AwareDatetime
    value: Reading
    quality: Literal["good", "uncertain", "bad"] = "good"

    @field_validator("value", mode="before")
    @classmethod
    def _exact(cls, value: object) -> object:
        """Refuse an integer a double would change (e.g. a 64-bit counter past 2^53) rather than store
        a different number; the agent then sets that one reading aside."""
        if isinstance(value, int) and not isinstance(value, bool) and abs(value) > EXACT_INTEGERS:
            raise ValueError(f"{value} is too large to store exactly (the limit is ±2^53)")
        return value


class SamplesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    samples: Annotated[list[SampleIn], Field(max_length=MAX_BATCH)]


class SamplesOut(BaseModel):
    received: int
    stored: int  # the rest were already stored


def store_samples(conn: Any, site_id: Any, source: str, samples: list[SampleIn]) -> int:
    """Stores readings for a site and returns how many were new. Tags seen for the first time join
    the site's signals with `source`. Shared by agents' batches and file imports (T2.07). Readings
    for a model's derived signals are left out (only the model runner writes those)."""
    if not samples:
        return 0
    now = one(conn.execute("SELECT clock_timestamp() AS now").fetchone())["now"]
    for i, s in enumerate(samples):
        if s.at > now + MAX_AHEAD:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"sample {i} ({s.signal}) is stamped {s.at.isoformat()}, more than a day ahead of Tiles's clock",
            )

    tags = sorted({s.signal for s in samples})
    conn.execute(
        """
        INSERT INTO signals (site_id, tag, source)
        SELECT %s, tag, %s FROM unnest(%s::text[]) AS tag
        ON CONFLICT (site_id, tag) DO NOTHING
        """,
        [site_id, source, tags],
    )
    # A model's derived signals (T3.03) are written by the model runner only: readings sent under
    # their tags are left out, not mixed in with what the model computed.
    ids = {
        r["tag"]: r["id"]
        for r in conn.execute(
            "SELECT tag, id FROM signals WHERE site_id = %s AND tag = ANY(%s) AND source NOT LIKE 'model:%%'",
            [site_id, tags],
        )
    }
    columns: tuple[list[object], ...] = ([], [], [], [], [], [])
    for s in samples:
        if s.signal not in ids:
            continue
        v = s.value
        row = (
            ids[s.signal],
            s.at,
            v if isinstance(v, float) else None,
            v if isinstance(v, str) else None,
            v if isinstance(v, bool) else None,
            s.quality,
        )
        for column, cell in zip(columns, row, strict=True):
            column.append(cell)
    # Through tiles_store_samples (row security, T5.04): readings of this site's signals only.
    row = conn.execute(
        "SELECT tiles_store_samples(%s::uuid[], %s::timestamptz[], %s::float8[], %s::text[], %s::bool[], %s::text[])"
        " AS n",
        list(columns),
    ).fetchone()
    stored = int(row["n"]) if row else 0
    kind = source.split(":", 1)[0]  # edge, import
    refused = sum(1 for s in samples if s.signal not in ids)  # a model's derived signal
    telemetry.readings.add(stored, {"source": kind, "stored": "new"})
    telemetry.readings.add(len(samples) - refused - stored, {"source": kind, "stored": "not new"})
    telemetry.readings.add(refused, {"source": kind, "stored": "refused"})
    if kind == "edge":
        telemetry.ingest_delay.record(max(0.0, (now - max(s.at for s in samples)).total_seconds()))
    return stored


@router.post("/agent/samples", response_model=SamplesOut)
def ingest(body: SamplesIn, conn: DbConn, authorization: Annotated[str, Header()] = "") -> SamplesOut:
    """Stores a batch of readings from an edge agent (at most 10,000), skipping ones already stored."""
    agent = calling_agent(conn, authorization)
    stored = store_samples(conn, agent["site_id"], f"edge:{agent['name']}", body.samples)
    return SamplesOut(received=len(body.samples), stored=stored)
