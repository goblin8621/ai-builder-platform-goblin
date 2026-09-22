import json
from pathlib import Path

import pytest

from app.common.errors import AppError
from app.skills.validator import validate_skill_spec

FIXTURES_DIR = Path(__file__).resolve().parents[1] / "contract" / "fixtures" / "skill-spec"
FIXTURE_FILES = sorted(FIXTURES_DIR.glob("*.json"))


@pytest.mark.parametrize("fixture_path", FIXTURE_FILES, ids=lambda p: p.name)
def test_skill_spec_fixture(fixture_path: Path):
    assert fixture_path.name.startswith(("valid-", "invalid-")), (
        f"Fixture {fixture_path.name} must be named valid-*.json or invalid-*.json"
    )
    spec = json.loads(fixture_path.read_text())

    if fixture_path.name.startswith("valid-"):
        result = validate_skill_spec(spec)
        assert result.schemaVersion == "1.0"
    else:
        with pytest.raises(AppError) as exc_info:
            validate_skill_spec(spec)
        assert exc_info.value.code == "validation_error"
        assert len(exc_info.value.details["errors"]) > 0


def test_fixture_set_covers_valid_and_invalid_cases():
    names = [p.name for p in FIXTURE_FILES]
    assert any(n.startswith("valid-") for n in names)
    assert any(n.startswith("invalid-") for n in names)
