from pathlib import Path

import pytest
from conftest import TOKEN, write_config

from tiles_edge.config import ConfigError, load


def test_a_minimal_config_loads(tmp_path: Path) -> None:
    config = load(write_config(tmp_path, "https://tiles.example.com/"), env={})
    assert (config.url, config.token, config.heartbeat_seconds) == ("https://tiles.example.com", TOKEN, 5)
    assert (config.ca_file, config.timeout_seconds) == (None, 10.0)


def test_the_token_can_come_from_the_environment(tmp_path: Path) -> None:
    path = write_config(tmp_path, "https://tiles.example.com", token=None)
    assert load(path, env={"TILES_EDGE_TOKEN": "tla_from-env"}).token == "tla_from-env"


@pytest.mark.parametrize(
    ("url", "extra", "message"),
    [
        ("http://tiles.example.com", "", "must use https"),
        ("ftp://tiles.example.com", "", "must be an http(s) URL"),
        ("", "", "url is required"),
        ("https://tiles.example.com?x=1", "", "query or fragment"),
        ("https://tiles.example.com", 'ca_file = "missing.pem"', "doesn't exist"),
        ("https://tiles.example.com", "timeout_seconds = 0", "timeout_seconds"),
        ("https://tiles.example.com", "password = 1", "unknown setting(s) in [tiles]: password"),
    ],
)
def test_bad_settings_are_explained(tmp_path: Path, url: str, extra: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message.replace("(", r"\(").replace(")", r"\)").replace("[", r"\[")):
        load(write_config(tmp_path, url, extra), env={})


def test_plain_http_is_allowed_only_to_this_machine(tmp_path: Path) -> None:
    for host in ("localhost:8000", "127.0.0.1:8000", "[::1]:8000"):
        assert load(write_config(tmp_path, f"http://{host}"), env={}).url == f"http://{host}"


@pytest.mark.parametrize("value", ["0", "4", "3601", "1.5", "true", '"30"'])
def test_heartbeat_seconds_must_be_sensible(tmp_path: Path, value: str) -> None:
    path = tmp_path / "c.toml"
    (tmp_path / "token").write_text(TOKEN)
    path.write_text(
        f'[tiles]\nurl = "https://t.example.com"\ntoken_file = "token"\n[agent]\nheartbeat_seconds = {value}\n'
    )
    with pytest.raises(ConfigError, match="heartbeat_seconds"):
        load(path, env={})


def test_token_problems_are_explained(tmp_path: Path) -> None:
    path = write_config(tmp_path, "https://tiles.example.com", token=None)
    with pytest.raises(ConfigError, match="can't read the token file"):
        load(path, env={})
    (tmp_path / "token").write_text("eyJhbGciOi.a-user-token")
    with pytest.raises(ConfigError, match="should start with tla_"):
        load(path, env={})
    path.write_text('[tiles]\nurl = "https://tiles.example.com"\n')
    with pytest.raises(ConfigError, match="no agent token"):
        load(path, env={})


def test_unreadable_files_are_explained(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="can't read"):
        load(tmp_path / "nope.toml", env={})
    (tmp_path / "bad.toml").write_text("[tiles\n")
    with pytest.raises(ConfigError, match="not valid TOML"):
        load(tmp_path / "bad.toml", env={})


def test_a_bad_port_is_a_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="invalid port"):
        load(write_config(tmp_path, "https://tiles.example.com:abc"), env={})


def test_a_ca_file_without_certificates_is_a_config_error(tmp_path: Path) -> None:
    (tmp_path / "ca.pem").write_text("not a certificate\n")
    with pytest.raises(ConfigError, match="holds no usable PEM certificate"):
        load(write_config(tmp_path, "https://tiles.example.com", 'ca_file = "ca.pem"'), env={})


def test_an_unreadable_token_file_says_how_to_fix_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = write_config(tmp_path, "https://tiles.example.com")
    real = Path.read_text

    def read_text(self: Path, *args: object, **kwargs: object) -> str:
        if self.name == "token":
            raise PermissionError(13, "Permission denied")
        return real(self)

    monkeypatch.setattr(Path, "read_text", read_text)
    with pytest.raises(ConfigError, match=r"permission denied for this user .* set TILES_EDGE_TOKEN"):
        load(path, env={})


OPCUA = """
[[opcua]]
name = "press-line"
endpoint = "opc.tcp://10.0.0.5:4840"
certificate = "opcua/agent.der"
private_key = "opcua/agent.pem"
server_certificate = "opcua/server.der"
{extra}
[[opcua.signals]]
node = "ns=2;s=Press1.Temperature"
signal = "press1.temperature"
"""


def with_opcua(tmp_path: Path, extra: str = "", body: str | None = None) -> Path:
    path = write_config(tmp_path, "https://tiles.example.com")
    path.write_text(path.read_text() + (body if body is not None else OPCUA.format(extra=extra)))
    return path


def test_an_opcua_connector_loads_with_secure_defaults(tmp_path: Path) -> None:
    [c] = load(with_opcua(tmp_path), env={}).opcua
    assert (c.name, c.endpoint, c.security, c.secured) == (
        "press-line",
        "opc.tcp://10.0.0.5:4840",
        "Basic256Sha256-SignAndEncrypt",
        True,
    )
    assert (c.certificate, c.server_certificate) == (tmp_path / "opcua/agent.der", tmp_path / "opcua/server.der")
    assert c.application_uri.startswith("urn:tiles-edge:")
    assert c.publishing_interval_ms == 1000
    assert [(s.node, s.signal) for s in c.signals] == [("ns=2;s=Press1.Temperature", "press1.temperature")]


@pytest.mark.parametrize(
    ("extra", "message"),
    [
        ('security = "None"', "set allow_unsecured = true"),
        ('security = "Basic128Rsa15-Sign"', "security must be one of"),
        ('username = "tiles"', "set username and password_file together"),
        ("publishing_interval_ms = 10", "publishing_interval_ms"),
        ('application_uri = "tiles"', "application_uri must be a URN"),
        ("speed = 1", r"unknown setting\(s\) in \[\[opcua\]\] press-line: speed"),
    ],
)
def test_opcua_settings_are_checked(tmp_path: Path, extra: str, message: str) -> None:
    with pytest.raises(ConfigError, match=message):
        load(with_opcua(tmp_path, extra), env={})


def test_a_password_is_never_sent_unsecured(tmp_path: Path) -> None:
    body = OPCUA.format(
        extra='security = "None"\nallow_unsecured = true\nusername = "tiles"\npassword_file = "opcua/password"'
    )
    with pytest.raises(ConfigError, match="need a secured connection"):
        load(with_opcua(tmp_path, body=body), env={})


def test_unsecured_opcua_needs_saying_so(tmp_path: Path) -> None:
    body = OPCUA.format(extra='security = "None"\nallow_unsecured = true').replace(
        'server_certificate = "opcua/server.der"\n', ""
    )
    [c] = load(with_opcua(tmp_path, body=body), env={}).opcua
    assert (c.security, c.secured) == ("None", False)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (('server_certificate = "opcua/server.der"\n', ""), "server's certificate is pinned"),
        (('endpoint = "opc.tcp://10.0.0.5:4840"', 'endpoint = "http://10.0.0.5"'), "endpoint must be an opc.tcp://"),
        (("opc.tcp://10.0.0.5:4840", "opc.tcp://10.0.0.5:port"), "endpoint has an invalid port"),
        (('signal = "press1.temperature"', 'signal = "Press 1"'), "must be a Tiles signal ID"),
        (('name = "press-line"', 'name = "press line"'), "each \\[\\[opcua\\]\\] needs a name"),
        (
            ('[[opcua.signals]]\nnode = "ns=2;s=Press1.Temperature"\nsignal = "press1.temperature"\n', ""),
            "list the nodes",
        ),
    ],
)
def test_opcua_mistakes_are_explained(tmp_path: Path, change: tuple[str, str], message: str) -> None:
    body = OPCUA.format(extra="")
    assert change[0] in body
    with pytest.raises(ConfigError, match=message):
        load(with_opcua(tmp_path, body=body.replace(*change)), env={})


def test_signals_and_connector_names_are_unique(tmp_path: Path) -> None:
    twice = OPCUA.format(extra="") + OPCUA.format(extra="").replace("press-line", "press-line-2")
    with pytest.raises(ConfigError, match=r"signal 'press1\.temperature' appears more than once"):
        load(with_opcua(tmp_path, body=twice), env={})
    same_name = OPCUA.format(extra="") + OPCUA.format(extra="").replace("press1.temperature", "press1.other")
    with pytest.raises(ConfigError, match="connector name 'press-line' appears more than once"):
        load(with_opcua(tmp_path, body=same_name), env={})


def test_at_most_100_connectors(tmp_path: Path) -> None:
    many = "".join(
        OPCUA.format(extra="").replace("press-line", f"line-{i}").replace("press1.temperature", f"s{i}")
        for i in range(101)
    )
    with pytest.raises(ConfigError, match="at most 100 connectors"):
        load(with_opcua(tmp_path, body=many), env={})


SQL = """
[[sql]]
name = "mes"
engine = "postgresql"
host = "mes-db.plant.local"
database = "mes"
username = "tiles_reader"
password_file = "sql/password"
{extra}
[[sql.queries]]
name = "quality"
query = "SELECT id, measured_at, temperature FROM quality WHERE id > :watermark ORDER BY id"
watermark = "id"
start = 0
time = "measured_at"
columns = {{ temperature = "line1.temperature" }}
"""


def with_sql(tmp_path: Path, body: str) -> Path:
    path = write_config(tmp_path, "https://tiles.example.com")
    path.write_text(path.read_text() + body)
    return path


def test_a_sql_connector_loads_with_secure_defaults(tmp_path: Path) -> None:
    [c] = load(with_sql(tmp_path, SQL.format(extra="")), env={}).sql
    assert (c.engine, c.host, c.port, c.database, c.tls, c.ca_file) == (
        "postgresql",
        "mes-db.plant.local",
        5432,
        "mes",
        True,
        None,
    )
    assert (c.poll_seconds, c.max_rows, c.timeout_seconds, str(c.timezone)) == (60, 10000, 60, "UTC")
    [q] = c.queries
    assert (q.watermark, q.start, q.time, q.columns) == ("id", 0, "measured_at", {"temperature": "line1.temperature"})
    assert c.source == "postgresql://mes-db.plant.local:5432/mes"


def test_a_sqlite_database_is_a_file(tmp_path: Path) -> None:
    body = SQL.format(extra="").replace(
        'engine = "postgresql"\nhost = "mes-db.plant.local"\ndatabase = "mes"\n'
        'username = "tiles_reader"\npassword_file = "sql/password"\n',
        'engine = "sqlite"\npath = "data/quality.sqlite"\n',
    )
    [c] = load(with_sql(tmp_path, body), env={}).sql
    assert (c.path, c.host, c.tls, c.source) == (tmp_path / "data/quality.sqlite", None, False, str(c.path))


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (('engine = "postgresql"', 'engine = "oracle"'), "engine must be one of postgresql, sqlserver, sqlite"),
        (('engine = "postgresql"', 'engine = "sqlite"'), "a sqlite database is a file: set path, not host"),
        (('host = "mes-db.plant.local"\n', ""), "host is required"),
        (('password_file = "sql/password"\n', ""), "password_file is required"),
        (("{extra}", "tls = false"), "set allow_unsecured = true"),
        (('engine = "postgresql"', 'engine = "sqlserver"\nca_file = "ca.pem"'), "add the CA to the system"),
        (("{extra}", 'timezone = "Mars/Olympus"'), "isn't a known time zone"),
        (("{extra}", "max_rows = 5"), "max_rows must be a whole number from 10"),
        (("SELECT id", "DELETE FROM quality; SELECT id"), "query must be a SELECT"),
        (("SELECT id", "WITH x AS (SELECT 1) SELECT id"), None),
        (("ORDER BY id", "ORDER BY id; DROP TABLE quality"), "single statement"),
        (("id > :watermark", "id > 0"), "use :watermark exactly once"),
        ((" ORDER BY id", ""), "must ORDER BY the watermark column"),
        (("start = 0\n", ""), "start is where the first poll begins"),
        (("columns = {{ temperature", 'signal_column = "tag"\ncolumns = {{ temperature'), "map columns to signals"),
        (("columns = {{ temperature", 'signal_column = "tag"\nzz = {{ temperature'), "unknown setting"),
        (('"line1.temperature"', '"Line 1"'), "must be a Tiles signal ID"),
        (('name = "quality"', 'name = "quality"\nspeed = 1'), r"unknown setting\(s\) in \[\[sql\]\] mes query quality"),
    ],
)
def test_sql_mistakes_are_explained(tmp_path: Path, change: tuple[str, str], message: str | None) -> None:
    assert change[0] in SQL
    body = SQL.replace(*change).format(extra="")
    if message is None:
        assert load(with_sql(tmp_path, body), env={}).sql
        return
    with pytest.raises(ConfigError, match=message):
        load(with_sql(tmp_path, body), env={})


def test_long_rows_map_signal_values(tmp_path: Path) -> None:
    body = SQL.format(extra="").replace(
        'columns = { temperature = "line1.temperature" }',
        'signal_column = "tag"\nvalue_column = "value"\nsignals = { "TT-101" = "press1.temperature" }',
    )
    [q] = load(with_sql(tmp_path, body), env={}).sql[0].queries
    assert (q.columns, q.signal_column, q.value_column, q.signals) == (
        {},
        "tag",
        "value",
        {"TT-101": "press1.temperature"},
    )
    incomplete = body.replace('value_column = "value"\n', "")
    with pytest.raises(ConfigError, match="set signal_column, value_column and signals together"):
        load(with_sql(tmp_path, incomplete), env={})


def test_sql_signals_are_unique_across_connectors(tmp_path: Path) -> None:
    body = SQL.format(extra="") + SQL.format(extra="").replace('name = "mes"', 'name = "mes-2"')
    with pytest.raises(ConfigError, match=r"signal 'line1\.temperature' appears more than once"):
        load(with_sql(tmp_path, body), env={})
