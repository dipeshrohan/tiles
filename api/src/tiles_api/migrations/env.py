"""Alembic environment: plain SQL migrations, no ORM models."""

from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config


def run_migrations_offline() -> None:
    context.configure(url=config.get_main_option("sqlalchemy.url"), literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = engine_from_config(
        config.get_section(config.config_ini_section, {}), prefix="sqlalchemy.", poolclass=pool.NullPool
    )
    with engine.connect() as connection:
        # Every site's rows, for migrations that move data (row security, 0024).
        connection.exec_driver_sql("SET tiles.site_id = '*'")
        connection.commit()
        context.configure(connection=connection, transaction_per_migration=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
