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
