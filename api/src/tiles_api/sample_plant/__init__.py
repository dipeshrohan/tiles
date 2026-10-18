"""Sample plants: a year of a made-up plant in each of four industries, complete as a partner would
hand it over (data/sample-plants/README.md). `tiles-sample-plant generate <plant>` writes a plant's
files; `tiles-sample-plant load <plant>` loads them into a Tiles site through the API.
"""

import argparse
import importlib
import sys
from pathlib import Path
from types import ModuleType

DATA = Path(__file__).resolve().parents[4] / "data" / "sample-plants"
PLANTS = {
    "die-casting": "tiles_api.sample_plant.die_casting",
    "battery": "tiles_api.sample_plant.battery",
    "graphene": "tiles_api.sample_plant.graphene",
    "biologics": "tiles_api.sample_plant.biologics",
}


def plant(name: str) -> ModuleType:
    """The plant's `generate` module: its `generate(out, big)` writes the files."""
    return importlib.import_module(f"{PLANTS[name]}.generate")


def main(argv: list[str] | None = None) -> None:
    """`tiles-sample-plant`: generate a sample plant's files, or load them into a site."""
    parser = argparse.ArgumentParser(prog="tiles-sample-plant", description=main.__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    gen = sub.add_parser("generate", help="simulate a plant's year and write its files")
    gen.add_argument("plant", choices=[*PLANTS, "all"], help="which plant (all: every one)")
    gen.add_argument(
        "--out", type=Path, help="the folder (default: data/sample-plants/<plant>; with all, a folder each in it)"
    )
    gen.add_argument("--all", action="store_true", help="also write the large files under generated/")
    ld = sub.add_parser("load", help="load a plant's files into a site through the API")
    ld.add_argument("plant", choices=list(PLANTS), help="which plant")
    ld.add_argument("--root", type=Path, help="the folder (default: data/sample-plants/<plant>)")
    ld.add_argument("--api", default="http://localhost:8000", help="the API's address")
    ld.add_argument("--site", required=True, help="the site's id")
    who = ld.add_mutually_exclusive_group(required=True)
    who.add_argument("--as", help="an engineer's email (the API's development sign-in)")
    who.add_argument("--token", help="an engineer's access token")
    ld.add_argument("--shift-to-now", action="store_true", help="move the year on by whole weeks to end last week")
    ld.add_argument("--no-readings", action="store_true", help="leave out the large files")
    args = parser.parse_args(argv)
    if args.command == "load":
        from tiles_api.sample_plant import load

        args.root = args.root or DATA / args.plant
        load.main(args)
        return
    for name in PLANTS if args.plant == "all" else [args.plant]:
        # --out is the plant's folder; with all, the folder each plant's goes in.
        out = (args.out / name if args.plant == "all" else args.out) if args.out else DATA / name
        manifest = plant(name).generate(out, big=args.all)
        print(
            f"{name}: wrote {out}, {len(manifest['committed'])} files"
            + (f", {len(manifest['generated'])} generated" if args.all else "")
        )
    sys.exit(0)
