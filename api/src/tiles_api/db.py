"""Database migrations (Alembic) and the `tiles-migrate` command."""

import argparse
from importlib.resources import files

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

from tiles_api.settings import Settings, get_settings


def sqlalchemy_url(database_url: str) -> str:
    """Point SQLAlchemy at psycopg 3, whatever scheme the setting uses."""
    for prefix in ("postgresql+psycopg://", "postgresql://", "postgres://"):
        if database_url.startswith(prefix):
            return "postgresql+psycopg://" + database_url.removeprefix(prefix)
    raise ValueError("TILES_DATABASE_URL must be a postgresql:// URL")


def alembic_config(settings: Settings | None = None) -> Config:
    settings = settings or get_settings()
    cfg = Config()
    cfg.set_main_option("script_location", str(files("tiles_api") / "migrations"))
    # Alembic's config is an INI parser, so a literal % must be doubled.
    cfg.set_main_option("sqlalchemy.url", sqlalchemy_url(settings.database_url).replace("%", "%%"))
    return cfg


def upgrade(settings: Settings | None = None, revision: str = "head") -> None:
    command.upgrade(alembic_config(settings), revision)


def downgrade(settings: Settings | None = None, revision: str = "base") -> None:
    command.downgrade(alembic_config(settings), revision)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="tiles-migrate", description="Apply Tiles database migrations.")
    sub = parser.add_subparsers(dest="action", required=True)
    up = sub.add_parser("upgrade", help="migrate forward (default: to the latest revision)")
    up.add_argument("revision", nargs="?", default="head")
    down = sub.add_parser("downgrade", help="migrate back (e.g. -1, or base to drop everything)")
    down.add_argument("revision")
    sub.add_parser("current", help="show the applied revision")
    sub.add_parser("history", help="list all revisions")
    rev = sub.add_parser("revision", help="create an empty migration file to fill in")
    rev.add_argument("message")
    args = parser.parse_args(argv)

    cfg = alembic_config()
    if args.action == "upgrade":
        command.upgrade(cfg, args.revision)
    elif args.action == "downgrade":
        command.downgrade(cfg, args.revision)
    elif args.action == "current":
        command.current(cfg, verbose=True)
    elif args.action == "history":
        command.history(cfg)
    else:
        command.revision(cfg, message=args.message, rev_id=next_revision_id(cfg))


def next_revision_id(cfg: Config) -> str:
    """Sequential ids (0001, 0002, ...) so files sort in the order they apply."""
    head = ScriptDirectory.from_config(cfg).get_current_head()
    return f"{int(head or 0) + 1:04d}"
