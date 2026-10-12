from app.common.tools.interface import ToolDescriptor
from app.exports.compatibility import analyze
from app.exports.compiler import compile_graph
from app.exports.models import ExportTargetProfile, ProfileCapabilities
from app.exports.pipeline import build_export, effective_options
from app.exports.profiles import get_format, resolve_profile
from export_helpers import child, composite_spec, document, knowledge_spec, make_request, prompt_spec, workflow_spec


def analyze_request(tools=None, **kwargs):
    request = make_request(**kwargs)
    fmt = get_format(request.options.target, request.options.format)
    effective = effective_options(fmt, request.options)
    graph = compile_graph(request, effective, tools)
    profile = resolve_profile(request.options.target, request.options.format)
    return analyze(graph, profile, effective), graph


def result_for(**kwargs):
    return analyze_request(**kwargs)[0]


def check(result, check_id):
    return next(c for c in result.checks if c.id == check_id)


def mcp_tools():
    return {
        "file-parser": ToolDescriptor("file-parser", "FP", {"type": "object"}, {"type": "object"}, "parse files", "mcp"),
        "python-data-analysis": ToolDescriptor("python-data-analysis", "PDA", {"type": "object"}, {"type": "object"}, "x", "builtin"),
    }


def test_levels_are_lowercase_canonical_values():
    result = result_for(spec=prompt_spec(), fmt="generic-markdown")
    assert result.level in {"full", "partial", "unsupported"}
    assert all(c.status in {"supported", "partial", "unsupported"} for c in result.checks)
    assert (result.target, result.format) == ("generic", "markdown")


# ---------------- FULL ----------------


def test_prompt_skill_is_full_for_markdown_even_though_it_cannot_enforce_the_timeout():
    result = result_for(spec=prompt_spec(), fmt="generic-markdown")
    assert result.level == "full"
    timeout = check(result, "limits.timeoutSec")
    assert timeout.status == "partial" and timeout.affectsLevel is False  # advisory: reported, never downgrades
    assert any(w.checkId == "limits.timeoutSec" for w in result.warnings)  # still a Warning, not silent
    assert result.manualSteps == []


def test_prompt_skill_is_full_for_package_raw_and_claude():
    for fmt in ("portable-package", "raw-spec", "claude"):
        assert result_for(spec=prompt_spec(), fmt=fmt).level == "full", fmt


# ---------------- PARTIAL: reasons, no silent drops ----------------


def test_tool_workflow_to_markdown_is_partial_with_reasons_and_manual_steps():
    result = result_for(spec=workflow_spec(), fmt="generic-markdown")
    assert result.level == "partial"
    for check_id in ("tools", "codeExecution", "workflow.retry", "workflow.fallback", "workflow.skip", "workflow.fail"):
        assert check(result, check_id).status == "partial", check_id
        assert check(result, check_id).reasons
    assert check(result, "tools").reasons[0].endswith("file-parser, python-data-analysis.")
    assert result.manualSteps and any("tool" in s.lower() for s in result.manualSteps)


def test_every_non_supported_check_produces_a_warning():
    for fmt in ("generic-markdown", "claude"):
        result = result_for(spec=workflow_spec(), fmt=fmt)
        for c in result.checks:
            if c.status != "supported":
                assert [w for w in result.warnings if w.checkId == c.id], (fmt, c.id)
        assert all(w.code.startswith("COMPAT_") or w.checkId == "export" for w in result.warnings)


def test_claude_explains_tools_in_terms_of_mcp_and_lists_required_mcp():
    result = result_for(spec=workflow_spec(), fmt="claude")
    assert result.level == "partial"
    tools = check(result, "tools")
    assert tools.status == "partial"
    assert "file-parser, python-data-analysis" in tools.reasons[0]
    assert any("MCP server" in r for r in tools.reasons)  # the Claude-specific note
    assert result.summary.requiredMcp == ["file-parser", "python-data-analysis"]
    assert any("tool" in step.lower() for step in result.manualSteps)


def test_mcp_protocol_tools_are_partial_even_where_the_target_supports_mcp():
    # Claude supports MCP, but a package cannot configure an MCP server for the user.
    result = result_for(spec=workflow_spec(), fmt="claude", tools=mcp_tools())
    mcp = check(result, "mcp")
    assert mcp.status == "partial" and "cannot configure MCP" in mcp.reasons[0]
    assert any("MCP" in step for step in result.manualSteps)
    assert "file-parser" in result.summary.requiredMcp


def test_declarative_carriers_record_an_mcp_requirement_instead_of_failing_it():
    result = result_for(spec=workflow_spec(), fmt="portable-package", tools=mcp_tools())
    assert check(result, "mcp").status == "supported"
    assert result.summary.requiredMcp == ["file-parser"]  # only the protocol=mcp tool


def test_markdown_cannot_use_mcp_at_all():
    result = result_for(spec=workflow_spec(), fmt="generic-markdown", tools=mcp_tools())
    mcp = check(result, "mcp")
    assert mcp.status == "partial" and "cannot use MCP" in mcp.reasons[0]
    assert result.summary.requiredMcp == ["file-parser"]


def test_claude_follows_order_and_mapping_but_cannot_enforce_error_policies_or_the_tool_call_cap():
    result = result_for(spec=workflow_spec(), fmt="claude")
    cap = check(result, "limits.maxToolCalls")
    assert cap.status == "partial" and cap.affectsLevel is True
    assert check(result, "workflow.sequentialSteps").status == "supported"
    for policy in ("retry", "fallback", "skip", "fail"):
        c = check(result, f"workflow.{policy}")
        assert c.status == "partial", policy
        assert len(c.reasons) == 2 and "Claude" in c.reasons[1], policy  # generic reason + Claude-specific explanation


def test_a_plain_multi_step_skill_without_error_policies_is_full_on_claude():
    spec = prompt_spec()
    spec["execution"]["steps"] = [
        {"id": "a", "name": "A", "type": "llm"},
        {"id": "b", "name": "B", "type": "llm", "inputMap": {"x": {"$ref": "steps.a.output"}}},
    ]
    assert result_for(spec=spec, fmt="claude").level == "full"
    assert result_for(spec=spec, fmt="generic-markdown").level == "partial"  # markdown enforces no ordering/mapping


def test_approval_unsupported_is_partial_not_silently_dropped():
    spec = workflow_spec()
    spec["execution"]["steps"][2]["approvalRequired"] = True
    for fmt in ("generic-markdown", "claude"):
        approval = check(result_for(spec=spec, fmt=fmt), "approval")
        assert approval.status == "partial" and "aggregate" in approval.reasons[0]
    claude = result_for(spec=spec, fmt="claude")
    assert any("ask for your confirmation" in r for r in check(claude, "approval").reasons)
    assert any("aggregate" in s and "confirmation" in s for s in claude.manualSteps)
    assert check(result_for(spec=spec, fmt="portable-package"), "approval").status == "supported"


def test_condition_is_never_fully_supported_because_the_source_runtime_does_not_evaluate_it():
    spec = prompt_spec()
    spec["execution"]["steps"][0]["condition"] = "input.text != ''"
    package = result_for(spec=spec, fmt="portable-package")
    cond = check(package, "workflow.condition")
    assert cond.status == "partial" and any("does not evaluate" in r for r in cond.reasons)
    assert package.level == "partial"


def test_runtime_limits_unsupported_by_target_generate_warnings():
    result = result_for(spec=workflow_spec(), fmt="generic-markdown")
    assert {"limits.timeoutSec", "limits.retryCount", "limits.maxToolCalls"} <= {w.checkId for w in result.warnings}


# ---------------- knowledge ----------------


def test_knowledge_references_only_is_partial_and_include_is_full_for_package_and_claude():
    spec = knowledge_spec(["d1"])
    docs = [document("d1", "policy.txt", "content")]
    for fmt in ("portable-package", "claude"):
        refs_only = result_for(spec=spec, documents=docs, fmt=fmt, include_knowledge=False)
        assert refs_only.level == "partial", fmt
        assert check(refs_only, "knowledge").reasons[0] == "1 knowledge document(s) are not included in this export; provide them separately."
        assert "policy.txt" not in str(refs_only.model_dump())  # counts only — never document names
        assert refs_only.summary.knowledge.model_dump() == {"documents": 1, "included": 0, "workspaceScope": False}
        included = result_for(spec=spec, documents=docs, fmt=fmt, include_knowledge=True)
        assert included.level == "full", fmt
        assert included.summary.knowledge.model_dump() == {"documents": 1, "included": 1, "workspaceScope": False}


def test_markdown_cannot_embed_documents_and_says_so():
    spec = knowledge_spec(["d1"])
    result = result_for(spec=spec, documents=[document("d1", "policy.txt", "c")], fmt="generic-markdown", include_knowledge=True)
    assert result.level == "partial"
    assert check(result, "knowledge").status == "partial"


def test_workspace_scope_knowledge_is_always_references_only():
    spec = knowledge_spec([], mode="workspace")
    for fmt in ("portable-package", "claude"):
        result = result_for(spec=spec, fmt=fmt, include_knowledge=True)
        assert result.level == "partial"
        assert any("Workspace-wide" in r for r in check(result, "knowledge").reasons)
        assert result.summary.knowledge.workspaceScope is True


# ---------------- nested skills ----------------


def nested_fixture():
    parent = composite_spec("c1")
    return parent, [child("c1", "Parser", prompt_spec(name="Parser"))]


def test_nested_unsupported_target_without_children_is_unsupported_with_children_is_partial():
    parent, children = nested_fixture()
    not_included = result_for(spec=parent, children=children, fmt="claude", include_children=False)
    assert check(not_included, "nestedSkill").status == "unsupported"
    assert not_included.level == "unsupported"
    included = result_for(spec=parent, children=children, fmt="claude", include_children=True)
    assert check(included, "nestedSkill").status == "partial"
    assert included.level == "partial"
    assert any("bundled as additional skill files" in r for r in check(included, "nestedSkill").reasons)


def test_package_with_children_is_full_and_without_is_partial():
    parent, children = nested_fixture()
    assert result_for(spec=parent, children=children, fmt="portable-package", include_children=True).level == "full"
    without = result_for(spec=parent, children=children, fmt="portable-package", include_children=False)
    assert without.level == "partial"
    assert "child:parser" in check(without, "nestedSkill").reasons[0]


def test_nested_approval_known_limitation_is_unsupported_everywhere():
    parent, _ = nested_fixture()
    approving_child = prompt_spec(name="Parser")
    approving_child["execution"]["steps"][0]["approvalRequired"] = True
    for fmt in ("portable-package", "claude"):
        result = result_for(spec=parent, children=[child("c1", "Parser", approving_child)], fmt=fmt, include_children=True)
        nested_approval = check(result, "nestedApproval")
        assert nested_approval.status == "unsupported"
        assert "NESTED_SKILL_APPROVAL_NOT_SUPPORTED" in nested_approval.reasons[0]
        assert result.level == "unsupported"


def test_nesting_deeper_than_declared_limit_is_flagged():
    parent = composite_spec("mid")
    parent["runtime"]["maxNestedSkillDepth"] = 1
    result = result_for(
        spec=parent,
        children=[child("mid", "Mid", composite_spec("leaf", name="Mid")), child("leaf", "Leaf", prompt_spec(name="Leaf"))],
        fmt="portable-package",
        include_children=True,
    )
    assert any("depth 2 exceeds maxNestedSkillDepth 1" in r for r in check(result, "nestedSkill").reasons)
    assert result.level == "partial"


# ---------------- UNSUPPORTED capability ----------------


def custom_profile(**overrides) -> ExportTargetProfile:
    base = resolve_profile("generic", "markdown").capabilities.model_dump()
    base.update(overrides)
    return ExportTargetProfile(
        target="custom", format="x", displayName="Custom", declarative=False, capabilities=ProfileCapabilities.model_validate(base)
    )


def analyze_with(profile, **kwargs):
    request = make_request(**kwargs)
    effective = effective_options(get_format("generic", "markdown"), request.options)
    return analyze(compile_graph(request, effective), profile, effective)


def test_target_without_llm_makes_an_llm_skill_unsupported():
    result = analyze_with(custom_profile(llm=False), spec=prompt_spec(), fmt="generic-markdown")
    assert check(result, "llm").status == "unsupported"
    assert result.level == "unsupported"
    assert "LLM" in check(result, "llm").reasons[0]
    assert {c.id for c in result.summary.unsupportedCapabilities} == {"llm"}


def test_target_without_instructions_is_unsupported():
    assert analyze_with(custom_profile(instructions=False), spec=prompt_spec(), fmt="generic-markdown").level == "unsupported"


def test_unsupported_always_explains_why():
    parent, children = nested_fixture()
    result = result_for(spec=parent, children=children, fmt="claude")
    assert result.level == "unsupported"
    assert all(c.reasons for c in result.checks if c.status == "unsupported")


# ---------------- summary & option adjustments ----------------


def test_summary_lists_only_level_affecting_gaps():
    result = result_for(spec=workflow_spec(), fmt="generic-markdown")
    ids = {c.id for c in result.summary.unsupportedCapabilities}
    assert "tools" in ids and "workflow.retry" in ids
    assert "limits.timeoutSec" not in ids  # advisory
    assert result_for(spec=prompt_spec(), fmt="portable-package").summary.unsupportedCapabilities == []


def test_option_adjustments_are_reported_not_applied_silently():
    spec = knowledge_spec(["d1"])
    response = build_export(
        make_request(
            spec=spec, documents=[document("d1", "a.txt", "x")], fmt="generic-markdown",
            include_knowledge=True, include_source=True, dry_run=True,
        )
    )
    codes = {w.code for w in response.compatibility.warnings}
    assert "EXPORT_OPTION_KNOWLEDGE_REFERENCES_ONLY" in codes
    assert "EXPORT_OPTION_SOURCE_SPEC_IGNORED" in codes
    assert response.effectiveOptions.includeKnowledge is False
    assert response.effectiveOptions.includeSourceSpec is False
