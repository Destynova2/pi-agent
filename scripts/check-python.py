#!/usr/bin/env python3
"""Compile maintained Python sources without executing them or writing caches in the checkout."""
from pathlib import Path
import py_compile
import sys
import tempfile


def check(root):
    files = sorted(
        path
        for directory in ("extensions", "lib", "scripts", "gates", "tests")
        for path in (root / directory).rglob("*.py")
        if not any(part.startswith(".") or part in ("node_modules", "__pycache__")
                   for part in path.relative_to(root).parts)
    )
    if not files:
        print("check:python: no Python sources found", file=sys.stderr)
        return 1
    failed = False
    with tempfile.TemporaryDirectory(prefix="pi-python-check-") as cache:
        for index, path in enumerate(files):
            try:
                py_compile.compile(str(path), cfile=str(Path(cache) / f"{index}.pyc"), doraise=True)
            except py_compile.PyCompileError as error:
                failed = True
                print(error, file=sys.stderr)
    print(f"check:python: {len(files)} file(s) checked")
    return int(failed)


if __name__ == "__main__":
    sys.exit(check(Path(sys.argv[1]).resolve() if len(sys.argv) == 2
                   else Path(__file__).resolve().parent.parent))
