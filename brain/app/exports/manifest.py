"""Manifest builder (10번 §12, Phase 9 확정 결정 #8/#9).

The Manifest holds STABLE metadata only — Skill Version, the locked
Dependency snapshot (resolved Child Version + content hash), Knowledge
document hashes, format version, Target/Profile, effective Export Options,
and the hash of every file in the package. It never holds a timestamp or a
random id: the actual export time is API-response/audit-log metadata, not part
of the Portable Artifact.

Reproducibility contract (precisely): same Parent Version + same resolved
Child Versions + same Knowledge Content + same Export Options + same
Target/Profile ⇒ byte-identical output. It is NOT "same Parent Version ⇒ same
files": a Child's `currentVersion` may have moved between two exports, and
that is exactly what the dependency snapshot records.
"""
from __future__ import annotations

from typing import Optional

from .canonical import sha256_text
from .compiler import CompiledGraph
from .models import (
    EffectiveOptions,
    ExportFile,
    ExportTargetProfile,
    Manifest,
    ManifestDependency,
    ManifestExport,
    ManifestFile,
    ManifestKnowledgeDocument,
    ManifestRequirements,
    ManifestSkill,
)


def aggregate_requirements(graph: CompiledGraph) -> ManifestRequirements:
    """Union over the root Skill and every locked Child — the Package needs all of them to run."""
    portables = [s.portable for s in graph.all_skills()]
    return ManifestRequirements(
        llm=any(p.runtimeRequirements.requiresLLM for p in portables),
        tools=sorted({t.id for p in portables for t in p.requiredTools}),
        mcp=any(p.runtimeRequirements.requiresMcp for p in portables),
        knowledge=any(p.runtimeRequirements.requiresKnowledge for p in portables),
        codeExecution=any(p.runtimeRequirements.requiresCodeExecution for p in portables),
        approval=any(p.runtimeRequirements.requiresApproval for p in portables),
        nestedSkill=any(p.runtimeRequirements.requiresNestedSkill for p in portables),
    )


def build_manifest(
    graph: CompiledGraph,
    *,
    profile: ExportTargetProfile,
    effective: EffectiveOptions,
    files: list[ExportFile],
    package_root: Optional[str],
) -> Manifest:
    """`package_root` is the ZIP root folder (None for single-file formats). Every
    path recorded here is ASCII-safe; display names are kept only as metadata."""
    dependencies: dict[str, ManifestDependency] = {}
    for alias, child in graph.children.items():
        included = effective.includeChildSkills
        dependency = ManifestDependency(
            displayName=child.name,
            version=child.version,
            contentHash=child.content_hash,
            included=included,
        )
        if included and package_root is not None and child.archive_dir:
            dependency.path = child.archive_dir + "/"
        dependencies[alias] = dependency

    knowledge: dict[str, ManifestKnowledgeDocument] = {}
    for doc in graph.docs.values():
        entry = ManifestKnowledgeDocument(fileName=doc.file_name, mimeType=doc.mime_type, included=doc.included)
        if doc.included:
            entry.path = doc.path
            entry.contentHash = doc.content_hash
        knowledge[doc.alias] = entry

    return Manifest(
        skill=ManifestSkill(
            displayName=graph.root.name,
            archivePath=package_root,
            version=graph.root.version,
            skillType=graph.root.portable.skillType,
            contentHash=graph.root.content_hash,
        ),
        export=ManifestExport(target=profile.target, format=profile.format, options=effective),
        requirements=aggregate_requirements(graph),
        dependencies=dependencies,
        knowledge=knowledge,
        files=[
            ManifestFile(path=f.path, sha256=sha256_text(f.content), bytes=len(f.content.encode("utf-8")))
            for f in sorted(files, key=lambda f: f.path)
        ],
    )
