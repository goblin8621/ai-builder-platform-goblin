"""Export Target / Format registry (10번 §7) — "what does the Target support".

A Target (e.g. `claude`, `generic`) offers one or more Formats. Each Format has
a Target Profile (capabilities) and the option support the format can honor.
NO conversion logic lives here — that is the Export Adapter's job
(../adapters). Adding a new Provider/Runtime = register a TargetDefinition here
+ an Adapter there; SkillSpec and the Skill Runtime are never touched.

Error semantics (Phase 9 확정 결정):
  EXPORT_TARGET_UNSUPPORTED          the target id is not a known/supported target
  EXPORT_FORMAT_UNSUPPORTED          known target, format it does not offer
  EXPORT_TARGET_ADAPTER_UNAVAILABLE  supported target/format, but no Adapter registered
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.exports.canonical import export_error
from app.exports.models import ExportTargetProfile, ProfileCapabilities


@dataclass(frozen=True)
class FormatDefinition:
    id: str
    display_name: str
    content_type: str
    capabilities: ProfileCapabilities
    declarative: bool = False
    target_optimized: bool = False
    embeds_knowledge: bool = False
    embeds_children: bool = False
    embeds_source_spec: bool = False


@dataclass(frozen=True)
class TargetDefinition:
    id: str
    display_name: str
    formats: tuple[FormatDefinition, ...]


_TARGETS: dict[str, TargetDefinition] = {}


def register_target(definition: TargetDefinition) -> None:
    _TARGETS[definition.id] = definition


def unregister_target(target_id: str) -> None:
    _TARGETS.pop(target_id, None)


def list_targets() -> list[TargetDefinition]:
    return list(_TARGETS.values())


def get_target(target_id: Optional[str]) -> TargetDefinition:
    definition = _TARGETS.get(target_id or "")
    if definition is None:
        raise export_error(
            "EXPORT_TARGET_UNSUPPORTED",
            f"Export target '{target_id}' is not supported",
            target=target_id,
            supported=sorted(_TARGETS),
        )
    return definition


def get_format(target_id: Optional[str], format_id: Optional[str]) -> FormatDefinition:
    target = get_target(target_id)
    for fmt in target.formats:
        if fmt.id == format_id:
            return fmt
    raise export_error(
        "EXPORT_FORMAT_UNSUPPORTED",
        f"Target '{target.id}' does not offer format '{format_id}'",
        target=target.id,
        format=format_id,
        supported=[f.id for f in target.formats],
    )


def resolve_profile(target_id: Optional[str], format_id: Optional[str]) -> ExportTargetProfile:
    target = get_target(target_id)
    fmt = get_format(target_id, format_id)
    return ExportTargetProfile(
        target=target.id,
        format=fmt.id,
        displayName=f"{target.display_name} — {fmt.display_name}",
        declarative=fmt.declarative,
        capabilities=fmt.capabilities,
    )
