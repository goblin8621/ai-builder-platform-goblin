"""Portable Skill Package (10번 §5) — the generic exchange format.

    skill-<id8>/                 (ASCII-safe root; display name lives in manifest.json)
    ├─ SKILL.md                  human/LLM readable description (no provider frontmatter)
    ├─ skill.json                PortableSkill (+ source/sourceSpec iff includeSourceSpec)
    ├─ manifest.json             requirements + locked dependency snapshot + file hashes
    ├─ references/document-<id8>.<ext>   Knowledge documents (only when Include Documents)
    └─ children/<slug>-<id8>/{SKILL.md,skill.json}   (only when includeChildSkills)

Every entry path is ASCII-safe (see ../archive.py). `scripts/` and `assets/`
from 10번 §5 are not created: a Skill currently owns no script or asset, and
empty directories would only add noise.
"""
from __future__ import annotations

from typing import Optional

from app.exports.canonical import pretty_json
from app.exports.models import ExportFile, dump_portable

from .base import ExportAdapter, RenderInput
from .markdown import render_skill_markdown

MANIFEST_PATH = "manifest.json"


class PortablePackageAdapter(ExportAdapter):
    target_id = "generic"
    format_id = "portable-package"
    embeds_manifest = True

    def render(self, data: RenderInput) -> list[ExportFile]:
        graph, effective = data.graph, data.effective
        included_children = dict(graph.children) if effective.includeChildSkills else {}
        included_docs = [d for d in graph.docs.values() if d.included]

        contents = sorted(
            [
                "SKILL.md",
                "skill.json",
                MANIFEST_PATH,
                *[doc.path for doc in included_docs],
                *[
                    f"{child.archive_dir}/{name}"
                    for child in included_children.values()
                    for name in ("SKILL.md", "skill.json")
                ],
            ]
        )
        locations = {alias: f"{child.archive_dir}/" for alias, child in included_children.items()}

        files: list[ExportFile] = [
            ExportFile(
                path="SKILL.md",
                content=render_skill_markdown(
                    graph.root, graph, effective, dependency_location=locations, contents=contents
                ),
            ),
            ExportFile(path="skill.json", content=pretty_json(dump_portable(graph.root.portable))),
        ]
        for child in included_children.values():
            prefix = f"{child.archive_dir}/"
            files.append(
                ExportFile(
                    path=prefix + "SKILL.md",
                    content=render_skill_markdown(child, graph, effective, dependency_location=locations),
                )
            )
            files.append(ExportFile(path=prefix + "skill.json", content=pretty_json(dump_portable(child.portable))))
        for doc in included_docs:
            files.append(ExportFile(path=doc.path, content=doc.content or ""))
        return files

    def filename(self, graph) -> str:  # type: ignore[no-untyped-def]
        return f"{graph.archive_root}-v{graph.root.version}.zip"

    def package_root(self, graph) -> Optional[str]:  # type: ignore[no-untyped-def]
        return graph.archive_root
