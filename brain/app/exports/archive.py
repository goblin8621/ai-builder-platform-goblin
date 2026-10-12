"""ASCII-safe archive paths (Phase 9 확정 결정: ZIP 내부 파일명 B안).

The goal of a Portable package is portability across tools and platforms, so
EVERY ZIP entry path is ASCII-only, regardless of the Skill's / document's
display name (which can be Korean or anything else). Display names are kept
as metadata (manifest `displayName`/`fileName`), never as path segments.

Rules, all enforced by `is_safe_archive_path` and re-checked by BFF before
packaging:
  - ASCII letters/digits and `._-` only, each segment starting with an
    alphanumeric (so no `.`/`..`/hidden files, no empty segments)
  - `/` is the only separator; no absolute paths, no backslashes, no control
    characters
  - deterministic: derived only from (display name, stable id)
  - collision-proof: a stable id suffix + explicit uniqueness pass
"""
from __future__ import annotations

import hashlib
import os
import re
import unicodedata

from .canonical import unique_name

_SEGMENT = r"[A-Za-z0-9][A-Za-z0-9._-]*"
_SAFE_PATH = re.compile(rf"^{_SEGMENT}(?:/{_SEGMENT})*$")
MAX_PATH_LENGTH = 200


def stable_id(kind: str, raw_id: str) -> str:
    """8 hex chars derived from the entity's stable internal id. The id itself
    is never exposed (a truncated hash cannot be reversed), but the same entity
    always maps to the same name across exports and versions."""
    return hashlib.sha256(f"{kind}:{raw_id}".encode("utf-8")).hexdigest()[:8]


def ascii_slug(text: str, max_length: int = 40) -> str:
    """Lowercase ASCII slug. Non-ASCII letters (e.g. Hangul) are dropped, so a
    purely non-ASCII name yields '' — callers fall back to a generic stem."""
    folded = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode("ascii").lower()
    slug = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")
    return slug[:max_length].strip("-")


def skill_dir_name(display_name: str, skill_id: str) -> str:
    """`sales-analyzer-a31fc912`, or `skill-a31fc912` for a name with no ASCII letters."""
    return f"{ascii_slug(display_name) or 'skill'}-{stable_id('skill', skill_id)}"


def document_archive_path(file_name: str, document_id: str, used: set[str]) -> str:
    """`references/document-928ac031.md` — extension kept only if it is plain ASCII."""
    extension = os.path.splitext((file_name or "").replace("\\", "/").split("/")[-1])[1].lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,8}", extension):
        extension = ""
    base = f"document-{stable_id('document', document_id)}"
    candidate = unique_name(base, {os.path.splitext(p.split('/')[-1])[0] for p in used})
    path = f"references/{candidate}{extension}"
    used.add(path)
    return path


def is_safe_archive_path(path: str) -> bool:
    return len(path) <= MAX_PATH_LENGTH and _SAFE_PATH.fullmatch(path) is not None
