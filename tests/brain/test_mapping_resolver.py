import pytest

from app.skills.mapping_resolver import MappingError, is_mapping_ref, resolve_mapping, resolve_ref


def test_is_mapping_ref_only_matches_the_exact_dollar_ref_object_shape():
    assert is_mapping_ref({"$ref": "input.text"}) is True
    assert is_mapping_ref("input.text") is False
    assert is_mapping_ref("steps.x.output.y") is False
    assert is_mapping_ref({"$ref": "input.text", "extra": 1}) is False
    assert is_mapping_ref({"$ref": 123}) is False
    assert is_mapping_ref(None) is False
    assert is_mapping_ref(["$ref"]) is False


def test_resolve_ref_whole_input():
    assert resolve_ref("input", {"a": 1}, {}) == {"a": 1}


def test_resolve_ref_input_path():
    assert resolve_ref("input.a.b", {"a": {"b": 42}}, {}) == 42


def test_resolve_ref_input_missing_path_raises():
    with pytest.raises(MappingError, match="not found"):
        resolve_ref("input.missing", {"a": 1}, {})


def test_resolve_ref_step_output_whole():
    assert resolve_ref("steps.parse.output", {}, {"parse": {"rows": [1, 2]}}) == {"rows": [1, 2]}


def test_resolve_ref_step_output_path():
    assert resolve_ref("steps.parse.output.rows", {}, {"parse": {"rows": [1, 2]}}) == [1, 2]


def test_resolve_ref_unknown_step_raises():
    with pytest.raises(MappingError, match="does-not-exist"):
        resolve_ref("steps.does-not-exist.output.x", {}, {})


def test_resolve_ref_not_yet_executed_step_raises():
    # A step that exists in the spec but has not produced output yet
    # (or was skipped/failed) is indistinguishable here by design.
    with pytest.raises(MappingError, match="has not produced output"):
        resolve_ref("steps.later.output.x", {}, {"earlier": {"x": 1}})


def test_resolve_ref_malformed_steps_ref_raises():
    with pytest.raises(MappingError, match="expected"):
        resolve_ref("steps.parse", {}, {"parse": {"x": 1}})


def test_resolve_ref_invalid_prefix_raises():
    with pytest.raises(MappingError, match='must start with "input" or "steps\\."'):
        resolve_ref("something.else", {}, {})


def test_resolve_mapping_mixes_refs_and_static_values():
    resolved = resolve_mapping(
        {
            "text": {"$ref": "input.text"},
            "rows": {"$ref": "steps.parse.output.rows"},
            "language": "en",
            "looksLikeARefButIsnt": "input.text",
        },
        {"text": "hello"},
        {"parse": {"rows": [1, 2, 3]}},
    )
    assert resolved == {
        "text": "hello",
        "rows": [1, 2, 3],
        "language": "en",
        "looksLikeARefButIsnt": "input.text",
    }


def test_resolve_mapping_propagates_the_first_error():
    with pytest.raises(MappingError):
        resolve_mapping({"a": {"$ref": "input.missing"}}, {}, {})
