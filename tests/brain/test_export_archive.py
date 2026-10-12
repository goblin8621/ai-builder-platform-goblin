"""ASCII-safe archive path rules (Phase 9: ZIP entry paths are ASCII-only for portability)."""
import re

import pytest

from app.exports.archive import (
    ascii_slug,
    document_archive_path,
    is_safe_archive_path,
    skill_dir_name,
    stable_id,
)

ASCII_ONLY = re.compile(r"^[\x20-\x7e]+$")


def test_stable_id_is_deterministic_short_hex_and_kind_scoped():
    assert stable_id("skill", "abc") == stable_id("skill", "abc")
    assert re.fullmatch(r"[0-9a-f]{8}", stable_id("skill", "abc"))
    assert stable_id("skill", "abc") != stable_id("document", "abc")
    assert stable_id("skill", "abc") != stable_id("skill", "abd")
    assert "abc" not in stable_id("skill", "abc")  # the internal id itself is never exposed


@pytest.mark.parametrize(
    "name,expected_prefix",
    [
        ("Sales Analyzer", "sales-analyzer-"),
        ("매출 분석 스킬", "skill-"),  # no ASCII letters at all -> generic stem
        ("Café Münch", "cafe-munch-"),  # accents folded
        ("월별 Report 분석", "report-"),  # ASCII part survives
        ("", "skill-"),
        ("!!!", "skill-"),
    ],
)
def test_skill_dir_name_is_ascii_with_a_stable_id_suffix(name, expected_prefix):
    result = skill_dir_name(name, "skill-id-1")
    assert result.startswith(expected_prefix)
    assert result.endswith("-" + stable_id("skill", "skill-id-1"))
    assert ASCII_ONLY.match(result) and is_safe_archive_path(result)


def test_same_skill_keeps_its_folder_name_across_renames_and_versions():
    # "stable ID based": renaming the Skill changes the slug part only, never the id part.
    a, b = skill_dir_name("Old Name", "same-skill"), skill_dir_name("New Name", "same-skill")
    assert a.rsplit("-", 1)[1] == b.rsplit("-", 1)[1]
    assert skill_dir_name("매출 분석", "same-skill") == skill_dir_name("매출 분석", "same-skill")


def test_two_different_korean_skills_never_collide():
    assert skill_dir_name("매출 분석 스킬", "id-1") != skill_dir_name("매출 분석 스킬", "id-2")
    assert skill_dir_name("매출 분석 스킬", "id-1") != skill_dir_name("재고 관리 스킬", "id-2")


def test_ascii_slug_limits_length_and_never_ends_with_a_hyphen():
    slug = ascii_slug("a" * 100 + " tail", max_length=40)
    assert len(slug) <= 40 and not slug.endswith("-") and not slug.startswith("-")


@pytest.mark.parametrize(
    "file_name,expected_ext",
    [("report.md", ".md"), ("DATA.CSV", ".csv"), ("보고서.txt", ".txt"), ("no-extension", ""), ("x.테스트", ""), ("archive.tar.gz", ".gz"), ("../../etc/passwd", "")],
)
def test_document_path_is_ascii_and_keeps_only_a_plain_extension(file_name, expected_ext):
    used: set[str] = set()
    path = document_archive_path(file_name, "doc-1", used)
    assert path == f"references/document-{stable_id('document', 'doc-1')}{expected_ext}"
    assert ASCII_ONLY.match(path) and is_safe_archive_path(path)


def test_document_paths_are_unique_even_for_the_same_file_name():
    used: set[str] = set()
    paths = [document_archive_path("same.md", f"doc-{i}", used) for i in range(5)]
    assert len(set(paths)) == 5
    # and a (practically impossible) id-hash collision is still disambiguated
    forced = {f"references/document-{stable_id('document', 'x')}.md"}
    before = set(forced)
    resolved = document_archive_path("a.md", "x", forced)
    assert resolved not in before and resolved in forced


@pytest.mark.parametrize(
    "path,safe",
    [
        ("SKILL.md", True),
        ("skill-4aa7345a/SKILL.md", True),
        ("references/document-928ac031.md", True),
        ("children/parser-1a2b3c4d/skill.json", True),
        ("../escape.txt", False),
        ("a/../b", False),
        ("/absolute", False),
        ("a//b", False),
        ("a/./b", False),
        (".hidden", False),
        ("a/.hidden", False),
        ("a\\b", False),
        ("한글/파일.md", False),
        ("a b.md", False),
        ("a\x00b", False),
        ("a\nb", False),
        ("a/b/", False),
        ("", False),
        ("x" * 300, False),
    ],
)
def test_is_safe_archive_path(path, safe):
    assert is_safe_archive_path(path) is safe
