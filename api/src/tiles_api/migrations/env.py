"""Alembic environment: plain SQL migrations, no ORM models."""

from alembic import context
from sqlalchemy import engine_from_config, pool

from tiles_api.db import GRANT_APP, MIGRATION_LOCK

config = context.config


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = engine_from_config(
        config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    migrating = config.attributes.get("migrating", False)  # set by db.upgrade and db.downgrade
    with engine.connect() as connection:
        if migrating:
            # One migrator at a time: each API pod migrates as it starts (the Helm chart, T5.09), so
            # the others wait here, then find the database at head. Released when the connection
            # closes. `tiles-migrate current` and `history` neither wait nor grant.
            connection.exec_driver_sql(f"SELECT pg_advisory_lock({MIGRATION_LOCK})")
        # Every site's rows, for migrations that move data (row security, 0024).
        connection.exec_driver_sql("SET tiles.site_id = '*'")
        connection.commit()
        context.configure(connection=connection, transaction_per_migration=True)
        with context.begin_transaction():
            context.run_migrations()
        # Grants `tiles_app` (row security, 0024) every table again, so tables a later migration
        # made, as whichever login, are covered; still under the lock, as concurrent GRANTs on the
        # same tables fail. Nothing before 0024 or after downgrading past it.
        if migrating:
            connection.exec_driver_sql(GRANT_APP)
            connection.commit()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
