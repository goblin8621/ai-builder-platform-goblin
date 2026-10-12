"""The `claude` Target: a Claude / Agent Skill package (SKILL.md + YAML
frontmatter + references). This Profile states what Claude can do WITH such a
package — Provider-specific facts live here and in ClaudeSkillAdapter, never in
SkillSpec or PortableSkill.

What a Skill package gives Claude: instructions loaded on demand, bundled
reference files it can read, optional scripts it can run, and whatever tools the
user's environment already exposes (e.g. MCP servers).

- tools=False   this platform's builtin tools (file-parser, ...) do not exist in
                Claude; equivalents must come from an MCP server the user adds.
- mcp=True      Claude can use MCP servers, but a package cannot configure one —
                so a Skill that requires MCP is always `partial` here.
- knowledge     reference files are readable by Claude; documents that are NOT
                included are reported by the Analyzer.
- codeExecution Claude runs code only where a code-execution environment is
                enabled (Claude Code, or the code execution tool) — environment
                dependent, so it is not promised.
- workflow      Claude follows an ordered procedure — that is what a Skill is — so
                step order, conditions and input/output data flow are supported as
                instructions. Error POLICIES (retry / fallback / skip / fail) and
                runtime limits are system-level behaviour a package cannot
                guarantee: Claude decides how to react, so they are not promised.
- nestedSkill/approval  no equivalent of this platform's nested runs / pause for
                approval; child Skills are bundled as additional skill files and
                approval becomes an instruction to ask the user first.
"""
from __future__ import annotations

from app.exports.models import ProfileCapabilities

from app.exports.models import WorkflowSemantics

from .generic import limits
from .registry import FormatDefinition, TargetDefinition, register_target

_CLAUDE = ProfileCapabilities(
    llm=True, instructions=True, structuredInput=True, structuredOutput=True,
    tools=False, mcp=True, knowledge=True, codeExecution=False, workflow=True,
    nestedSkill=False, approval=False,
    workflowSemantics=WorkflowSemantics(
        sequentialSteps=True, condition=True, inputMapping=True, outputMapping=True,
        retry=False, fallback=False, skip=False, fail=False,
    ),
    runtimeLimits=limits(False),
    supportedCapabilities=["file-analysis"],
    notes={
        "tools": "Claude has no access to this platform's builtin tools; provide equivalents through an MCP server you add to your Claude environment.",
        "mcp": "A Skill package cannot configure MCP servers; add the required server to your Claude environment (call its tools as ServerName:tool_name).",
        "codeExecution": "Claude can run code only where code execution is enabled (e.g. Claude Code or the code execution tool).",
        "approval": "Claude cannot pause for this platform's approval flow; the Skill instructs Claude to ask for your confirmation first, which is not enforced.",
        "nestedSkill": "Child Skills are bundled as additional skill files that Claude follows; there are no nested runs.",
        "workflow.retry": "Claude is told to retry, but attempts are not counted or limited by the platform.",
        "workflow.fallback": "Claude is told to continue with the fallback step, but the platform's loop protection does not apply.",
        "workflow.skip": "Claude is told to skip the step on failure; this is an instruction, not an enforced policy.",
        "workflow.fail": "Claude is told to stop on failure; this is an instruction, not an enforced policy.",
    },
)

CLAUDE = TargetDefinition(
    id="claude",
    display_name="Claude",
    formats=(
        FormatDefinition(
            id="skill-package",
            display_name="Claude Skill",
            content_type="application/zip",
            capabilities=_CLAUDE,
            target_optimized=True,
            embeds_knowledge=True,
            embeds_children=True,
            embeds_source_spec=True,
        ),
    ),
)

register_target(CLAUDE)
