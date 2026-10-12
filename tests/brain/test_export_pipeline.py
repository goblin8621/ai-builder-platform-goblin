import json
import re

import pytest

from app.common.errors import AppError
from app.exports.archive import is_safe_archive_path, skill_dir_name, stable_id
from app.exports.canonical import sha256_text
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

ISO_TIMESTAMP = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
OPENAI_STYLE = "sk-" + "Ab3dE5gH7jK9mN1pQ3rS5tU7"
ASCII_ONLY = re.compile(r"^[\x20-\x7e]+$")


def export(**kwargs):
    return build_export(make_request(**kwargs))


def files_of(response) -> dict[str, str]:
    return {f.path: f.content for f in response.files}


def error_code(exc: pytest.ExceptionInfo[AppError]) -> str:
    return exc.value.details["code"]


def composite_inputs():
    parent = composite_spec("child-id-aaa", name="Report Builder")
    parser = prompt_spec(name="Parser")
    return parent, [child("child-id-aaa", "Parser", parser, version=2)]


def root_of(skill_id: str, name: str) -> str:
    return skill_dir_name(name, skill_id)


# ---------------- Portable Package ----------------


def test_prompt_skill_package_has_the_documented_layout():
    response = export(spec=prompt_spec(), version=5)
    assert sorted(files_of(response)) == ["SKILL.md", "manifest.json", "skill.json"]
    root = root_of("skill-001", "Korean to English Translator")
    assert response.packageRoot == root and root.startswith("korean-to-english-translator-")
    assert response.filename == f"{root}-v5.zip"
    assert response.contentType == "application/zip"
    assert (response.compatibility.target, response.compatibility.format) == ("generic", "portable-package")
    skill_json = json.loads(files_of(response)["skill.json"])
    assert skill_json["name"] == "Korean to English Translator" and skill_json["formatVersion"] == "1.0"


def test_generic_package_skill_md_has_no_provider_frontmatter():
    assert not files_of(export(spec=prompt_spec()))["SKILL.md"].startswith("---")


def test_every_entry_path_is_ascii_even_for_korean_skill_and_document_names():
    spec = knowledge_spec(["d1", "d2"])
    spec["name"] = "매출 분석 스킬"
    docs = [document("d1", "매출 정책 문서.md", "a"), document("d2", "../../보고서 최종.txt", "b")]
    response = export(spec=spec, documents=docs, include_knowledge=True, skill_id="skill-kr")
    for path in files_of(response):
        assert ASCII_ONLY.match(path) and is_safe_archive_path(path), path
    assert response.packageRoot == skill_dir_name("", "skill-kr") and response.packageRoot.startswith("skill-")
    assert ASCII_ONLY.match(response.filename)

    kr_parent, kr_children = composite_spec("c-1", name="한글 부모"), [child("c-1", "한글 자식", prompt_spec(name="한글 자식"))]
    package = export(spec=kr_parent, children=kr_children, include_children=True)
    for path in files_of(package):
        assert ASCII_ONLY.match(path), path
    assert any(p.startswith("children/skill-") for p in files_of(package))


def test_package_files_are_sorted_utf8_with_lf_endings():
    response = export(spec=prompt_spec(name="한글 스킬"))
    paths = [f.path for f in response.files]
    assert paths == sorted(paths)
    for f in response.files:
        assert "\r" not in f.content
        assert f.content.endswith("\n") or f.path.startswith("references/")
        f.content.encode("utf-8")


def test_package_with_children_and_documents():
    parent, children = composite_inputs()
    parent["knowledge"] = {"mode": "selected", "documentIds": ["doc-id-1"]}
    parent["capabilities"]["knowledgeSearch"] = True
    docs = [document("doc-id-1", "policy.txt", "p\r\nq")]
    response = export(spec=parent, children=children, documents=docs, include_children=True, include_knowledge=True)
    files = files_of(response)
    child_dir = f"children/{skill_dir_name('Parser', 'child-id-aaa')}"
    doc_path = f"references/document-{stable_id('document', 'doc-id-1')}.txt"
    assert sorted(files) == sorted(["SKILL.md", "manifest.json", "skill.json", doc_path, f"{child_dir}/SKILL.md", f"{child_dir}/skill.json"])
    assert files[doc_path] == "p\nq"  # CRLF normalized
    assert doc_path in files["SKILL.md"] and child_dir + "/" in files["SKILL.md"]


def test_without_include_flags_no_children_or_references_are_written():
    parent, children = composite_inputs()
    parent["knowledge"] = {"mode": "selected", "documentIds": ["doc-id-1"]}
    parent["capabilities"]["knowledgeSearch"] = True
    response = export(spec=parent, children=children, documents=[document("doc-id-1", "policy.txt", None)])
    assert sorted(files_of(response)) == ["SKILL.md", "manifest.json", "skill.json"]
    dep = response.manifest.dependencies["child:parser"]
    assert dep.included is False and dep.path is None
    assert response.manifest.knowledge["doc:policy-txt"].included is False


def test_raw_spec_is_the_original_spec_and_ignores_children_with_a_warning():
    parent, children = composite_inputs()
    response = export(spec=parent, children=children, fmt="raw-spec", include_children=True)
    assert [f.path for f in response.files] == [f"{root_of('skill-001', 'Report Builder')}-v1.skillspec.json"]
    assert json.loads(response.files[0].content) == parent
    assert response.contentType == "application/json; charset=utf-8"
    assert response.packageRoot is None and response.manifest.skill.archivePath is None
    assert response.effectiveOptions.includeChildSkills is False
    assert "EXPORT_OPTION_CHILD_SKILLS_IGNORED" in {w.code for w in response.compatibility.warnings}
    assert response.manifest is not None  # lock info is still reported even though raw has no manifest file


# ---------------- Generic Markdown ----------------


def test_generic_markdown_follows_the_documented_sections_for_a_prompt_skill():
    response = export(spec=prompt_spec(), fmt="generic-markdown", version=3)
    assert [f.path for f in response.files] == [f"{root_of('skill-001', 'Korean to English Translator')}-v3.md"]
    assert response.contentType == "text/markdown; charset=utf-8"
    md = response.files[0].content
    headings = re.findall(r"^## (.+)$", md, flags=re.M)
    assert headings[:6] == ["Description", "Objective", "Instructions", "Input Contract", "Output Contract", "Workflow"]
    assert md.startswith("# Korean to English Translator\n")
    assert "- `text`: string (required)" in md
    assert "1. **Translate to English** — llm step `translate`" in md
    assert response.compatibility.level == "full"


def test_markdown_lists_dependencies_and_includes_children_inline():
    parent, children = composite_inputs()
    md = export(spec=parent, children=children, fmt="generic-markdown", include_children=True).files[0].content
    assert "## Dependencies" in md and "`child:parser` — Parser v2" in md
    assert "## Dependency `child:parser`" in md
    without = export(spec=parent, children=children, fmt="generic-markdown", include_children=False).files[0].content
    assert "not included in this export" in without and "## Dependency `child:parser`" not in without


def test_markdown_is_safe_for_awkward_text():
    spec = prompt_spec(name="Weird `name`\nwith newline", description="line1\r\nline2")
    spec["usageExamples"] = [{"input": {"text": "```evil``` fence"}}]
    md = export(spec=spec, fmt="generic-markdown").files[0].content
    assert md.startswith("# Weird `name` with newline\n")  # heading: newline collapsed, no structure break
    assert "\r" not in md
    assert "````json" in md  # fence widened past the embedded ``` run


# ---------------- Manifest ----------------


def test_manifest_records_display_names_archive_paths_and_the_locked_snapshot():
    parent, children = composite_inputs()
    response = export(spec=parent, children=children, include_children=True, version=4)
    manifest = response.manifest
    root = root_of("skill-001", "Report Builder")
    assert manifest.formatVersion == "1.0"
    assert manifest.skill.displayName == "Report Builder" and manifest.skill.archivePath == root and manifest.skill.version == 4
    dep = manifest.dependencies["child:parser"]
    child_dir = f"children/{skill_dir_name('Parser', 'child-id-aaa')}/"
    assert (dep.displayName, dep.version, dep.included, dep.path) == ("Parser", 2, True, child_dir)
    assert re.fullmatch(r"[0-9a-f]{64}", dep.contentHash)
    assert manifest.export.model_dump() == {
        "target": "generic",
        "format": "portable-package",
        "options": {"includeKnowledge": False, "includeChildSkills": True, "includeSourceSpec": False},
    }
    assert manifest.requirements.nestedSkill is True and manifest.requirements.llm is True

    files = files_of(response)
    manifest_json = json.loads(files["manifest.json"])
    assert manifest_json["skill"]["displayName"] == "Report Builder" and manifest_json["skill"]["archivePath"] == root
    listed = {f["path"]: f for f in manifest_json["files"]}
    assert "manifest.json" not in listed  # a file cannot hash itself
    assert set(listed) == set(files) - {"manifest.json"}
    for path, entry in listed.items():
        assert entry["sha256"] == sha256_text(files[path]) and entry["bytes"] == len(files[path].encode("utf-8"))


def test_manifest_keeps_the_original_korean_names_while_paths_are_ascii():
    spec = knowledge_spec(["d1"])
    spec["name"] = "매출 분석 스킬"
    docs = [document("d1", "매출 정책 문서.md", "내용")]
    response = export(spec=spec, documents=docs, include_knowledge=True, skill_id="skill-kr")
    manifest = response.manifest
    assert manifest.skill.displayName == "매출 분석 스킬"
    assert ASCII_ONLY.match(manifest.skill.archivePath)
    doc = manifest.knowledge["doc:" + "매출-정책-문서-md"]
    assert doc.fileName == "매출 정책 문서.md" and ASCII_ONLY.match(doc.path)  # display name preserved, path ASCII
    raw = json.loads(files_of(response)["manifest.json"])
    assert raw["skill"]["displayName"] == "매출 분석 스킬"


def test_manifest_requirements_aggregate_over_locked_children():
    parent = composite_spec("c1")
    manifest = export(spec=parent, children=[child("c1", "Analyzer", workflow_spec())], include_children=True).manifest
    assert manifest.requirements.tools == ["file-parser", "python-data-analysis"]
    assert manifest.requirements.codeExecution is True and manifest.requirements.nestedSkill is True


def test_no_timestamps_or_random_ids_anywhere_in_the_artifact():
    parent, children = composite_inputs()
    for fmt in ("portable-package", "claude"):
        response = export(spec=parent, children=children, fmt=fmt, include_children=True, include_source=True)
        blob = "\n".join(f.content for f in response.files)
        assert not ISO_TIMESTAMP.search(blob), fmt
        assert "exportedAt" not in blob and "generatedAt" not in blob and "timestamp" not in blob.lower()
        assert not re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", blob)  # no uuids


# ---------------- deterministic export ----------------


def test_same_inputs_produce_byte_identical_output():
    parent, children = composite_inputs()
    for fmt in ("portable-package", "claude"):
        one = export(spec=parent, children=children, fmt=fmt, include_children=True, include_source=True)
        two = export(spec=parent, children=children, fmt=fmt, include_children=True, include_source=True)
        assert files_of(one) == files_of(two) and one.contentHash == two.contentHash


def test_output_does_not_depend_on_input_ordering():
    parent, children = composite_inputs()
    parent["knowledge"] = {"mode": "selected", "documentIds": ["d1", "d2"]}
    parent["capabilities"]["knowledgeSearch"] = True
    docs = [document("d1", "a.txt", "A"), document("d2", "b.txt", "B")]
    reordered_spec = dict(reversed(list(json.loads(json.dumps(parent)).items())))
    for fmt in ("portable-package", "claude"):
        one = export(spec=parent, children=children, documents=docs, fmt=fmt, include_children=True, include_knowledge=True)
        two = export(
            spec=reordered_spec, children=list(reversed(children)), documents=list(reversed(docs)), fmt=fmt,
            include_children=True, include_knowledge=True,
        )
        assert files_of(one) == files_of(two) and one.contentHash == two.contentHash


@pytest.mark.parametrize("fmt", ["portable-package", "generic-markdown", "raw-spec", "claude"])
def test_every_format_is_deterministic(fmt):
    spec = workflow_spec()
    assert export(spec=spec, fmt=fmt).contentHash == export(spec=spec, fmt=fmt).contentHash


def test_reproducibility_is_defined_over_resolved_dependencies_not_just_the_parent_version():
    parent = composite_spec("c1")
    parser_v1 = prompt_spec(name="Parser")
    parser_v2 = json.loads(json.dumps(parser_v1))
    parser_v2["instructions"]["rules"].append("Handle tables.")

    first = export(spec=parent, version=5, children=[child("c1", "Parser", parser_v1, 1)], include_children=True)
    same_inputs = export(spec=parent, version=5, children=[child("c1", "Parser", parser_v1, 1)], include_children=True)
    moved_child = export(spec=parent, version=5, children=[child("c1", "Parser", parser_v2, 2)], include_children=True)

    assert first.contentHash == same_inputs.contentHash
    # SAME Parent Version 5, but the resolved Child moved on ⇒ a different (and honestly different) artifact.
    assert moved_child.contentHash != first.contentHash
    assert moved_child.manifest.dependencies["child:parser"].version == 2
    assert first.manifest.dependencies["child:parser"].version == 1
    assert moved_child.manifest.skill.contentHash != first.manifest.skill.contentHash  # Merkle: parent hash covers it


def test_changed_knowledge_content_or_options_change_the_output():
    spec = knowledge_spec(["d1"])
    base = export(spec=spec, documents=[document("d1", "a.txt", "one")], include_knowledge=True)
    other_content = export(spec=spec, documents=[document("d1", "a.txt", "two")], include_knowledge=True)
    refs_only = export(spec=spec, documents=[document("d1", "a.txt", "one")], include_knowledge=False)
    assert len({base.contentHash, other_content.contentHash, refs_only.contentHash}) == 3


def test_crlf_and_lf_documents_produce_the_same_artifact():
    spec = knowledge_spec(["d1"])
    crlf = export(spec=spec, documents=[document("d1", "a.txt", "x\r\ny\r\n")], include_knowledge=True)
    lf = export(spec=spec, documents=[document("d1", "a.txt", "x\ny\n")], include_knowledge=True)
    assert crlf.contentHash == lf.contentHash


# ---------------- knowledge modes ----------------


def test_include_documents_writes_references_and_references_only_does_not():
    spec = knowledge_spec(["d1"])
    included = export(spec=spec, documents=[document("d1", "../../Policy Doc.txt", "body")], include_knowledge=True)
    path = f"references/document-{stable_id('document', 'd1')}.txt"
    assert files_of(included)[path] == "body"
    kd = included.manifest.knowledge["doc:policy-doc-txt"]
    assert kd.included and kd.path == path and kd.contentHash == sha256_text("body")
    assert kd.fileName == "../../Policy Doc.txt"  # display metadata only; never a path

    refs_only = export(spec=spec, documents=[document("d1", "../../Policy Doc.txt", None)])
    assert not any(p.startswith("references/") for p in files_of(refs_only))
    assert refs_only.manifest.knowledge["doc:policy-doc-txt"].included is False


def test_duplicate_document_file_names_get_distinct_ascii_paths():
    spec = knowledge_spec(["d1", "d2", "d3"])
    docs = [document("d1", "a.txt", "1"), document("d2", "dir/a.txt", "2"), document("d3", "a.txt", "3")]
    paths = sorted(p for p in files_of(export(spec=spec, documents=docs, include_knowledge=True)) if p.startswith("references/"))
    assert len(paths) == 3 and len(set(paths)) == 3
    assert all(ASCII_ONLY.match(p) for p in paths)


def test_workspace_scope_is_forced_to_references_only_with_a_warning():
    spec = knowledge_spec([], mode="workspace")
    response = export(spec=spec, include_knowledge=True)
    assert not any(p.startswith("references/") for p in files_of(response))
    assert "EXPORT_KNOWLEDGE_WORKSPACE_REFERENCES_ONLY" in {w.code for w in response.compatibility.warnings}
    assert response.manifest.knowledge == {}


def test_markdown_never_embeds_documents_even_if_asked():
    spec = knowledge_spec(["d1"])
    response = export(spec=spec, documents=[document("d1", "a.txt", "secret-free body")], fmt="generic-markdown", include_knowledge=True)
    assert "secret-free body" not in response.files[0].content
    assert response.effectiveOptions.includeKnowledge is False


# ---------------- internal ids never leak ----------------


def test_internal_ids_do_not_appear_unless_source_spec_is_requested():
    parent, children = composite_inputs()
    parent["knowledge"] = {"mode": "selected", "documentIds": ["internal-doc-9"]}
    parent["capabilities"]["knowledgeSearch"] = True
    docs = [document("internal-doc-9", "a.txt", "x")]
    kwargs = dict(
        spec=parent, children=children, documents=docs, skill_id="internal-skill-7",
        include_children=True, include_knowledge=True,
    )
    for fmt in ("portable-package", "generic-markdown", "claude"):
        blob = "\n".join(f.content for f in export(fmt=fmt, **kwargs).files)
        paths = "\n".join(f.path for f in export(fmt=fmt, **kwargs).files)
        for internal in ("internal-skill-7", "internal-doc-9", "child-id-aaa"):
            assert internal not in blob, (fmt, internal)
            assert internal not in paths, (fmt, internal)

    with_source = "\n".join(f.content for f in export(include_source=True, **kwargs).files)
    assert "internal-skill-7" in with_source  # opt-in provenance
    skill_json = json.loads(files_of(export(include_source=True, **kwargs))["skill.json"])
    assert skill_json["source"] == {"skillId": "internal-skill-7", "skillVersion": 1}


# ---------------- Sanitizer is mandatory for every format ----------------


@pytest.mark.parametrize("fmt", ["portable-package", "generic-markdown", "raw-spec", "claude"])
def test_secret_in_spec_blocks_every_format_including_raw(fmt):
    spec = prompt_spec()
    spec["instructions"]["rules"].append(f"Authenticate with {OPENAI_STYLE}")
    with pytest.raises(AppError) as exc:
        export(spec=spec, fmt=fmt)
    assert error_code(exc) == "EXPORT_SECRET_DETECTED"
    assert exc.value.details["findings"] == [{"path": "/instructions/rules/2", "category": "api_key"}]
    assert OPENAI_STYLE not in json.dumps(exc.value.details) and OPENAI_STYLE not in exc.value.message


def test_documentation_urls_that_name_auth_endpoints_are_exportable():
    spec = prompt_spec()
    spec["instructions"]["rules"].append("The token endpoint is https://example.com/oauth/token (see /oauth/authorize too).")
    for fmt in ("portable-package", "generic-markdown", "raw-spec", "claude"):
        assert export(spec=spec, fmt=fmt).files, fmt


def test_dry_run_reports_blockers_with_level_blocked_and_no_files():
    spec = prompt_spec()
    spec["instructions"]["rules"].append(f"use {OPENAI_STYLE}")
    response = export(spec=spec, dry_run=True)
    assert response.files == [] and response.manifest is None
    assert response.compatibility.level == "blocked"
    assert response.blockers[0].code == "EXPORT_SECRET_DETECTED"
    assert [(f.path, f.category) for f in response.blockers[0].findings] == [("/instructions/rules/2", "api_key")]


def test_secret_in_child_spec_and_included_document_are_located():
    parent, _ = composite_inputs()
    bad_child = prompt_spec(name="Parser")
    bad_child["usageExamples"] = [{"input": {"apiKey": "0123456789abcdef0123"}}]
    with pytest.raises(AppError) as exc:
        export(spec=parent, children=[child("child-id-aaa", "Parser", bad_child)], include_children=True)
    assert exc.value.details["findings"][0]["path"] == "child:parser:/usageExamples/0/input/apiKey"

    spec = knowledge_spec(["d1"])
    with pytest.raises(AppError) as exc:
        export(spec=spec, documents=[document("d1", "notes.txt", f"token {OPENAI_STYLE}")], include_knowledge=True)
    assert exc.value.details["findings"] == [{"path": "doc:notes-txt", "category": "api_key"}]


def test_unincluded_document_content_is_not_part_of_the_artifact_so_it_is_not_scanned():
    spec = knowledge_spec(["d1"])
    response = export(spec=spec, documents=[document("d1", "notes.txt", f"token {OPENAI_STYLE}")], include_knowledge=False)
    assert OPENAI_STYLE not in "\n".join(f.content for f in response.files)


# ---------------- target / format validation ----------------


@pytest.mark.parametrize(
    "fmt,code",
    [
        (("nope", "skill-package"), "EXPORT_TARGET_UNSUPPORTED"),
        (("claude", "markdown"), "EXPORT_FORMAT_UNSUPPORTED"),
        (("generic", "pdf"), "EXPORT_FORMAT_UNSUPPORTED"),
    ],
)
def test_unsupported_target_or_format(fmt, code):
    with pytest.raises(AppError) as exc:
        export(spec=prompt_spec(), fmt=fmt)
    assert error_code(exc) == code
