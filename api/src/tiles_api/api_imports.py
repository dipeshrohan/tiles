"""File imports (T2.07): engineers backfill readings from CSV files and historian exports.

The browser reads the file and maps its columns to signals (js/lib/importer.ts),
then calls these endpoints: start an import, send its readings in batches of up
to 10,000, and finish it. Batches go through the same storing step as edge
agents' readings, so a reading already stored (same signal and time) is skipped,
and importing the same file twice stores nothing new. New tags join the site's
signals with the import as their source. Starting and finishing are audited;
the batches in between are counted on the import's row.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from tiles_api.api_ontology import Ctx, Editor
from tiles_api.api_samples import SamplesIn, SamplesOut, store_samples
from tiles_api.store import one

router = APIRouter(tags=["imports"])

ImportName = Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[^\x00-\x1f]+$")]


class ImportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ImportName  # e.g. the file's name


class Import(BaseModel):
    id: uuid.UUID
    name: str
    created_by: str | None
    created_at: datetime
    received: int
    stored: int
    finished_at: datetime | None


IMPORT_SQL = """
SELECT i.id, i.name, u.name AS created_by, i.created_at, i.received, i.stored, i.finished_at
FROM imports i LEFT JOIN users u ON u.id = i.created_by
"""


def _get(ctx: Any, import_id: uuid.UUID) -> Import:
    row = ctx.conn.execute(IMPORT_SQL + " WHERE i.id = %s AND i.site_id = %s", [import_id, ctx.site_id]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such import on this site")
    return Import(**row)


@router.get("/sites/{site_id}/imports", response_model=list[Import])
def list_imports(ctx: Ctx) -> list[Import]:
    """The site's imports, newest first (the last 100)."""
    rows = ctx.conn.execute(IMPORT_SQL + " WHERE i.site_id = %s ORDER BY i.created_at DESC LIMIT 100", [ctx.site_id])
    return [Import(**r) for r in rows]


@router.post("/sites/{site_id}/imports", response_model=Import, status_code=status.HTTP_201_CREATED)
def start_import(ctx: Editor, body: ImportIn) -> Import:
    """Starts an import (engineers and admins). Its readings follow in batches."""
    row = one(
        ctx.conn.execute(
            "INSERT INTO imports (site_id, name, created_by) VALUES (%s, %s, %s) RETURNING id",
            [ctx.site_id, body.name, ctx.user.id],
        ).fetchone()
    )
    ctx.audit("import.start", "import", str(row["id"]), after={"name": body.name})
    return _get(ctx, row["id"])


@router.post("/sites/{site_id}/imports/{import_id}/samples", response_model=SamplesOut)
def import_samples(ctx: Editor, import_id: uuid.UUID, body: SamplesIn) -> SamplesOut:
    """One batch of an import's readings (at most 10,000). All or nothing: one invalid reading
    and the batch is refused (422), naming it."""
    imp = _get(ctx, import_id)
    if imp.finished_at is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "This import is finished; start a new one")
    stored = store_samples(ctx.conn, ctx.site_id, f"import:{imp.name}", body.samples)
    ctx.conn.execute(
        "UPDATE imports SET received = received + %s, stored = stored + %s WHERE id = %s",
        [len(body.samples), stored, import_id],
    )
    return SamplesOut(received=len(body.samples), stored=stored)


@router.post("/sites/{site_id}/imports/{import_id}/finish", response_model=Import)
def finish_import(ctx: Editor, import_id: uuid.UUID) -> Import:
    """Marks the import done; its counts are final."""
    row = ctx.conn.execute(
        "UPDATE imports SET finished_at = clock_timestamp()"
        " WHERE id = %s AND site_id = %s AND finished_at IS NULL RETURNING received, stored",
        [import_id, ctx.site_id],
    ).fetchone()
    if row is None:
        _get(ctx, import_id)  # 404 if there is no such import
        raise HTTPException(status.HTTP_409_CONFLICT, "This import is already finished")
    ctx.audit("import.finish", "import", str(import_id), after={"received": row["received"], "stored": row["stored"]})
    return _get(ctx, import_id)
