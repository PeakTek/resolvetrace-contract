"""Tests for ``resolvetrace.scrubber``."""

from __future__ import annotations

from resolvetrace.scrubber import (
    OVERFLOW_RULE_ID,
    REDACTED_OVERFLOW,
    RULES_DIGEST,
    Scrubber,
    _luhn_valid,
    redaction_token,
    rules_digest,
)


def test_rules_digest_is_stable_sha256() -> None:
    assert rules_digest().startswith("sha256:")
    assert len(rules_digest()) == len("sha256:") + 64
    assert RULES_DIGEST == rules_digest()


def test_redaction_token_format() -> None:
    assert redaction_token("regex:email") == "[REDACTED:regex:email]"
    assert redaction_token("selector:user-configured") == "[REDACTED:selector:user-configured]"


def test_email_is_redacted() -> None:
    s = Scrubber(sdk_version="0.1.0")
    out, report = s.scrub({"message": "contact jane@example.com please"})
    assert out is not None
    assert "jane@example.com" not in out["message"]
    assert "regex:email" in report.applied
    assert "[REDACTED:regex:email]" in out["message"]


def test_ssn_us_redacted() -> None:
    s = Scrubber(sdk_version="0.1.0")
    out, report = s.scrub({"note": "SSN 123-45-6789"})
    assert "123-45-6789" not in out["note"]  # type: ignore[index]
    assert "regex:ssn-us" in report.applied


def test_sin_ca_requires_luhn() -> None:
    s = Scrubber(sdk_version="0.1.0")
    # This SIN passes the SIN-specific Luhn check: 046 454 286.
    out_real, report_real = s.scrub({"sin": "046 454 286"})
    assert "046" not in out_real["sin"]  # type: ignore[index]
    assert "regex:sin-ca" in report_real.applied

    # A random 9-digit string that fails Luhn must NOT be redacted.
    s2 = Scrubber(sdk_version="0.1.0")
    out_fake, report_fake = s2.scrub({"random": "111 222 333"})
    assert out_fake["random"] == "111 222 333"  # type: ignore[index]
    assert "regex:sin-ca" not in report_fake.applied


def test_phone_e164_requires_country_code() -> None:
    s = Scrubber(sdk_version="0.1.0")
    out, report = s.scrub({"phone": "+14165551234"})
    assert "+14165551234" not in out["phone"]  # type: ignore[index]
    assert "regex:phone-e164" in report.applied

    # A bare 10-digit number (no country code) is not a phone match.
    s2 = Scrubber(sdk_version="0.1.0")
    out_nocc, report_nocc = s2.scrub({"phone": "4165551234"})
    assert out_nocc["phone"] == "4165551234"  # type: ignore[index]
    assert "regex:phone-e164" not in report_nocc.applied


def test_credit_card_luhn_validated() -> None:
    s = Scrubber(sdk_version="0.1.0")
    # Test PAN that passes Luhn.
    out, report = s.scrub({"card": "4111 1111 1111 1111"})
    assert "4111" not in out["card"]  # type: ignore[index]
    assert "regex:creditcard" in report.applied

    # Random 16 digits that fail Luhn.
    s2 = Scrubber(sdk_version="0.1.0")
    out_fake, report_fake = s2.scrub({"card": "1234 5678 9012 3456"})
    assert out_fake["card"] == "1234 5678 9012 3456"  # type: ignore[index]
    assert "regex:creditcard" not in report_fake.applied


def test_mask_selectors_applied_to_top_level_key() -> None:
    s = Scrubber(sdk_version="0.1.0", mask_selectors=("ssn",))
    out, report = s.scrub({"ssn": "some-free-form-text"})
    # The selector:user-configured rule replaces the value with its
    # rule-specific redaction token.
    assert out["ssn"] == "[REDACTED:selector:user-configured]"  # type: ignore[index]
    assert "selector:user-configured" in report.applied


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
    assert OVERFLOW_RULE_ID in report.applied
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


def test_applied_list_is_sorted() -> None:
    """``applied`` must be sorted so TS and Python produce identical JSON output."""
    s = Scrubber(sdk_version="0.1.0")
    _, report = s.scrub({
        "m": (
            "Reach me at combo@example.com or +15551230000; "
            "my card 4242424242424242 is on file."
        ),
    })
    # Three rules fire: email, phone-e164, creditcard. After sort:
    assert report.applied == ["regex:creditcard", "regex:email", "regex:phone-e164"]


def test_rules_digest_matches_committed_constant() -> None:
    """Digest-parity anchor: our computed digest must match the file constant."""
    import pathlib

    digest_file = (
        pathlib.Path(__file__).resolve().parents[3]
        / "schemas"
        / "scrubber-rules.digest.txt"
    )
    expected = digest_file.read_text(encoding="utf-8").strip()
    assert rules_digest() == expected


def test_matrix_in_package_matches_canonical_schema_file() -> None:
    """The copy shipped inside the Python package must byte-match the schema copy."""
    import pathlib

    schema_path = (
        pathlib.Path(__file__).resolve().parents[3]
        / "schemas"
        / "scrubber-rules.matrix.json"
    )
    pkg_path = (
        pathlib.Path(__file__).resolve().parent.parent
        / "resolvetrace"
        / "scrubber-rules.matrix.json"
    )
    assert schema_path.read_bytes() == pkg_path.read_bytes()
