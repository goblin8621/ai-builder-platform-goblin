import copy
import json
from pathlib import Path

import pytest
from jsonschema import Draft7Validator

from app.common.errors import AppError
from app.common.tools.interface import ToolDescriptor
from app.exports.compiler import compile_graph
from app.exports.models import dump_portable
from app.exports.archive import stable_id
from app.exports.pipeline import effective_options
from app.exports.profiles import get_format
from export_helpers import (
    FIXTURES,
    child,
    composite_spec,
    document,
    knowledge_spec,
    load_spec_fixture,
    make_request,
    prompt_spec,
    workflow_spec,
)

SCHEMA = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "portable-skill.schema.json").read_text())
VALIDATOR = Draft7Validator(SCHEMA)
PORTABLE_FIXTURES = FIXTURES / "portable-skill"


def effective_for(request):
    return effective_options(get_format(request.options.target, request.options.format), request.options)


def compile_request(**kwargs):
    request = make_request(**kwargs)
    return compile_graph(request, effective_for(request))


def code_of(exc: pytest.ExceptionInfo[AppError]) -> str:
    return exc.value.details["code"]


# ---------------- contract / golden ----------------


@pytest.mark.parametrize(
    "fixture,spec_name",
    [("valid-prompt.portable.json", "valid-prompt-skill.json"), ("valid-workflow.portable.json", "valid-workflow-skill.json")],
)
def test_compile_matches_golden_fixture_and_schema(fixture, spec_name):
    graph = compile_request(spec=load_spec_fixture(spec_name), skill_id="skill-001", version=1)
    produced = dump_portable(graph.root.portable)
    golden = json.loads((PORTABLE_FIXTURES / fixture).read_text())
    assert produced == golden
    assert list(VALIDATOR.iter_errors(produced)) == []


@pytest.mark.parametrize("fixture", sorted(p.name for p in PORTABLE_FIXTURES.glob("invalid-*.json")))
def test_invalid_portable_fixtures_are_rejected_by_schema(fixture):
    data = json.loads((PORTABLE_FIXTURES / fixture).read_text())
    assert list(VALIDATOR.iter_errors(data)) != []


def test_there_are_valid_and_invalid_fixtures():
    assert list(PORTABLE_FIXTURES.glob("valid-*.json"))
    assert list(PORTABLE_FIXTURES.glob("invalid-*.json"))


def test_pydantic_models_mirror_the_json_schema_fields():
    from app.exports.models import (
        PortableRuntimeLimits,
        PortableRuntimeRequirements,
        PortableSkill,
        PortableStep,
    )

    assert set(PortableSkill.model_fields) == set(SCHEMA["properties"])
    assert set(PortableStep.model_fields) == set(SCHEMA["definitions"]["step"]["properties"])
    assert set(PortableRuntimeRequirements.model_fields) == set(SCHEMA["properties"]["runtimeRequirements"]["properties"])
    assert set(PortableRuntimeLimits.model_fields) == set(SCHEMA["properties"]["runtimeLimits"]["properties"])


# ---------------- neutrality ----------------


def test_portable_skill_has_no_model_registry_id_or_provider_fields():
    spec = prompt_spec()
    assert spec["model"]["modelId"] == "model-001"
    graph = compile_request(spec=spec)
    text = json.dumps(dump_portable(graph.root.portable))
    assert "model-001" not in text
    assert "modelId" not in text
    assert '"model"' not in text


def test_guardrails_and_runtime_limits_are_carried_as_declared_values():
    graph = compile_request(spec=workflow_spec())
    portable = dump_portable(graph.root.portable)
    assert portable["guardrails"] == ["외부로 원본 파일을 전송하지 않음"]
    assert portable["runtimeLimits"] == {
        "timeoutSec": 120,
        "retryCount": 2,
        "maxToolCalls": 8,
        "maxNestedSkillDepth": 0,
    }


def test_source_metadata_only_when_include_source_spec():
    spec = prompt_spec()
    off = dump_portable(compile_request(spec=spec, skill_id="internal-skill-id-123", version=7).root.portable)
    assert "source" not in off and "sourceSpec" not in off
    assert "internal-skill-id-123" not in json.dumps(off)

    on = dump_portable(
        compile_request(spec=spec, skill_id="internal-skill-id-123", version=7, include_source=True).root.portable
    )
    assert on["source"] == {"skillId": "internal-skill-id-123", "skillVersion": 7}
    assert on["sourceSpec"] == spec
    assert list(VALIDATOR.iter_errors(on)) == []


# ---------------- workflow / requirements ----------------


def test_workflow_semantics_are_preserved_not_dropped():
    spec = workflow_spec()
    spec["execution"]["steps"][2]["approvalRequired"] = True
    spec["execution"]["steps"][4]["inputMap"] = {"rows": {"$ref": "steps.parse.output.rows"}, "mode": "static"}
    spec["execution"]["steps"][4]["condition"] = "steps.parse.output.rowCount > 0"
    spec["execution"]["outputMap"] = {"summary": {"$ref": "steps.summarize.output.summary"}}
    portable = dump_portable(compile_request(spec=spec).root.portable)

    steps = {s["id"]: s for s in portable["workflow"]}
    assert [s["id"] for s in portable["workflow"]] == ["parse", "validate", "aggregate", "anomaly", "summarize"]
    assert steps["parse"]["ref"] == "file-parser" and steps["parse"]["kind"] == "tool"
    assert steps["validate"]["onError"] == {"action": "retry", "retryCount": 2}
    assert steps["aggregate"]["onError"] == {"action": "fallback", "fallbackStepId": "summarize"}
    assert steps["aggregate"]["requiresApproval"] is True
    assert steps["anomaly"]["onError"] == {"action": "skip"}
    assert steps["summarize"]["input"] == {"rows": {"$ref": "steps.parse.output.rows"}, "mode": "static"}
    assert steps["summarize"]["condition"] == "steps.parse.output.rowCount > 0"
    assert portable["outputMapping"] == {"summary": {"$ref": "steps.summarize.output.summary"}}
    assert list(VALIDATOR.iter_errors(portable)) == []


def test_runtime_requirements_and_capabilities_for_a_tool_workflow():
    portable = dump_portable(compile_request(spec=workflow_spec()).root.portable)
    assert portable["runtimeRequirements"] == {
        "requiresLLM": True,
        "requiresTools": True,
        "requiresMcp": False,
        "requiresKnowledge": False,
        "requiresCodeExecution": True,
        "requiresApproval": False,
        "requiresNestedSkill": False,
    }
    assert [c["id"] for c in portable["requiredCapabilities"]] == ["code-execution", "data-analysis", "file-analysis"]
    assert [t["id"] for t in portable["requiredTools"]] == ["file-parser", "python-data-analysis"]
    assert all(t["protocol"] == "builtin" and t["description"] for t in portable["requiredTools"])


def test_unknown_tool_fails_instead_of_being_dropped():
    spec = workflow_spec()
    spec["execution"]["steps"][0]["refId"] = "tool-that-does-not-exist"
    with pytest.raises(AppError) as exc:
        compile_request(spec=spec)
    assert code_of(exc) == "EXPORT_TOOL_UNKNOWN"
    assert exc.value.details["toolId"] == "tool-that-does-not-exist"


def test_mcp_tool_requirement_is_recorded_with_protocol():
    spec = workflow_spec()
    tools = {
        "file-parser": ToolDescriptor("file-parser", "File Parser", {"type": "object"}, {"type": "object"}, "parse", "mcp"),
        "python-data-analysis": ToolDescriptor(
            "python-data-analysis", "PDA", {"type": "object"}, {"type": "object"}, "analyze", "builtin"
        ),
    }
    request = make_request(spec=spec)
    portable = dump_portable(compile_graph(request, effective_for(request), tools).root.portable)
    protocols = {t["id"]: t["protocol"] for t in portable["requiredTools"]}
    assert protocols == {"file-parser": "mcp", "python-data-analysis": "builtin"}
    assert portable["runtimeRequirements"]["requiresMcp"] is True


def test_invalid_spec_is_rejected():
    spec = prompt_spec()
    spec["unexpected"] = True
    with pytest.raises(AppError) as exc:
        compile_request(spec=spec)
    assert exc.value.code == "validation_error"


# ---------------- child skills / aliases / dependency lock ----------------


def make_composite():
    parser_spec = prompt_spec(name="Parser")
    spec = composite_spec("child-id-aaa")
    return spec, [child("child-id-aaa", "Parser", parser_spec, version=2)]


def test_child_skills_use_package_local_aliases_never_internal_ids():
    spec, children = make_composite()
    graph = compile_request(spec=spec, children=children)
    portable = dump_portable(graph.root.portable)
    assert portable["dependencies"] == [{"ref": "child:parser"}]
    assert portable["workflow"][0]["ref"] == "child:parser"
    assert "child-id-aaa" not in json.dumps(portable)
    assert list(graph.children) == ["child:parser"]
    assert graph.children["child:parser"].version == 2
    assert list(VALIDATOR.iter_errors(portable)) == []


def test_alias_collisions_and_unicode_names_are_stable():
    a, b, c = (prompt_spec(name=n) for n in ("Parser", "parser", "파서"))
    spec = composite_spec("id-a", {"id": "second", "name": "Second", "type": "skill", "refId": "id-b"})
    spec["execution"]["steps"].append({"id": "third", "name": "Third", "type": "skill", "refId": "id-c"})
    children = [child("id-c", "파서", c), child("id-b", "parser", b), child("id-a", "Parser", a)]
    graph = compile_request(spec=spec, children=children)
    assert list(graph.children) == ["child:parser", "child:parser-2", "child:파서"]
    assert graph.aliases.child_alias_by_id == {"id-a": "child:parser", "id-b": "child:parser-2", "id-c": "child:파서"}


def test_missing_or_cyclic_children_fail_clearly():
    spec = composite_spec("ghost")
    with pytest.raises(AppError) as exc:
        compile_request(spec=spec, children=[])
    assert code_of(exc) == "EXPORT_CHILD_UNAVAILABLE"

    a = composite_spec("skill-b", name="A")
    b = composite_spec("skill-a", name="B")
    with pytest.raises(AppError) as exc:
        compile_request(spec=a, skill_id="skill-a", children=[child("skill-a", "A", a), child("skill-b", "B", b)])
    assert code_of(exc) == "EXPORT_DEPENDENCY_CYCLE"

    with pytest.raises(AppError) as exc:
        compile_request(spec=composite_spec("skill-self"), skill_id="skill-self", children=[child("skill-self", "Self", composite_spec("skill-self"))])
    assert code_of(exc) == "EXPORT_DEPENDENCY_CYCLE"


def test_content_hash_is_merkle_over_locked_dependencies():
    grandchild = prompt_spec(name="Leaf")
    mid = composite_spec("leaf", name="Mid")
    top = composite_spec("mid", name="Top")

    def build(leaf_spec, leaf_version=1):
        return compile_request(
            spec=top,
            children=[child("mid", "Mid", mid), child("leaf", "Leaf", leaf_spec, version=leaf_version)],
        )

    base = build(grandchild)
    again = build(copy.deepcopy(grandchild))
    assert base.root.content_hash == again.root.content_hash

    changed_leaf = copy.deepcopy(grandchild)
    changed_leaf["instructions"]["rules"].append("A new rule")
    changed = build(changed_leaf)
    assert changed.children["child:leaf"].content_hash != base.children["child:leaf"].content_hash
    assert changed.children["child:mid"].content_hash != base.children["child:mid"].content_hash  # propagates
    assert changed.root.content_hash != base.root.content_hash

    # The Version NUMBER alone is not content (identical content ⇒ identical hash).
    assert build(grandchild, leaf_version=9).root.content_hash == base.root.content_hash


def test_hash_and_output_do_not_depend_on_input_ordering():
    spec, children = make_composite()
    reordered_spec = json.loads(json.dumps(spec))
    reordered_spec = dict(reversed(list(reordered_spec.items())))
    one = compile_request(spec=spec, children=children)
    two = compile_request(spec=reordered_spec, children=list(reversed(children)))
    assert one.root.content_hash == two.root.content_hash
    assert dump_portable(one.root.portable) == dump_portable(two.root.portable)


# ---------------- knowledge ----------------


def test_selected_documents_use_aliases_and_references_only_has_no_path_or_hash():
    spec = knowledge_spec(["doc-id-1", "doc-id-2"])
    docs = [document("doc-id-1", "Sales Report.csv", None), document("doc-id-2", "../../secret notes.txt", None)]
    portable = dump_portable(compile_request(spec=spec, documents=docs).root.portable)
    assert portable["knowledge"] == [
        {
            "scope": "selected",
            "documents": [
                {"ref": "doc:sales-report-csv", "fileName": "Sales Report.csv", "mimeType": "text/plain", "included": False},
                {"ref": "doc:secret-notes-txt", "fileName": "../../secret notes.txt", "mimeType": "text/plain", "included": False},
            ],
        }
    ]
    assert "doc-id-1" not in json.dumps(portable)
    assert list(VALIDATOR.iter_errors(portable)) == []


def test_included_documents_carry_safe_path_and_normalized_content_hash():
    spec = knowledge_spec(["doc-id-1"])
    docs = [document("doc-id-1", "../../evil.txt", "line1\r\nline2\r\n")]
    graph = compile_request(spec=spec, documents=docs, include_knowledge=True)
    entry = dump_portable(graph.root.portable)["knowledge"][0]["documents"][0]
    assert entry["included"] is True
    # ASCII-safe archive path derived from the stable document id — the hostile display name never reaches a path.
    assert entry["path"] == f"references/document-{stable_id('document', 'doc-id-1')}.txt"
    assert ".." not in entry["path"] and "evil" not in entry["path"]
    from app.exports.canonical import sha256_text

    assert entry["contentHash"] == sha256_text("line1\nline2\n")
    assert graph.docs["doc-id-1"].content == "line1\nline2\n"


def test_workspace_scope_never_lists_documents():
    spec = knowledge_spec([], mode="workspace")
    portable = dump_portable(compile_request(spec=spec, include_knowledge=True).root.portable)
    assert portable["knowledge"] == [{"scope": "workspace", "documents": []}]


def test_include_documents_without_content_is_an_error_not_a_silent_skip():
    spec = knowledge_spec(["doc-id-1"])
    with pytest.raises(AppError) as exc:
        compile_request(spec=spec, documents=[document("doc-id-1", "a.txt", None)], include_knowledge=True)
    assert code_of(exc) == "EXPORT_DOCUMENT_UNAVAILABLE"
    with pytest.raises(AppError) as exc:
        compile_request(spec=spec, documents=[], include_knowledge=False)
    assert code_of(exc) == "EXPORT_DOCUMENT_UNAVAILABLE"
