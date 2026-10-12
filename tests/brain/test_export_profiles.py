import pytest

from app.common.errors import AppError
from app.exports.adapters import get_adapter, has_adapter, register_adapter, unregister_adapter
from app.exports.adapters.generic_markdown import GenericMarkdownAdapter
from app.exports.models import ExportTargetProfile
from app.exports.pipeline import build_export
from app.exports.profiles import (
    FormatDefinition,
    TargetDefinition,
    get_format,
    list_targets,
    register_target,
    resolve_profile,
    unregister_target,
)
from app.exports.profiles.generic import _MARKDOWN
from export_helpers import make_request, prompt_spec


def code(exc: pytest.ExceptionInfo[AppError]) -> str:
    return exc.value.details["code"]


def test_built_in_targets_and_formats():
    targets = {t.id: [f.id for f in t.formats] for t in list_targets()}
    assert targets == {"generic": ["portable-package", "markdown", "raw-spec"], "claude": ["skill-package"]}


def test_every_profile_declares_llm_and_fine_grained_workflow_semantics():
    for target in list_targets():
        for fmt in target.formats:
            profile = resolve_profile(target.id, fmt.id)
            assert isinstance(profile, ExportTargetProfile)
            assert isinstance(profile.capabilities.llm, bool)
            assert set(profile.capabilities.workflowSemantics.model_dump()) == {
                "sequentialSteps", "condition", "retry", "fallback", "skip", "fail", "inputMapping", "outputMapping",
            }
            assert set(profile.capabilities.runtimeLimits.model_dump()) == {
                "timeoutSec", "retryCount", "maxToolCalls", "maxNestedSkillDepth",
            }


def test_carrier_formats_preserve_everything_while_markdown_enforces_nothing():
    package = resolve_profile("generic", "portable-package")
    assert package.declarative is True
    assert all(package.capabilities.workflowSemantics.model_dump().values())
    caps = package.capabilities
    assert caps.tools and caps.mcp and caps.knowledge and caps.nestedSkill and caps.approval

    markdown = resolve_profile("generic", "markdown")
    assert markdown.declarative is False
    assert not any(markdown.capabilities.workflowSemantics.model_dump().values())
    assert not any(markdown.capabilities.runtimeLimits.model_dump().values())
    assert not (markdown.capabilities.tools or markdown.capabilities.mcp or markdown.capabilities.knowledge)


def test_claude_profile_states_what_a_skill_package_can_and_cannot_do():
    profile = resolve_profile("claude", "skill-package")
    caps = profile.capabilities
    assert profile.declarative is False
    assert caps.llm and caps.instructions and caps.knowledge and caps.mcp
    assert not caps.tools  # this platform's builtin tools do not exist in Claude
    assert not caps.nestedSkill and not caps.approval and not caps.codeExecution
    semantics = caps.workflowSemantics
    # An ordered procedure with conditions and data flow is native to a Skill ...
    assert semantics.sequentialSteps and semantics.condition and semantics.inputMapping and semantics.outputMapping
    # ... error POLICIES and runtime limits are system behaviour a package cannot guarantee.
    assert not (semantics.retry or semantics.fallback or semantics.skip or semantics.fail)
    assert not any(caps.runtimeLimits.model_dump().values())
    assert caps.notes["tools"] and "MCP" in caps.notes["tools"]


def test_format_options_a_format_can_honor():
    package, markdown, raw, claude = (
        get_format("generic", "portable-package"),
        get_format("generic", "markdown"),
        get_format("generic", "raw-spec"),
        get_format("claude", "skill-package"),
    )
    assert (package.embeds_knowledge, package.embeds_children, package.embeds_source_spec) == (True, True, True)
    assert (markdown.embeds_knowledge, markdown.embeds_children, markdown.embeds_source_spec) == (False, True, False)
    assert (raw.embeds_knowledge, raw.embeds_children, raw.embeds_source_spec) == (False, False, False)
    assert (claude.embeds_knowledge, claude.embeds_children, claude.embeds_source_spec) == (True, True, True)
    assert claude.target_optimized and not package.target_optimized and not markdown.target_optimized


# ---------------- error semantics: unsupported target vs missing adapter ----------------


def test_unknown_target_is_EXPORT_TARGET_UNSUPPORTED():
    with pytest.raises(AppError) as exc:
        resolve_profile("no-such-target", "x")
    assert code(exc) == "EXPORT_TARGET_UNSUPPORTED"
    assert exc.value.details["supported"] == ["claude", "generic"]


def test_known_target_with_an_unknown_format_is_EXPORT_FORMAT_UNSUPPORTED():
    with pytest.raises(AppError) as exc:
        resolve_profile("claude", "markdown")
    assert code(exc) == "EXPORT_FORMAT_UNSUPPORTED"
    assert exc.value.details["supported"] == ["skill-package"]


def test_supported_target_without_an_adapter_is_EXPORT_TARGET_ADAPTER_UNAVAILABLE():
    register_target(
        TargetDefinition(
            id="custom-runtime",
            display_name="Custom Runtime",
            formats=(FormatDefinition(id="bundle", display_name="Bundle", content_type="application/zip", capabilities=_MARKDOWN),),
        )
    )
    try:
        assert resolve_profile("custom-runtime", "bundle").target == "custom-runtime"  # the target IS supported
        assert not has_adapter("custom-runtime", "bundle")
        with pytest.raises(AppError) as exc:
            get_adapter("custom-runtime", "bundle")
        assert code(exc) == "EXPORT_TARGET_ADAPTER_UNAVAILABLE"

        # A real export fails with that exact code (not UNSUPPORTED) ...
        request = make_request(prompt_spec(), fmt=("custom-runtime", "bundle"))
        with pytest.raises(AppError) as exc:
            build_export(request)
        assert code(exc) == "EXPORT_TARGET_ADAPTER_UNAVAILABLE"

        # ... while compatibility analysis still works.
        dry = build_export(make_request(prompt_spec(), fmt=("custom-runtime", "bundle"), dry_run=True))
        assert dry.compatibility.target == "custom-runtime" and dry.files == []
    finally:
        unregister_target("custom-runtime")


def test_adding_a_target_needs_only_a_profile_and_an_adapter():
    """Extensibility contract: no SkillSpec / Runtime change — register a Profile + an Adapter."""

    class EchoAdapter(GenericMarkdownAdapter):
        target_id = "echo"
        format_id = "text"

        def filename(self, graph):  # type: ignore[no-untyped-def]
            return f"{graph.archive_root}-v{graph.root.version}.txt"

    register_target(
        TargetDefinition(
            id="echo",
            display_name="Echo",
            formats=(FormatDefinition(id="text", display_name="Plain text", content_type="text/plain", capabilities=_MARKDOWN),),
        )
    )
    register_adapter(EchoAdapter())
    try:
        response = build_export(make_request(prompt_spec(), fmt=("echo", "text")))
        assert response.compatibility.target == "echo" and response.filename.endswith("-v1.txt")
        assert response.contentType == "text/plain"
    finally:
        unregister_adapter("echo", "text")
        unregister_target("echo")
    assert "echo" not in {t.id for t in list_targets()}
