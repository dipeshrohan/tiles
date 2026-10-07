"""Builds the configured connectors. Protocol libraries are optional extras, imported only when used."""

from tiles_edge.agent import Connector
from tiles_edge.config import Config, ConfigError
from tiles_edge.samples import SampleSink


def build(config: Config, sink: SampleSink) -> list[Connector]:
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
    return connectors
