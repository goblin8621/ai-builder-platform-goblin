import unicodedata

from app.exports.canonical import (
    canonical_json,
    ensure_trailing_newline,
    normalize_newlines,
    pretty_json,
    sha256_text,
    slugify,
    unique_name,
)


def test_slugify_basic_and_unicode():
    assert slugify("Sales Analyzer") == "sales-analyzer"
    assert slugify("월별 매출 분석") == "월별-매출-분석"
    assert slugify("  --Hello__World!!  ") == "hello-world"
    assert slugify("") == ""
    assert slugify("!!!") == ""


def test_slugify_is_normalization_independent():
    nfc = unicodedata.normalize("NFC", "한글 스킬")
    nfd = unicodedata.normalize("NFD", "한글 스킬")
    assert nfc != nfd
    assert slugify(nfc) == slugify(nfd)


def test_unique_helpers_suffix_collisions_deterministically():
    used: set[str] = set()
    assert [unique_name("parser", used) for _ in range(3)] == ["parser", "parser-2", "parser-3"]


def test_newline_normalization():
    assert normalize_newlines("a\r\nb\rc\n") == "a\nb\nc\n"
    assert ensure_trailing_newline("a\r\nb") == "a\nb\n"
    assert ensure_trailing_newline("a\n") == "a\n"


def test_canonical_json_is_order_independent_and_pretty_json_is_stable():
    a = {"b": 1, "a": {"y": [1, 2], "x": None}}
    b = {"a": {"x": None, "y": [1, 2]}, "b": 1}
    assert canonical_json(a) == canonical_json(b)
    assert pretty_json(a) == pretty_json(b)
    assert pretty_json(a).endswith("\n")
    assert "\r" not in pretty_json(a)
    assert pretty_json({"t": "한글"}) == '{\n  "t": "한글"\n}\n'  # UTF-8, not \u escapes


def test_integers_are_not_turned_into_floats():
    assert canonical_json({"n": 30}) == '{"n":30}'


def test_sha256_text_is_utf8_stable():
    assert sha256_text("안녕") == sha256_text("안녕")
    assert len(sha256_text("x")) == 64
