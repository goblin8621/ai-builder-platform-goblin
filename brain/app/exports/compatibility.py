"""Compatibility Analyzer (10번 §8, Phase 9 확정 결정 #4/#5/#11).

Compares what the Skill REQUIRES (derived from the compiled PortableSkill
graph — never from SkillSpec directly) with what the Target Profile SUPPORTS,
and returns a lowercase `full | partial | unsupported` level plus the reason
for every non-supported check. Unsupported features are never silently
dropped: they always surface as a check with reasons, a warning, and (for
partial) the manual steps needed to reproduce the Skill.

Level = worst status among checks with `affectsLevel`. Advisory checks
(`affectsLevel=False`, e.g. "target can't enforce the Skill timeout") are
still reported as warnings but do not downgrade the level — otherwise every
Generic Markdown export of even a trivial prompt Skill would be `partial`.
"""
from __future__ import annotations

from typing import Optional

from .compiler import CompiledGraph
from .models import (
    CompatibilityCheck,
    CompatibilityLevel,
    CompatibilityResult,
    CompatibilityStatus,
    CompatibilitySummary,
    CompatibilityWarning,
    EffectiveOptions,
    ExportTargetProfile,
    KnowledgeSummary,
    UnsupportedCapability,
)

_RANK: dict[str, int] = {"supported": 0, "partial": 1, "unsupported": 2}


def _warning_code(check_id: str) -> str:
    return "COMPAT_" + check_id.upper().replace(".", "_")


def analyze(
    graph: CompiledGraph,
    profile: ExportTargetProfile,
    effective: EffectiveOptions,
    notes: Optional[list[tuple[str, str]]] = None,
) -> CompatibilityResult:
    caps = profile.capabilities
    sem = caps.workflowSemantics
    lim = caps.runtimeLimits
    skills = graph.all_skills()
    portables = [s.portable for s in skills]
    root = graph.root.portable

    checks: list[CompatibilityCheck] = []
    manual: list[str] = []

    def add(
        check_id: str,
        label: str,
        ok: bool,
        reasons: list[str],
        *,
        failing: CompatibilityStatus = "partial",
        affects_level: bool = True,
        manual_step: Optional[str] = None,
    ) -> None:
        status: CompatibilityStatus = "supported" if ok and not reasons else failing
        checks.append(
            CompatibilityCheck(
                id=check_id, label=label, status=status, affectsLevel=affects_level, reasons=list(reasons)
            )
        )
        if status != "supported" and affects_level and manual_step and manual_step not in manual:
            manual.append(manual_step)

    # ---- core: instructions / llm / structured I/O -------------------------------------------
    add(
        "instructions",
        "Instructions",
        caps.instructions,
        [] if caps.instructions else ["Target cannot carry the Skill's instructions and guardrails."],
        failing="unsupported",
    )
    if any(p.runtimeRequirements.requiresLLM for p in portables):
        add(
            "llm",
            "LLM",
            caps.llm,
            [] if caps.llm else ["Skill requires an LLM, but the Target does not provide one."],
            failing="unsupported",
        )
    add(
        "structuredInput",
        "Structured Input",
        caps.structuredInput,
        [] if caps.structuredInput else ["Target cannot honor a structured input contract."],
        manual_step="Validate the Skill input against the input contract in the calling application.",
    )
    add(
        "structuredOutput",
        "Structured Output",
        caps.structuredOutput,
        [] if caps.structuredOutput else ["Target cannot honor a structured output contract."],
        manual_step="Validate the Skill output against the output contract in the calling application.",
    )

    # ---- tools / MCP ---------------------------------------------------------------------------
    tool_ids = sorted({t.id for p in portables for t in p.requiredTools})
    if tool_ids:
        add(
            "tools",
            "Tools",
            caps.tools,
            [] if caps.tools else [f"Target cannot provide the required tool(s): {', '.join(tool_ids)}."],
            manual_step=f"Provide equivalent implementations for tool(s): {', '.join(tool_ids)}.",
        )
    if any(p.runtimeRequirements.requiresMcp for p in portables):
        mcp_tools = sorted({t.id for p in portables for t in p.requiredTools if t.protocol == "mcp"})
        detail = f" (tools: {', '.join(mcp_tools)})" if mcp_tools else ""
        # A carrier (declarative) format records the MCP requirement. A runtime Target may
        # SUPPORT MCP, but an export can never configure an MCP server for the user.
        mcp_ok = caps.mcp and profile.declarative
        if not caps.mcp:
            mcp_reasons = [f"This Skill requires MCP{detail}; the Target cannot use MCP."]
        elif not profile.declarative:
            mcp_reasons = [f"This Skill requires MCP{detail}; the export cannot configure MCP servers for you."]
        else:
            mcp_reasons = []
        add(
            "mcp",
            "MCP",
            mcp_ok,
            mcp_reasons,
            manual_step="Configure the MCP server/tools required by this Skill on the Target runtime.",
        )

    # ---- knowledge ----------------------------------------------------------------------------
    if any(p.runtimeRequirements.requiresKnowledge for p in portables):
        reasons: list[str] = []
        knowledge_entries = [k for p in portables for k in p.knowledge]
        documents = [d for k in knowledge_entries for d in k.documents]
        if not caps.knowledge:
            reasons.append("Target has no knowledge retrieval; documents cannot be searched automatically.")
        if any(k.scope == "workspace" for k in knowledge_entries):
            reasons.append(
                "Workspace-wide knowledge is References Only; the consumer must provide its own corpus."
            )
        # A COUNT, never file names: a compatibility answer must not expose document metadata
        # (the caller may not be allowed to export those documents at all).
        missing = {d.ref for d in documents if not d.included}
        if missing:
            reasons.append(f"{len(missing)} knowledge document(s) are not included in this export; provide them separately.")
        add(
            "knowledge",
            "Knowledge",
            caps.knowledge,
            reasons,
            manual_step="Provide the Skill's knowledge documents and a retrieval mechanism on the Target.",
        )

    # ---- code execution & capabilities without a dedicated profile flag -----------------------
    if any(p.runtimeRequirements.requiresCodeExecution for p in portables):
        add(
            "codeExecution",
            "Code Execution",
            caps.codeExecution,
            [] if caps.codeExecution else ["Skill needs sandboxed code execution; the Target does not provide it."],
            manual_step="Provide a sandboxed code-execution environment on the Target.",
        )
    capability_ids = sorted({c.id for p in portables for c in p.requiredCapabilities})
    for cap_id in ("file-analysis", "image-generation", "web-search"):
        if cap_id in capability_ids:
            ok = cap_id in caps.supportedCapabilities
            add(
                f"capability.{cap_id}",
                cap_id.replace("-", " ").title(),
                ok,
                [] if ok else [f"Target does not support the '{cap_id}' capability."],
                manual_step=f"Provide the '{cap_id}' capability on the Target.",
            )

    # ---- workflow & semantics ------------------------------------------------------------------
    all_steps = [(s, step) for s in skills for step in s.portable.workflow]

    def ids(predicate) -> str:  # type: ignore[no-untyped-def]
        return ", ".join(sorted({f"{step.id}" for _s, step in all_steps if predicate(step)}))

    if any(len(p.workflow) > 1 for p in portables):
        add(
            "workflow",
            "Workflow",
            caps.workflow,
            [] if caps.workflow else ["Target cannot represent a multi-step workflow."],
            manual_step="Orchestrate the multi-step workflow in the calling application.",
        )
        add(
            "workflow.sequentialSteps",
            "Sequential Steps",
            sem.sequentialSteps,
            [] if sem.sequentialSteps else ["Target does not enforce step ordering; steps are described, not guaranteed."],
            manual_step="Run the workflow steps in the declared order in the calling application.",
        )

    def semantic(check_id: str, label: str, used: bool, supported: bool, what: str, step_ids: str) -> None:
        if not used:
            return
        add(
            check_id,
            label,
            supported,
            [] if supported else [f"Target does not enforce {what} (steps: {step_ids})."],
            manual_step=f"Implement {what} handling in the calling application (steps: {step_ids}).",
        )

    condition_used = any(step.kind == "condition" or step.condition is not None for _s, step in all_steps)
    if condition_used:
        cond_ids = ids(lambda st: st.kind == "condition" or st.condition is not None)
        cond_reasons: list[str] = []
        if not sem.condition:
            cond_reasons.append(f"Target does not enforce conditions (steps: {cond_ids}).")
        cond_reasons.append(
            "AI Builder's own Runtime does not evaluate `condition` either, so its semantics are declaration-only."
        )
        add(
            "workflow.condition",
            "Condition",
            False,
            cond_reasons,
            manual_step=f"Define and evaluate the step conditions yourself (steps: {cond_ids}).",
        )
    semantic(
        "workflow.retry", "Retry",
        any(st.onError is not None and st.onError.action == "retry" for _s, st in all_steps),
        sem.retry, "retry",
        ids(lambda st: st.onError is not None and st.onError.action == "retry"),
    )
    semantic(
        "workflow.fallback", "Fallback",
        any(st.onError is not None and st.onError.action == "fallback" for _s, st in all_steps),
        sem.fallback, "fallback",
        ids(lambda st: st.onError is not None and st.onError.action == "fallback"),
    )
    semantic(
        "workflow.skip", "Skip",
        any(st.onError is not None and st.onError.action == "skip" for _s, st in all_steps),
        sem.skip, "skip-on-error",
        ids(lambda st: st.onError is not None and st.onError.action == "skip"),
    )
    semantic(
        "workflow.fail", "Fail Policy",
        any(st.onError is not None and st.onError.action == "fail" for _s, st in all_steps),
        sem.fail, "fail-fast",
        ids(lambda st: st.onError is not None and st.onError.action == "fail"),
    )
    semantic(
        "workflow.inputMapping", "Input Mapping",
        any(bool(st.input) for _s, st in all_steps),
        sem.inputMapping, "input mapping",
        ids(lambda st: bool(st.input)),
    )
    semantic(
        "workflow.outputMapping", "Output Mapping",
        any(p.outputMapping for p in portables),
        sem.outputMapping, "output mapping",
        ", ".join(sorted({s.portable.name for s in skills if s.portable.outputMapping})),
    )

    # ---- nested skills -------------------------------------------------------------------------
    if any(p.runtimeRequirements.requiresNestedSkill for p in portables):
        nested_reasons: list[str] = []
        child_aliases = ", ".join(graph.children)
        if not caps.nestedSkill:
            nested_reasons.append("Target has no Nested Skill support.")
            nested_reasons.append(
                "Child Skills are included; they must be inlined or orchestrated manually."
                if effective.includeChildSkills
                else "Child Skills are not included, so the delegated behavior cannot be reproduced."
            )
        elif not effective.includeChildSkills:
            nested_reasons.append(f"Child Skills are not included; provide them separately ({child_aliases}).")
        depth = graph.nested_depth()
        limit = root.runtimeLimits.maxNestedSkillDepth
        if limit is not None and depth > limit:
            nested_reasons.append(
                f"Nesting depth {depth} exceeds maxNestedSkillDepth {limit}; "
                "the source Runtime would refuse the deeper calls."
            )
        failing: CompatibilityStatus = (
            "unsupported" if (not caps.nestedSkill and not effective.includeChildSkills) else "partial"
        )
        add(
            "nestedSkill",
            "Nested Skill",
            caps.nestedSkill,
            nested_reasons,
            failing=failing,
            manual_step=f"Provide the Child Skills ({child_aliases}) and orchestrate their calls on the Target.",
        )

    nested_approval = [alias for alias, s in graph.children.items() if s.portable.runtimeRequirements.requiresApproval]
    if nested_approval:
        add(
            "nestedApproval",
            "Nested Approval",
            False,
            [
                "Approval inside a nested Skill is not supported by the source Runtime "
                f"(NESTED_SKILL_APPROVAL_NOT_SUPPORTED): {', '.join(nested_approval)}.",
            ],
            failing="unsupported",
        )

    # ---- human approval ------------------------------------------------------------------------
    if root.runtimeRequirements.requiresApproval:
        approval_steps = ", ".join(s.id for s in root.workflow if s.requiresApproval)
        add(
            "approval",
            "Human Approval",
            caps.approval,
            [] if caps.approval else [
                f"Target cannot pause for human approval (steps: {approval_steps}); "
                "side effects could run unapproved."
            ],
            manual_step=f"Add a human confirmation before running step(s): {approval_steps}.",
        )

    # ---- runtime limits (declared values; never assumed enforceable) --------------------------
    limits_decl = root.runtimeLimits
    tools_used = bool(tool_ids)
    nested_used = any(p.runtimeRequirements.requiresNestedSkill for p in portables)
    retry_used = any(st.onError is not None and st.onError.action == "retry" for _s, st in all_steps)

    if limits_decl.timeoutSec is not None:
        add(
            "limits.timeoutSec",
            "Timeout Limit",
            lim.timeoutSec,
            [] if lim.timeoutSec else [
                f"Target does not enforce the Skill timeout ({limits_decl.timeoutSec:g}s); apply it in the calling application."
            ],
            affects_level=False,
        )
    if retry_used and limits_decl.retryCount is not None:
        add(
            "limits.retryCount",
            "Retry Limit",
            lim.retryCount,
            [] if lim.retryCount else [
                f"Target does not enforce the default retry limit ({limits_decl.retryCount}); apply it in the calling application."
            ],
            affects_level=False,
        )
    if tools_used and (limits_decl.maxToolCalls or 0) > 0:
        add(
            "limits.maxToolCalls",
            "Tool Call Limit",
            lim.maxToolCalls,
            [] if lim.maxToolCalls else [
                f"Target does not enforce maxToolCalls ({limits_decl.maxToolCalls}); cap tool calls in the calling application."
            ],
            manual_step=f"Cap tool calls at {limits_decl.maxToolCalls} per run in the calling application.",
        )
    if nested_used and (limits_decl.maxNestedSkillDepth or 0) > 0:
        add(
            "limits.maxNestedSkillDepth",
            "Nested Depth Limit",
            lim.maxNestedSkillDepth,
            [] if lim.maxNestedSkillDepth else [
                f"Target does not enforce maxNestedSkillDepth ({limits_decl.maxNestedSkillDepth})."
            ],
            manual_step=f"Cap nested Skill depth at {limits_decl.maxNestedSkillDepth} in the calling application.",
        )

    # ---- Target-specific explanations (Profile notes) ------------------------------------------
    for c in checks:
        note = caps.notes.get(c.id)
        if note and c.status != "supported":
            c.reasons.append(note)

    # ---- aggregate -----------------------------------------------------------------------------
    worst = max((_RANK[c.status] for c in checks if c.affectsLevel), default=0)
    level: CompatibilityLevel = ("full", "partial", "unsupported")[worst]  # type: ignore[assignment]

    warnings = [
        CompatibilityWarning(code=_warning_code(c.id), message=reason, checkId=c.id)
        for c in checks
        if c.status != "supported"
        for reason in c.reasons
    ]
    warnings.extend(CompatibilityWarning(code=code, message=message, checkId="export") for code, message in (notes or []))

    all_tools = [t for p in portables for t in p.requiredTools]
    needs_mcp_substitute = caps.mcp and not caps.tools and not profile.declarative
    knowledge_entries = [k for p in portables for k in p.knowledge]
    documents = {d.ref: d for k in knowledge_entries for d in k.documents}
    summary = CompatibilitySummary(
        requiredMcp=sorted({t.id for t in all_tools if t.protocol == "mcp" or needs_mcp_substitute}),
        knowledge=KnowledgeSummary(
            documents=len(documents),
            included=sum(1 for d in documents.values() if d.included),
            workspaceScope=any(k.scope == "workspace" for k in knowledge_entries),
        ),
        unsupportedCapabilities=[
            UnsupportedCapability(id=c.id, label=c.label, status=c.status)
            for c in checks
            if c.status != "supported" and c.affectsLevel
        ],
    )

    return CompatibilityResult(
        target=profile.target,
        format=profile.format,
        level=level,
        checks=checks,
        warnings=warnings,
        manualSteps=manual,
        summary=summary,
    )
