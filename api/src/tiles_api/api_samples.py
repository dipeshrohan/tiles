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
from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, Strict

from tiles_api.api_agents import calling_agent
from tiles_api.store import DbConn, one

router = APIRouter(tags=["edge agents"])

MAX_BATCH = 10_000
# Readings stamped further ahead than this come from a clock that is wrong.
MAX_AHEAD = timedelta(days=1)

SignalTag = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,127}$")]
Reading = (
    Annotated[bool, Strict()]  # first, so true/false stay booleans rather than becoming 1/0
    | Annotated[float, Field(allow_inf_nan=False)]
    | Annotated[str, Field(max_length=1000)]
)


class SampleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    signal: SignalTag
    at: AwareDatetime
    value: Reading
    quality: Literal["good", "uncertain", "bad"] = "good"


class SamplesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    samples: Annotated[list[SampleIn], Field(max_length=MAX_BATCH)]


class SamplesOut(BaseModel):
    received: int
    stored: int  # the rest were already stored


@router.post("/agent/samples", response_model=SamplesOut)
def ingest(body: SamplesIn, conn: DbConn, authorization: Annotated[str, Header()] = "") -> SamplesOut:
    """Stores a batch of readings from an edge agent (at most 10,000), skipping ones already stored."""
    agent = calling_agent(conn, authorization)
    if not body.samples:
        return SamplesOut(received=0, stored=0)
    now = one(conn.execute("SELECT clock_timestamp() AS now").fetchone())["now"]
    for i, s in enumerate(body.samples):
        if s.at > now + MAX_AHEAD:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                f"sample {i} ({s.signal}) is stamped {s.at.isoformat()}, more than a day ahead of Tiles's clock",
            )

    tags = sorted({s.signal for s in body.samples})
    conn.execute(
        """
        INSERT INTO signals (site_id, tag, source)
        SELECT %s, tag, %s FROM unnest(%s::text[]) AS tag
        ON CONFLICT (site_id, tag) DO NOTHING
        """,
        [agent["site_id"], f"edge:{agent['name']}", tags],
    )
    ids = {
        r["tag"]: r["id"]
        for r in conn.execute(
            "SELECT tag, id FROM signals WHERE site_id = %s AND tag = ANY(%s)", [agent["site_id"], tags]
        )
    }
    columns: tuple[list[object], ...] = ([], [], [], [], [], [])
    for s in body.samples:
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
    stored = conn.execute(
        """
        INSERT INTO samples (signal_id, at, value, value_text, value_bool, quality)
        SELECT * FROM unnest(%s::uuid[], %s::timestamptz[], %s::float8[], %s::text[], %s::bool[], %s::text[])
        ON CONFLICT (signal_id, at) DO NOTHING
        """,
        list(columns),
    ).rowcount
    return SamplesOut(received=len(body.samples), stored=stored)
