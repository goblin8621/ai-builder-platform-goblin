"""Claude Skill Adapter: PortableSkill -> a Claude / Agent Skill package.

This Adapter owns EVERYTHING Claude-specific — the Provider's formatting and
validation rules never leak into SkillSpec, PortableSkill or the Generic
Markdown renderer. SKILL.md is rendered by a dedicated renderer written for
Claude as the reader (imperative instructions), not by renaming Generic Markdown.

Rules implemented (Claude Platform docs, "Agent Skills" + "Skill authoring best practices"):
  - SKILL.md starts with YAML frontmatter holding `name` and `description`
  - name:        <= 64 chars, lowercase letters / digits / hyphens only,
                 no XML tags, must not contain the reserved words "anthropic"/"claude"
  - description: non-empty, <= 1024 chars, no XML tags; says what the Skill does
                 AND when to use it, in the third person
  - SKILL.md body < 500 lines; supporting material is linked ONE level deep from
    SKILL.md and read on demand (progressive disclosure); forward slashes only
  - MCP tools are referenced by fully qualified `ServerName:tool_name`

Package layout (every path is ASCII-safe, see ../archive.py):

    skill-<id8>/
    ├─ SKILL.md            frontmatter + instructions for Claude
    ├─ skill.json          PortableSkill (round-trippable; + sourceSpec iff includeSourceSpec)
    ├─ manifest.json       requirements, locked dependencies, display names, file hashes
    ├─ references/         bundled Knowledge documents (document-<id8>.<ext>) [+ schemas.md]
    └─ children/<slug>-<id8>/{SKILL.md,skill.json}   Child Skills as further skills

`validate()` re-checks the FINAL file set (see validate_claude_package) so a
package that Claude would reject is never handed to the user.
"""
from __future__ import annotations

import json
import posixpath
import re
from typing import Any, Optional

import yaml

from app.exports.archive import ascii_slug, is_safe_archive_path, skill_dir_name
from app.exports.canonical import ensure_trailing_newline, export_error, pretty_json
from app.exports.compiler import CompiledGraph, CompiledSkill
from app.exports.models import EffectiveOptions, ExportFile, dump_portable

from .base import ExportAdapter, RenderInput
from .markdown import describe_error_policy, describe_schema, fence, inline_code, mapping_value, one_line

NAME_MAX = 64
DESCRIPTION_MAX = 1024
BODY_MAX_LINES = 500
# Above this the root's JSON schemas move to references/schemas.md (still one level deep).
INLINE_LINE_BUDGET = 400
RESERVED_WORDS = ("anthropic", "claude")
SCHEMAS_PATH = "references/schemas.md"

_XML_TAG = re.compile(r"</?[A-Za-z][^>]*>")
_NAME_PATTERN = re.compile(r"[a-z0-9-]{1,64}")
_PLAIN_SCALAR = re.compile(r"[A-Za-z0-9][A-Za-z0-9 .,()/_-]*")
_FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
_LINK = re.compile(r"\]\(([^)\s]+)\)")
_SCHEME = re.compile(r"[a-zA-Z][a-zA-Z0-9+.-]*:")


# ---------------------------------------------------------------------------
# name / description (frontmatter)
# ---------------------------------------------------------------------------


def _has_reserved_word(name: str) -> bool:
    return any(word in name for word in RESERVED_WORDS)


def _valid_name(name: str) -> bool:
    return _NAME_PATTERN.fullmatch(name) is not None and not _has_reserved_word(name)


def claude_skill_name(skill: CompiledSkill, graph: CompiledGraph) -> tuple[str, Optional[tuple[str, str]]]:
    """Valid Claude `name` for one Skill + an optional (code, message) note.

    Root: the ASCII slug of the display name (e.g. `sales-analyzer`).
    Child: its unique archive folder name (`<slug>-<id8>`).
    Falls back to `skill-<id8>` when that is empty/invalid or would contain a
    reserved word. Non-ASCII names (e.g. Korean) simply have no ASCII slug.
    """
    fallback = skill_dir_name("", skill.skill_id)
    candidate = ascii_slug(skill.name, 40) if skill.archive_dir is None else skill.archive_dir.split("/")[-1]
    if _valid_name(candidate):
        return candidate, None
    if candidate and _has_reserved_word(candidate):
        return fallback, (
            "CLAUDE_NAME_RESERVED_WORD",
            f"Claude reserves the words 'claude'/'anthropic' in skill names; the name for '{one_line(skill.name)}' "
            f"was set to '{fallback}'.",
        )
    return fallback, None


def _normalize(text: str) -> str:
    return re.sub(r"\W+", "", text.lower())


def claude_description(skill: CompiledSkill) -> tuple[str, list[tuple[str, str]]]:
    """description = what it does (+ when to use it), single line, no XML tags, <= 1024 chars."""
    notes: list[tuple[str, str]] = []
    portable = skill.portable

    def clean(text: str) -> str:
        return _XML_TAG.sub("", one_line(text)).strip()

    base, objective = clean(portable.description), clean(portable.objective)
    if base != one_line(portable.description) or objective != one_line(portable.objective):
        notes.append(("CLAUDE_DESCRIPTION_SANITIZED", f"XML-like tags were removed from the description of '{one_line(skill.name)}'."))
    text = base or objective or clean(skill.name)
    if base and objective and _normalize(objective) not in _normalize(base):
        text = f"{base if base.endswith(('.', '!', '?', '。')) else base + '.'} Use when: {objective}"
    if len(text) > DESCRIPTION_MAX:
        cut = text[: DESCRIPTION_MAX - 3]
        cut = cut.rsplit(" ", 1)[0] if " " in cut else cut
        text = cut.rstrip(" ,.;:") + "..."
        notes.append(
            (
                "CLAUDE_DESCRIPTION_TRUNCATED",
                f"The description of '{one_line(skill.name)}' exceeds Claude's {DESCRIPTION_MAX}-character limit and was "
                "shortened in the frontmatter; the full text is kept in skill.json.",
            )
        )
    return text, notes


def _yaml_scalar(text: str) -> str:
    """Plain scalar when that round-trips as the same string, otherwise a
    JSON-quoted string (valid YAML double-quoted, keeps UTF-8)."""
    if _PLAIN_SCALAR.fullmatch(text) and not text.endswith(" "):
        try:
            if yaml.safe_load(text) == text:
                return text
        except yaml.YAMLError:
            pass
    return json.dumps(text, ensure_ascii=False)


def _frontmatter(name: str, description: str) -> str:
    block = f"---\nname: {_yaml_scalar(name)}\ndescription: {_yaml_scalar(description)}\n---\n"
    parsed = yaml.safe_load(_FRONTMATTER.match(block).group(1))  # type: ignore[union-attr]
    if parsed != {"name": name, "description": description}:
        raise export_error("EXPORT_PACKAGE_INVALID", "Generated frontmatter does not round-trip", status="internal_error")
    return block


# ---------------------------------------------------------------------------
# SKILL.md body (written for Claude as the reader)
# ---------------------------------------------------------------------------


def _link(target_path: str, from_dir: str) -> str:
    return posixpath.relpath(target_path, from_dir or ".")


def _step_block(
    index: int,
    step: Any,
    skill: CompiledSkill,
    graph: CompiledGraph,
    effective: EffectiveOptions,
    from_dir: str,
) -> str:
    lines = [f"{index}. **{one_line(step.name)}** ({step.kind}, id {inline_code(step.id)})"]
    if step.condition is not None and step.kind != "condition":
        lines.append(f"   - Only do this if: {inline_code(step.condition)}")
    if step.kind == "llm":
        lines.append("   - Reason over the current data and produce this step's result yourself.")
    elif step.kind == "tool":
        lines.append(
            f"   - Call the tool {inline_code(step.ref)}. It is not built into Claude: use the matching MCP tool "
            f"(`ServerName:{step.ref}`); if none is configured, tell the user which server is needed."
        )
    elif step.kind == "knowledge":
        lines.append("   - Look up what the input asks for in the documents under *Reference documents*; base the answer only on what they say.")
    elif step.kind == "skill":
        child = graph.children.get(step.ref or "")
        if child is not None and effective.includeChildSkills and child.archive_dir:
            lines.append(
                f"   - Follow the sub-skill [{one_line(child.name)}]({_link(child.archive_dir + '/SKILL.md', from_dir)}) "
                "(read it first) on the current data."
            )
        else:
            lines.append(
                f"   - This step uses the sub-skill {inline_code(step.ref)}, which is not bundled; ask the user to provide it."
            )
    elif step.kind == "transform":
        lines.append("   - Reshape the data exactly as the input mapping describes.")
    elif step.kind == "condition":
        lines.append(f"   - Decide using this condition and continue accordingly: {inline_code(step.condition or '')}")
    if step.input:
        lines.append("   - Inputs:")
        for key in sorted(step.input):
            lines.append(f"     - {inline_code(key)} {mapping_value(step.input[key])}")
    if step.requiresApproval:
        lines.append("   - Before this step, ask the user for explicit confirmation and do not continue without it.")
    if step.onError is not None:
        lines.append(f"   - If it fails: {describe_error_policy(step.onError)}.")
    if step.outputKey is not None:
        lines.append(f"   - Name this step's result {inline_code(step.outputKey)}.")
    return "\n".join(lines)


def render_claude_skill_md(
    skill: CompiledSkill,
    graph: CompiledGraph,
    effective: EffectiveOptions,
    *,
    schemas_in_reference: bool = False,
) -> str:
    p = skill.portable
    from_dir = skill.archive_dir or ""
    name, _ = claude_skill_name(skill, graph)
    description, _ = claude_description(skill)

    blocks: list[str] = [f"# {one_line(p.name)}", p.objective.strip()]

    if p.instructions:
        blocks.append("## Instructions\n\n" + "\n".join(f"- {one_line(rule)}" for rule in p.instructions))

    def contract(title: str, intro: str, schema: dict[str, Any]) -> str:
        parts = [f"## {title}", intro]
        summary = describe_schema(schema)
        if summary:
            parts.append("\n".join(summary))
        if schemas_in_reference and skill.archive_dir is None:
            parts.append(f"Full JSON schema: [{SCHEMAS_PATH}]({SCHEMAS_PATH})")
        else:
            parts.append(fence(pretty_json(schema), "json"))
        return "\n\n".join(parts)

    blocks.append(contract("Input", "Expect input with these fields:", p.inputContract))

    steps = "\n".join(_step_block(i, step, skill, graph, effective, from_dir) for i, step in enumerate(p.workflow, start=1))
    workflow = f"## Workflow\n\nFollow these steps in order:\n\n{steps}"
    if p.outputMapping:
        mapping = "\n".join(f"- {inline_code(key)} {mapping_value(p.outputMapping[key])}" for key in sorted(p.outputMapping))
        workflow += f"\n\nBuild the final result from:\n\n{mapping}"
    else:
        workflow += "\n\nThe final result is the result of the last step that completed."
    blocks.append(workflow)

    blocks.append(contract("Output", "Return a result that matches:", p.outputContract))

    if p.guardrails:
        blocks.append("## Guardrails\n\nNever cross these boundaries:\n\n" + "\n".join(f"- {one_line(g)}" for g in p.guardrails))

    constraints: list[str] = []
    if p.runtimeLimits.timeoutSec is not None:
        constraints.append(f"- Aim to finish within about {p.runtimeLimits.timeoutSec:g} seconds.")
    if p.requiredTools and (p.runtimeLimits.maxToolCalls or 0) > 0:
        constraints.append(f"- Make at most {p.runtimeLimits.maxToolCalls} tool calls.")
    if constraints:
        blocks.append("## Constraints\n\nThese are the limits this Skill was designed with (guidance; Claude does not enforce them):\n\n" + "\n".join(constraints))

    if p.requiredTools:
        tool_lines = "\n".join(f"- {inline_code(t.id)} ({t.protocol}): {one_line(t.description)}" for t in p.requiredTools)
        blocks.append(
            "## Required tools\n\n"
            "These tools are not built into Claude. Make sure an MCP server that provides them is configured, "
            "and call them by their fully qualified name (`ServerName:tool_name`).\n\n" + tool_lines
        )

    doc_lines: list[str] = []
    for entry in p.knowledge:
        if entry.scope == "workspace":
            doc_lines.append("- Workspace-wide knowledge is not bundled; ask the user for the relevant documents.")
        for doc in entry.documents:
            if doc.included and doc.path:
                doc_lines.append(f"- [{one_line(doc.fileName)}]({_link(doc.path, from_dir)}) — read it when the task needs it")
            else:
                doc_lines.append(f"- {one_line(doc.fileName)} — not bundled; ask the user to provide it")
    if doc_lines:
        blocks.append("## Reference documents\n\n" + "\n".join(doc_lines))

    if p.dependencies:
        child_lines = []
        for dependency in p.dependencies:
            child = graph.children[dependency.ref]
            if effective.includeChildSkills and child.archive_dir:
                child_lines.append(f"- [{one_line(child.name)}]({_link(child.archive_dir + '/SKILL.md', from_dir)})")
            else:
                child_lines.append(f"- {one_line(child.name)} — not bundled")
        blocks.append("## Sub-skills\n\n" + "\n".join(child_lines))

    if p.examples:
        example_blocks = ["## Examples"]
        for index, example in enumerate(p.examples, start=1):
            title = f"### Example {index}"
            if example.description:
                title += f" — {one_line(example.description)}"
            example_blocks.append(f"{title}\n\nInput:\n\n" + fence(pretty_json(example.input), "json"))
        blocks.append("\n\n".join(example_blocks))

    return _frontmatter(name, description) + "\n" + ensure_trailing_newline("\n\n".join(blocks))


def render_schemas_reference(skill: CompiledSkill) -> str:
    p = skill.portable
    return ensure_trailing_newline(
        "# Input and output schemas\n\n## Contents\n\n- Input schema\n- Output schema\n\n"
        "## Input schema\n\n" + fence(pretty_json(p.inputContract), "json")
        + "\n\n## Output schema\n\n" + fence(pretty_json(p.outputContract), "json")
    )


# ---------------------------------------------------------------------------
# package validation (final file set)
# ---------------------------------------------------------------------------


def _text_outside_fences(text: str) -> str:
    kept: list[str] = []
    fenced = False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
            continue
        if not fenced:
            kept.append(line)
    return "\n".join(kept)


def _validate_skill_md(path: str, content: str, all_paths: set[str]) -> list[str]:
    errors: list[str] = []
    match = _FRONTMATTER.match(content)
    if match is None:
        return [f"{path}: missing YAML frontmatter (file must start with '---')"]
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        return [f"{path}: frontmatter is not valid YAML ({type(exc).__name__})"]
    if not isinstance(data, dict):
        return [f"{path}: frontmatter must be a mapping"]

    name, description = data.get("name"), data.get("description")
    if not isinstance(name, str) or not name:
        errors.append(f"{path}: frontmatter 'name' is required")
    else:
        if len(name) > NAME_MAX:
            errors.append(f"{path}: name is longer than {NAME_MAX} characters")
        if not re.fullmatch(r"[a-z0-9-]+", name):
            errors.append(f"{path}: name may only contain lowercase letters, numbers and hyphens")
        if _has_reserved_word(name):
            errors.append(f"{path}: name contains a reserved word (anthropic/claude)")
        if _XML_TAG.search(name):
            errors.append(f"{path}: name contains an XML tag")
    if not isinstance(description, str) or not description.strip():
        errors.append(f"{path}: frontmatter 'description' is required and must be non-empty")
    else:
        if len(description) > DESCRIPTION_MAX:
            errors.append(f"{path}: description is longer than {DESCRIPTION_MAX} characters")
        if _XML_TAG.search(description):
            errors.append(f"{path}: description contains an XML tag")

    line_count = content.count("\n")
    if line_count > BODY_MAX_LINES:
        errors.append(f"{path}: {line_count} lines exceeds the {BODY_MAX_LINES}-line limit for SKILL.md")

    base_dir = posixpath.dirname(path)
    for target in _LINK.findall(_text_outside_fences(content[match.end():])):
        if target.startswith("#") or _SCHEME.match(target):
            continue
        resolved = posixpath.normpath(posixpath.join(base_dir, target.split("#")[0]))
        if resolved.startswith("..") or resolved.startswith("/"):
            errors.append(f"{path}: link '{target}' escapes the skill folder")
        elif resolved not in all_paths:
            errors.append(f"{path}: link '{target}' points to a file that is not in the package")
    return errors


def validate_claude_package(files: list[ExportFile]) -> list[str]:
    """All problems that would make Claude reject / mis-read the package (empty = valid)."""
    errors: list[str] = []
    paths = [f.path for f in files]
    path_set = set(paths)
    if len(paths) != len(path_set):
        errors.append("duplicate file paths in package")
    for path in paths:
        if not is_safe_archive_path(path):
            errors.append(f"unsafe archive path: {path!r}")
    for required in ("SKILL.md", "skill.json", "manifest.json"):
        if required not in path_set:
            errors.append(f"required file is missing: {required}")
    by_path = {f.path: f.content for f in files}
    for path in sorted(p for p in paths if p == "SKILL.md" or p.endswith("/SKILL.md")):
        errors.extend(_validate_skill_md(path, by_path[path], path_set))
    return errors


# ---------------------------------------------------------------------------
# Adapter
# ---------------------------------------------------------------------------


class ClaudeSkillAdapter(ExportAdapter):
    target_id = "claude"
    format_id = "skill-package"
    embeds_manifest = True

    def render(self, data: RenderInput) -> list[ExportFile]:
        graph, effective = data.graph, data.effective
        included_children = list(graph.children.values()) if effective.includeChildSkills else []
        included_docs = [d for d in graph.docs.values() if d.included]

        root_md = render_claude_skill_md(graph.root, graph, effective)
        schemas_in_reference = root_md.count("\n") > INLINE_LINE_BUDGET
        if schemas_in_reference:
            root_md = render_claude_skill_md(graph.root, graph, effective, schemas_in_reference=True)

        files = [
            ExportFile(path="SKILL.md", content=root_md),
            ExportFile(path="skill.json", content=pretty_json(dump_portable(graph.root.portable))),
        ]
        if schemas_in_reference:
            files.append(ExportFile(path=SCHEMAS_PATH, content=render_schemas_reference(graph.root)))
        for child in included_children:
            prefix = f"{child.archive_dir}/"
            files.append(ExportFile(path=prefix + "SKILL.md", content=render_claude_skill_md(child, graph, effective)))
            files.append(ExportFile(path=prefix + "skill.json", content=pretty_json(dump_portable(child.portable))))
        for doc in included_docs:
            files.append(ExportFile(path=doc.path, content=doc.content or ""))
        return files

    def filename(self, graph) -> str:  # type: ignore[no-untyped-def]
        return f"{graph.archive_root}-v{graph.root.version}.zip"

    def package_root(self, graph) -> str:  # type: ignore[no-untyped-def]
        return graph.archive_root

    def notes(self, graph) -> list[tuple[str, str]]:  # type: ignore[no-untyped-def]
        notes: list[tuple[str, str]] = []
        for skill in graph.all_skills():
            _, name_note = claude_skill_name(skill, graph)
            _, description_notes = claude_description(skill)
            if name_note:
                notes.append(name_note)
            notes.extend(description_notes)
        return notes

    def validate(self, files: list[ExportFile]) -> None:
        errors = validate_claude_package(files)
        if errors:
            raise export_error(
                "EXPORT_PACKAGE_INVALID",
                "The generated Claude Skill package does not satisfy Claude's skill format",
                errors=errors,
            )
