"""Builds the configured connectors. Protocol libraries are optional extras, imported only when used."""

from tiles_edge.agent import Connector
from tiles_edge.config import Config, ConfigError
from tiles_edge.samples import StateSink

# The extra each SQL engine needs, and the module it brings (sqlite is in the standard library).
SQL_DRIVERS = {"postgresql": ("postgresql", "psycopg"), "sqlserver": ("sqlserver", "mssql_python")}


def build(config: Config, sink: StateSink) -> list[Connector]:
    connectors: list[Connector] = []
    if config.opcua:
        try:
            from tiles_edge.opcua import OpcUaConnector
        except ImportError:
            raise ConfigError(
                'the config has [[opcua]] connectors, which need the opcua extra: pip install "tiles-edge[opcua]" '
                "(the container image includes it; the single-file build does not)"
            ) from None
        connectors += [OpcUaConnector(c, sink) for c in config.opcua]
    if config.mqtt:
        try:
            from tiles_edge.mqtt import MqttConnector
        except ImportError:
            raise ConfigError(
                'the config has [[mqtt]] connectors, which need the mqtt extra: pip install "tiles-edge[mqtt]" '
                "(the container image includes it; the single-file build does not)"
            ) from None
        connectors += [MqttConnector(c, sink) for c in config.mqtt]
    if config.sql:
        for engine in sorted({c.engine for c in config.sql} & set(SQL_DRIVERS)):
            extra, module = SQL_DRIVERS[engine]
            try:
                __import__(module)
            except ImportError:
                raise ConfigError(
                    f"the config has {engine} [[sql]] connectors, which need the {extra} extra: "
                    f'pip install "tiles-edge[{extra}]" '
                    "(the container image includes it; the single-file build does not)"
                ) from None
        from tiles_edge.sql import SqlConnector

        connectors += [SqlConnector(c, sink) for c in config.sql]
    return connectors
