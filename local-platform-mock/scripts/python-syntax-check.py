#!/usr/bin/env python3
"""Compile Python sources in memory without mutating __pycache__."""

from __future__ import annotations

from pathlib import Path
import sys


def main() -> int:
    failed = False
    for value in sys.argv[1:]:
        source = Path(value)
        try:
            compile(source.read_bytes(), str(source), "exec")
        except Exception as error:
            failed = True
            print(f"{source}: {error}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
