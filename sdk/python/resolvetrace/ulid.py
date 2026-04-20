"""ULID generator.

Produces 26-character Crockford base32 ULIDs matching the ``^[0-9A-HJKMNP-TV-Z]{26}$``
pattern declared in ``schemas/events.json``.

Uses the OS CSPRNG (``secrets.token_bytes``) for the 80-bit random component.
The ``random`` module's PRNG is never used here; cryptographic strength is
important because event IDs are included in logs and correlation identifiers.
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

# Crockford base32 alphabet: 32 symbols, excluding I, L, O, U to avoid
# ambiguity with 1, 1, 0, V.
_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

_TIME_LEN = 10  # 48-bit timestamp encoded as 10 base32 characters.
_RAND_LEN = 16  # 80-bit randomness encoded as 16 base32 characters.
_ULID_LEN = _TIME_LEN + _RAND_LEN  # 26 characters total.

_MAX_TIMESTAMP_MS = (1 << 48) - 1


def _encode_base32(value: int, length: int) -> str:
    """Encode an integer into ``length`` Crockford base32 characters."""
    if value < 0:
        raise ValueError("ulid: value must be non-negative")
    out = [""] * length
    for i in range(length - 1, -1, -1):
        out[i] = _CROCKFORD[value & 0x1F]
        value >>= 5
    if value != 0:
        raise ValueError("ulid: value did not fit in requested length")
    return "".join(out)


def _timestamp_ms(now: datetime | None) -> int:
    if now is None:
        ts = datetime.now(tz=timezone.utc)
    else:
        ts = now if now.tzinfo is not None else now.replace(tzinfo=timezone.utc)
    ms = int(ts.timestamp() * 1000)
    if ms < 0 or ms > _MAX_TIMESTAMP_MS:
        raise ValueError("ulid: timestamp outside 48-bit range")
    return ms


def generate_ulid(now: datetime | None = None) -> str:
    """Generate a fresh ULID string.

    Parameters
    ----------
    now:
        Optional timestamp override. Naive datetimes are assumed UTC. When
        omitted the current UTC wall clock is used. Exposing ``now`` makes the
        function easy to test without monkey-patching ``time``.

    Returns
    -------
    str
        26-character Crockford base32 ULID.
    """
    ts_ms = _timestamp_ms(now)
    # 80 random bits from the OS CSPRNG — NOT ``random`` module. ADR-0011
    # mandates cryptographically-strong randomness for event identity.
    rand_bytes = secrets.token_bytes(10)
    rand_int = int.from_bytes(rand_bytes, byteorder="big", signed=False)
    return _encode_base32(ts_ms, _TIME_LEN) + _encode_base32(rand_int, _RAND_LEN)


# Regex-friendly constants re-exported for tests.
ULID_LENGTH = _ULID_LEN
ULID_ALPHABET = _CROCKFORD
