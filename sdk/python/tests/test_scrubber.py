"""Tests for ``resolvetrace.scrubber``."""

from __future__ import annotations

from resolvetrace.scrubber import (
    REDACTED_OVERFLOW,
    REDACTED_PII,
    Scrubber,
    _luhn_valid,
    rules_digest,
)


def test_rules_digest_is_stable_sha256() -> None:
    assert rules_digest().startswith("sha256:")
    assert len(rules_digest()) == len("sha256:") + 64


def test_email_is_redacted() -> None:
    s = Scrubber(sdk_version="0.1.0")
    out, report = s.scrub({"message": "contact jane@example.com please"})
    assert out is not None
    assert "jane@example.com" not in out["message"]
    assert "regex:email" in report.applied


def test_ssn_us_redacted() -> None:
    s = Scrubber(sdk_version="0.1.0")
    out, report = s.scrub({"note": "SSN 123-45-6789"})
    assert "123-45-6789" not in out["note"]  # type: ignore[index]
    assert "regex:ssn_us" in report.applied


def test_sin_ca_requires_luhn() -> None:
    s = Scrubber(sdk_version="0.1.0")
    # This SIN passes the SIN-specific Luhn check: 046 454 286.
    out_real, report_real = s.scrub({"sin": "046 454 286"})
    assert "046" not in out_real["sin"]  # type: ignore[index]
    assert "regex:sin_ca" in report_real.applied

    # A random 9-digit string that fails Luhn must NOT be redacted.
    s2 = Scrubber(sdk_version="0.1.0")
    out_fake, report_fake = s2.scrub({"random": "111 222 333"})
    assert out_fake["random"] == "111 222 333"  # type: ignore[index]
    assert "regex:sin_ca" not in report_fake.applied


def test_phone_e164_requires_country_code() -> None:
    s = Scrubber(sdk_version="0.1.0")
    out, report = s.scrub({"phone": "+14165551234"})
    assert "+14165551234" not in out["phone"]  # type: ignore[index]
    assert "regex:phone_e164" in report.applied

    # A bare 10-digit number (no country code) is not a phone match.
    s2 = Scrubber(sdk_version="0.1.0")
    out_nocc, report_nocc = s2.scrub({"phone": "4165551234"})
    assert out_nocc["phone"] == "4165551234"  # type: ignore[index]
    assert "regex:phone_e164" not in report_nocc.applied


def test_credit_card_luhn_validated() -> None:
    s = Scrubber(sdk_version="0.1.0")
    # Test PAN that passes Luhn.
    out, report = s.scrub({"card": "4111 1111 1111 1111"})
    assert "4111" not in out["card"]  # type: ignore[index]
    assert "regex:credit_card" in report.applied

    # Random 16 digits that fail Luhn.
    s2 = Scrubber(sdk_version="0.1.0")
    out_fake, report_fake = s2.scrub({"card": "1234 5678 9012 3456"})
    assert out_fake["card"] == "1234 5678 9012 3456"  # type: ignore[index]
    assert "regex:credit_card" not in report_fake.applied


def test_mask_selectors_applied_to_top_level_key() -> None:
    s = Scrubber(sdk_version="0.1.0", mask_selectors=("ssn",))
    out, report = s.scrub({"ssn": "some-free-form-text"})
    assert out["ssn"] == REDACTED_PII.format(rule="mask")  # type: ignore[index]
    assert "attr:mask_selectors" in report.applied


def test_scrub_report_version_matches_sdk() -> None:
    s = Scrubber(sdk_version="0.1.0")
    _, report = s.scrub({"x": "y"})
    assert report.version == "sdk@0.1.0"
    assert report.rules_digest == rules_digest()
    assert report.budget_exceeded is False


def test_budget_exceeded_sets_overflow_marker() -> None:
    """When scrub exceeds the budget the overflow path triggers."""
    s = Scrubber(sdk_version="0.1.0", budget_ms=0.0)  # guaranteed overflow
    out, report = s.scrub({"a": "x", "b": "y"})
    assert report.budget_exceeded is True
    # Every string value should be replaced with the overflow marker.
    values = list(out.values())  # type: ignore[arg-type]
    assert all(v == REDACTED_OVERFLOW for v in values)
    assert "overflow_fallback" in report.applied
    assert s.scrub_overflow_count == 1


def test_none_attributes_passes_through() -> None:
    s = Scrubber(sdk_version="0.1.0")
    out, report = s.scrub(None)
    assert out is None
    assert report.applied == []
    assert report.budget_exceeded is False


def test_luhn_helper() -> None:
    assert _luhn_valid("4111111111111111") is True
    assert _luhn_valid("1234567890123456") is False
