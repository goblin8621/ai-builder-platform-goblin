"""The provider-neutral `generic` Target.

Semantics of a capability flag: "the Target can provide / enforce this", not
merely "can mention it in prose".

- portable-package / raw-spec are lossless CARRIERS (declarative): they preserve
  every declaration (workflow, mapping, error policy, limits, tool/knowledge/
  child requirements) in machine-readable form and execute nothing, so whatever
  a consuming Runtime must supply is still surfaced (documents / children not
  included, ...).
- markdown is a prompt/context document: it carries instructions and the I/O
  contract and can describe a workflow in prose, but cannot provide
  tools/MCP/knowledge/code execution, nor ENFORCE any workflow semantic or
  runtime limit.
"""
from __future__ import annotations

from app.exports.models import ProfileCapabilities, RuntimeLimitSupport, WorkflowSemantics

from .registry import FormatDefinition, TargetDefinition, register_target


def semantics(value: bool) -> WorkflowSemantics:
    return WorkflowSemantics(
        sequentialSteps=value, condition=value, retry=value, fallback=value,
        skip=value, fail=value, inputMapping=value, outputMapping=value,
    )


def limits(value: bool) -> RuntimeLimitSupport:
    return RuntimeLimitSupport(timeoutSec=value, retryCount=value, maxToolCalls=value, maxNestedSkillDepth=value)


_CARRIER = ProfileCapabilities(
    llm=True, instructions=True, structuredInput=True, structuredOutput=True,
    tools=True, mcp=True, knowledge=True, codeExecution=True, workflow=True,
    nestedSkill=True, approval=True,
    workflowSemantics=semantics(True), runtimeLimits=limits(True),
    supportedCapabilities=["file-analysis", "image-generation", "web-search"],
)

_MARKDOWN = ProfileCapabilities(
    llm=True, instructions=True, structuredInput=True, structuredOutput=True,
    tools=False, mcp=False, knowledge=False, codeExecution=False, workflow=True,
    nestedSkill=False, approval=False,
    workflowSemantics=semantics(False), runtimeLimits=limits(False),
    supportedCapabilities=[],
)

GENERIC = TargetDefinition(
    id="generic",
    display_name="Generic",
    formats=(
        FormatDefinition(
            id="portable-package",
            display_name="Portable Skill Package",
            content_type="application/zip",
            capabilities=_CARRIER,
            declarative=True,
            embeds_knowledge=True,
            embeds_children=True,
            embeds_source_spec=True,
        ),
        FormatDefinition(
            id="markdown",
            display_name="Generic Markdown",
            content_type="text/markdown; charset=utf-8",
            capabilities=_MARKDOWN,
            embeds_children=True,  # appended inline to the same file
        ),
        FormatDefinition(
            id="raw-spec",
            display_name="Raw SkillSpec",
            content_type="application/json; charset=utf-8",
            capabilities=_CARRIER,
            declarative=True,
        ),
    ),
)

register_target(GENERIC)
