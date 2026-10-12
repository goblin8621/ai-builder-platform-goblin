from fastapi.testclient import TestClient

from app.main import app
from export_helpers import make_request, prompt_spec

client = TestClient(app)
HEADERS = {"x-user-id": "user-1", "x-workspace-id": "workspace-1", "x-request-id": "req-1"}
OPENAI_STYLE = "sk-" + "Ab3dE5gH7jK9mN1pQ3rS5tU7"


def body(**kwargs):
    return make_request(**kwargs).model_dump(mode="json")


def test_compile_returns_files_manifest_and_compatibility():
    response = client.post("/exports/compile", json=body(spec=prompt_spec(), fmt="portable-package"), headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert data["compatibility"]["level"] == "full"
    assert data["effectiveOptions"] == {"includeKnowledge": False, "includeChildSkills": False, "includeSourceSpec": False}
    assert {f["path"] for f in data["files"]} == {"SKILL.md", "skill.json", "manifest.json"}
    assert data["manifest"]["skill"]["version"] == 1
    assert data["filename"].endswith(".zip") and data["contentType"] == "application/zip"
    assert data["packageRoot"] and len(data["contentHash"]) == 64
    assert data["blockers"] == []
    assert data["compatibility"]["summary"] == {
        "requiredMcp": [],
        "knowledge": {"documents": 0, "included": 0, "workspaceScope": False},
        "unsupportedCapabilities": [],
    }


def test_claude_compile_returns_a_skill_package():
    response = client.post("/exports/compile", json=body(spec=prompt_spec(), fmt="claude"), headers=HEADERS)
    assert response.status_code == 200
    data = response.json()
    assert (data["compatibility"]["target"], data["compatibility"]["format"]) == ("claude", "skill-package")
    skill_md = next(f["content"] for f in data["files"] if f["path"] == "SKILL.md")
    assert skill_md.startswith("---\nname: ")


def test_unsupported_target_and_format_are_distinct_400s():
    unknown = client.post("/exports/compile", json=body(spec=prompt_spec(), fmt=("nope", "x")), headers=HEADERS)
    assert unknown.status_code == 400 and unknown.json()["error"]["details"]["code"] == "EXPORT_TARGET_UNSUPPORTED"
    bad_format = client.post("/exports/compile", json=body(spec=prompt_spec(), fmt=("claude", "markdown")), headers=HEADERS)
    assert bad_format.json()["error"]["details"]["code"] == "EXPORT_FORMAT_UNSUPPORTED"


def test_secret_block_travels_as_a_400_with_machine_code_and_no_value():
    spec = prompt_spec()
    spec["description"] = f"call with {OPENAI_STYLE}"
    response = client.post("/exports/compile", json=body(spec=spec, fmt="raw-spec"), headers=HEADERS)
    assert response.status_code == 400
    error = response.json()["error"]
    assert error["code"] == "validation_error"
    assert error["details"]["code"] == "EXPORT_SECRET_DETECTED"
    assert error["details"]["findings"] == [{"path": "/description", "category": "api_key"}]
    assert OPENAI_STYLE not in response.text


def test_dry_run_returns_blockers_with_200():
    spec = prompt_spec()
    spec["description"] = f"call with {OPENAI_STYLE}"
    response = client.post("/exports/compile", json=body(spec=spec, dry_run=True), headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["blockers"][0]["code"] == "EXPORT_SECRET_DETECTED"
    assert response.json()["files"] == []


def test_targets_lists_every_supported_format_and_flags_the_ones_without_an_adapter():
    response = client.get("/exports/targets", headers=HEADERS)
    assert response.status_code == 200
    targets = {t["id"]: t for t in response.json()["targets"]}
    assert set(targets) == {"generic", "claude"}
    generic = {f["id"]: f for f in targets["generic"]["formats"]}
    assert list(generic) == ["portable-package", "markdown", "raw-spec"]
    assert generic["markdown"]["contentType"] == "text/markdown; charset=utf-8"
    assert generic["markdown"]["embedsKnowledge"] is False and generic["portable-package"]["embedsKnowledge"] is True
    assert all(f["targetOptimized"] is False for f in generic.values())
    claude = targets["claude"]["formats"]
    assert [f["id"] for f in claude] == ["skill-package"]
    assert claude[0]["targetOptimized"] is True and claude[0]["embedsKnowledge"] is True
    assert targets["claude"]["displayName"] == "Claude"
    assert all(f["adapterAvailable"] is True for t in targets.values() for f in t["formats"])


def test_a_supported_format_without_an_adapter_is_listed_as_unavailable():
    from app.exports.models import ProfileCapabilities  # noqa: F401
    from app.exports.profiles import FormatDefinition, TargetDefinition, register_target, unregister_target
    from app.exports.profiles.generic import _MARKDOWN

    register_target(
        TargetDefinition(
            id="no-adapter-yet", display_name="No Adapter Yet",
            formats=(FormatDefinition(id="bundle", display_name="Bundle", content_type="application/zip", capabilities=_MARKDOWN),),
        )
    )
    try:
        targets = {t["id"]: t for t in client.get("/exports/targets", headers=HEADERS).json()["targets"]}
        assert targets["no-adapter-yet"]["formats"][0]["adapterAvailable"] is False
    finally:
        unregister_target("no-adapter-yet")


def test_tools_registry_now_exposes_description_and_protocol():
    tools = client.get("/tools").json()["tools"]
    assert all(t["description"] and t["protocol"] == "builtin" for t in tools)
