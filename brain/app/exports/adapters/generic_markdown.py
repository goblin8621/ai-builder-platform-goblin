"""Generic Markdown (10번 §6): one self-contained `.md` usable as an LLM
prompt/context or plain documentation. It cannot configure Tool/MCP/RAG
runtimes, and it cannot carry Knowledge documents — Compatibility Analyzer
reports exactly that (the format's Target Profile says so).

Child Skills, when requested, are appended as full sections of the same file.
"""
from __future__ import annotations

from app.exports.canonical import ensure_trailing_newline
from app.exports.models import ExportFile

from .base import ExportAdapter, RenderInput
from .markdown import render_skill_markdown


class GenericMarkdownAdapter(ExportAdapter):
    target_id = "generic"
    format_id = "markdown"

    def render(self, data: RenderInput) -> list[ExportFile]:
        graph, effective = data.graph, data.effective
        locations = {alias: "see the section below" for alias in graph.children}
        parts = [render_skill_markdown(graph.root, graph, effective, dependency_location=locations)]
        if effective.includeChildSkills:
            for alias, child in graph.children.items():
                parts.append(
                    f"---\n\n## Dependency `{alias}`\n\n"
                    + render_skill_markdown(child, graph, effective, heading=3, dependency_location=locations)
                )
        return [ExportFile(path=self.filename(graph), content=ensure_trailing_newline("\n".join(parts)))]

    def filename(self, graph) -> str:  # type: ignore[no-untyped-def]
        return f"{graph.archive_root}-v{graph.root.version}.md"
