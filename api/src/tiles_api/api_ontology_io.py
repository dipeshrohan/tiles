"""Bulk ontology import and export (T2.13): the committed graph as a JSON or CSV file, and a
file turned into staged changes (see ontology_io.py)."""

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, ConfigDict, Field

from tiles_api import ontology as o
from tiles_api import ontology_io as io_
from tiles_api import ontology_store as store
from tiles_api.api_ontology import Ctx, Editor
from tiles_api.store import one

router = APIRouter(tags=["ontology"])

MAX_FILE = 20_000_000  # characters
PREVIEW_OPS = 500  # ops sent back for a preview; the counts cover them all


class ImportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: io_.Format
    content: Annotated[str, Field(max_length=MAX_FILE)]
    mode: io_.Mode = "merge"
    name: Annotated[str, Field(max_length=200, pattern=r"^[^\x00]*$")] = ""  # the file's name, for the audit log
    dry_run: bool = False  # only plan: nothing is staged


class ImportOut(BaseModel):
    counts: dict[str, int]  # add_nodes, remove_nodes, set_props, remove_props, add_edges, remove_edges
    total: int  # ops planned
    ops: list[dict[str, Any]]  # the first PREVIEW_OPS of them
    duplicates: list[str]  # relationships in the file already in the ontology under another id: skipped
    staged: bool


@router.get("/sites/{site_id}/ontology/export")
def export(ctx: Ctx, format: io_.Format = "json") -> Response:
    """The committed ontology as a file: JSON (nodes, edges and where it came from) or CSV (one table)."""
    graph = store.load_head(ctx.conn, ctx.site_id)
    site = one(ctx.conn.execute("SELECT slug, name FROM sites WHERE id = %s", [ctx.site_id]).fetchone())
    if format == "json":
        latest = ctx.conn.execute(
            "SELECT id FROM commits WHERE site_id = %s ORDER BY seq DESC LIMIT 1", [ctx.site_id]
        ).fetchone()
        meta = {
            "site": {"slug": site["slug"], "name": site["name"]},
            "commit": latest["id"] if latest else None,
            "exported_at": store.iso(datetime.now(UTC)),
        }
        body, media = io_.to_json(graph, meta), "application/json"
    else:
        body, media = io_.to_csv(graph), "text/csv; charset=utf-8"
    name = f"{site['slug']}-ontology.{format}"
    return Response(body, media_type=media, headers={"Content-Disposition": f'attachment; filename="{name}"'})


@router.post("/sites/{site_id}/ontology/import", response_model=ImportOut)
def import_file(ctx: Editor, body: ImportIn) -> dict[str, Any]:
    """Plan the changes that bring the committed ontology to the file's, and stage them (unless `dry_run`).

    `merge` adds and sets; `replace` also removes what the file doesn't have. You then commit
    them, or send them for review, like any staged change. Needs no staged changes of your own.
    """
    store.lock_site(ctx.conn, ctx.site_id)
    if store.load_staged(ctx.conn, ctx.site_id, ctx.user):
        raise HTTPException(status.HTTP_409_CONFLICT, "Commit, send or discard your staged changes first")
    try:
        target = io_.read(body.content, body.format)
        planned = io_.plan(store.load_head(ctx.conn, ctx.site_id), target, body.mode)
    except io_.FileProblems as e:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "The file can't be imported: " + "; ".join(e.problems)
        ) from e
    staged = False
    if planned.ops and not body.dry_run:
        try:
            store.stage(ctx.conn, ctx.site_id, ctx.user, *planned.ops)
        except o.OntologyError as e:  # pragma: no cover - the plan applies to the head by construction
            raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
        staged = True
        after = {"name": body.name, "format": body.format, "mode": body.mode, "counts": planned.counts}
        ctx.audit("ontology.import", "staged_ops", str(ctx.user.id), after=after)
    return {
        "counts": planned.counts,
        "total": len(planned.ops),
        "ops": planned.ops[:PREVIEW_OPS],
        "duplicates": planned.duplicates,
        "staged": staged,
    }
