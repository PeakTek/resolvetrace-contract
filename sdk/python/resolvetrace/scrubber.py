"""SDK-side deterministic scrubber (Stage-1).

Applies a fixed set of PII regex rules and optional field-path masking to
event attributes before transport. Stage-1 is intentionally small: heavier,
tenant-configurable rules run server-side in Stage-2.

Per-event budget: ``4 ms`` wall clock. When the budget trips, the scrubber
stops mid-event and replaces any un-processed string values with
``[REDACTED_OVERFLOW]``, sets ``budget_exceeded=true`` on the report, and
tracks the trip in diagnostics. Callers must never dispatch an envelope
whose scrub budget tripped without the overflow marker applied.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field
from typing import Any

from .models import ScrubberReport

#: Per-event scrub budget in seconds. ADR-0001 envelope ceiling; customer
#: hooks may tighten but not loosen this.
DEFAULT_BUDGET_MS = 4.0

#: Sentinel inserted in place of an unprocessed string when the budget
#: trips. The same sentinel text is used by the TypeScript SDK so downstream
#: consumers can detect overflow events with one string compare.
REDACTED_OVERFLOW = "[REDACTED_OVERFLOW]"

#: Sentinel inserted in place of a field that matched a PII rule.
REDACTED_PII = "[REDACTED:{rule}]"


# ---------------------------------------------------------------------------
# Detector definitions
# ---------------------------------------------------------------------------


_EMAIL_REGEX = re.compile(
    r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b"
)

# US SSN: 3-2-4 digit groups, strict hyphen format.
_SSN_REGEX = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")

# Canadian SIN candidate: 9 digits with optional space/hyphen separators.
# Luhn check applied at match time so unrelated 9-digit strings don't match.
_SIN_CANDIDATE_REGEX = re.compile(r"\b(\d{3})[- ]?(\d{3})[- ]?(\d{3})\b")

# E.164 international phone: leading ``+``, 8-15 digits.
_E164_REGEX = re.compile(r"(?<!\d)\+\d{8,15}(?!\d)")

# Credit-card candidate: 13-19 digits with optional space/hyphen separators.
_CC_CANDIDATE_REGEX = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")


def _luhn_valid(digits: str) -> bool:
    """Return ``True`` when ``digits`` (0-9 only) satisfies the Luhn checksum."""
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = ord(ch) - 48
        if d < 0 or d > 9:
            return False
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


@dataclass
class _DetectionResult:
    rules: list[str] = field(default_factory=list)


def _redact_detections(value: str) -> tuple[str, list[str]]:
    """Apply every Stage-1 PII rule to ``value``.

    Returns the possibly-redacted value and the ordered list of rule ids
    that fired. Each rule runs independently; callers must accumulate the
    ``applied`` list across rules.
    """
    applied: list[str] = []

    def _redact(rule_id: str, match: re.Match[str]) -> str:
        if rule_id not in applied:
            applied.append(rule_id)
        return REDACTED_PII.format(rule=rule_id.split(":", 1)[-1])

    # Email
    value, count = _EMAIL_REGEX.subn(lambda m: _redact("regex:email", m), value)
    if count and "regex:email" not in applied:  # pragma: no cover - defensive
        applied.append("regex:email")

    # US SSN
    value = _SSN_REGEX.sub(lambda m: _redact("regex:ssn_us", m), value)

    # Canadian SIN (Luhn-validated)
    def _sin_sub(m: re.Match[str]) -> str:
        digits = "".join(m.groups())
        if _luhn_valid(digits):
            if "regex:sin_ca" not in applied:
                applied.append("regex:sin_ca")
            return REDACTED_PII.format(rule="sin_ca")
        return m.group(0)

    value = _SIN_CANDIDATE_REGEX.sub(_sin_sub, value)

    # E.164 phone
    value = _E164_REGEX.sub(lambda m: _redact("regex:phone_e164", m), value)

    # Credit card (Luhn-validated)
    def _cc_sub(m: re.Match[str]) -> str:
        digits = re.sub(r"[ -]", "", m.group(0))
        if 13 <= len(digits) <= 19 and _luhn_valid(digits):
            if "regex:credit_card" not in applied:
                applied.append("regex:credit_card")
            return REDACTED_PII.format(rule="credit_card")
        return m.group(0)

    value = _CC_CANDIDATE_REGEX.sub(_cc_sub, value)

    return value, applied


# ---------------------------------------------------------------------------
# Rules digest
# ---------------------------------------------------------------------------


#: Human-readable ruleset identifier. Bumped when rules change. Hashed into
#: ``rules_digest`` so Stage-2 can decide whether to skip already-applied
#: deterministic rules.
_RULESET_IDENTIFIER = (
    "resolvetrace-stage1-v1:"
    "email;ssn_us;sin_ca_luhn;phone_e164;credit_card_luhn;mask_selectors"
)


def rules_digest() -> str:
    """Return the ``sha256:<hex>`` identifier of the Stage-1 ruleset."""
    digest = hashlib.sha256(_RULESET_IDENTIFIER.encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


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
    budget_ms:
        Per-event wall-clock budget. Defaults to the ADR-0001 ceiling.
    """

    sdk_version: str
    mask_selectors: tuple[str, ...] = ()
    budget_ms: float = DEFAULT_BUDGET_MS

    #: Incremented every time the budget trips. Surfaced via diagnostics.
    scrub_overflow_count: int = 0

    def scrub(self, attributes: dict[str, Any] | None) -> tuple[
        dict[str, Any] | None, ScrubberReport
    ]:
        """Scrub ``attributes`` in place-ish; return a fresh dict + report."""
        start = time.perf_counter()
        applied: list[str] = []
        budget_exceeded = False

        if attributes is None:
            duration_ms = (time.perf_counter() - start) * 1000.0
            return None, self._report(applied, budget_exceeded, duration_ms)

        budget_s = self.budget_ms / 1000.0

        # Apply mask_selectors first — cheapest and most specific.
        masked = self._apply_mask_selectors(attributes, applied)

        # Then PII regex detection on every string we can visit within budget.
        def _walk(node: Any, path: str) -> Any:
            nonlocal budget_exceeded
            if (time.perf_counter() - start) >= budget_s:
                budget_exceeded = True
                return REDACTED_OVERFLOW if isinstance(node, str) else node

            if isinstance(node, str):
                redacted, rule_hits = _redact_detections(node)
                for rule_id in rule_hits:
                    if rule_id not in applied:
                        applied.append(rule_id)
                return redacted

            if isinstance(node, dict):
                out: dict[str, Any] = {}
                for key, value in node.items():
                    child_path = f"{path}.{key}" if path else str(key)
                    if self._selector_matches(child_path):
                        out[key] = self._mask_value(value)
                        self._record("attr:mask_selectors", applied)
                    else:
                        out[key] = _walk(value, child_path)
                return out

            if isinstance(node, list):
                return [_walk(item, f"{path}[]") for item in node]

            return node

        scrubbed = _walk(masked, path="")

        if budget_exceeded:
            self.scrub_overflow_count += 1
            self._record("overflow_fallback", applied)

        duration_ms = (time.perf_counter() - start) * 1000.0
        return scrubbed, self._report(applied, budget_exceeded, duration_ms)

    # ---- helpers -----------------------------------------------------------

    def _apply_mask_selectors(
        self, attributes: dict[str, Any], applied: list[str]
    ) -> dict[str, Any]:
        if not self.mask_selectors:
            return dict(attributes)
        out: dict[str, Any] = {}
        for key, value in attributes.items():
            if self._selector_matches(str(key)):
                out[key] = self._mask_value(value)
                self._record("attr:mask_selectors", applied)
            else:
                out[key] = value
        return out

    def _selector_matches(self, path: str) -> bool:
        for selector in self.mask_selectors:
            if selector == path or path.endswith("." + selector):
                return True
        return False

    @staticmethod
    def _mask_value(value: Any) -> Any:
        if isinstance(value, str):
            return REDACTED_PII.format(rule="mask")
        if isinstance(value, (int, float, bool)):
            return REDACTED_PII.format(rule="mask")
        if isinstance(value, list):
            return [REDACTED_PII.format(rule="mask") for _ in value]
        if isinstance(value, dict):
            return {k: REDACTED_PII.format(rule="mask") for k in value}
        return REDACTED_PII.format(rule="mask")

    @staticmethod
    def _record(rule: str, applied: list[str]) -> None:
        if rule not in applied:
            applied.append(rule)

    def _report(
        self, applied: list[str], budget_exceeded: bool, duration_ms: float
    ) -> ScrubberReport:
        return ScrubberReport(
            version=f"sdk@{self.sdk_version}",
            rulesDigest=rules_digest(),
            applied=applied,
            budgetExceeded=budget_exceeded,
            durationMs=round(duration_ms, 3),
        )


__all__ = [
    "DEFAULT_BUDGET_MS",
    "REDACTED_OVERFLOW",
    "REDACTED_PII",
    "Scrubber",
    "rules_digest",
]
