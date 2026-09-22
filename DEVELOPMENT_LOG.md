# AI Builder Platform — 개발 현황 (Phase 1~6)

> 이 문서는 신규 Standalone Skill Platform(`ai-builder-platform`)의 지금까지 개발 이력을
> 정리한 기록입니다. 공식 설계 기준은 Notion "AI Builder Platform 기능 기획안"(00~09번
> 문서)이며, 이 문서는 그 기준으로 실제 무엇을 구현했는지, 어떤 설계 결정을 내렸는지,
> 무엇이 아직 남았는지를 코드 기준으로 정리한 진행 로그입니다. **Notion 문서 자체는
> 수정하지 않았습니다** — 03/08번 문서에 반영이 필요한 항목은 아래 [문서 반영 필요
> 항목]에 별도로 정리했습니다.

- 기준 날짜: 2026-09-22
- 완료 Phase: **Phase 1 ~ Phase 6**
- 다음 Phase: Phase 7 (Skill Playground) — 아직 미착수

---

## 0. 전체 아키텍처 (현재 구현 기준)

```
Web (미착수, Phase 7)
      ↓
BFF (Node.js/Fastify) — Skill CRUD/Version, Skill Run API, Registry 조회 프록시,
                         Document API, DB Transaction 전담
      ↓ REST/JSON
Python Brain (FastAPI) — Skill Builder, Skill Runtime/Execution Engine,
                          Model/Tool/Capability Registry 구현체, Sandbox, RAG
      ↓
PostgreSQL (Docker Compose) — workspaces/skills/skill_versions/skill_runs/
                               skill_run_steps/documents/document_chunks
```

- BFF는 DB를 소유하고 Brain은 DB에 접근하지 않는다(06번 역할 분리) — Nested Skill과
  Knowledge Step 실행에 필요한 데이터는 BFF가 미리 조회해서 Brain에 넘긴다.
- Preview는 아직 Playground(Phase 7)가 없어 UI로 확인할 수 없지만, `POST /skill-runs`가
  실제 Runtime과 100% 동일 경로이므로 언제든 그대로 Preview에 재사용 가능한 구조다.
- 인증은 구현하지 않고 `RequestContext`(userId/workspaceId/requestId) +
  `AuthContextProvider`/`DevAuthContextProvider`로 경계만 분리해두었다(Phase 1 결정).

---

## Phase 1 — Project Bootstrap / Common Foundation

**구현 범위**
- 저장소 구조(`ai-builder-platform/`), Web/BFF/Brain 3계층, PostgreSQL(Docker Compose)
- Config/Error/Logging 공통 모듈, Health Check
- `RequestContext` + `AuthContextProvider` 인터페이스 + `DevAuthContextProvider`(seed 값,
  헤더로 override 가능, 운영에서는 override 비활성화)
- Common Foundation 인터페이스만 정의(구현 없음): Model/Tool/Knowledge/Capability/
  Approval/Streaming/Sandbox
- BFF ↔ Brain: REST/HTTP+JSON, OpenAPI로 계약 관리, Correlation ID(requestId) 전파

**DB**: `001_init.sql` — `workspaces` 테이블 + seed 1건

**결정/이슈**
- 프로젝트 위치는 `/Users/a09281/claude/one-chat/ai-builder-platform/` 하위 신규 생성
- Python은 3.11 계열로 고정(`brain/.python-version` = 3.11.12), 시스템 기본 3.13은 사용 안 함
- 로컬 인프라는 Docker Compose(Postgres만), Podman 환경에서도 동일하게 동작 확인

**테스트**: BFF/Brain 각각 Health/Config 최소 테스트 통과

---

## Phase 2 — Skill Contract / DB

**구현 범위**
- SkillSpec v1: JSON Schema(`contracts/skill-spec.schema.json`, **유일한 검증 기준**) +
  TS 타입(`contracts/skill-spec.ts`, 타입 미러) + Python Pydantic(`schemas.py`, 타입 미러)
- 구조적/의미적 검증(Registry 불필요한 부분만): unknown field 거부, step id 중복 금지,
  fallbackStepId 존재 검증, JSON Schema로서의 inputSchema/outputSchema 유효성 검증
- DB: `skills`/`skill_versions`/`skill_runs`/`skill_run_steps`/`documents`/`document_chunks`
  전체 테이블 + 필수 인덱스(`002_skill_registry.sql`)

**Contract Test**: 공유 fixture(`tests/contract/fixtures/skill-spec/`)를 TS/Python 양쪽이
동시에 검증 — 두 언어의 판정이 항상 일치함을 자동으로 보증

**결정/이슈**
- `document_chunks.embedding`은 pgvector 미도입으로 `jsonb`(임시, 현재도 미사용)
- Runtime Limit 상한(`timeoutSec≤600` 등)은 잠정값으로 JSON Schema에 명시

---

## Phase 3 — Registry / Skill CRUD

**구현 범위**
- Model/Tool Registry: 정적 카탈로그(Brain), Capability Registry(Phase 3 시점엔 전부 false)
- Skill CRUD: `GET/POST /skills`, `GET/PATCH /skills/:id`, `activate`, `duplicate`,
  `DELETE`(soft delete), `GET /skills/:id/versions`, `.../restore`
- **Registry Validation(신규 계층)**: 구조검증 통과 후 modelId/toolId 존재, Capability
  서버 지원 여부, **Skill 참조 직접/간접 Cycle 차단**(BFS)까지 저장 시점에 차단
- `GET /models`, `/tools`, `/capabilities` — BFF가 Brain을 그대로 프록시

**결정/이슈**
- Version append-only, `expectedVersion` 불일치 시 409, Restore/Duplicate 시 Registry 재검증

**테스트**: BFF 40개(신규 19개) 통과, HTTP E2E로 409/404/400 에러 포맷까지 확인

---

## Phase 4 — Skill Builder

**구현 범위**
- Builder 파이프라인(Brain): `request → LLM 구조화 출력 → SkillSpec 검증 → Registry 검증
  → 실패 시 Repair 1회 → Draft/Update/Clarify`
- `POST /skills/build`, `POST /skills/:id/refine`(BFF) — Builder 출력은 절대 그대로
  신뢰하지 않고 수동 제출 Spec과 **동일한** 3단계 검증을 다시 통과해야 저장
- `ModelClient` 실제 구현 2종: `AnthropicModelClient`(운영), `HeuristicModelClient`(개발/
  테스트 전용 결정론적 Fallback)

**결정/이슈 — 중요**
- 이 환경에는 실제 LLM API Key가 없음. `ANTHROPIC_API_KEY`가 있으면 실제 Anthropic을
  쓰고, 없으면 개발환경에선 Heuristic으로 자동 대체(운영에서는 Phase 5 결정으로 금지,
  아래 참고)
- Builder 자체의 자연어 이해 품질은 검증되지 않음 — 파이프라인(검증/Repair/Registry체크/
  refine 필드보존) 정합성만 실제로 테스트됨

**테스트**: Brain 35개(+14 신규), BFF 45개(+5 신규) 통과

---

## Phase 5 — Core Skill Runtime

**구현 범위**
- Execution Engine(Brain): `llm`/`transform` Step만 지원, 그 외는 명확히 실패
- `POST /skill-runs`, `GET /skill-runs/:id` — Input Validation(실패 시 Run 행 미생성) →
  Run 저장(Skill Version 고정) → Brain 실행 → Output Validation(Brain) → Run/Step 저장
- Skill Version Pinning 실증(과거 Run은 이후 Skill 수정에 영향받지 않음)

**Phase 5 → Phase 6에서 재설계된 항목** (사용자 피드백 반영)
1. **최종 Run Output 규칙**: "마지막 Step = 최종 Output"이 아니라 `execution.outputMap`
   (명시적 매핑)이 있으면 그것을 사용, 없으면 **뒤에서부터 스캔한 마지막 성공 Step**을
   기본값으로 사용(향후 skip/fallback 대비)
2. **Mapping 문법 변경**: `"steps.x.output.y"` 같은 일반 문자열 방식 → **명시적
   `{"$ref": "..."}` 객체만 참조**로 인정(그 외는 전부 Static Value, 참조처럼 보이는
   문자열도 포함). `brain/app/skills/mapping_resolver.py`로 별도 모듈화
3. **ModelClient 운영/개발 분리 강화**: `brain/app/common/models/selection.py` 신설 —
   운영(`BRAIN_ENV=production`)에서 Key가 없으면 **앱 기동 자체가 실패**(조용한 Heuristic
   대체 금지). 실제 LLM opt-in Smoke Test(`LIVE_LLM_TEST=true`) 추가

**테스트**: Brain 47→(재설계 후)여러 차례 갱신, BFF 45→51개

---

## Phase 6 — Extended Runtime

**구현 범위**
- **Retry/Fallback/Skip**: `onError.action` 전체 실동작. 무한 Fallback Loop 차단(시작
  Step으로 되돌아오는 케이스 포함)
- **Tool 실행 + Sandbox**: `file-parser`(CSV 파싱)/`python-data-analysis`(월별 합계,
  이상치 탐지 — 고정 스크립트 + subprocess Sandbox)/`service-status`(시뮬레이션) 실제
  구현. `runtime.maxToolCalls` Run 전체(Nested 포함) 강제
- **Nested Skill**: BFF가 `maxNestedSkillDepth`까지 Child Skill Version을 재귀적으로
  고정해 Brain에 전달 → Brain이 in-process 재귀 실행 → BFF가 실제 `parent_run_id` 연결된
  Run/Step으로 저장
- **Human Approval/Cancel**: `approvalRequired` Step은 실행 전 정지(Side Effect 없음
  실증). `approve`는 기저장된 완료 Step으로 상태 복원 후 재개, `reject`는 Brain 재호출
  없이 종료. `cancel`은 `waiting_approval`에서만 허용(동기 실행 중인 Run은 라이브 취소
  불가 — 명확한 에러로 안내)
- **RAG/Knowledge**: `POST/GET/DELETE /documents`(텍스트 전용, 800자 고정 청크), 로컬
  해싱 기반 유사도 검색(`brain/app/rag/vectorizer.py`, 결정론적 TF 벡터+코사인 유사도),
  `knowledge` Step 실행
- **Capability 전환**: `codeExecution`/`dataAnalysis`/`fileAnalysis`/`knowledgeSearch` →
  `true`(실제 구현 존재). `webSearch`/`imageGeneration`/`mcp`는 계속 `false`

**명시적으로 보류**
- **Streaming(SSE)**: 동기 호출 구조를 바꾸는 별도 아키텍처 작업 필요
- **MCP**: 연동 테스트할 실제 MCP 서버가 없음

**설계 이슈**
- Sandbox는 **프로세스 수준 격리**(subprocess)이지 컨테이너/VM 격리가 아님 — 신뢰할 수
  없는 사용자 코드를 다중 테넌트 운영에서 실행하기엔 부족(06번이 열어둔 선택, 최종
  결정 아님)
- RAG는 진짜 임베딩이 아니라 결정론적 해싱 기반 키워드 유사도(Phase4/5의 Heuristic
  LLM과 같은 성격의 투명한 placeholder)

**테스트**: Brain 107개(+1 skipped opt-in), BFF 73개 통과. HTTP E2E로 Document/Nested
Skill/Approve/Reject/Cancel 전부 실제 확인

---

## 1. 현재 지원 범위 요약

| 영역 | 상태 |
|---|---|
| Skill Builder (create/refine/repair) | ✅ (LLM은 Heuristic 또는 실제 Anthropic, Key 필요) |
| Skill CRUD/Version/Restore | ✅ |
| Skill Run (동기 실행) | ✅ |
| Input/Output Schema Validation | ✅ |
| Retry/Fallback/Skip | ✅ |
| Tool 실행 (file-parser/python-data-analysis/service-status) | ✅ (로컬/결정론적, 외부 연동 없음) |
| Sandbox | ✅ (프로세스 격리, 컨테이너/VM 아님) |
| Nested Skill (Parent/Child Run) | ✅ |
| Human Approval / Reject | ✅ |
| Cancel | ⚠️ `waiting_approval`에서만 (동기 실행 중엔 불가) |
| Knowledge/RAG | ✅ (로컬 해싱 유사도, 실제 임베딩 아님) |
| Document 업로드 | ⚠️ 텍스트 전용, 바이너리/오브젝트 스토리지 없음 |
| Streaming(SSE) | ❌ 보류 |
| MCP | ❌ 보류 |
| Agent/외부 서비스 연동 | ❌ 범위 밖(계획대로) |
| Skill Playground(Web UI) | ❌ 미착수 (Phase 7) |

---

## 2. 문서 반영 필요 항목 (Notion, 미반영)

Phase 5에서 사용자 결정으로 도입했으나 **Notion 03/08번 문서에는 아직 반영되지
않은** 규칙:

1. **Run Output 규칙**: `execution.outputMap`이 있으면 그것을 최종 Output으로,
   없으면 "뒤에서부터 스캔한 마지막 성공 Step" output을 기본값으로 사용
2. **Mapping 참조 문법**: `inputMap`/`outputMap` 값은 `{"$ref": "input.<path>"}` /
   `{"$ref": "steps.<stepId>.output.<path>"}` 객체만 참조로 인정, 그 외 값(문자열
   포함)은 전부 Static Value

---

## 3. 다음 계획

- **Phase 7 — Skill Playground**: My Skills / 만들기·구성 / Preview / Debug / Run·Version
  History (Web UI, 지금까지 만든 API를 그대로 사용)
- **Phase 8 — E2E / Stabilization**: 00번 유즈케이스 전체 재검증, Failure/Isolation/
  Restart Recovery/Security/Runtime Limit 테스트
- 보류 항목(Streaming, MCP, 컨테이너 기반 Sandbox 강화, 실제 임베딩 Provider 연동)은
  이후 필요 시점에 별도로 진행
- Phase 8 완료 전 최소 1개 실제 LLM Provider 연동 확인 필요(`LIVE_LLM_TEST=true`)
