"""Regenerate `schemas/scrubber-rules.matrix.json` + `.digest.txt`.

Run: python scripts/compute_rules_digest.py

The matrix is the single source of truth both SDKs load at init. The digest
file carries the expected `sha256:<hex>` that the digest-parity tests assert
against — changing the matrix means this script is rerun in the same PR so
the committed digest is in sync.

The emitted JSON is pretty-printed (2-space indent) for readability, but the
digest is computed on the canonical serialization
(`json.dumps(matrix, sort_keys=True, separators=(",", ":"))`), matching the
canonicalization both SDK implementations perform at runtime.
"""

from __future__ import annotations

import hashlib
import json
import pathlib

MATRIX = {
    "version": "1.0.0",
    "notes": (
        "Stage-1 deterministic scrubber ruleset. Patterns are shared between "
        "TypeScript (ECMAScript dialect) and Python (re dialect); we prefer "
        "portable anchors (\\b, \\d, character classes) and avoid lookbehind "
        "/ lookahead so both engines compile identical regex semantics. Known "
        "trade-offs: regex:email uses a simplified RFC-5322 subset and may "
        "miss quoted local-parts; regex:phone-e164 requires the literal + "
        "prefix (no country code means no match); regex:sin-ca requires a "
        "post-check SIN Luhn pass (weights 1,2,1,2,1,2,1,2,1); regex:creditcard "
        "requires a post-check standard Luhn pass. Rule execution order is "
        "defined by the array order and MUST be preserved; attribute / "
        "selector rules run before regex rules. Changing a rule id, pattern, "
        "flags, or order is a breaking change that bumps rulesDigest."
    ),
    "redactionTokenTemplate": "[REDACTED:{rule}]",
    "overflowToken": "[REDACTED_OVERFLOW]",
    "rules": [
        {
            "id": "attr:password-input",
            "kind": "attribute",
            "selector": 'input[type="password"]',
        },
        {
            "id": "attr:data-rt-mask",
            "kind": "attribute",
            "attribute": "data-rt-mask",
        },
        {
            "id": "attr:data-private",
            "kind": "attribute",
            "attribute": "data-private",
        },
        {
            "id": "selector:user-configured",
            "kind": "user-configured-selector",
        },
        {
            "id": "regex:email",
            "kind": "regex",
            "pattern": r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
            "flags": "gi",
        },
        {
            "id": "regex:ssn-us",
            "kind": "regex",
            "pattern": r"\b\d{3}-\d{2}-\d{4}\b",
            "flags": "g",
        },
        {
            "id": "regex:sin-ca",
            "kind": "regex",
            "pattern": r"\b\d{3}[- ]?\d{3}[- ]?\d{3}\b",
            "flags": "g",
            "postCheck": "luhn-sin",
        },
        {
            "id": "regex:creditcard",
            "kind": "regex",
            "pattern": r"\b(?:\d[ -]?){12,18}\d\b",
            "flags": "g",
            "postCheck": "luhn",
        },
        {
            "id": "regex:phone-e164",
            "kind": "regex",
            "pattern": r"\+\d{8,15}",
            "flags": "g",
        },
    ],
}


def canonical_json(matrix: dict) -> str:
    return json.dumps(matrix, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main() -> None:
    here = pathlib.Path(__file__).resolve().parent
    root = here.parent
    schema_matrix = root / "schemas" / "scrubber-rules.matrix.json"
    schema_digest = root / "schemas" / "scrubber-rules.digest.txt"
    py_matrix = root / "sdk" / "python" / "resolvetrace" / "scrubber-rules.matrix.json"

    pretty = json.dumps(MATRIX, indent=2, ensure_ascii=False) + "\n"
    schema_matrix.write_text(pretty, encoding="utf-8", newline="\n")
    py_matrix.write_text(pretty, encoding="utf-8", newline="\n")

    canon = canonical_json(MATRIX)
    hex_digest = hashlib.sha256(canon.encode("utf-8")).hexdigest()
    schema_digest.write_text(f"sha256:{hex_digest}\n", encoding="utf-8", newline="\n")

    print(f"wrote {schema_matrix.relative_to(root)} ({schema_matrix.stat().st_size} bytes)")
    print(f"wrote {py_matrix.relative_to(root)} ({py_matrix.stat().st_size} bytes)")
    print(f"canonical bytes: {len(canon)}")
    print(f"digest: sha256:{hex_digest}")


if __name__ == "__main__":
    main()

