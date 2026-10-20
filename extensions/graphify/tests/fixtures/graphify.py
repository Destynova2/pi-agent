#!/usr/bin/env python3
"""Deterministic extractor failures for testing cache publication."""
import json
from pathlib import Path
import sys
import time

if sys.argv[1] == "extract":
    config = json.loads((Path(sys.argv[2]) / "fixture.json").read_text())
    output = Path(sys.argv[sys.argv.index("--out") + 1])
    (output / "graphify-out").mkdir()
    (output / "graphify-out/graph.json").write_text(json.dumps(config))
    (output / "extract.ready").touch()
    if config.get("slow"):
        time.sleep(30)
else:
    graph = json.loads(Path(sys.argv[sys.argv.index("--graph") + 1]).read_text())
    if graph.get("failAnalysis"):
        print("fixture analysis failed", file=sys.stderr)
        sys.exit(7)
    print("fixture overview")
