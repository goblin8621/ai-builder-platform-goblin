"""Raw SkillSpec (10번 §4): the original SkillSpec JSON, for backup / transfer /
future Import. NOT a PortableSkill — it is the internal contract as stored.

It still passes through the mandatory Export Sanitizer (pipeline.py) like
every other format; being "raw" is not an exemption.
"""
from __future__ import annotations

from app.exports.canonical import pretty_json
from app.exports.models import ExportFile

from .base import ExportAdapter, RenderInput


class RawSpecAdapter(ExportAdapter):
    target_id = "generic"
    format_id = "raw-spec"

    def render(self, data: RenderInput) -> list[ExportFile]:
        return [ExportFile(path=self.filename(data.graph), content=pretty_json(data.root_spec))]

    def filename(self, graph) -> str:  # type: ignore[no-untyped-def]
        return f"{graph.archive_root}-v{graph.root.version}.skillspec.json"
