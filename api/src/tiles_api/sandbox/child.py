"""One evaluation of a model from GitHub (T4.15), in a process of its own that the sandbox server
starts with `python -I -S` (the standard library only), resource limits, no environment and the
model's directory as its working directory.

It reads `{"entry", "inputs", "params"}` from stdin, then, before any of the model's code runs,
installs an audit hook (PEP 578) that refuses sockets, new processes, writing files, foreign code
(ctypes) and reading anything outside the model's directory and the standard library. It imports
the entry file, calls its `run(inputs, params)` and writes `{"outputs": {...}}`, or
`{"error": "..."}` with exit code 1, to stdout.

The hook is a second wall, not the first: the server's pod has no network and no credentials, a
read-only filesystem and a non-root user (deploy/helm). Standard library only: keep it importable
without the rest of tiles_api.
"""

import importlib.util
import io
import json
import math
import os
import resource
import sys
import sysconfig
from typing import Any

# Modules a model may not import, even from the standard library: network, processes, foreign code.
BLOCKED_MODULES = frozenset(
    {
        "_ctypes",
        "_posixsubprocess",
        "_socket",
        "_ssl",
        "asyncio",
        "ctypes",
        "ftplib",
        "http",
        "imaplib",
        "mmap",
        "multiprocessing",
        "poplib",
        "pty",
        "smtplib",
        "socket",
        "socketserver",
        "ssl",
        "subprocess",
        "telnetlib",
        "urllib",
        "webbrowser",
        "xmlrpc",
    }
)
# Audit events refused outright: by prefix, or exactly.
BLOCKED_PREFIXES = (
    "socket.",
    "subprocess.",
    "os.exec",
    "os.spawn",
    "os.posix_spawn",
    "os.fork",
    "os.forkpty",
    "os.kill",
    "os.killpg",
    "ctypes.",
    "shutil.",
    "mmap.",
    "winreg.",
)
BLOCKED_EVENTS = frozenset(
    {
        "os.system",
        "os.putenv",
        "os.unsetenv",
        "os.remove",
        "os.rename",
        "os.rmdir",
        "os.mkdir",
        "os.chmod",
        "os.chown",
        "os.link",
        "os.symlink",
        "os.truncate",
        "os.chdir",
        "os.chflags",
        "os.lchflags",
        "os.setxattr",
        "os.removexattr",
        "os.utime",
        "fcntl.fcntl",
        "fcntl.ioctl",
        "fcntl.flock",
        "fcntl.lockf",
        "resource.setrlimit",
        "resource.prlimit",
        "sys.addaudithook",
        "sys.settrace",
        "sys.setprofile",
        "cpython.PyInterpreterState_New",
        "cpython.run_command",
        "cpython.run_file",
        "cpython.run_module",
        "cpython.run_startup",
        "code.__new__",
        "marshal.loads",
        "marshal.load",
    }
)
WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def readable_roots(workdir: str) -> tuple[str, ...]:
    paths = sysconfig.get_paths()
    roots = {workdir, paths["stdlib"], paths["platstdlib"]}
    return tuple(os.path.realpath(r) + os.sep for r in roots)


def install_guard(workdir: str) -> None:
    roots = readable_roots(workdir)

    def guard(event: str, args: tuple[Any, ...]) -> None:
        if event == "open":
            path, mode, flags = args
            if path is None or isinstance(path, int):
                raise PermissionError("the sandbox opens no file descriptors")
            writing = bool(flags & WRITE_FLAGS) if isinstance(flags, int) else False
            if writing or (isinstance(mode, str) and any(c in mode for c in "wax+")):
                raise PermissionError("models may not write files")
            real = os.path.realpath(os.fsdecode(path))
            if not (real + os.sep).startswith(roots) and not real.startswith(roots):
                raise PermissionError(f"models may read only their own directory, not {real}")
        elif event in ("os.listdir", "os.scandir"):
            where = os.path.realpath(os.fsdecode(args[0])) if args[0] not in (None, ".") else workdir
            if not (where + os.sep).startswith(roots):
                raise PermissionError(f"models may list only their own directory, not {where}")
        elif event == "import":
            top = str(args[0]).split(".")[0]
            if top in BLOCKED_MODULES:
                raise ImportError(f"models may not import {top}")
        elif event in BLOCKED_EVENTS or event.startswith(BLOCKED_PREFIXES):
            raise PermissionError(f"models may not use {event}")

    sys.addaudithook(guard)


def limit(cpu_s: int, memory_mb: int) -> None:
    """Hard limits on this process, which the guard then keeps it from raising: CPU time, memory,
    no files written, few open, no new processes, no core dumps."""
    memory = memory_mb * 1024 * 1024
    for which, value in (
        (resource.RLIMIT_CPU, cpu_s),
        (resource.RLIMIT_AS, memory),
        (resource.RLIMIT_FSIZE, 0),
        (resource.RLIMIT_NOFILE, 64),
        (resource.RLIMIT_NPROC, 0),
        (resource.RLIMIT_CORE, 0),
    ):
        resource.setrlimit(which, (value, value))


def _finite(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def main() -> None:
    workdir = os.getcwd()
    request = json.loads(sys.stdin.buffer.read())
    limit(int(request["limits"]["cpu_s"]), int(request["limits"]["memory_mb"]))
    entry = os.path.realpath(os.path.join(workdir, request["entry"]))
    if not entry.startswith(os.path.realpath(workdir) + os.sep):
        raise SystemExit("the entry file must be in the model's directory")
    out = sys.stdout
    sys.stdout = sys.stderr = io.StringIO()  # what the model prints never mixes with the reply
    sys.dont_write_bytecode = True
    sys.path[:0] = [workdir]  # the model's own modules, beside the entry file
    install_guard(workdir)
    try:
        spec = importlib.util.spec_from_file_location("tiles_model", entry)
        if spec is None or spec.loader is None:
            raise ImportError(f"{request['entry']} can't be imported")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        run = getattr(module, "run", None)
        if not callable(run):
            raise TypeError(f"{request['entry']} has no run(inputs, params) function")
        outputs = run(request["inputs"], request["params"])
        if not isinstance(outputs, dict):
            raise TypeError("run must return a dict of output name to a list of values")
        reply = {"outputs": {str(k): [_finite(v) for v in vs] for k, vs in outputs.items()}}
        text = json.dumps(reply, allow_nan=False)
    except BaseException as e:  # whatever the model raised, as words; then a failed exit
        out.write(json.dumps({"error": f"{type(e).__name__}: {e}"[:500]}))
        out.flush()
        os._exit(1)
    out.write(text)
    out.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
