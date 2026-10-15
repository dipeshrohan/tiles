"""Errors carry a code the browser translates (U6.01, errors.py)."""

import ast
import json
import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from tiles_api import errors
from tiles_api.errors import Problem
from tiles_api.main import create_app
from tiles_api.settings import Settings

SRC = Path(__file__).resolve().parents[1] / "src" / "tiles_api"
CATALOGUE = Path(__file__).resolve().parents[2] / "js" / "i18n" / "en.json"
# A message's values: `{name}`, or `{name, plural|select, …}`.
PLACEHOLDER = re.compile(r"\{(\w+)(?=[,}])")


def calls(name: str) -> list[tuple[Path, ast.Call]]:
    out: list[tuple[Path, ast.Call]] = []
    for path in SRC.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(), str(path))):
            if isinstance(node, ast.Call):
                func = node.func
                called = func.id if isinstance(func, ast.Name) else func.attr if isinstance(func, ast.Attribute) else ""
                if called == name:
                    out.append((path, node))
    return out


def test_errors_are_problems_with_a_code() -> None:
    bare = [f"{p.relative_to(SRC)}:{n.lineno}" for p, n in calls("HTTPException") if p.name != "errors.py"]
    assert not bare, f"raise errors.Problem (with a code), not HTTPException: {bare}"


def test_every_code_has_its_message_with_the_same_params() -> None:
    catalogue = json.loads(CATALOGUE.read_text())
    problems = []
    for path, node in calls("Problem"):
        where = f"{path.relative_to(SRC)}:{node.lineno}"
        code = node.args[1] if len(node.args) > 1 else None
        if not (isinstance(code, ast.Constant) and isinstance(code.value, str)):
            problems.append(f"{where}: the code must be a string literal")
            continue
        if not re.fullmatch(r"[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+", code.value):
            problems.append(f"{where}: {code.value!r} isn't a dotted lower-case code")
        message = catalogue.get(f"api.{code.value}")
        if message is None:
            problems.append(f"{where}: no api.{code.value} in js/i18n/en.json")
            continue
        params = {k.arg for k in node.keywords if k.arg and k.arg != "headers"}
        wanted = set(PLACEHOLDER.findall(message))
        if params != wanted:
            problems.append(f"{where}: api.{code.value} takes {sorted(wanted)}, given {sorted(params)}")
    assert not problems, "\n".join(problems)


def test_answers_carry_code_params_and_headers() -> None:
    app = FastAPI()
    app.add_exception_handler(StarletteHTTPException, errors.answer)

    @app.get("/thing")
    def thing() -> None:
        raise Problem(409, "thing.busy", "Thing 4 is busy", headers={"Retry-After": "3"}, number=4)

    client = TestClient(app)
    r = client.get("/thing")
    assert r.status_code == 409
    assert r.headers["Retry-After"] == "3"
    assert r.json() == {"detail": "Thing 4 is busy", "code": "thing.busy", "params": {"number": 4}}
    # One the API didn't raise itself: its status as the code.
    r = client.get("/nowhere")
    assert r.status_code == 404
    assert r.json()["code"] == "http.404"


def test_the_app_answers_with_codes() -> None:
    client = TestClient(create_app(Settings(env="test")))
    assert client.get("/nowhere").json()["code"] == "http.404"
    assert client.post("/health").json()["code"] == "http.405"


def test_validation_errors_keep_their_types() -> None:
    app = create_app(Settings(env="test"))

    class Body(BaseModel):
        name: str

    @app.post("/echo")
    def echo(body: Body) -> Body:
        return body

    r = TestClient(app).post("/echo", json={})
    assert r.status_code == 422
    assert r.json()["code"] == "validation"
    assert r.json()["detail"][0]["type"] == "missing"


def test_every_api_message_is_one_the_api_sends() -> None:
    """No catalogue words left behind for a code the API no longer sends (fields' are Pydantic's)."""
    used = {
        f"api.{n.args[1].value}"
        for _, n in calls("Problem")
        if len(n.args) > 1 and isinstance(n.args[1], ast.Constant) and isinstance(n.args[1].value, str)
    }
    keys = {k for k in json.loads(CATALOGUE.read_text()) if k.startswith("api.") and not k.startswith("api.field.")}
    assert not keys - used, f"not sent by the API: {sorted(keys - used)}"
