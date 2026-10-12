"""Export Adapter registry, keyed by (target, format).

A new Target = register a Target Profile (../profiles) + register an Adapter
here. Looking up a supported target/format that has no Adapter raises
EXPORT_TARGET_ADAPTER_UNAVAILABLE (distinct from an unsupported target).
"""
from __future__ import annotations

from app.exports.canonical import export_error

from .base import ExportAdapter, RenderInput  # noqa: F401
from .claude_skill import ClaudeSkillAdapter
from .generic_markdown import GenericMarkdownAdapter
from .portable_package import PortablePackageAdapter
from .raw_spec import RawSpecAdapter

_ADAPTERS: dict[tuple[str, str], ExportAdapter] = {}


def register_adapter(adapter: ExportAdapter) -> None:
    _ADAPTERS[(adapter.target_id, adapter.format_id)] = adapter


def unregister_adapter(target_id: str, format_id: str) -> None:
    _ADAPTERS.pop((target_id, format_id), None)


def has_adapter(target_id: str, format_id: str) -> bool:
    return (target_id, format_id) in _ADAPTERS


def get_adapter(target_id: str, format_id: str) -> ExportAdapter:
    adapter = _ADAPTERS.get((target_id, format_id))
    if adapter is None:
        raise export_error(
            "EXPORT_TARGET_ADAPTER_UNAVAILABLE",
            f"No Export Adapter is registered for target '{target_id}' format '{format_id}'",
            target=target_id,
            format=format_id,
        )
    return adapter


for _adapter in (PortablePackageAdapter(), GenericMarkdownAdapter(), RawSpecAdapter(), ClaudeSkillAdapter()):
    register_adapter(_adapter)
