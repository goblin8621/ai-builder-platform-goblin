"""Skill Execution Engine (08. Skill Runtime / Execution Engine 설계).

Phase 5 gave this `llm` / `transform` steps only, always `fail`-on-error.
Phase 6 adds:
  - real `retry` / `fallback` / `skip` Error Policy (with infinite-Fallback-
    loop protection — 08번 6.: "무한 재시도와 Fallback Loop를 차단한다")
  - `tool` steps, dispatched to a `ToolExecutor` (app/tools/executors.py),
    counted against `runtime.maxToolCalls`
  - `knowledge` steps, searched via app/rag/vectorizer.py against a
    corpus BFF already fetched (Brain has no DB — see module note below)
  - `skill` steps (Nested Skill), executed recursively in-process against
    a map of already-resolved (version-pinned) child specs BFF supplies
    — 08번 8.: "Child Version을 호출 시점에 고정"
  - Human Approval (08번 7.): a Step with `approvalRequired: true` halts
    BEFORE executing it — Brain has no notion of "waiting", it simply
    returns immediately with `status="waiting_approval"` and a
    `pendingApproval` marker describing the paused Step. BFF persists that
    as the Run's status and, on a later `approve`, calls `/runtime/execute`
    again with `resumeFromStepId`/`approvedStepId` set to that Step and
    `priorStepOutputs` reconstructed from the Steps BFF already persisted
    — Brain re-enters the SAME Step (now treated as approved) and
    continues. `reject` never calls Brain again; BFF just ends the Run.

`condition` steps remain unsupported (Phase 7+); a Step of that type still
fails clearly rather than silently no-op'ing.

Nested Skill / Knowledge data note: Brain has no database access (06번
역할 분리). BFF resolves and pins every reachable child Skill Version (up
to `maxNestedSkillDepth`) and fetches every in-scope Knowledge chunk
*before* calling `/runtime/execute`, passing them as plain data
(`child_skills`, `knowledge_corpus`). Brain only ever reads this map — a
`skill` step whose `refId` is missing from it fails with a clear error
that doubles as depth/cycle enforcement (it was intentionally left out by
BFF for exactly that reason).
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Literal, Optional

from jsonschema import Draft7Validator
from pydantic import BaseModel

from app.common.models.interface import ModelClient, ModelCompletionRequest
from app.common.json_utils import parse_json_object
from app.common.tools.interface import ToolCallRequest, ToolExecutor
from app.rag.vectorizer import search as knowledge_search
from app.skills.mapping_resolver import MappingError, resolve_mapping
from app.skills.step_prompts import build_step_system_prompt, build_step_user_prompt

SUPPORTED_STEP_TYPES = {"llm", "transform", "tool", "knowledge", "skill"}


class StepResult(BaseModel):
    stepId: str
    stepType: str
    status: Literal["completed", "failed", "skipped"]
    attempt: int = 1
    input: dict[str, Any]
    output: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    # Present only for stepType == "skill": the child Run's own full trace,
    # so BFF can persist it as a real skill_runs/skill_run_steps row tree
    # with parent_run_id set (02번). Recursive (a grandchild nests inside).
    childRun: Optional[dict[str, Any]] = None


class PendingApproval(BaseModel):
    stepId: str
    stepType: str
    input: dict[str, Any]


class RunResult(BaseModel):
    status: Literal["completed", "failed", "waiting_approval"]
    output: Optional[dict[str, Any]] = None
    error: Optional[str] = None
    steps: list[StepResult] = []
    pendingApproval: Optional[PendingApproval] = None


@dataclass
class ChildSkillRef:
    skillId: str
    skillVersionId: str
    spec: dict[str, Any]


@dataclass
class _ExecutionBudget:
    """Shared across a whole Run INCLUDING nested child Skill Runs, so a
    parent can't bypass its own `maxToolCalls` by delegating to children."""

    max_tool_calls: int
    tool_calls_used: int = 0

    def use_tool_call(self) -> None:
        self.tool_calls_used += 1
        if self.tool_calls_used > self.max_tool_calls:
            raise RuntimeError(f"runtime.maxToolCalls ({self.max_tool_calls}) exceeded")


@dataclass
class _ExecutionContext:
    model_client: ModelClient
    default_model_id: str
    tool_executor: Optional[ToolExecutor]
    child_skills: dict[str, ChildSkillRef]
    knowledge_corpus: list[dict[str, Any]]
    budget: _ExecutionBudget
    depth: int = 0
    max_depth: int = 0
    # Every step id entered so far in THIS Skill's execution (sequential or
    # via fallback) — used only to detect a fallback chain looping back to
    # an already-visited step. Fresh per Skill invocation (not shared with
    # a parent/child across a Nested Skill boundary).
    visited_step_ids: set[str] = field(default_factory=set)


def _resolve_step_input(
    step: dict[str, Any],
    run_input: dict[str, Any],
    step_outputs: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    input_map = step.get("inputMap")
    if not input_map:
        return run_input
    return resolve_mapping(input_map, run_input, step_outputs)


async def _execute_llm_step(
    step_input: dict[str, Any],
    output_schema: dict[str, Any],
    spec: dict[str, Any],
    ctx: _ExecutionContext,
) -> dict[str, Any]:
    model_cfg = spec.get("model", {})
    model_id = model_cfg.get("modelId") if model_cfg.get("mode") != "user" else None
    model_id = model_id or ctx.default_model_id

    instructions = spec.get("instructions", {})
    messages = [
        {
            "role": "system",
            "content": build_step_system_prompt(instructions.get("objective", ""), instructions.get("rules", [])),
        },
        {"role": "user", "content": build_step_user_prompt(step_input, output_schema)},
    ]
    result = await ctx.model_client.complete(ModelCompletionRequest(model_id=model_id, messages=messages))
    return parse_json_object(result.text)


def _execute_transform_step(step_input: dict[str, Any]) -> dict[str, Any]:
    # "Safe Transform Executor": identity pass-through of whatever
    # inputMap already assembled — no arbitrary code execution (08번).
    return dict(step_input)


async def _execute_tool_step(step: dict[str, Any], step_input: dict[str, Any], ctx: _ExecutionContext) -> dict[str, Any]:
    if ctx.tool_executor is None:
        raise RuntimeError("no ToolExecutor configured for this Runtime")
    ctx.budget.use_tool_call()
    ref_id = step.get("refId")
    result = await ctx.tool_executor.call(ToolCallRequest(tool_id=ref_id, input=step_input))
    return result.output


async def _execute_knowledge_step(step_input: dict[str, Any], ctx: _ExecutionContext) -> dict[str, Any]:
    query = step_input.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError('knowledge step requires a "query" string field in its resolved input')
    top_k = step_input.get("topK", 3)
    results = knowledge_search(query, ctx.knowledge_corpus, top_k=top_k)
    return {"results": results}


async def _execute_skill_step(
    step: dict[str, Any],
    step_input: dict[str, Any],
    ctx: _ExecutionContext,
) -> tuple[dict[str, Any], dict[str, Any]]:
    child_id = step.get("refId")
    if ctx.depth >= ctx.max_depth:
        raise RuntimeError(f"runtime.maxNestedSkillDepth ({ctx.max_depth}) exceeded")
    child_ref = ctx.child_skills.get(child_id) if child_id else None
    if child_ref is None:
        raise RuntimeError(
            f"child skill '{child_id}' was not provided to the Runtime "
            "(unknown skill id, or exceeds maxNestedSkillDepth)"
        )

    child_ctx = _ExecutionContext(
        model_client=ctx.model_client,
        default_model_id=ctx.default_model_id,
        tool_executor=ctx.tool_executor,
        child_skills=ctx.child_skills,
        knowledge_corpus=ctx.knowledge_corpus,
        budget=ctx.budget,
        depth=ctx.depth + 1,
        max_depth=ctx.max_depth,
    )
    child_result = await _execute_skill_with_context(child_ref.spec, step_input, child_ctx)
    child_trace = {
        "skillId": child_ref.skillId,
        "skillVersionId": child_ref.skillVersionId,
        **child_result.model_dump(),
    }
    if child_result.status != "completed":
        raise RuntimeError(f"child skill '{child_id}' Run failed: {child_result.error}")
    return child_result.output or {}, child_trace


def _next_step_id(steps_spec: list[dict[str, Any]], current_id: str) -> Optional[str]:
    ids = [s["id"] for s in steps_spec]
    idx = ids.index(current_id)
    return ids[idx + 1] if idx + 1 < len(ids) else None


def _last_completed_output(results: list[StepResult]) -> Optional[dict[str, Any]]:
    """Scans backward for the last Step that actually completed — never
    just `results[-1]`, so a trailing skipped/fallback-routed Step can't
    silently become the Run Output (Phase 5/6 결정)."""
    for result in reversed(results):
        if result.status == "completed":
            return result.output
    return None


async def _run_steps(
    spec: dict[str, Any],
    run_input: dict[str, Any],
    ctx: _ExecutionContext,
    start_step_id: Optional[str] = None,
    prior_step_outputs: Optional[dict[str, dict[str, Any]]] = None,
    approved_step_id: Optional[str] = None,
) -> tuple[list[StepResult], Optional[dict[str, Any]], Optional[str], Optional[PendingApproval]]:
    steps_spec: list[dict[str, Any]] = spec["execution"]["steps"]
    step_by_id = {s["id"]: s for s in steps_spec}
    step_outputs: dict[str, dict[str, Any]] = dict(prior_step_outputs or {})
    results: list[StepResult] = []

    current_id: Optional[str] = start_step_id or (steps_spec[0]["id"] if steps_spec else None)

    while current_id is not None:
        # Tracks EVERY step id ever entered (sequential progress or a
        # fallback jump) so a fallback chain that loops back to ANY
        # earlier step — not just a previous fallback *target* — is
        # caught (e.g. start -> fails -> fallback B -> fails -> fallback
        # back to start would otherwise not be a previously-recorded
        # "fallback target" and could loop forever).
        ctx.visited_step_ids.add(current_id)
        step = step_by_id[current_id]
        step_type = step["type"]
        is_last = current_id == steps_spec[-1]["id"]
        output_map_present = bool(spec["execution"].get("outputMap"))
        target_output_schema = spec["outputSchema"] if (is_last and not output_map_present) else {"type": "object"}

        try:
            step_input = _resolve_step_input(step, run_input, step_outputs)
        except MappingError as exc:
            error = f"Step '{current_id}' input mapping failed: {exc}"
            results.append(StepResult(stepId=current_id, stepType=step_type, status="failed", input={}, error=error))
            return results, None, error, None

        if step.get("approvalRequired") and current_id != approved_step_id:
            pending = PendingApproval(stepId=current_id, stepType=step_type, input=step_input)
            return results, None, None, pending

        on_error = step.get("onError") or {"action": "fail"}
        action = on_error.get("action", "fail")
        max_attempts = (on_error.get("retryCount") or 0) + 1 if action == "retry" else 1

        step_succeeded = False
        last_error_message: Optional[str] = None
        output: Optional[dict[str, Any]] = None
        child_trace: Optional[dict[str, Any]] = None

        for attempt in range(1, max_attempts + 1):
            try:
                if step_type not in SUPPORTED_STEP_TYPES:
                    raise NotImplementedError(
                        f"Step type '{step_type}' is not supported until a later Runtime phase"
                    )
                if step_type == "llm":
                    output = await _execute_llm_step(step_input, target_output_schema, spec, ctx)
                elif step_type == "tool":
                    output = await _execute_tool_step(step, step_input, ctx)
                elif step_type == "knowledge":
                    output = await _execute_knowledge_step(step_input, ctx)
                elif step_type == "skill":
                    output, child_trace = await _execute_skill_step(step, step_input, ctx)
                else:  # transform
                    output = _execute_transform_step(step_input)

                results.append(
                    StepResult(
                        stepId=current_id,
                        stepType=step_type,
                        status="completed",
                        attempt=attempt,
                        input=step_input,
                        output=output,
                        childRun=child_trace,
                    )
                )
                step_outputs[current_id] = output
                step_succeeded = True
                break
            except Exception as exc:  # noqa: BLE001 - every Step failure funnels through the same Error Policy
                last_error_message = str(exc)
                is_final_attempt = attempt == max_attempts
                status: Literal["failed", "skipped"] = "skipped" if (is_final_attempt and action == "skip") else "failed"
                step_error = f"Step '{current_id}' failed (attempt {attempt}/{max_attempts}): {last_error_message}"
                results.append(
                    StepResult(
                        stepId=current_id,
                        stepType=step_type,
                        status=status,
                        attempt=attempt,
                        input=step_input,
                        error=step_error,
                    )
                )

        if step_succeeded:
            current_id = _next_step_id(steps_spec, current_id)
            continue

        if action == "skip":
            current_id = _next_step_id(steps_spec, current_id)
            continue

        if action == "fallback":
            target = on_error["fallbackStepId"]
            if target in ctx.visited_step_ids:
                error = f"Step '{current_id}' fallback to '{target}' would create an infinite Fallback loop"
                return results, None, error, None
            current_id = target
            continue

        # 'fail' (explicit, default, or retry attempts exhausted)
        error = f"Step '{current_id}' failed after {max_attempts} attempt(s): {last_error_message}"
        return results, None, error, None

    try:
        output_map = spec["execution"].get("outputMap")
        final_output = (
            resolve_mapping(output_map, run_input, step_outputs) if output_map else _last_completed_output(results)
        )
    except MappingError as exc:
        error = f"execution.outputMap failed: {exc}"
        return results, None, error, None

    return results, final_output, None, None


async def _execute_skill_with_context(
    spec: dict[str, Any],
    run_input: dict[str, Any],
    ctx: _ExecutionContext,
    start_step_id: Optional[str] = None,
    prior_step_outputs: Optional[dict[str, dict[str, Any]]] = None,
    approved_step_id: Optional[str] = None,
) -> RunResult:
    timeout_sec = spec.get("runtime", {}).get("timeoutSec", 30)

    try:
        steps, output, error, pending_approval = await asyncio.wait_for(
            _run_steps(spec, run_input, ctx, start_step_id, prior_step_outputs, approved_step_id),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        return RunResult(status="failed", error=f"Run exceeded runtime.timeoutSec ({timeout_sec}s)", steps=[])

    if pending_approval is not None:
        return RunResult(status="waiting_approval", steps=steps, pendingApproval=pending_approval)

    if error is not None:
        return RunResult(status="failed", error=error, steps=steps)

    output_errors = sorted(
        f"{'/'.join(str(p) for p in e.path) or '(root)'}: {e.message}"
        for e in Draft7Validator(spec["outputSchema"]).iter_errors(output)
    )
    if output_errors:
        return RunResult(status="failed", error=f"Output failed outputSchema validation: {output_errors}", steps=steps)

    return RunResult(status="completed", output=output, steps=steps)


async def execute_skill(
    spec: dict[str, Any],
    run_input: dict[str, Any],
    model_client: ModelClient,
    default_model_id: str = "model-001",
    tool_executor: Optional[ToolExecutor] = None,
    child_skills: Optional[dict[str, ChildSkillRef]] = None,
    knowledge_corpus: Optional[list[dict[str, Any]]] = None,
    resume_from_step_id: Optional[str] = None,
    prior_step_outputs: Optional[dict[str, dict[str, Any]]] = None,
    approved_step_id: Optional[str] = None,
) -> RunResult:
    budget = _ExecutionBudget(max_tool_calls=spec.get("runtime", {}).get("maxToolCalls", 0))
    ctx = _ExecutionContext(
        model_client=model_client,
        default_model_id=default_model_id,
        tool_executor=tool_executor,
        child_skills=child_skills or {},
        knowledge_corpus=knowledge_corpus or [],
        budget=budget,
        depth=0,
        max_depth=spec.get("runtime", {}).get("maxNestedSkillDepth", 0),
    )
    return await _execute_skill_with_context(
        spec, run_input, ctx, resume_from_step_id, prior_step_outputs, approved_step_id
    )
