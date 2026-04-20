#!/usr/bin/env python3
"""Regenerate Pydantic v2 models from the contract JSON Schemas.

This is the future-automation hook for the SDK. Today (v0.1.0) we ship
hand-authored models in ``resolvetrace/models.py``. A later milestone
replaces those with the output of this script so the Python surface stays
in lockstep with ``schemas/*.json``.

Usage
-----

    # From the SDK directory:
    python scripts/regenerate_models.py

    # Or point at a different schema root:
    python scripts/regenerate_models.py --schemas ../../schemas --out resolvetrace/_generated_models.py

The script wraps ``datamodel-code-generator``; pin the version in the
``dev`` optional-dependencies group so regeneration is deterministic across
contributor machines.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

#: Directory containing ``events.json``, ``replay.json``, etc.
DEFAULT_SCHEMA_DIR = Path(__file__).resolve().parents[3] / "schemas"

#: File to write generated models into. Committed alongside source so PRs
#: can diff the regenerated output.
DEFAULT_OUTPUT = (
    Path(__file__).resolve().parents[1] / "resolvetrace" / "_generated_models.py"
)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--schemas",
        type=Path,
        default=DEFAULT_SCHEMA_DIR,
        help="Directory containing the JSON Schema files (default: contract-repo schemas/).",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Output Python file (default: resolvetrace/_generated_models.py).",
    )
    parser.add_argument(
        "--generator",
        default="datamodel-codegen",
        help="CLI entry point for datamodel-code-generator (default: datamodel-codegen).",
    )
    args = parser.parse_args(argv)

    if not args.schemas.is_dir():
        print(f"error: schemas directory not found: {args.schemas}", file=sys.stderr)
        return 2

    schema_files = sorted(args.schemas.glob("*.json"))
    if not schema_files:
        print(f"error: no .json schemas in {args.schemas}", file=sys.stderr)
        return 2

    args.out.parent.mkdir(parents=True, exist_ok=True)

    # One invocation per schema file keeps model names distinct; callers can
    # opt in to a merged invocation once the generator supports that cleanly.
    combined_lines: list[str] = [
        '"""Auto-generated Pydantic models.\n\n'
        "Do not edit by hand. Regenerate with:\n\n"
        "    python scripts/regenerate_models.py\n"
        '"""\n',
        "from __future__ import annotations\n",
    ]

    for schema_file in schema_files:
        cmd = [
            args.generator,
            "--input",
            str(schema_file),
            "--input-file-type",
            "jsonschema",
            "--output-model-type",
            "pydantic_v2.BaseModel",
            "--use-standard-collections",
            "--use-union-operator",
            "--target-python-version",
            "3.10",
        ]
        print("+", " ".join(cmd), file=sys.stderr)
        try:
            result = subprocess.run(
                cmd,
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError:
            print(
                "error: datamodel-code-generator not installed. "
                "Install with: pip install datamodel-code-generator",
                file=sys.stderr,
            )
            return 1
        except subprocess.CalledProcessError as exc:
            print(exc.stderr, file=sys.stderr)
            return exc.returncode

        combined_lines.append(f"\n# --- generated from {schema_file.name} ---\n")
        combined_lines.append(result.stdout)

    args.out.write_text("\n".join(combined_lines), encoding="utf-8")
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
