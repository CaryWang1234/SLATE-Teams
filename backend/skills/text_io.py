"""Unicode-safe text file helpers for SLATE skills.

The file tools need to preserve non-ASCII text, BOMs, and legacy encodings
without turning edits into mojibake. These helpers keep that policy in one
place instead of scattering ad-hoc ``read_text(encoding="utf-8")`` calls.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


DEFAULT_TEXT_ENCODING = "utf-8"
COMMON_TEXT_ENCODINGS = (
    "utf-8",
    "utf-8-sig",
    "gb18030",
    "gbk",
    "gb2312",
    "big5",
    "cp1252",
    "latin-1",
)

_BOMS: tuple[tuple[bytes, str], ...] = (
    (b"\xff\xfe\x00\x00", "utf-32"),
    (b"\x00\x00\xfe\xff", "utf-32"),
    (b"\xff\xfe", "utf-16"),
    (b"\xfe\xff", "utf-16"),
    (b"\xef\xbb\xbf", "utf-8-sig"),
)


@dataclass(frozen=True)
class TextRead:
    content: str
    encoding: str
    decoded_with_errors: bool = False


@dataclass(frozen=True)
class TextWrite:
    encoding: str
    encoding_changed: bool = False


def _normalize_encoding(encoding: str | None) -> str:
    return (encoding or "").strip().lower().replace("_", "-")


def _candidate_encodings(preferred: str | None = None) -> list[str]:
    candidates: list[str] = []
    preferred = _normalize_encoding(preferred)
    if preferred and preferred not in {"auto", "detect"}:
        candidates.append(preferred)
    for enc in COMMON_TEXT_ENCODINGS:
        if enc not in candidates:
            candidates.append(enc)
    return candidates


def detect_text_encoding(raw: bytes, preferred: str | None = None) -> tuple[str, bool]:
    """Return ``(encoding, decoded_with_errors)`` for text bytes."""
    preferred_norm = _normalize_encoding(preferred)
    if preferred_norm and preferred_norm not in {"auto", "detect"}:
        try:
            raw.decode(preferred_norm)
            return preferred_norm, False
        except (LookupError, UnicodeError):
            pass

    for bom, enc in _BOMS:
        if raw.startswith(bom):
            try:
                raw.decode(enc)
                return enc, False
            except UnicodeError:
                break

    for enc in _candidate_encodings(preferred):
        try:
            raw.decode(enc)
            return enc, False
        except (LookupError, UnicodeError):
            continue

    return DEFAULT_TEXT_ENCODING, True


def read_text_file(path: str | Path, encoding: str | None = None) -> TextRead:
    """Read a text file with BOM/legacy encoding detection."""
    target = Path(path)
    raw = target.read_bytes()
    enc, with_errors = detect_text_encoding(raw, encoding)
    if with_errors:
        return TextRead(raw.decode(enc, errors="replace"), enc, True)
    return TextRead(raw.decode(enc), enc, False)


def encode_text_for_write(
    content: str,
    encoding: str | None = None,
    *,
    fallback_encoding: str = DEFAULT_TEXT_ENCODING,
) -> tuple[bytes, TextWrite]:
    """Encode text, preserving ``encoding`` when possible.

    If the original encoding cannot represent new Unicode characters (for
    example emoji in a GBK file), fall back to UTF-8 so no user text is lost.
    """
    target_encoding = _normalize_encoding(encoding) or DEFAULT_TEXT_ENCODING
    try:
        return content.encode(target_encoding), TextWrite(target_encoding, False)
    except (LookupError, UnicodeEncodeError):
        fallback = _normalize_encoding(fallback_encoding) or DEFAULT_TEXT_ENCODING
        return content.encode(fallback), TextWrite(fallback, fallback != target_encoding)


def write_text_file(
    path: str | Path,
    content: str,
    encoding: str | None = None,
    *,
    fallback_encoding: str = DEFAULT_TEXT_ENCODING,
) -> TextWrite:
    """Write text with the requested encoding, falling back safely to UTF-8."""
    raw, info = encode_text_for_write(content, encoding, fallback_encoding=fallback_encoding)
    Path(path).write_bytes(raw)
    return info
