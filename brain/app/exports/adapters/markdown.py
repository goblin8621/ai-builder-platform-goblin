"""Markdown rendering of a compiled Skill (10번 §6). Shared by the Generic
Markdown adapter and the Portable Package's SKILL.md.

Everything here is order-independent (schema properties and mapping keys are
sorted) and newline-normalized, so the same logical input renders to the same
bytes. No timestamps, no provider names.
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

from app.exports.canonical import ensure_trailing_newline, pretty_json
from app.exports.compiler import CompiledGraph, CompiledSkill
from app.exports.models import EffectiveOptions


def one_line(value: Any) -> str:
    return " ".join(str(value).split())


def inline_code(value: Any) -> str:
    return "`" + str(value).replace("`", "'") + "`"


def fence(text: str, lang: str = "") -> str:
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    ticks = "`" * max(3, longest + 1)
    return f"{ticks}{lang}\n{text.rstrip(chr(10))}\n{ticks}"


def type_label(schema: Any) -> str:
    if not isinstance(schema, dict):
        return "any"
    declared = schema.get("type")
    if isinstance(declared, list):
        label = "|".join(str(t) for t in declared)
    elif declared == "array":
        items = schema.get("items")
        label = f"array<{type_label(items)}>" if isinstance(items, dict) else "array"
    elif declared is None:
        label = "any"
    else:
        label = str(declared)
    if "enum" in schema and isinstance(schema["enum"], list):
        label += " (one of " + ", ".join(json.dumps(v, ensure_ascii=False) for v in schema["enum"]) + ")"
    return label


def describe_schema(schema: dict[str, Any]) -> list[str]:
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return []
    required = set(schema.get("required", [])) if isinstance(schema.get("required"), list) else set()
    lines: list[str] = []
    for name in sorted(properties):
        sub = properties[name]
        line = f"- {inline_code(name)}: {type_label(sub)}"
        if name in required:
            line += " (required)"
        description = sub.get("description") if isinstance(sub, dict) else None
        if isinstance(description, str) and description.strip():
            line += f" — {one_line(description)}"
        lines.append(line)
    return lines


def mapping_value(value: Any) -> str:
    if isinstance(value, dict) and set(value) == {"$ref"} and isinstance(value["$ref"], str):
        return f"from {inline_code(value['$ref'])}"
    return "= " + inline_code(json.dumps(value, ensure_ascii=False, sort_keys=True))


def describe_error_policy(policy: Any) -> str:
    action = policy.action
    if action == "retry":
        count = policy.retryCount
        return f"retry up to {count} time(s)" if count is not None else "retry (default retry limit)"
    if action == "fallback":
        return f"fall back to step {inline_code(policy.fallbackStepId)}"
    if action == "skip":
        return "skip this step and continue"
    return "fail the run"


def render_skill_markdown(
    skill: CompiledSkill,
    graph: CompiledGraph,
    effective: EffectiveOptions,
    *,
    heading: int = 1,
    dependency_location: Optional[dict[str, str]] = None,
    contents: Optional[list[str]] = None,
) -> str:
    p = skill.portable
    h1, h2, h3 = "#" * heading, "#" * (heading + 1), "#" * (heading + 2)
    blocks: list[str] = [f"{h1} {one_line(p.name)}"]

    blocks.append(f"{h2} Description\n\n{p.description.strip()}")
    blocks.append(f"{h2} Objective\n\n{p.objective.strip()}")

    if p.instructions:
        blocks.append(f"{h2} Instructions\n\n" + "\n".join(f"- {one_line(rule)}" for rule in p.instructions))
    if p.guardrails:
        blocks.append(f"{h2} Guardrails\n\n" + "\n".join(f"- {one_line(rule)}" for rule in p.guardrails))

    for title, schema in (("Input Contract", p.inputContract), ("Output Contract", p.outputContract)):
        parts = [f"{h2} {title}"]
        summary = describe_schema(schema)
        if summary:
            parts.append("\n".join(summary))
        parts.append(fence(pretty_json(schema), "json"))
        blocks.append("\n\n".join(parts))

    workflow_lines: list[str] = []
    for index, step in enumerate(p.workflow, start=1):
        lines = [f"{index}. **{one_line(step.name)}** — {step.kind} step {inline_code(step.id)}"]
        if step.ref is not None:
            lines.append(f"   - Uses: {inline_code(step.ref)}")
        if step.input:
            lines.append("   - Input:")
            for key in sorted(step.input):
                lines.append(f"     - {inline_code(key)} {mapping_value(step.input[key])}")
        if step.condition is not None:
            lines.append(f"   - Condition: {inline_code(step.condition)}")
        if step.requiresApproval:
            lines.append("   - Requires human approval before this step runs.")
        if step.onError is not None:
            lines.append(f"   - On error: {describe_error_policy(step.onError)}")
        if step.outputKey is not None:
            lines.append(f"   - Output key: {inline_code(step.outputKey)}")
        workflow_lines.append("\n".join(lines))
    workflow_block = f"{h2} Workflow\n\n" + "\n".join(workflow_lines)
    if p.outputMapping:
        mapping = "\n".join(f"- {inline_code(key)} {mapping_value(p.outputMapping[key])}" for key in sorted(p.outputMapping))
        workflow_block += f"\n\nFinal output is built from:\n\n{mapping}"
    else:
        workflow_block += "\n\nFinal output is the output of the last completed step."
    blocks.append(workflow_block)

    if p.requiredTools:
        blocks.append(
            f"{h2} Required Tools\n\n"
            + "\n".join(f"- {inline_code(t.id)} ({t.protocol}): {one_line(t.description)}" for t in p.requiredTools)
        )
    if p.requiredCapabilities:
        blocks.append(
            f"{h2} Required Capabilities\n\n" + "\n".join(f"- {inline_code(c.id)}" for c in p.requiredCapabilities)
        )

    if p.knowledge:
        knowledge_lines: list[str] = []
        for entry in p.knowledge:
            knowledge_lines.append(f"- Scope: {entry.scope}")
            if entry.scope == "workspace":
                knowledge_lines.append("  - Workspace-wide knowledge (References Only; the consumer provides its own corpus).")
            for doc in entry.documents:
                location = (
                    f"included at {inline_code(doc.path)}" if doc.included and doc.path else "not included (References Only)"
                )
                knowledge_lines.append(f"  - {inline_code(doc.ref)} — {one_line(doc.fileName)} ({doc.mimeType}), {location}")
        blocks.append(f"{h2} Knowledge\n\n" + "\n".join(knowledge_lines))

    if p.dependencies:
        dependency_lines: list[str] = []
        for dependency in p.dependencies:
            child = graph.children[dependency.ref]
            if effective.includeChildSkills:
                where = (dependency_location or {}).get(dependency.ref, "included")
                location = f"included ({where})"
            else:
                location = "not included in this export"
            dependency_lines.append(
                f"- {inline_code(dependency.ref)} — {one_line(child.name)} v{child.version}, "
                f"content hash {inline_code(child.content_hash)}; {location}"
            )
        blocks.append(f"{h2} Dependencies\n\n" + "\n".join(dependency_lines))

    limit_labels = (
        ("timeoutSec", "Timeout (seconds)"),
        ("retryCount", "Default retry count"),
        ("maxToolCalls", "Max tool calls"),
        ("maxNestedSkillDepth", "Max nested Skill depth"),
    )
    limit_lines = [
        f"- {label}: {getattr(p.runtimeLimits, field):g}"
        for field, label in limit_labels
        if getattr(p.runtimeLimits, field) is not None
    ]
    if limit_lines:
        blocks.append(
            f"{h2} Runtime Limits\n\n"
            + "\n".join(limit_lines)
            + "\n\nThese are the limits the Skill was designed with; enforcement depends on the runtime you use."
        )

    if p.examples:
        example_blocks = [f"{h2} Examples"]
        for index, example in enumerate(p.examples, start=1):
            title = f"{h3} Example {index}"
            if example.description:
                title += f" — {one_line(example.description)}"
            example_blocks.append(title + "\n\n" + fence(pretty_json(example.input), "json"))
        blocks.append("\n\n".join(example_blocks))

    if contents:
        blocks.append(f"{h2} Package Contents\n\n" + "\n".join(f"- {inline_code(path)}" for path in contents))

    return ensure_trailing_newline("\n\n".join(blocks))
