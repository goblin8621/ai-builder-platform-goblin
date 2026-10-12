"""Portable Skill Compiler: SkillSpec (+ locked Child specs + Document data)
-> PortableSkill graph (10번 §1/§3).

Pure and deterministic: no DB, no clock, no randomness. BFF has already done
Dependency Resolution (Child Versions locked at Export start) and Document
permission checks; this module only transforms what it is given.

Phase 9 확정 결정 반영:
- #8  every Child carries a content hash that also covers ITS OWN locked
      dependencies (Merkle style), so the Manifest can pin the exact snapshot.
- #10 internal skillId / documentId never appear in the Portable document —
      only Package-local aliases (`child:<slug>`, `doc:<slug>`). Internal ids
      show up solely in the optional `source`/`sourceSpec`, i.e. only when
      includeSourceSpec is on.
- Registry model ids (spec.model) are NOT exported; they are internal.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from app.common.tools.interface import ToolDescriptor
from app.common.tools.static_registry import StaticToolRegistry
from app.skills.validator import validate_skill_spec

from .archive import document_archive_path, skill_dir_name
from .canonical import canonical_json, export_error, normalize_newlines, sha256_text, slugify, unique_name
from .models import (
    CAPABILITY_IDS,
    ChildSkillInput,
    DocumentInput,
    EffectiveOptions,
    ExportCompileRequest,
    PortableSkill,
    dump_portable,
)

CHILD_PREFIX = "child:"
DOC_PREFIX = "doc:"
MAX_DEPENDENCY_DEPTH = 16


@dataclass
class AliasTable:
    child_alias_by_id: dict[str, str] = field(default_factory=dict)
    # ASCII-safe archive folder per child (`children/<slug>-<id8>`); never the display name.
    child_dir_by_id: dict[str, str] = field(default_factory=dict)
    child_order: list[str] = field(default_factory=list)
    doc_alias_by_id: dict[str, str] = field(default_factory=dict)
    doc_path_by_id: dict[str, str] = field(default_factory=dict)
    doc_order: list[str] = field(default_factory=list)


@dataclass
class ExportDoc:
    document_id: str
    alias: str
    path: str
    file_name: str
    mime_type: str
    included: bool
    content: Optional[str] = None
    content_hash: Optional[str] = None


@dataclass
class CompiledSkill:
    skill_id: str
    alias: Optional[str]
    name: str
    version: int
    portable: PortableSkill
    content_hash: str
    dependency_aliases: list[str]
    # `children/<slug>-<id8>` for a Child, None for the root Skill.
    archive_dir: Optional[str] = None


@dataclass
class CompiledGraph:
    root: CompiledSkill
    children: dict[str, CompiledSkill]
    aliases: AliasTable
    docs: dict[str, ExportDoc]
    # ASCII-safe root folder of a ZIP package: `<ascii-slug>-<id8>` or `skill-<id8>`.
    archive_root: str

    def all_skills(self) -> list[CompiledSkill]:
        return [self.root, *self.children.values()]

    def nested_depth(self) -> int:
        def depth(skill: CompiledSkill) -> int:
            if not skill.dependency_aliases:
                return 0
            return 1 + max(depth(self.children[a]) for a in skill.dependency_aliases)

        return depth(self.root)


def _skill_steps(spec: dict[str, Any]) -> list[dict[str, Any]]:
    return spec["execution"]["steps"]


def _child_ids_in_order(spec: dict[str, Any]) -> list[str]:
    seen: list[str] = []
    for step in _skill_steps(spec):
        if step["type"] == "skill" and step.get("refId") and step["refId"] not in seen:
            seen.append(step["refId"])
    return seen


def build_alias_table(
    root_skill_id: str,
    root_spec: dict[str, Any],
    children_by_id: dict[str, ChildSkillInput],
    docs_by_id: dict[str, DocumentInput],
) -> AliasTable:
    table = AliasTable()
    used_child_slugs: set[str] = set()
    used_child_dirs: set[str] = set()
    seen: set[str] = set()

    def visit(spec: dict[str, Any], stack: list[str]) -> None:
        if len(stack) > MAX_DEPENDENCY_DEPTH:
            raise export_error(
                "EXPORT_DEPENDENCY_TOO_DEEP",
                f"Child Skill nesting exceeds {MAX_DEPENDENCY_DEPTH} levels",
            )
        for step in _skill_steps(spec):
            if step["type"] != "skill":
                continue
            child_id = step.get("refId")
            child = children_by_id.get(child_id) if child_id else None
            if child is None:
                raise export_error(
                    "EXPORT_CHILD_UNAVAILABLE",
                    f"Step '{step['id']}' references a Child Skill that is not available for export",
                    stepId=step["id"],
                )
            if child_id in stack:
                raise export_error(
                    "EXPORT_DEPENDENCY_CYCLE",
                    f"Child Skill dependency cycle detected at step '{step['id']}'",
                    stepId=step["id"],
                )
            if child_id in seen:
                continue
            seen.add(child_id)
            validate_skill_spec(child.spec)
            alias = CHILD_PREFIX + unique_name(slugify(child.name) or "skill", used_child_slugs)
            table.child_alias_by_id[child_id] = alias
            table.child_dir_by_id[child_id] = "children/" + unique_name(
                skill_dir_name(child.name, child_id), used_child_dirs
            )
            table.child_order.append(child_id)
            visit(child.spec, [*stack, child_id])

    visit(root_spec, [root_skill_id])

    used_doc_slugs: set[str] = set()
    used_paths: set[str] = set()
    for spec in [root_spec, *[children_by_id[i].spec for i in table.child_order]]:
        knowledge = spec["knowledge"]
        if knowledge["mode"] != "selected":
            continue
        for doc_id in knowledge["documentIds"]:
            if doc_id in table.doc_alias_by_id:
                continue
            doc = docs_by_id.get(doc_id)
            if doc is None:
                raise export_error(
                    "EXPORT_DOCUMENT_UNAVAILABLE",
                    "A Knowledge document referenced by the Skill is not available for export",
                    status="not_found",
                )
            table.doc_alias_by_id[doc_id] = DOC_PREFIX + unique_name(slugify(doc.fileName) or "document", used_doc_slugs)
            table.doc_path_by_id[doc_id] = document_archive_path(doc.fileName, doc_id, used_paths)
            table.doc_order.append(doc_id)
    return table


def _build_docs(
    aliases: AliasTable, docs_by_id: dict[str, DocumentInput], effective: EffectiveOptions
) -> dict[str, ExportDoc]:
    docs: dict[str, ExportDoc] = {}
    for doc_id in aliases.doc_order:
        raw = docs_by_id[doc_id]
        included = effective.includeKnowledge
        content: Optional[str] = None
        content_hash: Optional[str] = None
        if included:
            if raw.content is None:
                raise export_error(
                    "EXPORT_DOCUMENT_UNAVAILABLE",
                    "Document content was not provided although Include Documents is on",
                    status="not_found",
                )
            content = normalize_newlines(raw.content)
            content_hash = sha256_text(content)
        docs[doc_id] = ExportDoc(
            document_id=doc_id,
            alias=aliases.doc_alias_by_id[doc_id],
            path=aliases.doc_path_by_id[doc_id],
            file_name=raw.fileName,
            mime_type=raw.mimeType,
            included=included,
            content=content,
            content_hash=content_hash,
        )
    return docs


def _convert_step(step: dict[str, Any], aliases: AliasTable) -> dict[str, Any]:
    kwargs: dict[str, Any] = {"id": step["id"], "name": step["name"], "kind": step["type"]}
    ref = step.get("refId")
    if step["type"] == "skill" and ref is not None:
        ref = aliases.child_alias_by_id[ref]
    if ref is not None:
        kwargs["ref"] = ref
    if step.get("inputMap") is not None:
        kwargs["input"] = step["inputMap"]
    if step.get("outputKey") is not None:
        kwargs["outputKey"] = step["outputKey"]
    if step.get("condition") is not None:
        kwargs["condition"] = step["condition"]
    if step.get("approvalRequired") is not None:
        kwargs["requiresApproval"] = step["approvalRequired"]
    if step.get("onError") is not None:
        on_error = {k: v for k, v in step["onError"].items() if v is not None}
        kwargs["onError"] = on_error
    return kwargs


def _portable_kwargs(
    spec: dict[str, Any],
    aliases: AliasTable,
    docs: dict[str, ExportDoc],
    tools: dict[str, ToolDescriptor],
) -> dict[str, Any]:
    steps = _skill_steps(spec)
    capabilities = spec["capabilities"]

    required_tool_ids: set[str] = set()
    for step in steps:
        if step["type"] == "tool":
            tool_id = step.get("refId") or ""
            if tool_id not in tools:
                raise export_error(
                    "EXPORT_TOOL_UNKNOWN",
                    f"Tool '{tool_id}' referenced by step '{step['id']}' is not available in the Tool Registry",
                    toolId=tool_id,
                    stepId=step["id"],
                )
            required_tool_ids.add(tool_id)
    required_tools = [
        {
            "id": tools[tool_id].tool_id,
            "description": tools[tool_id].description,
            "protocol": tools[tool_id].protocol,
            "inputSchema": tools[tool_id].input_schema,
            "outputSchema": tools[tool_id].output_schema,
        }
        for tool_id in sorted(required_tool_ids)
    ]

    knowledge: list[dict[str, Any]] = []
    knowledge_spec = spec["knowledge"]
    if knowledge_spec["mode"] == "selected":
        documents = []
        for doc_id in knowledge_spec["documentIds"]:
            doc = docs[doc_id]
            entry: dict[str, Any] = {
                "ref": doc.alias,
                "fileName": doc.file_name,
                "mimeType": doc.mime_type,
                "included": doc.included,
            }
            if doc.included:
                entry["path"] = doc.path
                entry["contentHash"] = doc.content_hash
            documents.append(entry)
        knowledge.append({"scope": "selected", "documents": documents})
    elif knowledge_spec["mode"] == "workspace":
        knowledge.append({"scope": "workspace", "documents": []})

    dependencies = [{"ref": aliases.child_alias_by_id[child_id]} for child_id in _child_ids_in_order(spec)]

    requires_mcp = bool(capabilities.get("mcp")) or any(t["protocol"] == "mcp" for t in required_tools)
    kwargs: dict[str, Any] = {
        # Explicit (not the model default): dump_portable uses exclude_unset,
        # which would otherwise drop the required formatVersion.
        "formatVersion": "1.0",
        "name": spec["name"],
        "description": spec["description"],
        "objective": spec["instructions"]["objective"],
        "instructions": list(spec["instructions"]["rules"]),
        "guardrails": list(spec["guardrails"]),
        "skillType": spec["skillType"],
        "inputContract": spec["inputSchema"],
        "outputContract": spec["outputSchema"],
        "workflow": [_convert_step(step, aliases) for step in steps],
        "dependencies": dependencies,
        "requiredCapabilities": [{"id": cid} for flag, cid in CAPABILITY_IDS if capabilities.get(flag)],
        "requiredTools": required_tools,
        "knowledge": knowledge,
        "examples": [
            {k: v for k, v in {"description": ex.get("description"), "input": ex.get("input")}.items() if k == "input" or v is not None}
            for ex in spec["usageExamples"]
        ],
        "runtimeRequirements": {
            "requiresLLM": any(s["type"] == "llm" for s in steps),
            "requiresTools": len(required_tools) > 0,
            "requiresMcp": requires_mcp,
            "requiresKnowledge": knowledge_spec["mode"] != "none"
            or bool(capabilities.get("knowledgeSearch"))
            or any(s["type"] == "knowledge" for s in steps),
            "requiresCodeExecution": bool(capabilities.get("codeExecution") or capabilities.get("dataAnalysis")),
            "requiresApproval": any(s.get("approvalRequired") for s in steps),
            "requiresNestedSkill": any(s["type"] == "skill" for s in steps),
        },
        "runtimeLimits": {
            "timeoutSec": spec["runtime"]["timeoutSec"],
            "retryCount": spec["runtime"]["retryCount"],
            "maxToolCalls": spec["runtime"]["maxToolCalls"],
            "maxNestedSkillDepth": spec["runtime"]["maxNestedSkillDepth"],
        },
    }
    output_map = spec["execution"].get("outputMap")
    if output_map is not None:
        kwargs["outputMapping"] = output_map
    return kwargs


def compile_graph(
    request: ExportCompileRequest,
    effective: EffectiveOptions,
    tools: Optional[dict[str, ToolDescriptor]] = None,
) -> CompiledGraph:
    if tools is None:
        tools = {t.tool_id: t for t in StaticToolRegistry().list_available()}

    validate_skill_spec(request.spec)
    children_by_id = {c.skillId: c for c in request.children}
    docs_by_id = {d.documentId: d for d in request.documents}

    aliases = build_alias_table(request.skillId, request.spec, children_by_id, docs_by_id)
    docs = _build_docs(aliases, docs_by_id, effective)
    compiled: dict[str, CompiledSkill] = {}

    def compile_node(skill_id: str, name: str, version: int, spec: dict[str, Any]) -> CompiledSkill:
        existing = compiled.get(skill_id)
        if existing is not None:
            return existing

        dep_ids = _child_ids_in_order(spec)
        dep_hashes: dict[str, str] = {}
        for dep_id in dep_ids:
            child = children_by_id[dep_id]
            dep_hashes[aliases.child_alias_by_id[dep_id]] = compile_node(
                dep_id, child.name, child.version, child.spec
            ).content_hash

        kwargs = _portable_kwargs(spec, aliases, docs, tools)
        core = PortableSkill(**kwargs)
        content_hash = sha256_text(canonical_json({"portable": dump_portable(core), "dependencies": dep_hashes}))

        final = core
        if effective.includeSourceSpec:
            final = PortableSkill(
                **kwargs,
                source={"skillId": skill_id, "skillVersion": version},
                sourceSpec=spec,
            )

        node = CompiledSkill(
            skill_id=skill_id,
            alias=aliases.child_alias_by_id.get(skill_id),
            name=name,
            version=version,
            portable=final,
            content_hash=content_hash,
            dependency_aliases=[aliases.child_alias_by_id[i] for i in dep_ids],
            archive_dir=aliases.child_dir_by_id.get(skill_id),
        )
        compiled[skill_id] = node
        return node

    root = compile_node(request.skillId, request.spec["name"], request.version, request.spec)
    children = {
        aliases.child_alias_by_id[child_id]: compiled[child_id] for child_id in aliases.child_order
    }
    return CompiledGraph(
        root=root,
        children=children,
        aliases=aliases,
        docs=docs,
        archive_root=skill_dir_name(request.spec["name"], request.skillId),
    )
