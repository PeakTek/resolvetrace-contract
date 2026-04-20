"""SDK-side deterministic scrubber (Stage-1).

Applies the shared Stage-1 rule matrix to event attributes before transport.
Stage-1 is intentionally small: heavier, tenant-configurable rules run
server-side in Stage-2.

The rule set is defined in ``schemas/scrubber-rules.matrix.json`` at the root
of the contract repository and packaged inside this SDK so the exact same
matrix drives the TypeScript and Python scrubbers. Both SDKs canonicalize
the matrix with ``json.dumps(sort_keys=True, separators=(",", ":"))`` and
hash it with SHA-256, so the wire-stamped ``rulesDigest`` is byte-identical
across languages for a given matrix version.

Per-event budget: ``4 ms`` wall clock. When the budget trips, the scrubber
stops mid-event and replaces any un-processed string values with the
matrix's ``overflowToken`` sentinel, sets ``budgetExceeded=True`` on the
report, and increments the overflow diagnostic counter. Callers must never
dispatch an envelope whose scrub budget tripped without the overflow marker
applied.
"""

from __future__ import annotations

import hashlib
import importlib.resources as resources
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Callable

from .models import ScrubberReport

#: Per-event scrub budget in milliseconds. ADR-0001 envelope ceiling; customer
#: hooks may tighten but not loosen this.
DEFAULT_BUDGET_MS = 4.0


# ---------------------------------------------------------------------------
# Matrix loader
# ---------------------------------------------------------------------------


_MATRIX_RESOURCE_NAME = "scrubber-rules.matrix.json"


def _load_matrix() -> dict[str, Any]:
    """Load the canonical rule matrix that ships with this package.

    Uses :mod:`importlib.resources` so the file is read from the installed
    wheel / sdist rather than requiring a specific filesystem layout. The
    matrix is packaged via ``pyproject.toml`` hatch ``include``.
    """
    with (
        resources.files("resolvetrace")
        .joinpath(_MATRIX_RESOURCE_NAME)
        .open("r", encoding="utf-8")
    ) as f:
        return json.load(f)


RULES_MATRIX: dict[str, Any] = _load_matrix()

#: Sentinel inserted in place of an unprocessed string when the budget trips.
#: Sourced from the matrix so TS and Python agree.
REDACTED_OVERFLOW: str = RULES_MATRIX["overflowToken"]

#: Python ``str.format``-style template used to render a rule-specific
#: redaction token. Kept as a compatibility re-export for the existing test
#: suite; new code should call :func:`redaction_token` instead.
REDACTED_PII: str = RULES_MATRIX["redactionTokenTemplate"].replace("{rule}", "{rule}")

#: Rule-id echoed in ``applied`` when the overflow path fires.
OVERFLOW_RULE_ID = "overflow_fallback"


def redaction_token(rule_id: str) -> str:
    """Render the canonical redaction token for ``rule_id``."""
    return RULES_MATRIX["redactionTokenTemplate"].replace("{rule}", rule_id)


# ---------------------------------------------------------------------------
# Luhn validators (referenced by the matrix's ``postCheck`` hooks)
# ---------------------------------------------------------------------------


def _luhn_valid(digits: str) -> bool:
    """Return True when ``digits`` (0-9 only) satisfies the standard Luhn checksum."""
    clean = re.sub(r"\D", "", digits)
    if len(clean) < 2:
        return False
    total = 0
    parity = len(clean) % 2
    for i, ch in enumerate(clean):
        d = ord(ch) - 48
        if d < 0 or d > 9:
            return False
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _valid_sin(digits: str) -> bool:
    """Canadian SIN checksum with weights (1,2,1,2,1,2,1,2,1)."""
    clean = re.sub(r"\D", "", digits)
    if len(clean) != 9:
        return False
    weights = (1, 2, 1, 2, 1, 2, 1, 2, 1)
    total = 0
    for i, ch in enumerate(clean):
        d = ord(ch) - 48
        if d < 0 or d > 9:
            return False
        p = d * weights[i]
        if p > 9:
            p = p // 10 + p % 10
        total += p
    return total % 10 == 0


_POST_CHECKS: dict[str, Callable[[str], bool]] = {
    "luhn": _luhn_valid,
    "luhn-sin": _valid_sin,
}


# ---------------------------------------------------------------------------
# Compiled regex rules
# ---------------------------------------------------------------------------


@dataclass
class _CompiledRule:
    rule_id: str
    regex: re.Pattern[str]
    post_check: Callable[[str], bool] | None


def _flags_to_re(flags: str) -> int:
    """Translate matrix flag string to :mod:`re` flag bitmask.

    The matrix uses ECMAScript-style flag letters; we honour the subset that
    has a direct Python equivalent. ``g`` is a no-op in Python because
    ``re.sub`` replaces every match by default.
    """
    out = 0
    for ch in flags:
        if ch == "g":
            continue  # global is implicit in Python's re.sub / re.subn
        if ch == "i":
            out |= re.IGNORECASE
        elif ch == "m":
            out |= re.MULTILINE
        elif ch == "s":
            out |= re.DOTALL
        else:
            raise ValueError(f"scrubber-rules: unsupported regex flag {ch!r}")
    return out


def _compile_rules(matrix: dict[str, Any]) -> list[_CompiledRule]:
    compiled: list[_CompiledRule] = []
    for rule in matrix["rules"]:
        if rule.get("kind") != "regex":
            continue
        pattern = rule.get("pattern")
        if not isinstance(pattern, str):
            raise ValueError(f"scrubber-rules: rule {rule.get('id')!r} is missing pattern")
        regex = re.compile(pattern, _flags_to_re(rule.get("flags", "")))
        post = rule.get("postCheck")
        post_check = _POST_CHECKS.get(post) if isinstance(post, str) else None
        compiled.append(
            _CompiledRule(rule_id=rule["id"], regex=regex, post_check=post_check)
        )
    return compiled


_REGEX_RULES: list[_CompiledRule] = _compile_rules(RULES_MATRIX)


# ---------------------------------------------------------------------------
# Rules digest
# ---------------------------------------------------------------------------


def _canonical_json(value: Any) -> str:
    """Canonical JSON: alphabetically-sorted keys, no insignificant whitespace."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_rules_digest(matrix: dict[str, Any]) -> str:
    """Compute the ``sha256:<hex>`` digest for ``matrix``.

    Used at module init to stamp every envelope and by the digest-parity test
    to verify the committed constant in ``schemas/scrubber-rules.digest.txt``.
    """
    canon = _canonical_json(matrix)
    digest = hashlib.sha256(canon.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


#: Committed digest for the shipped ``RULES_MATRIX``. Computed at import time
#: from the canonicalized matrix; also checked in as
#: ``schemas/scrubber-rules.digest.txt`` so the digest-parity test can assert
#: the two stay in sync.
RULES_DIGEST: str = compute_rules_digest(RULES_MATRIX)


def rules_digest() -> str:
    """Return the current ``rulesDigest`` string stamped on every envelope."""
    return RULES_DIGEST


# ---------------------------------------------------------------------------
# Core scrub logic
# ---------------------------------------------------------------------------


def _redact_detections(value: str) -> tuple[str, list[str]]:
    """Apply every Stage-1 regex rule to ``value``.

    Rules run in canonical matrix order. Returns the possibly-redacted value
    and the ordered list of rule ids that fired.
    """
    applied: list[str] = []
    for rule in _REGEX_RULES:
        if rule.post_check is not None:
            post_check = rule.post_check  # local binding to help type-narrowing

            def _sub(match: re.Match[str], _rule_id: str = rule.rule_id) -> str:
                if post_check(match.group(0)):
                    if _rule_id not in applied:
                        applied.append(_rule_id)
                    return redaction_token(_rule_id)
                return match.group(0)

            value = rule.regex.sub(_sub, value)
        else:
            def _sub_direct(match: re.Match[str], _rule_id: str = rule.rule_id) -> str:
                if _rule_id not in applied:
                    applied.append(_rule_id)
                return redaction_token(_rule_id)

            value = rule.regex.sub(_sub_direct, value)
    return value, applied


# ---------------------------------------------------------------------------
# Scrubber
# ---------------------------------------------------------------------------


@dataclass
class Scrubber:
    """Deterministic SDK-side scrubber.

    Parameters
    ----------
    sdk_version:
        The SDK package version string. Emitted in the report's ``version``
        field as ``sdk@<ver>``.
    mask_selectors:
        Attribute-name or dot-path selectors that should be redacted wholesale
        regardless of content. Example: ``["creditCard", "billing.card"]``.
        Implements the ``selector:user-configured`` matrix rule in a
        server-friendly (DOM-free) fashion.
    budget_ms:
        Per-event wall-clock budget. Defaults to the ADR-0001 ceiling.
    """

    sdk_version: str
    mask_selectors: tuple[str, ...] = ()
    budget_ms: float = DEFAULT_BUDGET_MS

    #: Incremented every time the budget trips. Surfaced via diagnostics.
    scrub_overflow_count: int = 0

    def scrub(
        self, attributes: dict[str, Any] | None
    ) -> tuple[dict[str, Any] | None, ScrubberReport]:
        """Scrub ``attributes``; return a fresh dict and the per-event report."""
        start = time.perf_counter()
        applied: list[str] = []
        budget_exceeded = False

        if attributes is None:
            duration_ms = (time.perf_counter() - start) * 1000.0
            return None, self._report(applied, budget_exceeded, duration_ms)

        budget_s = self.budget_ms / 1000.0

        def _replace_with_overflow(node: Any) -> Any:
            """Recursively replace every string-leaf with the overflow sentinel.

            Used when the budget has already tripped: we still emit a
            deterministic, structurally-equivalent payload so downstream
            consumers see the overflow marker on every string slot rather
            than raw caller data.
            """
            if isinstance(node, str):
                return REDACTED_OVERFLOW
            if isinstance(node, dict):
                return {k: _replace_with_overflow(v) for k, v in node.items()}
            if isinstance(node, list):
                return [_replace_with_overflow(item) for item in node]
            return node

        def _walk(node: Any, path: str) -> Any:
            nonlocal budget_exceeded
            if (time.perf_counter() - start) >= budget_s:
                budget_exceeded = True
                return _replace_with_overflow(node)

            if isinstance(node, str):
                redacted, rule_hits = _redact_detections(node)
                for rule_id in rule_hits:
                    if rule_id not in applied:
                        applied.append(rule_id)
                return redacted

            if isinstance(node, dict):
                out: dict[str, Any] = {}
                items = list(node.items())
                for i, (key, value) in enumerate(items):
                    child_path = f"{path}.{key}" if path else str(key)
                    if self._selector_matches(child_path):
                        out[key] = self._mask_value(value)
                        self._record("selector:user-configured", applied)
                    else:
                        out[key] = _walk(value, child_path)
                    if budget_exceeded:
                        # Fill remaining keys with overflow so the structure
                        # is preserved but no un-scrubbed data leaks.
                        for j in range(i + 1, len(items)):
                            k2, v2 = items[j]
                            out[k2] = _replace_with_overflow(v2)
                        break
                return out

            if isinstance(node, list):
                out_list: list[Any] = []
                for i, item in enumerate(node):
                    out_list.append(_walk(item, f"{path}[]"))
                    if budget_exceeded:
                        for j in range(i + 1, len(node)):
                            out_list.append(_replace_with_overflow(node[j]))
                        break
                return out_list

            return node

        scrubbed = _walk(attributes, path="")

        if budget_exceeded:
            self.scrub_overflow_count += 1
            self._record(OVERFLOW_RULE_ID, applied)

        duration_ms = (time.perf_counter() - start) * 1000.0
        return scrubbed, self._report(applied, budget_exceeded, duration_ms)

    # ---- helpers -----------------------------------------------------------

    def _selector_matches(self, path: str) -> bool:
        for selector in self.mask_selectors:
            if selector == path or path.endswith("." + selector):
                return True
        return False

    @staticmethod
    def _mask_value(value: Any) -> Any:
        token = redaction_token("selector:user-configured")
        if isinstance(value, str):
            return token
        if isinstance(value, (int, float, bool)):
            return token
        if isinstance(value, list):
            return [token for _ in value]
        if isinstance(value, dict):
            return {k: token for k in value}
        return token

    @staticmethod
    def _record(rule: str, applied: list[str]) -> None:
        if rule not in applied:
            applied.append(rule)

    def _report(
        self, applied: list[str], budget_exceeded: bool, duration_ms: float
    ) -> ScrubberReport:
        return ScrubberReport(
            version=f"sdk@{self.sdk_version}",
            rulesDigest=RULES_DIGEST,
            applied=sorted(applied),
            budgetExceeded=budget_exceeded,
            durationMs=round(duration_ms, 3),
        )


__all__ = [
    "DEFAULT_BUDGET_MS",
    "OVERFLOW_RULE_ID",
    "REDACTED_OVERFLOW",
    "REDACTED_PII",
    "RULES_DIGEST",
    "RULES_MATRIX",
    "Scrubber",
    "compute_rules_digest",
    "redaction_token",
    "rules_digest",
]
