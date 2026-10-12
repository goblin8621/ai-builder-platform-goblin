"""Shared builders for the Phase 9 Export tests (not a test module)."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from app.exports.models import ExportCompileRequest

FIXTURES = Path(__file__).resolve().parents[1] / "contract" / "fixtures"


def load_spec_fixture(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / "skill-spec" / name).read_text())


def prompt_spec(**overrides: Any) -> dict[str, Any]:
    spec = load_spec_fixture("valid-prompt-skill.json")
    spec.update(overrides)
    return spec


def workflow_spec() -> dict[str, Any]:
    return load_spec_fixture("valid-workflow-skill.json")


def composite_spec(child_ref: str, *extra_steps: dict[str, Any], name: str = "Composite Parent") -> dict[str, Any]:
    spec = prompt_spec(name=name, skillType="composite")
    spec["execution"] = {
        "steps": [
            {
                "id": "delegate",
                "name": "Delegate",
                "type": "skill",
                "refId": child_ref,
                "inputMap": {"text": {"$ref": "input.text"}},
            },
            *extra_steps,
        ]
    }
    spec["runtime"] = {"timeoutSec": 60, "retryCount": 1, "maxToolCalls": 0, "maxNestedSkillDepth": 3}
    return spec


def child(skill_id: str, name: str, spec: dict[str, Any], version: int = 1) -> dict[str, Any]:
    return {"skillId": skill_id, "name": name, "version": version, "spec": spec}


def document(doc_id: str, file_name: str, content: str | None, mime: str = "text/plain") -> dict[str, Any]:
    return {"documentId": doc_id, "fileName": file_name, "mimeType": mime, "content": content}


def knowledge_spec(doc_ids: list[str], mode: str = "selected") -> dict[str, Any]:
    spec = copy.deepcopy(prompt_spec(name="Knowledge Skill", skillType="knowledge"))
    spec["capabilities"]["knowledgeSearch"] = True
    spec["knowledge"] = {"mode": mode, "documentIds": doc_ids}
    spec["execution"] = {
        "steps": [
            {"id": "search", "name": "Search", "type": "knowledge", "inputMap": {"query": {"$ref": "input.text"}}},
            {"id": "answer", "name": "Answer", "type": "llm"},
        ]
    }
    return spec


# Shorthand used across the tests: name -> (target, format).
FORMATS: dict[str, tuple[str, str]] = {
    "portable-package": ("generic", "portable-package"),
    "generic-markdown": ("generic", "markdown"),
    "raw-spec": ("generic", "raw-spec"),
    "claude": ("claude", "skill-package"),
}


def make_request(
    spec: dict[str, Any],
    *,
    skill_id: str = "skill-001",
    version: int = 1,
    fmt: str | tuple[str, str] = "portable-package",
    include_knowledge: bool = False,
    include_children: bool = False,
    include_source: bool = False,
    children: list[dict[str, Any]] | None = None,
    documents: list[dict[str, Any]] | None = None,
    dry_run: bool = False,
) -> ExportCompileRequest:
    target, format_id = FORMATS[fmt] if isinstance(fmt, str) else fmt
    return ExportCompileRequest.model_validate(
        {
            "skillId": skill_id,
            "version": version,
            "spec": spec,
            "children": children or [],
            "documents": documents or [],
            "options": {
                "target": target,
                "format": format_id,
                "includeKnowledge": include_knowledge,
                "includeChildSkills": include_children,
                "includeSourceSpec": include_source,
            },
            "dryRun": dry_run,
        }
    )
