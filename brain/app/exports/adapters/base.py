"""Export Adapter interface (10번 §7).

Adapter = how a PortableSkill graph is rendered into ONE (target, format).
It never decides WHAT the Target supports (that is the Target Profile) and
never packages bytes (ZIP/Download is BFF's job) — it only returns UTF-8 text
files, in a deterministic order, with normalized newlines. Provider-specific
formatting and validation rules live in the Adapter of that Provider.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, ClassVar, Optional

from app.exports.compiler import CompiledGraph
from app.exports.models import EffectiveOptions, ExportFile, ExportTargetProfile


@dataclass(frozen=True)
class RenderInput:
    graph: CompiledGraph
    effective: EffectiveOptions
    profile: ExportTargetProfile
    # The original SkillSpec of the root Skill (Raw SkillSpec needs it regardless of includeSourceSpec).
    root_spec: dict[str, Any]


class ExportAdapter(ABC):
    target_id: ClassVar[str]
    format_id: ClassVar[str]
    # True -> the pipeline appends `manifest.json` (built from the other files' hashes).
    embeds_manifest: ClassVar[bool] = False

    @abstractmethod
    def render(self, data: RenderInput) -> list[ExportFile]:
        """Every file EXCEPT manifest.json."""

    @abstractmethod
    def filename(self, graph: CompiledGraph) -> str:
        """Suggested download file name (ASCII-safe)."""

    def package_root(self, graph: CompiledGraph) -> Optional[str]:
        """ASCII-safe folder name inside a ZIP; None for single-file formats."""
        return None

    def notes(self, graph: CompiledGraph) -> list[tuple[str, str]]:
        """(code, message) warnings this Adapter's rendering decisions imply (e.g. truncated description)."""
        return []

    def validate(self, files: list[ExportFile]) -> None:
        """Target-specific validation of the FINAL file set (incl. manifest.json). Raise on violation."""
