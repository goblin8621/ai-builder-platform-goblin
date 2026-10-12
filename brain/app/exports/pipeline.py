"""Export pipeline orchestration (10번 §1):

    SkillSpec -> Compiler -> PortableSkill -> Sanitizer -> Compatibility
              -> Adapter -> Manifest -> files

Mandatory-by-construction: the Sanitizer runs for EVERY target/format
(including Raw SkillSpec) before any file is returned, and once more over the
generated files as a safety net. `dryRun` (Compatibility analysis) never
returns file contents; real exports with findings raise EXPORT_SECRET_DETECTED
instead of returning anything. A dry run reports blockers with level `blocked`.
"""
from __future__ import annotations

from typing import Optional

from app.common.tools.interface import ToolDescriptor

from .adapters import get_adapter, has_adapter
from .adapters.base import ExportAdapter, RenderInput
from .adapters.portable_package import MANIFEST_PATH
from .archive import is_safe_archive_path
from .canonical import canonical_json, export_error, pretty_json, sha256_text
from .compatibility import analyze
from .compiler import CompiledGraph, compile_graph
from .manifest import build_manifest
from .models import (
    EffectiveOptions,
    ExportBlocker,
    ExportCompileRequest,
    ExportCompileResponse,
    ExportFile,
    ExportOptions,
    SanitizerFindingOut,
    dump_manifest,
)
from .profiles import get_format, resolve_profile
from .profiles.registry import FormatDefinition
from .sanitizer import Finding, scan_text, scan_value

MAX_FINDINGS = 100


def effective_options(fmt: FormatDefinition, options: ExportOptions) -> EffectiveOptions:
    """What the chosen format can actually honor. Adjustments are reported
    (compatibility warnings), never silently applied."""
    return EffectiveOptions(
        includeKnowledge=options.includeKnowledge and fmt.embeds_knowledge,
        includeChildSkills=options.includeChildSkills and fmt.embeds_children,
        includeSourceSpec=options.includeSourceSpec and fmt.embeds_source_spec,
    )


def _option_notes(
    fmt: FormatDefinition, options: ExportOptions, effective: EffectiveOptions, graph: CompiledGraph
) -> list[tuple[str, str]]:
    notes: list[tuple[str, str]] = []
    if options.includeKnowledge and not effective.includeKnowledge and graph.docs:
        notes.append(
            (
                "EXPORT_OPTION_KNOWLEDGE_REFERENCES_ONLY",
                f"Format '{fmt.display_name}' cannot embed documents; Knowledge is exported as References Only.",
            )
        )
    if options.includeKnowledge and effective.includeKnowledge and any(
        k.scope == "workspace" for s in graph.all_skills() for k in s.portable.knowledge
    ):
        notes.append(
            (
                "EXPORT_KNOWLEDGE_WORKSPACE_REFERENCES_ONLY",
                "A Skill uses workspace-wide knowledge; that scope is always References Only "
                "(Include Documents applies to 'selected' knowledge only).",
            )
        )
    if options.includeChildSkills and not effective.includeChildSkills and graph.children:
        notes.append(
            (
                "EXPORT_OPTION_CHILD_SKILLS_IGNORED",
                f"Format '{fmt.display_name}' holds a single Skill; Child Skills are not included.",
            )
        )
    if options.includeSourceSpec and not effective.includeSourceSpec:
        notes.append(
            (
                "EXPORT_OPTION_SOURCE_SPEC_IGNORED",
                f"Format '{fmt.display_name}' does not carry source metadata.",
            )
        )
    return notes


def _scan_inputs(request: ExportCompileRequest, graph: CompiledGraph) -> list[Finding]:
    findings = scan_value(request.spec, "")
    children_by_id = {c.skillId: c for c in request.children}
    for child_id in graph.aliases.child_order:
        findings += scan_value(children_by_id[child_id].spec, f"{graph.aliases.child_alias_by_id[child_id]}:")
    for doc in graph.docs.values():
        findings += scan_text(doc.file_name, f"{doc.alias}/fileName")
        if doc.included and doc.content is not None:
            findings += scan_text(doc.content, doc.alias)
    return findings


def _scan_files(files: list[ExportFile]) -> list[Finding]:
    findings: list[Finding] = []
    for file in files:
        findings += scan_text(file.content, file.path)
    return findings


def _blocker(findings: list[Finding]) -> ExportBlocker:
    return ExportBlocker(
        code="EXPORT_SECRET_DETECTED",
        message="Export blocked: secret or sensitive values were detected. Remove them from the Skill and export again.",
        findings=[SanitizerFindingOut(path=f.path, category=f.category) for f in findings[:MAX_FINDINGS]],
    )


def build_export(
    request: ExportCompileRequest, *, tools: Optional[dict[str, ToolDescriptor]] = None
) -> ExportCompileResponse:
    options = request.options
    fmt = get_format(options.target, options.format)  # EXPORT_TARGET_UNSUPPORTED / EXPORT_FORMAT_UNSUPPORTED
    profile = resolve_profile(options.target, options.format)
    effective = effective_options(fmt, options)
    graph = compile_graph(request, effective, tools)

    # A registered target/format without an Adapter: analysis still works, a real export cannot.
    adapter: Optional[ExportAdapter] = (
        get_adapter(options.target, options.format) if has_adapter(options.target, options.format) else None
    )
    if adapter is None and not request.dryRun:
        get_adapter(options.target, options.format)  # raises EXPORT_TARGET_ADAPTER_UNAVAILABLE

    notes = _option_notes(fmt, options, effective, graph) + (adapter.notes(graph) if adapter else [])
    compatibility = analyze(graph, profile, effective, notes)

    def blocked(findings: list[Finding]) -> ExportCompileResponse:
        blocker = _blocker(findings)
        if request.dryRun:
            return ExportCompileResponse(
                compatibility=compatibility.model_copy(update={"level": "blocked"}),
                effectiveOptions=effective,
                blockers=[blocker],
            )
        raise export_error(blocker.code, blocker.message, findings=[f.model_dump() for f in blocker.findings])

    input_findings = _scan_inputs(request, graph)
    if input_findings:
        return blocked(input_findings)

    if adapter is None:
        manifest = build_manifest(graph, profile=profile, effective=effective, files=[], package_root=None)
        return ExportCompileResponse(compatibility=compatibility, effectiveOptions=effective, manifest=manifest)

    files = adapter.render(RenderInput(graph=graph, effective=effective, profile=profile, root_spec=request.spec))
    package_root = adapter.package_root(graph)
    manifest = build_manifest(graph, profile=profile, effective=effective, files=files, package_root=package_root)
    all_files = list(files)
    if adapter.embeds_manifest:
        all_files.append(ExportFile(path=MANIFEST_PATH, content=pretty_json(dump_manifest(manifest))))
    all_files.sort(key=lambda f: f.path)

    paths = [f.path for f in all_files]
    if len(paths) != len(set(paths)):
        raise export_error("EXPORT_INTERNAL_PATH_COLLISION", "Export produced duplicate file paths", status="internal_error")
    unsafe = [p for p in paths if not is_safe_archive_path(p)]
    if unsafe:
        raise export_error("EXPORT_UNSAFE_PATH", "Export produced a non-ASCII or unsafe file path", status="internal_error", paths=unsafe)

    adapter.validate(all_files)  # target-specific rules (e.g. Claude SKILL.md frontmatter)

    output_findings = _scan_files(all_files)
    if output_findings:
        return blocked(output_findings)

    content_hash = sha256_text(canonical_json([[f.path, sha256_text(f.content)] for f in all_files]))
    return ExportCompileResponse(
        compatibility=compatibility,
        effectiveOptions=effective,
        manifest=manifest,
        files=[] if request.dryRun else all_files,
        packageRoot=package_root,
        filename=adapter.filename(graph),
        contentType=fmt.content_type,
        contentHash=content_hash,
    )
