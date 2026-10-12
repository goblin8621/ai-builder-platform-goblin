"""Export Sanitizer (10번 §16, Phase 9 확정 결정 #3).

Policy (Phase 9 확정 결정 #7): block on the PRESENCE OF A CREDENTIAL VALUE, never
on a path name. Hard-blocked: vendor API keys, Bearer token values,
Authorization / API-key header values, JWTs, private keys, password / secret /
client_secret / access_token / api_key assignments with a real-looking value,
URL userinfo (`user:password@host`) and credential query parameters
(`?access_token=<value>`). Allowed: documentation URLs that merely NAME an auth
endpoint (`https://example.com/oauth/token`, `/authorize`, ...), placeholders
(`<token>`, `${SECRET}`, `YOUR_KEY`, `****`) and prose about credentials.

Detection BLOCKS the Export — it never redacts-and-continues (a redacted
Skill could silently change meaning, or leak part of a secret, or be mistaken
for a complete export). Findings carry ONLY `path` + `category`; the secret
value itself is never put in a finding, an error message or a log line.

The scan is mandatory for EVERY Export format (Portable Package, Generic
Markdown, Raw SkillSpec, Target Optimized) — it runs on the inputs, and again
on the generated files as a safety net (see pipeline.py).

03번 forbids secrets in a SkillSpec but nothing in the schema/validator
enforces it (only the Builder prompt asks the LLM not to), so this layer is
the real enforcement point at Export time.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlsplit


@dataclass(frozen=True)
class Finding:
    path: str
    category: str


_VENDOR_KEY_PATTERNS = [
    re.compile(p)
    for p in (
        r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}",
        r"\bAKIA[0-9A-Z]{16}\b",
        r"\bgh[pousr]_[A-Za-z0-9]{30,}",
        r"\bgithub_pat_[A-Za-z0-9_]{30,}",
        r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
        r"\bAIza[0-9A-Za-z_-]{30,}",
        r"\bglpat-[A-Za-z0-9_-]{20,}",
    )
]
_PRIVATE_KEY = re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----")
_JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")
_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}")
_AUTH_HEADER = re.compile(
    r"(?i)\b(?:authorization|x-api-key|proxy-authorization)\s*[:=]\s*"
    r"(?:(?:basic|bearer|token)\s+)?[A-Za-z0-9+/=._~-]{16,}"
)
_USERINFO_URL = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s/:@]+:([^\s/@]+)@")
_URL = re.compile(r"https?://[^\s\"'<>)\]]+", re.IGNORECASE)
_SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|"
    r"client[_-]?secret|private[_-]?key)\b[\"']?\s*[:=]\s*[\"']?([^\s\"',;]{8,})"
)

_SECRET_QUERY_KEYS = {
    "access_token", "refresh_token", "id_token", "api_key", "apikey", "token",
    "client_secret", "password", "passwd", "secret",
}
_SECRET_FIELD_NAMES = {
    "apikey", "secret", "clientsecret", "accesstoken", "refreshtoken", "authtoken", "bearertoken",
    "token", "password", "passwd", "credential", "credentials", "authorization", "privatekey", "secretkey",
}
_PLACEHOLDER_PREFIXES = (
    "your", "example", "sample", "dummy", "placeholder", "changeme", "todo", "none", "null", "redacted", "xxx",
)


def _is_placeholder(value: str) -> bool:
    lowered = value.strip().lower()
    if any(ch in lowered for ch in ("<", ">", "{{", "${")):
        return True
    if lowered.startswith(_PLACEHOLDER_PREFIXES):
        return True
    if re.fullmatch(r"[*xX•.\-_#]+", value.strip()) is not None:
        return True
    # Template variables: {token}, [token], <token>
    return re.fullmatch(r"[{\[<].*[}\]>]", value.strip()) is not None


def _escape_pointer(token: str) -> str:
    return token.replace("~", "~0").replace("/", "~1")


def _scan_urls(text: str) -> set[str]:
    """Only credential VALUES in a URL are findings: userinfo (`user:pass@`) and
    credential query parameters with a non-placeholder value. The path
    (`/oauth/token`, ...) is never a finding."""
    categories: set[str] = set()
    for match in _URL.finditer(text):
        try:
            parts = urlsplit(match.group(0))
        except ValueError:
            continue
        if parts.username and parts.password and not _is_placeholder(parts.password):
            categories.add("credential_url")
        for key, value in parse_qsl(parts.query, keep_blank_values=False):
            if key.lower() in _SECRET_QUERY_KEYS and value and not _is_placeholder(value):
                categories.add("credential_url")
    return categories


def detect_categories(text: str) -> set[str]:
    """Categories of secret/sensitive patterns present in `text` (never values)."""
    categories: set[str] = set()
    if any(p.search(text) for p in _VENDOR_KEY_PATTERNS):
        categories.add("api_key")
    if _PRIVATE_KEY.search(text):
        categories.add("private_key")
    if _JWT.search(text):
        categories.add("jwt")
    if _BEARER.search(text):
        categories.add("bearer_token")
    if _AUTH_HEADER.search(text):
        categories.add("auth_header")
    if any(not _is_placeholder(m.group(1)) for m in _USERINFO_URL.finditer(text)):
        categories.add("credential_url")
    for match in _SECRET_ASSIGNMENT.finditer(text):
        value = match.group(1)
        looks_real = any(ch.isdigit() for ch in value) or not value.isalpha() or len(value) >= 20
        if looks_real and not _is_placeholder(value):
            categories.add("secret_assignment")
            break
    categories |= _scan_urls(text)
    return categories


def _is_secret_field(key: str, value: Any) -> bool:
    if not isinstance(value, str):
        return False
    normalized = re.sub(r"[_\-\s]", "", key.lower())
    if normalized not in _SECRET_FIELD_NAMES:
        return False
    return len(value) >= 8 and not re.search(r"\s", value) and not _is_placeholder(value)


def scan_text(text: str, path: str) -> list[Finding]:
    return [Finding(path=path, category=c) for c in sorted(detect_categories(text))]


def scan_value(value: Any, path: str = "") -> list[Finding]:
    """Recursively scans a JSON-like structure. `path` is a JSON-Pointer-style
    location (`/instructions/rules/0`), optionally prefixed by a label such as
    `child:parser:` so a finding points at exactly where to fix it."""
    findings: list[Finding] = []

    def walk(node: Any, current: str) -> None:
        if isinstance(node, dict):
            for key in sorted(node, key=str):
                child_path = f"{current}/{_escape_pointer(str(key))}"
                child = node[key]
                if _is_secret_field(str(key), child):
                    findings.append(Finding(path=child_path, category="secret_field"))
                walk(child, child_path)
        elif isinstance(node, list):
            for index, item in enumerate(node):
                walk(item, f"{current}/{index}")
        elif isinstance(node, str):
            findings.extend(scan_text(node, current or "/"))

    walk(value, path)
    seen: set[tuple[str, str]] = set()
    unique: list[Finding] = []
    for finding in findings:
        key = (finding.path, finding.category)
        if key not in seen:
            seen.add(key)
            unique.append(finding)
    return unique
