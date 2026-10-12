"""Deterministic-output helpers shared by every Export stage (Phase 9 결정 #6/#9).

Deterministic Export = same Skill Version + resolved Dependency Versions +
Knowledge Content + Export Options + Target/Profile ⇒ the SAME bytes. So
nothing here may depend on dict insertion order, locale, wall-clock time or
random values.
"""
from __future__ import annotations

import hashlib
import json
import re
import unicodedata
from typing import Any

from app.common.errors import ApiErrorCode, AppError


def export_error(code: str, message: str, status: ApiErrorCode = "validation_error", **details: Any) -> AppError:
    """All Export failures reuse the existing ApiErrorCode union (no new HTTP
    error codes); the machine-readable reason is `details.code`."""
    return AppError(status, message, {"code": code, **details})


def canonical_json(value: Any) -> str:
    """Compact, key-sorted JSON used ONLY for hashing."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def pretty_json(value: Any) -> str:
    """Human-readable, key-sorted file output, always ends with a newline."""
    return json.dumps(value, sort_keys=True, ensure_ascii=False, indent=2) + "\n"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def normalize_newlines(text: str) -> str:
    """CRLF / CR -> LF. Does NOT add or remove a trailing newline (document
    content must keep its meaning)."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def ensure_trailing_newline(text: str) -> str:
    text = normalize_newlines(text)
    return text if text.endswith("\n") else text + "\n"


def slugify(value: str, max_length: int = 60) -> str:
    """Unicode-aware slug (Hangul etc. preserved). NFC-normalized so macOS
    (NFD) and other sources yield the same slug."""
    text = unicodedata.normalize("NFC", value or "").strip().lower()
    text = re.sub(r"[^\w]+", "-", text, flags=re.UNICODE).replace("_", "-")
    text = re.sub(r"-{2,}", "-", text).strip("-")
    return text[:max_length].strip("-")


def unique_name(base: str, used: set[str]) -> str:
    candidate = base
    counter = 2
    while candidate in used:
        candidate = f"{base}-{counter}"
        counter += 1
    used.add(candidate)
    return candidate
