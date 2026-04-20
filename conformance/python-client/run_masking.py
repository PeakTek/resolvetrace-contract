#!/usr/bin/env python3
"""Cross-language masking-parity helper.

Read JSON from stdin with the shape::

    {"attributes": {...}}

Write JSON to stdout with the shape::

    {
      "applied": [ ... rule identifiers the scrubber applied ... ],
      "attributes": { ... attribute payload after scrubbing ... }
    }

Exits non-zero on error. The harness spawns this script as a subprocess so
the TypeScript runner can call the Python SDK's scrubber without pulling
CPython into the Node process.

Prerequisite: the ``resolvetrace`` package must be importable. In CI this
is handled by ``pip install -e sdk/python`` ahead of running the harness;
see ``conformance/README.md`` for the full local setup.
"""

from __future__ import annotations

import json
import sys
from typing import Any


def _fatal(message: str) -> None:
    sys.stderr.write(f"run_masking: {message}\n")
    sys.exit(1)


def main() -> None:
    raw = sys.stdin.read()
    if not raw.strip():
        _fatal("empty stdin")
        return

    try:
        request: dict[str, Any] = json.loads(raw)
    except json.JSONDecodeError as exc:
        _fatal(f"invalid JSON: {exc}")
        return

    attributes = request.get("attributes")
    if attributes is not None and not isinstance(attributes, dict):
        _fatal("`attributes` must be an object or null")
        return

    try:
        # Import lazily so a helpful error is emitted if the SDK is not
        # installed yet.
        from resolvetrace.scrubber import Scrubber
    except Exception as exc:  # pragma: no cover - import failure path
        _fatal(
            f"failed to import resolvetrace.scrubber ({exc}); "
            "run 'pip install -e sdk/python' first"
        )
        return

    scrubber = Scrubber(sdk_version="conformance@0.1.0")
    scrubbed_attrs, report = scrubber.scrub(attributes)

    output = {
        "applied": list(report.applied),
        "attributes": scrubbed_attrs if scrubbed_attrs is not None else {},
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
