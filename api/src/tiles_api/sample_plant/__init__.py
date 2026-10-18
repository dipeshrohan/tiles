"""The sample plant: a year of a made-up die-casting plant, complete as a partner would hand it over
(data/sample-plant/README.md). `tiles-sample-plant generate` writes its files; `tiles-sample-plant
load` loads them into a Tiles site through the API.
"""

import argparse
import sys
from pathlib import Path

DEFAULT_OUT = Path(__file__).resolve().parents[4] / "data" / "sample-plant"


def main(argv: list[str] | None = None) -> None:
    """`tiles-sample-plant`: generate the sample plant's files, or load them into a site."""
    parser = argparse.ArgumentParser(prog="tiles-sample-plant", description=main.__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    gen = sub.add_parser("generate", help="simulate the year and write the files")
    gen.add_argument("--out", type=Path, default=DEFAULT_OUT, help="the folder (default: data/sample-plant)")
    gen.add_argument(
        "--all", action="store_true", help="also write the historian, X-ray and shot-curve files (about 1 GB)"
    )
    ld = sub.add_parser("load", help="load the files into a site through the API")
    ld.add_argument("--root", type=Path, default=DEFAULT_OUT, help="the folder (default: data/sample-plant)")
    ld.add_argument("--api", default="http://localhost:8000", help="the API's address")
    ld.add_argument("--site", required=True, help="the site's id")
    who = ld.add_mutually_exclusive_group(required=True)
    who.add_argument("--as", help="an engineer's email (the API's development sign-in)")
    who.add_argument("--token", help="an engineer's access token")
    ld.add_argument("--shift-to-now", action="store_true", help="move the year on by whole weeks to end last week")
    ld.add_argument("--no-readings", action="store_true", help="leave out the historian and X-ray files")
    args = parser.parse_args(argv)
    if args.command == "load":
        from tiles_api.sample_plant import load

        load.main(args)
        return
    if args.command == "generate":
        from tiles_api.sample_plant.generate import generate

        manifest = generate(args.out, big=args.all)
        print(
            f"Wrote {args.out}: {sum(manifest['shots'].values()):,} shots, {len(manifest['committed'])} files"
            + (f", {len(manifest['generated'])} generated" if args.all else "")
        )
        sys.exit(0)
