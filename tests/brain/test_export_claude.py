"""Claude Skill Adapter: SKILL.md format, frontmatter rules, package structure, validator."""
import json
import re

import pytest
import yaml

from app.common.errors import AppError
from app.exports.adapters.claude_skill import (
    BODY_MAX_LINES,
    DESCRIPTION_MAX,
    NAME_MAX,
    validate_claude_package,
)
from app.exports.archive import skill_dir_name, stable_id
from app.exports.models import ExportFile
from app.exports.pipeline import build_export
from export_helpers import (
    child,
    composite_spec,
    document,
    knowledge_spec,
    make_request,
    prompt_spec,
    workflow_spec,
)

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.DOTALL)
ASCII_ONLY = re.compile(r"^[\x20-\x7e]+$")


def claude(**kwargs):
    return build_export(make_request(fmt="claude", **kwargs))


def files_of(response) -> dict[str, str]:
    return {f.path: f.content for f in response.files}


def frontmatter(markdown: str) -> dict:
    match = FRONTMATTER.match(markdown)
    assert match, "SKILL.md must start with YAML frontmatter"
    return yaml.safe_load(match.group(1))


def skill_md(**kwargs) -> str:
    return files_of(claude(**kwargs))["SKILL.md"]


def pf(path: str, content: str) -> ExportFile:
    return ExportFile(path=path, content=content)


def minimal_package(skill_md_text: str, extra: list[ExportFile] | None = None) -> list[ExportFile]:
    return [pf("SKILL.md", skill_md_text), pf("skill.json", "{}\n"), pf("manifest.json", "{}\n"), *(extra or [])]


VALID_MD = '---\nname: my-skill\ndescription: Does a thing. Use when asked.\n---\n\n# My skill\n'


# ---------------- SKILL.md + frontmatter ----------------


def test_skill_md_has_yaml_frontmatter_with_name_and_description():
    spec = prompt_spec(name="Sales Analyzer", description="Analyze sales data and summarize trends and anomalies.")
    md = skill_md(spec=spec)
    assert md.startswith("---\nname: sales-analyzer\n")
    data = frontmatter(md)
    assert set(data) == {"name", "description"}
    assert data["name"] == "sales-analyzer"
    assert data["description"].startswith("Analyze sales data and summarize trends and anomalies.")
    assert "\n# Sales Analyzer\n" in md


def test_package_structure_for_a_prompt_skill():
    response = claude(spec=prompt_spec(), skill_id="skill-001")
    assert sorted(files_of(response)) == ["SKILL.md", "manifest.json", "skill.json"]
    assert response.packageRoot == skill_dir_name("Korean to English Translator", "skill-001")
    assert response.filename == f"{response.packageRoot}-v1.zip"
    assert response.contentType == "application/zip"
    assert response.manifest.export.model_dump()["target"] == "claude"
    assert validate_claude_package(response.files) == []


def test_korean_name_gets_an_ascii_claude_name_and_keeps_the_korean_text():
    spec = prompt_spec(name="매출 분석 스킬", description="CSV 월별 매출과 이상치를 분석하는 스킬")
    response = claude(spec=spec, skill_id="skill-kr")
    data = frontmatter(files_of(response)["SKILL.md"])
    assert data["name"] == skill_dir_name("", "skill-kr") and ASCII_ONLY.match(data["name"])
    assert "CSV 월별 매출과 이상치를 분석하는 스킬" in data["description"]  # quoted YAML keeps UTF-8
    assert "# 매출 분석 스킬" in files_of(response)["SKILL.md"]
    assert response.manifest.skill.displayName == "매출 분석 스킬"
    assert all(ASCII_ONLY.match(p) for p in files_of(response))


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Sales Analyzer", "sales-analyzer"),
        ("PDF  Processing!!", "pdf-processing"),
        ("2024", "2024"),  # would be an int in plain YAML — must still round-trip as the string "2024"
        ("true", "true"),  # ... or a boolean
    ],
)
def test_name_is_a_valid_lowercase_slug_that_round_trips_through_yaml(name, expected):
    data = frontmatter(skill_md(spec=prompt_spec(name=name)))
    assert data["name"] == expected and isinstance(data["name"], str)
    assert re.fullmatch(r"[a-z0-9-]{1,64}", data["name"])


@pytest.mark.parametrize("name", ["Claude Helper", "My Anthropic Tools", "claude"])
def test_reserved_words_are_never_used_in_the_name(name):
    response = claude(spec=prompt_spec(name=name), skill_id="s-reserved")
    data = frontmatter(files_of(response)["SKILL.md"])
    assert data["name"] == skill_dir_name("", "s-reserved")
    assert "claude" not in data["name"] and "anthropic" not in data["name"]
    assert "CLAUDE_NAME_RESERVED_WORD" in {w.code for w in response.compatibility.warnings}


def test_long_names_are_shortened_within_the_limit():
    data = frontmatter(skill_md(spec=prompt_spec(name="a very long skill name " * 10)))
    assert len(data["name"]) <= NAME_MAX


def test_description_says_what_and_when_without_duplicating_itself():
    spec = prompt_spec(description="Translates Korean sentences into English.")
    spec["instructions"]["objective"] = "Translate the user's Korean sentence into natural English."
    description = frontmatter(skill_md(spec=spec))["description"]
    assert description == "Translates Korean sentences into English. Use when: Translate the user's Korean sentence into natural English."

    spec["instructions"]["objective"] = "translates korean sentences into english"
    assert frontmatter(skill_md(spec=spec))["description"] == "Translates Korean sentences into English."


def test_description_is_single_line_tag_free_and_valid_yaml_for_awkward_text():
    spec = prompt_spec(description="Line one: has a colon.\nLine two # not a comment <b>bold</b> \"quoted\" 'single'")
    response = claude(spec=spec)
    description = frontmatter(files_of(response)["SKILL.md"])["description"]
    assert "\n" not in description and "<b>" not in description and "</b>" not in description
    assert "Line one: has a colon." in description and "# not a comment" in description
    assert "CLAUDE_DESCRIPTION_SANITIZED" in {w.code for w in response.compatibility.warnings}


def test_overlong_description_is_shortened_with_a_warning_and_kept_in_full_elsewhere():
    spec = prompt_spec(description="word " * 400)
    response = claude(spec=spec)
    data = frontmatter(files_of(response)["SKILL.md"])
    assert 0 < len(data["description"]) <= DESCRIPTION_MAX and data["description"].endswith("...")
    assert "CLAUDE_DESCRIPTION_TRUNCATED" in {w.code for w in response.compatibility.warnings}
    assert json.loads(files_of(response)["skill.json"])["description"] == spec["description"]  # nothing lost


# ---------------- body content (written for Claude as the reader) ----------------


def test_skill_md_is_a_claude_oriented_document_not_the_generic_markdown_renamed():
    spec = workflow_spec()
    claude_md = skill_md(spec=spec)
    generic_md = build_export(make_request(spec=spec, fmt="generic-markdown")).files[0].content
    assert claude_md.startswith("---\n") and not generic_md.startswith("---")
    assert "Follow these steps in order:" in claude_md and "## Input Contract" not in claude_md
    assert "## Input Contract" in generic_md and "Follow these steps in order:" not in generic_md
    assert claude_md.split("---\n", 2)[2] != generic_md


def test_workflow_semantics_are_written_as_instructions_to_claude():
    spec = workflow_spec()
    spec["execution"]["steps"][2]["approvalRequired"] = True
    md = skill_md(spec=spec)
    assert "ask the user for explicit confirmation" in md  # approval
    assert "retry up to 2 time(s)" in md and "fall back to step `summarize`" in md and "skip this step and continue" in md
    assert "Call the tool `file-parser`" in md and "`ServerName:file-parser`" in md  # MCP fully-qualified naming
    assert "## Required tools" in md and "fully qualified name (`ServerName:tool_name`)" in md
    assert "## Guardrails" in md and "## Constraints" in md and "at most 8 tool calls" in md


def test_knowledge_documents_are_linked_when_included_and_flagged_when_not():
    spec = knowledge_spec(["d1"])
    docs = [document("d1", "매출 정책.md", "policy body")]
    path = f"references/document-{stable_id('document', 'd1')}.md"

    included = files_of(claude(spec=spec, documents=docs, include_knowledge=True))
    assert f"[매출 정책.md]({path})" in included["SKILL.md"]  # display name in the text, ASCII path in the link
    assert included[path] == "policy body"

    refs_only = files_of(claude(spec=spec, documents=docs))
    assert "매출 정책.md — not bundled; ask the user to provide it" in refs_only["SKILL.md"]
    assert not any(p.startswith("references/") for p in refs_only)


def test_children_become_additional_skills_each_with_valid_frontmatter():
    parent = composite_spec("c-1", name="Report Builder")
    kids = [child("c-1", "Parser", prompt_spec(name="Parser"), version=2)]
    response = claude(spec=parent, children=kids, include_children=True, skill_id="p-1")
    files = files_of(response)
    child_dir = f"children/{skill_dir_name('Parser', 'c-1')}"
    assert {f"{child_dir}/SKILL.md", f"{child_dir}/skill.json"} <= set(files)
    assert f"]({child_dir}/SKILL.md)" in files["SKILL.md"]  # parent links to the child skill
    names = {frontmatter(files[p])["name"] for p in files if p.endswith("SKILL.md")}
    assert len(names) == 2 and all(re.fullmatch(r"[a-z0-9-]+", n) for n in names)
    assert validate_claude_package(response.files) == []


def test_children_not_included_are_flagged_as_not_bundled():
    parent = composite_spec("c-1", name="Report Builder")
    md = skill_md(spec=parent, children=[child("c-1", "Parser", prompt_spec(name="Parser"))])
    assert "not bundled" in md and "ask the user to provide it" in md


def test_skill_json_is_round_trippable_and_carries_source_spec_only_on_request():
    spec = prompt_spec()
    with_source = json.loads(files_of(claude(spec=spec, include_source=True, skill_id="sid"))["skill.json"])
    assert with_source["sourceSpec"] == spec and with_source["source"]["skillId"] == "sid"
    without = json.loads(files_of(claude(spec=spec, skill_id="sid"))["skill.json"])
    assert "sourceSpec" not in without and "source" not in without


# ---------------- size budget: SKILL.md < 500 lines, one level deep references ----------------


def test_large_schemas_move_to_a_reference_file_that_is_linked_one_level_deep():
    spec = prompt_spec()
    spec["inputSchema"] = {
        "type": "object",
        "properties": {f"field_{i}": {"type": "string", "description": f"field {i}"} for i in range(120)},
    }
    response = claude(spec=spec)
    files = files_of(response)
    assert "references/schemas.md" in files and "](references/schemas.md)" in files["SKILL.md"]
    assert files["SKILL.md"].count("\n") <= BODY_MAX_LINES
    assert '"field_119"' in files["references/schemas.md"]
    assert validate_claude_package(response.files) == []


def test_a_skill_md_that_cannot_fit_is_rejected_instead_of_exported():
    spec = prompt_spec()
    spec["execution"]["steps"] = [{"id": f"s{i}", "name": f"Step {i}", "type": "llm"} for i in range(250)]
    with pytest.raises(AppError) as exc:
        claude(spec=spec)
    assert exc.value.details["code"] == "EXPORT_PACKAGE_INVALID"
    assert any("exceeds the 500-line limit" in e for e in exc.value.details["errors"])


# ---------------- validator: every rule rejects what it should ----------------


def errors_for(skill_md_text: str, extra=None) -> list[str]:
    return validate_claude_package(minimal_package(skill_md_text, extra))


def test_a_well_formed_package_is_valid():
    assert errors_for(VALID_MD) == []


@pytest.mark.parametrize(
    "bad,fragment",
    [
        ("# no frontmatter\n", "missing YAML frontmatter"),
        ("---\nname: x\ndescription: [unclosed\n---\n", "not valid YAML"),
        ("---\n- a\n- b\n---\n", "must be a mapping"),
        ("---\ndescription: only a description\n---\n", "'name' is required"),
        ("---\nname: only-a-name\n---\n", "'description' is required"),
        ('---\nname: ""\ndescription: x\n---\n', "'name' is required"),
        ('---\nname: ok\ndescription: "   "\n---\n', "non-empty"),
        ("---\nname: Upper-Case\ndescription: x\n---\n", "lowercase letters, numbers and hyphens"),
        ("---\nname: has_underscore\ndescription: x\n---\n", "lowercase letters, numbers and hyphens"),
        ("---\nname: my-claude-skill\ndescription: x\n---\n", "reserved word"),
        ("---\nname: anthropic-helper\ndescription: x\n---\n", "reserved word"),
        (f"---\nname: {'a' * 65}\ndescription: x\n---\n", "longer than 64"),
        (f'---\nname: ok\ndescription: "{"d" * 1025}"\n---\n', "longer than 1024"),
        ('---\nname: ok\ndescription: "uses <b>html</b> tags"\n---\n', "XML tag"),
        ("---\nname: 123\ndescription: x\n---\n", "'name' is required"),  # int, not a string
    ],
)
def test_validator_rejects_invalid_frontmatter(bad, fragment):
    errors = errors_for(bad)
    assert any(fragment in e for e in errors), errors


def test_validator_rejects_missing_required_files_and_unsafe_paths():
    assert any("SKILL.md" in e for e in validate_claude_package([pf("skill.json", "{}"), pf("manifest.json", "{}")]))
    assert any("skill.json" in e for e in validate_claude_package([pf("SKILL.md", VALID_MD), pf("manifest.json", "{}")]))
    assert any("manifest.json" in e for e in validate_claude_package([pf("SKILL.md", VALID_MD), pf("skill.json", "{}")]))
    for bad_path in ["../x.md", "/abs.md", "references/한글.md", "a//b.md", ".hidden", "a\\b.md"]:
        assert any("unsafe archive path" in e for e in errors_for(VALID_MD, [pf(bad_path, "x")])), bad_path
    assert any("duplicate" in e for e in errors_for(VALID_MD, [pf("SKILL.md", VALID_MD)]))


def test_validator_checks_referenced_paths_exist_and_stay_inside_the_package():
    ok = VALID_MD + "\nSee [guide](references/guide.md).\n"
    assert errors_for(ok, [pf("references/guide.md", "g")]) == []
    assert any("not in the package" in e for e in errors_for(ok))  # required reference missing
    escaping = VALID_MD + "\n[x](../outside.md) and [y](references/../../etc/passwd)\n"
    assert sum("escapes the skill folder" in e for e in errors_for(escaping)) == 2
    assert errors_for(VALID_MD + "\n[web](https://example.com/a.md) [anchor](#top) [mail](mailto:a@b.co)\n") == []


def test_validator_ignores_link_like_text_inside_code_fences():
    text = VALID_MD + '\n```json\n{"x": "[a](missing.md)"}\n```\n'
    assert errors_for(text) == []


def test_validator_enforces_the_500_line_budget():
    long_md = VALID_MD + "\n".join(f"line {i}" for i in range(BODY_MAX_LINES))
    assert any("500-line limit" in e for e in errors_for(long_md))


def test_child_skill_files_are_validated_too():
    bad_child = "---\nname: Bad_Name\ndescription: x\n---\n"
    errors = errors_for(VALID_MD, [pf("children/kid-1a2b3c4d/SKILL.md", bad_child)])
    assert any(e.startswith("children/kid-1a2b3c4d/SKILL.md") for e in errors)
