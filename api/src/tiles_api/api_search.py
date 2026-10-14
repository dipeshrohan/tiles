"""Search across a site (U4.01): one query over its signals, ontology nodes, warnings, insights,
documents and apps, for the command palette (U4.02).

Each kind is searched on the fields people know it by and ranked the same way: the whole query
equal to a field, then a field starting with it, then a word in the field starting with it, then
the query anywhere in it, and last every word of the query somewhere in the record; a main field
(a tag, a label, a title) counts more than a side one (a description, a summary). Ties go to the
shorter field, then the newer record. A document's words are matched as the documents page matches
them (full-text, in the document's language), its title as the rest. Results come grouped by kind,
the best group first, a few per kind. Every kind here is readable by every role on the site, so
what a person finds is what the site's row security lets this request read.
"""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from tiles_api.api_ontology import Ctx

router = APIRouter(tags=["search"])

Kind = Literal["signal", "node", "warning", "insight", "document", "app"]
KINDS: tuple[Kind, ...] = ("signal", "node", "warning", "insight", "document", "app")
LABELS: dict[Kind, str] = {
    "signal": "Signals",
    "node": "Ontology",
    "warning": "Warnings",
    "insight": "Insights",
    "document": "Documents",
    "app": "Apps",
}

# How well a field matches, by how: the query equal to it, at its start, at a word's start,
# anywhere. Every word somewhere in the record, but not the query as written, scores the least.
EXACT, PREFIX, WORD, ANYWHERE, ALL_WORDS = 1.0, 0.8, 0.6, 0.4, 0.2


class Result(BaseModel):
    kind: Kind
    id: str  # the record's id or number, as its page links it
    title: str
    detail: str  # what else to know at a glance: a description, a type, a status
    score: float
    page: int | None = None  # a document: the page the words were found on
    snippet: str | None = None  # a document: the words found, between \u0002 and \u0003


class Group(BaseModel):
    kind: Kind
    label: str
    results: list[Result]
    more: bool  # more than these match


class SearchResults(BaseModel):
    query: str
    groups: list[Group]


def like_escape(text: str) -> str:
    """Text for a LIKE pattern, its wildcards taken as they are (escape character: backslash)."""
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def regex_escape(text: str) -> str:
    """Text for a PostgreSQL regular expression, every special character taken as it is."""
    return "".join(f"\\{c}" if c in "\\^$.|?*+()[]{}" else c for c in text)


def field_score(column: str, weight: float) -> str:
    """SQL scoring one field against the query: EXACT, PREFIX, WORD, ANYWHERE or 0, times its weight."""
    col = f"lower(coalesce({column}, ''))"
    return (
        f"(CASE WHEN {col} = %(q)s THEN {EXACT}"
        f" WHEN {col} LIKE %(prefix)s ESCAPE '\\' THEN {PREFIX}"
        f" WHEN {col} ~ %(word)s THEN {WORD}"
        f" WHEN {col} LIKE %(anywhere)s ESCAPE '\\' THEN {ANYWHERE}"
        f" ELSE 0 END) * {weight}"
    )


def scored(fields: list[tuple[str, float]]) -> tuple[str, str]:
    """The SQL score of a record (its best field, or ALL_WORDS when each word is somewhere in it) and
    the condition a record must meet (each word somewhere in it)."""
    every = "lower(concat_ws(' ', " + ", ".join(c for c, _ in fields) + "))"
    words = f"(SELECT bool_and({every} LIKE w ESCAPE '\\') FROM unnest(%(words)s::text[]) w)"  # noqa: S608
    best = "GREATEST(" + ", ".join(field_score(c, w) for c, w in fields) + ")"
    return f"GREATEST({best}, CASE WHEN {words} THEN {ALL_WORDS} ELSE 0 END)", words


def kind_sql(kind: Kind) -> str:
    """The query for one kind: id, title, detail and score of the records that match, best first,
    `%(limit)s` + 1 of them (the one over says there are more)."""
    if kind == "signal":
        score, where = scored([("s.tag", 1.0), ("s.description", 0.5), ("s.asset", 0.5)])
        return f"""
            SELECT s.id::text AS id, s.tag AS title,
                   concat_ws(' · ', nullif(s.description, ''), s.unit) AS detail,
                   {score} AS score, length(s.tag) AS len, s.created_at AS at
            FROM signals s WHERE s.site_id = %(site)s AND {where}
            ORDER BY score DESC, len, at DESC LIMIT %(limit)s + 1"""  # noqa: S608 - fixed columns; the query is a parameter
    if kind == "node":
        score, where = scored([("n.label", 1.0), ("n.id", 0.7), ("n.type", 0.3)])
        return f"""
            SELECT n.id AS id, n.label AS title, n.type AS detail,
                   {score} AS score, length(n.label) AS len, NULL::timestamptz AS at
            FROM ontology_nodes n WHERE n.site_id = %(site)s AND {where}
            ORDER BY score DESC, len, n.label LIMIT %(limit)s + 1"""  # noqa: S608 - fixed columns; the query is a parameter
    if kind == "warning":
        score, where = scored([("s.tag", 1.0), ("d.name", 0.8), ("coalesce(d.asset, s.asset)", 0.8)])
        return f"""
            SELECT w.id::text AS id, s.tag AS title,
                   concat_ws(' · ', d.name,
                             CASE WHEN w.resolved_at IS NOT NULL THEN 'resolved'
                                  WHEN w.acknowledged_at IS NOT NULL THEN 'acknowledged'
                                  ELSE 'raised' END) AS detail,
                   {score} AS score, length(s.tag) AS len, w.started_at AS at
            FROM warnings w
            JOIN signals s ON s.id = w.signal_id
            JOIN detectors d ON d.id = w.detector_id
            WHERE w.site_id = %(site)s AND {where}
            ORDER BY score DESC, at DESC, len LIMIT %(limit)s + 1"""  # noqa: S608 - fixed columns; the query is a parameter
    if kind == "insight":
        score, where = scored([("i.title", 1.0), ("i.summary", 0.4)])
        return f"""
            SELECT i.number::text AS id, i.title AS title, i.status AS detail,
                   {score} AS score, length(i.title) AS len, i.created_at AS at
            FROM insights i WHERE i.site_id = %(site)s AND {where}
            ORDER BY score DESC, len, at DESC LIMIT %(limit)s + 1"""  # noqa: S608 - fixed columns; the query is a parameter
    if kind == "app":
        score, where = scored([("a.name", 1.0), ("a.template", 0.3)])
        return f"""
            SELECT a.number::text AS id, a.name AS title, a.template AS detail,
                   {score} AS score, length(a.name) AS len, a.created_at AS at
            FROM apps a WHERE a.site_id = %(site)s AND a.archived_at IS NULL AND {where}
            ORDER BY score DESC, len, at DESC LIMIT %(limit)s + 1"""  # noqa: S608 - fixed columns; the query is a parameter
    # Documents: by title, as the rest, or by their words (the best page of each), in the document's
    # language; a page found scores between ALL_WORDS and ANYWHERE by how well its words match.
    score, where = scored([("d.title", 1.0)])
    return f"""
        WITH q AS MATERIALIZED (
            SELECT language, websearch_to_tsquery(language, %(raw)s) AS q
            FROM (SELECT DISTINCT language FROM documents
                  WHERE site_id = %(site)s AND archived_at IS NULL) langs
        ),
        pages AS (
            SELECT DISTINCT ON (c.document_id) c.document_id, c.page,
                   ts_rank_cd(c.tsv, q.q) AS rank,
                   ts_headline(c.language, c.text, q.q,
                               'MaxFragments=1, MaxWords=20, MinWords=8, '
                               'StartSel=' || chr(2) || ', StopSel=' || chr(3)) AS snippet
            FROM q JOIN document_chunks c
              ON c.site_id = %(site)s AND c.language = q.language AND c.tsv @@ q.q
            ORDER BY c.document_id, ts_rank_cd(c.tsv, q.q) DESC, c.page
        )
        SELECT d.number::text AS id, d.title AS title,
               concat(d.pages, ' page(s)') AS detail,
               GREATEST({score}, CASE WHEN p.document_id IS NOT NULL
                                      THEN {ALL_WORDS} + least(p.rank, 1) * {ANYWHERE - ALL_WORDS}
                                      ELSE 0 END) AS score,
               length(d.title) AS len, d.created_at AS at,
               p.page AS page, p.snippet AS snippet
        FROM documents d LEFT JOIN pages p ON p.document_id = d.id
        WHERE d.site_id = %(site)s AND d.archived_at IS NULL AND (p.document_id IS NOT NULL OR {where})
        ORDER BY score DESC, len, at DESC LIMIT %(limit)s + 1"""  # noqa: S608 - fixed columns; the query is a parameter


def params(q: str, site: Any, limit: int) -> dict[str, Any]:
    """The query's forms the SQL above uses."""
    text = " ".join(q.lower().split())
    words = [f"%{like_escape(w)}%" for w in text.split(" ")]
    return {
        "site": site,
        "limit": limit,
        "raw": q,
        "q": text,
        "prefix": f"{like_escape(text)}%",
        "anywhere": f"%{like_escape(text)}%",
        "word": f"(^|[^[:alnum:]]){regex_escape(text)}",
        "words": words,
    }


@router.get("/sites/{site_id}/search", response_model=SearchResults)
def search(
    ctx: Ctx,
    q: Annotated[str, Query(min_length=2, max_length=200, description="What to find: two characters or more")],
    limit: Annotated[int, Query(ge=1, le=20, description="At most this many of each kind")] = 5,
    kinds: Annotated[
        list[Kind] | None, Query(alias="kind", description="Only these kinds (repeat it); all by default")
    ] = None,
) -> SearchResults:
    """Finds a site's signals (by tag, description, asset), ontology nodes (label, id, type),
    warnings (signal, detector, asset), insights (title, summary), documents (title and words) and
    apps (name), ranked and grouped by kind: the best group first, at most `limit` of each, with
    `more` when there are others."""
    if not q.strip() or len(q.strip()) < 2:
        raise HTTPException(422, "Search for two characters or more")
    values = params(q.strip(), ctx.site_id, limit)
    groups: list[Group] = []
    for kind in kinds or list(KINDS):
        rows = ctx.conn.execute(kind_sql(kind), values).fetchall()
        if not rows:
            continue
        results = [
            Result(
                kind=kind,
                id=str(r["id"]),
                title=str(r["title"]),
                detail=str(r["detail"] or ""),
                score=round(float(r["score"]), 3),
                page=r.get("page"),
                snippet=r.get("snippet"),
            )
            for r in rows[:limit]
        ]
        groups.append(Group(kind=kind, label=LABELS[kind], results=results, more=len(rows) > limit))
    groups.sort(key=lambda g: (-g.results[0].score, KINDS.index(g.kind)))
    return SearchResults(query=q.strip(), groups=groups)
