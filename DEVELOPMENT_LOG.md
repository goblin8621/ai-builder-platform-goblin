# AI Builder Platform — 개발 현황 (Phase 1~9)

> 이 문서는 신규 Standalone Skill Platform(`ai-builder-platform`)의 지금까지 개발 이력을
> 정리한 기록입니다. 공식 설계 기준은 Notion "AI Builder Platform 기능 기획안"(00~09번
> 문서)이며, 이 문서는 그 기준으로 실제 무엇을 구현했는지, 어떤 설계 결정을 내렸는지,
> 무엇이 아직 남았는지를 코드 기준으로 정리한 진행 로그입니다. **Notion 문서 자체는
> 수정하지 않았습니다** — 03/08번 문서에 반영이 필요한 항목은 아래 [문서 반영 필요
> 항목]에 별도로 정리했습니다.

- 기준 날짜: 2026-10-07
- 완료 Phase: **Phase 1 ~ Phase 9** (+ 실LLM 실사용 검증 라운드)
- 다음 Phase: 없음 — Skill-first Standalone Platform + Skill Export/Portability 완료. Agent/외부 서비스 연동은 별도 착수 필요(자동 진행하지 않음)

---

## 0. 전체 아키텍처 (현재 구현 기준)

```
Web (Next.js 14 App Router, Phase 7) — Skill Playground
      ↓ REST/JSON (fetch, 브라우저에서 직접 BFF 호출)
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
- Preview(Phase 7 Web UI)는 `POST /skill-runs`(`mode: "preview"`)를 그대로 호출한다 —
  실제 Run과 100% 동일한 Runtime 경로이며 별도의 Fake Runtime은 없다.
- 인증은 구현하지 않고 `RequestContext`(userId/workspaceId/requestId) +
  `AuthContextProvider`/`DevAuthContextProvider`로 경계만 분리해두었다(Phase 1 결정).
- **Skill Export(Phase 9)**도 같은 역할 분리를 따른다 — BFF가 Version·Child·문서 권한을 해석해 Brain에
  넘기면 Brain(`brain/app/exports/`)이 PortableSkill 컴파일·Sanitizer·Compatibility·Adapter 변환만 하고,
  ZIP 패키징/다운로드는 BFF가 맡는다.
- Web은 Frontend에 Runtime 로직을 두지 않는다(00번 원칙) — Skill Spec 검증/실행/
  Approval 판단은 전부 BFF/Brain 응답을 그대로 표시할 뿐, Web 자체는 아무 판단도
  하지 않는다.

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

## Phase 7 — Skill Playground (Web UI)

**구현 범위**
- Next.js 14 App Router 신규 프로젝트(`web/`, 수동 스캐폴딩), Client Component만 사용
  (서버사이드 데이터 페칭 없음) — Web에는 Runtime 로직이 전혀 없다(00번 원칙 실증:
  모든 검증/실행/Approval 판단은 BFF/Brain 응답을 그대로 표시만 함)
- `web/lib/api.ts`: BFF REST API를 그대로 감싸는 fetch client. Skill CRUD/Build/Refine/
  Activate/Duplicate/Version History, Model/Tool/Capability 조회, Skill Run(Create/Get/
  Approve/Reject/Cancel), Document CRUD 전체 커버
- **My Skills** 목록 페이지: 자연어 "만들기" 입력 → `POST /skills/build` → 신규 Skill로
  이동, Activate/Duplicate/Archive
- **Skill Workspace** 페이지(만들기/구성/Version History 탭 + Preview/Debug 패널):
  - 만들기: 자연어 수정 요청 → `POST /skills/:id/refine`
  - 구성: SkillSpecV1 전체 필드 수동 편집(Capability는 서버 `GET /capabilities` 결과에
    따라 미지원 항목 비활성화, Model은 `GET /models` 목록에서만 선택 — Registry ID
    프론트 임의 생성 없음), Step 목록 편집(id/type/refId/approvalRequired/onError/
    inputMap), 저장 시 `expectedVersion` 포함 PATCH(충돌 시 409 처리 후 재조회)
  - Version History: 목록 + Restore
  - **Preview/Debug**: Preview는 저장된(persisted) Version만 실행 가능(Draft는 저장 전
    엔 실행 불가 — Version Pinning의 직접적 귀결). `mode: "preview"`로 실제
    `/skill-runs`를 그대로 호출하는 동일 Runtime 경로. Debug 탭은 Run 상태/Step별
    입출력/Nested Skill Child Run을 그대로 노출하되, **Chain-of-Thought(LLM reasoning
    내부 과정)는 애초에 API 응답에 존재하지 않으므로 노출될 수 없다**(00번 원칙)
  - Human Approval: `pendingApproval`이 있으면 Preview/Debug 어느 탭에 있든 항상 보이는
    Approve/Reject/Cancel 배너
- BFF에 `@fastify/cors` 추가(`config.webOrigins`, 기본 `http://localhost:3000`) — 브라우저
  에서 BFF를 직접 호출하기 위함

**실제 브라우저(Claude Browser 도구) E2E로 발견/수정한 버그 2건**
1. **Bodyless POST 500**: `web/lib/api.ts`가 body 없는 요청에도 항상
   `content-type: application/json`을 붙여 Fastify가 빈 body를 파싱하려다 500 발생
   (`POST /skills/:id/activate` 등). **원인은 Web 쪽** — body가 있을 때만 헤더를 붙이도록
   수정, 브라우저에서 Activate 정상 동작 재확인
2. **`pendingApproval`이 API 계약에 없던 문제(2단)**: (a) UX — 배너가 `tab==='preview'`
   조건 안에만 있어서 `run()`이 자동으로 Debug 탭으로 전환하면 안 보임 → 탭 조건 밖으로
   이동. (b) **원인은 BFF 쪽 실제 계약 결함** — `pendingApproval`이 최상위 필드로 전혀
   내려가지 않고 `run.output.__pendingApproval`(내부 저장 방식)에만 존재했음.
   `skill-run-service.ts`에 `toPublicRun()`을 추가해 모든 Run 응답에서 `pendingApproval`을
   최상위 필드로 노출하고 대기 중엔 `output`을 `null`로 정리, `markRunTerminal`도
   `output_json`을 함께 지우도록 수정(Reject/Cancel 후 마커 잔존 방지). 회귀 테스트 추가,
   BFF 재시작 후 브라우저에서 실제 확인

**브라우저 수동 검증 항목(전부 실제 스택 — Fake Runtime 없음)**
- Activate(버그 수정 후 재확인), Duplicate
- 자연어 Builder로 신규 Skill 생성 → 구성 탭에서 `approvalRequired`/`maxToolCalls` 수동
  수정 → 저장(v1→v2) → Preview 실행 → `WAITING_APPROVAL` 정지 확인
- **Approve**: 대기 중이던 `tool` Step이 실제로 재개·실행됨(`service-status` 실제 호출,
  Sandbox 아님 — 시뮬레이션 Tool). Step은 성공했으나 Heuristic Builder가 생성한
  `outputSchema`가 실제 Tool 출력과 맞지 않아 Run 전체는 `FAILED` — **이는 버그가
  아니라 Output Schema Validation이 의도대로 정직하게 작동한 것으로 판단**(Step 성공
  ≠ Run 성공을 실증)
- **Reject**: `waiting_approval` → `failed` 즉시 전환, `output: null`,
  `error.message: "Rejected by user at step '...'"`, `steps: []`(Tool이 실제로 한 번도
  호출되지 않음을 확인 — Approval 이전 Side Effect 없음 원칙 실증)
- **Cancel**: `waiting_approval` → `cancelled` 즉시 전환, Steps 없음
- **Nested Skill**: 기존 `composite` Skill("Nested Parent")을 Preview 실행 →
  `call-child`(skill) Step이 `COMPLETED`, Debug 패널의 "Child Runs (Nested Skill)"
  섹션에 실제 자식 `skill_runs` row(별도 UUID, `parent_run_id` 연결)가 그대로 노출됨
- **Knowledge**: 기존 `knowledge` Skill("Knowledge Test")을 Preview 실행 →
  `search`(knowledge) Step이 실제 RAG 코사인 유사도 검색 결과(content/chunkIndex/
  documentId 포함)를 반환

**설계 이슈**
- Web과 BFF 간 통신은 인증이 없다(Phase 1 결정 그대로) — CORS만 `webOrigins`로
  제한했을 뿐, 실제 Origin 검증/CSRF 방지는 없음. 운영 전환 시 반드시 재검토 필요
  (Notion에 이미 알려진 제약, Phase 1 결정사항 연장선)
- `web/lib/types.ts`는 `contracts/*.ts`를 import하지 않고 독립적으로 타입을 미러링함
  (Web을 독립 배포 가능한 프로젝트로 유지하기 위한 의도적 범위 결정이며, 타입 불일치
  가능성은 Contract Test로 방지되는 BFF/Brain 사이만큼 자동으로 보증되지 않음)

**테스트**: 브라우저 세션 중 발견한 2개 버그 모두 근본 원인(하나는 Web, 하나는 BFF)에서
수정 완료. 회귀 테스트 추가 후 재실행 결과 — **Brain 107 passed + 1 skipped(opt-in),
BFF 73 passed** (Phase 6과 동일 카운트 — Phase 7은 API 계약을 늘리지 않고 기존
엔드포인트의 응답 정확성만 수정했기 때문). 브라우저에서 생성한 테스트 Skill/Run은
검증 후 정리(`DELETE /skills/:id`)했고, Phase 1~6부터 누적된 자동화 테스트용 Fixture
Skill(Cancel Test/Nested Parent/Knowledge Test 등)은 대상에서 제외(기존 자동화 테스트
스위트가 소유한 데이터).

---

## Phase 8 — E2E / Stabilization

**구현 범위**: 09번 문서 기준 3가지(00 유즈케이스 검증 / Restart Recovery / Isolation·
Failure·Security Test)를 새 통합 테스트 스위트(`tests/e2e/`)로 실제 BFF→Brain→Postgres
경로에서 검증. Fake Runtime/Mock 없이 Phase 5~7이 만든 실제 서비스 계층만 사용.

- `tests/e2e/00-usecases.test.ts`: 00번의 6개 Skill 유즈케이스(번역/문서검색/CSV분석/
  API조회/승인필요운영변경/Composite배포)를 각각 재현. UC1·UC2·UC4는 실제 Skill
  Builder(Heuristic ModelClient)로 생성 후 실행, UC3·UC5·UC6은 Heuristic Builder가
  애초에 감지하지 못하는 skillType(workflow/승인/composite)이라 Phase 5~6과 동일한
  컨벤션대로 Spec을 직접 구성해 실행(자연어 이해 품질 자체는 Phase 4부터 이미 범위 밖).
- `tests/e2e/isolation.test.ts`: 두 번째 Workspace를 fixture로 생성해 Skill/Document가
  Workspace 경계를 절대 넘지 않음을 실제 Skill Run 경로로 확인(단순 Repository 단위
  테스트가 아니라 End-to-End).
- `tests/e2e/restart-recovery.test.ts`: BFF/Brain 모두 Run/Skill 상태를 메모리에 두지
  않는다는 것(코드 감사로 확인: 모듈 레벨 캐시 없음)을 "완전히 새로운 Pool +
  BrainClient" 시나리오로 재현해 증명. Phase 7 브라우저 세션 중 실제로 BFF 프로세스를
  kill 후 재기동했을 때도 기존 Skill/Run이 그대로 조회됐던 관찰과 일치.

**Phase 8 테스트로 발견하고 수정한 실제 버그 2건** (00번이 요구하는 정확한 조합을 직접
재현해보지 않으면 드러나지 않던 결함들)
1. **Heuristic Builder가 생성하는 knowledge Skill이 항상 실패함**: `search` Step에
   `inputMap`이 전혀 없어 `query` 필드가 절대 채워지지 않았음(UC2로 발견).
   `brain/app/common/models/heuristic_client.py`의 `_draft_knowledge_skill`에
   `inputMap: {"query": {"$ref": "input.question"}}` 추가로 수정.
2. **Heuristic Builder가 생성하는 tool Skill이 항상 실패함**: `_draft_tool_skill`이
   기본 `runtime.maxToolCalls=0`을 그대로 물려받아, Tool Step이 있는데도 Tool 호출이
   전부 차단됨(UC4로 발견). 같은 파일에서 tool Skill 생성 시 `maxToolCalls`를 5로
   override하도록 수정.

**Phase 8 테스트로 발견한 설계 이슈 (수정 여부 사용자 결정 완료)**
- **Nested Skill 자식의 Human Approval이 Parent Run으로 전파되지 않음**: 00번 UC6은
  "Composite Skill의 Deploy 단계는 승인 필요"를 요구하지만, 실제로는 자식 Skill이
  `waiting_approval`이 되면 Brain의 재귀 실행 엔진이 이를 즉시 실패("Run failed: None")
  로 처리했다 — Parent Run이 함께 대기하는 게 아니라 알 수 없는 에러로 끝남. 제대로
  고치려면 Brain의 재귀 실행 엔진과 BFF의 approve/resume 로직 둘 다 "여러 단계
  nesting을 거친 대기 지점"을 표현할 수 있어야 하는, Phase 8 범위를 넘는 별도 설계
  작업이 필요하다고 판단해 사용자에게 확인. **결정: 지금은 전파 기능 자체를 구현하지
  않고, 알 수 없는 에러 대신 "Nested Skill 안의 approvalRequired는 아직 지원되지
  않는다"는 명확한 에러로만 수정**(`brain/app/skills/execution_engine.py`). 회귀
  테스트(`00-usecases.test.ts`)로 이 동작을 명시적으로 고정해두었다 — 향후 실제로
  전파를 구현하기로 결정하면 이 테스트부터 갱신해야 한다.

**07번(테스트 전략) 13절 필수 회귀 체크리스트 — 현재 커버리지**

| 항목 | 커버리지 |
|---|---|
| SkillSpec TS/Python Validation 일치 | ✅ Phase 2 Contract Test |
| Builder create/refine/repair | ✅ Phase 4 + Phase 8 UC1/UC2/UC4 |
| Unsupported Registry ID 차단 | ✅ Phase 3 + Phase 8 UC4 |
| Input/Output Validation | ✅ Phase 5 + Phase 8 전체 유즈케이스 |
| Step 순서/상태 저장 | ✅ Phase 5/6 |
| Retry/Fallback/Skip/Fail | ✅ Phase 6 (Brain 단위) |
| Tool Failure/Timeout | ✅ Phase 6 (Sandbox 단위) |
| Approval 승인/거절 | ✅ Phase 6/7 + Phase 8 UC5(조회 자동/변경만 정지 조합까지) |
| Cancel | ✅ Phase 6/7 |
| Sandbox Limit | ✅ Phase 6 (timeout/output truncation 단위 테스트) |
| Knowledge Isolation | ✅ Phase 8(신규, Workspace 간 실제 Run 경로로 검증) |
| Version append-only | ✅ Phase 2/3 |
| Run Version Pinning | ✅ Phase 5 + Phase 8 restart-recovery(재시작 후에도 유지 확인) |
| Nested Skill Cycle/Depth | ✅ Phase 6 (Brain 단위) + Phase 8 UC6(E2E 경로) |
| 서비스 재시작 후 복구 | ✅ Phase 8(신규) |
| Workspace Isolation | ✅ Phase 8(신규) |
| Preview와 실제 Runtime 동일 경로 | ✅ Phase 7(코드 구조상 원천적으로 보장 — 별도 Fake Runtime 없음) |
| One-Chat Compatibility | ⚠️ 범위 결정 필요(아래 참고) |

**명시적 스코프 결정: One-Chat Compatibility**
07번 12절은 "Fixture 기반으로 User/Project/Conversation → userId/workspaceId/
conversationId Mapping을 검증"하라고 하지만, 09번은 "Agent와 외부 서비스 연동은
Skill Platform E2E·안정화 이후 별도 Phase"라고 명시한다. One-Chat 실제 연동은 외부
서비스 연동에 해당하므로, 이번 Phase 8에서는 **다루지 않았다** — RequestContext
(userId/workspaceId/requestId) + DevAuthContextProvider라는 경계 자체는 이미 Phase 1
부터 있으므로, 실제 One-Chat 연동은 이 인터페이스에 새 AuthContextProvider 구현체를
추가하는 형태가 될 것으로 예상되며, 향후 Agent/외부 연동 Phase에서 진행하는 것이
맞다고 판단.

**Security 관련 정직한 평가 (과장하지 않음)**
Sandbox는 Phase 6에서 이미 문서화한 대로 **프로세스 수준 격리**(subprocess)이지
컨테이너/VM 격리가 아니다. Phase 8에서도 이 한계를 실제로 우회 가능한지 새로
테스트하지는 않았다 — 이미 알려진 한계를 재확인하는 것 이상의 의미가 없고, 신뢰할
수 없는 임의 코드를 실행시키는 것 자체가 이 아키텍처의 전제와 맞지 않기 때문이다
(Skill Author가 코드를 작성하지 않고 고정 스크립트만 실행). 다중 테넌트 운영에
투입하려면 컨테이너/VM 기반 격리로 교체가 필요하다는 결론은 Phase 6와 동일하게
유지된다.

**테스트**: 신규 `tests/e2e/*` 3개 파일, 13개 테스트 추가. BFF **86개 전부 통과**(Phase
7의 73개 + 신규 13개), Brain **109 passed + 1 skipped(opt-in)**(회귀 없음).

**실제 LLM Provider 연동 확인 — 완료 (09번 Phase 8 완료 전 마지막 체크포인트)**

이 환경엔 `ANTHROPIC_API_KEY`가 없었으나, 사용자가 실제 **OpenAI** API Key를 제공해 그
Provider로 연동을 완료했다. 이 프로젝트는 지금까지 Anthropic 전용으로 설계되어 있었기
때문에(04번/Phase 4 결정), 이번에 두 번째 Provider를 추가로 구현했다:

- 신규 `brain/app/common/models/openai_client.py`(`OpenAIModelClient`) — 기존
  `AnthropicModelClient`와 동일한 `ModelClient` 인터페이스, 동일한 패턴(lazy import,
  Secret은 Skill Spec에 저장 안 함)
- `Settings`에 `openai_api_key`/`openai_model_provider_map` 추가 — Model Registry의
  추상 modelId("model-001" 등)는 그대로 두고, 실제 Provider 모델 문자열만 Provider별로
  분리(03번 "Registry ID로만 참조" 원칙 유지 — Skill Spec에는 여전히 `model-001`만
  존재)
- `select_model_client`: `ANTHROPIC_API_KEY` 우선, 없으면 `OPENAI_API_KEY`, 둘 다
  없으면 기존과 동일(dev fallback 또는 운영에서 기동 실패)
- `tests/brain/test_live_llm_smoke.py`를 `select_model_client`를 직접 통해 실행하도록
  일반화(특정 Provider 하드코딩 제거) — 어느 Provider든 설정된 쪽으로 자동 연결됨

**실행 중 발견한 실제 버그(Provider 무관, 지금까지 한 번도 실행된 적 없던 경로라
발견되지 않았던 것)**: Builder의 시스템 프롬프트가 SkillSpec의 실제 필드 구조를
`...SkillSpecV1...`이라는 자리표시자로만 설명하고 있어, 모델이 정확한 필드명/중첩
구조(`instructions.objective/rules`, `model.mode/allowUserOverride`,
`execution.steps[]`, `runtime.timeoutSec/...` 등)를 전혀 알 수 없었다. gpt-4o-mini/
gpt-4o 둘 다 1회 Repair 후에도 그럴듯하지만 스키마와 다른 구조(`"runtime":"default"`,
`"instructions":"..."`(문자열), `"guardrails":{"type":"none"}` 등)를 계속 생성해
저장이 거부됐다 — Registry Validation이 의도대로 정확히 작동한 것이라 버그는 아니지만,
Builder가 애초에 성공할 방법이 없는 프롬프트 결함이었다. `brain/app/skills/prompts.py`
의 시스템 프롬프트에 **완전히 유효한 예시 SkillSpec 전체를 리터럴로 포함**시켜
수정 — 이후 OpenAI로 첫 시도에 유효한 Spec을 생성했다. Anthropic으로는 실제 검증된
적이 없어 지금까지 우연히 통과했는지도 알 수 없었던 잠재 결함이며, 이번 수정은 두
Provider 모두에 적용된다.

**검증**: `LIVE_LLM_TEST=true OPENAI_API_KEY=... pytest tests/brain/test_live_llm_smoke.py`
— Build(자연어 → SkillSpec, 검증 통과) → Run(실제 실행) → Output Validation까지 전부
통과. 이후 Brain/BFF 전체 스위트 재실행으로 회귀 없음 확인(Brain 109 passed+1 skipped,
BFF 86 passed).

**보안 메모**: 사용자가 채팅에 API Key를 평문으로 붙여넣었다 — 어떤 파일에도 기록하지
않고 이번 세션 동안 프로세스 환경변수로만 사용했다(커밋되지 않음, `.gitignore`의
`.env`도 사용 안 함). 키가 대화 기록에 남아있으니 사용자에게 재발급을 권장함.

### Phase 8 Stabilization — 사용자 피드백 반영 (2차 라운드, 2026-09-30)

Phase 8 결과 보고 후 사용자가 5가지 항목에 대해 구체적인 결정과 요구사항을 줬다.
그대로 반영한 내용:

**1) Web ↔ BFF 인증 — DevAuthContextProvider 구조 유지, 단 Production 오발동 방지**
- 하드코딩된 userId/workspaceId가 domain/API 코드 어디에도 없음을 grep으로 재확인
  (config 기본값과 DevAuthContextProvider 외 0건)
- **실제 버그 발견**: `bff/src/server.ts`가 `config.mode`와 무관하게
  `DevAuthContextProvider`를 무조건 wiring하고 있었다 — Brain의
  `ModelClientConfigurationError`와 달리 **BFF에는 Production 오발동 방지 가드가
  전혀 없었다.** 신규 `bff/src/client-context/select-auth-provider.ts`
  (`AuthProviderConfigurationError`)로 Brain과 동일한 패턴의 가드 추가:
  `NODE_ENV=production`이면 실제 AuthContextProvider가 없어 기동 자체를 거부한다.
- CORS는 인증 수단으로 취급하지 않음(기존 그대로), Workspace Isolation은 Phase 8에서
  이미 실증 완료.

**2) Web Contract 중복 정의 — Drift 검출 테스트 추가 (대규모 변경 없음)**
- OpenAPI 기반 Web 타입 자동 생성은 검토했으나, "현재 구조를 대규모로 변경하지
  않는다"는 결정에 따라 이번 라운드에서는 보류.
- 대신 신규 `tests/contract/web-types-drift.test.ts` 추가:
  - `web/lib/types.ts`의 `SkillSpecV1`으로 구성한 구체적 예시가 canonical
    `contracts/skill-spec.schema.json`(BFF가 실제로 로드하는 유일한 검증 기준)을
    통과하는지 확인
  - 실제 `skillService.createSkill()` 응답의 key set이 `web/lib/types.ts`가
    선언한 `SkillRecord`/`SkillVersionRecord` key set과 정확히 일치하는지 확인
  - Web은 여전히 `contracts/*.ts`를 런타임 의존성으로 가져오지 않음(독립 배포
    특성 유지) — 검증은 테스트 시점에만 이루어짐

**3) Builder outputSchema ≠ 실제 Tool Output — 정상 동작으로 확정, Debug 가시성 개선**
- 이 동작 자체는 사용자 확인대로 정상(Output Validation이 의도대로 작동). 다만 지금까지
  **Debug에 이 정보가 전혀 노출되지 않았음**을 발견 — Run이 Output Validation에서
  실패하면 Brain이 실제 output 값 자체를 버리고 있었고, Web의 Debug 탭도 Run 레벨
  output/error를 아예 렌더링하지 않고 있었다(Preview 탭에만 있었는데 `run()`이 항상
  Debug 탭으로 전환해버려 사실상 안 보였음).
- 수정: `RunResult`에 `outputValidationErrors`(구조화된 path/message 배열) 필드
  추가, Output Validation 실패 시에도 실제(잘못된) output 값을 보존(`brain/app/
  skills/execution_engine.py`) → BFF가 그대로 persist → Web Debug 탭에 **Run
  Output(실제 값) / Run Error(요약 + path·message 표) / Expected Output Schema
  (Skill Spec에서)** 3가지를 나란히 표시하도록 `PreviewDebugPanel.tsx` 추가.
  브라우저로 실제 재현해 확인 완료(스크린샷 기준 실제 Tool 출력 vs 기대
  outputSchema가 한 화면에 비교됨).

**4) Nested Skill Approval 전파 — Known Limitation 확정, 명확한 에러 코드로 강화**
- 기존 "명확한 에러" 수정을 `NESTED_SKILL_APPROVAL_NOT_SUPPORTED`라는 **기계 판별
  가능한 코드**로 승격(`brain/app/skills/execution_engine.py`의
  `NestedApprovalNotSupportedError`, `RunResult.errorCode`로 BFF까지 전파 →
  API 응답의 `run.error.code`에 노출). 메시지는 사용자가 준 문구 그대로:
  "Approval required inside a nested Skill is not supported in the current runtime."
- 요구된 필수 테스트 매트릭스를 전부 구현(`tests/e2e/00-usecases.test.ts`):
  - 일반 Nested Skill 정상 실행 — 기존 UC6 성공 케이스로 커버
  - **Parent 자체 Approval 정상 실행**(Composite Skill이어도 Parent 레벨 Approval은
    Nested Approval 제약과 무관하게 정상 동작 — 신규 테스트로 실제 확인, Nested
    Pre-check 완료 + Parent 자체 Approval 대기/승인/완료까지 전부 실증)
  - Child Skill 내부 Approval 감지 → `NESTED_SKILL_APPROVAL_NOT_SUPPORTED` 코드로
    명확히 실패
  - **Child Approval 시 Tool/Side Effect 미실행**: 예외가 Tool 호출 이전 시점에
    던져지므로 `childRuns`가 아예 비어있고(0건), `call-child` Step의 output도
    `null`임을 직접 assert
  - Parent Run이 명확한 실패 사유 기록 — `run.error.code`/`run.error.message`로 확인
  - Run/Step Debug에서 원인 확인 가능 — 브라우저로 실제 재현해 Debug 탭에 정확한
    메시지가 뜨는 것 확인
- 향후 실제 전파를 구현할 경우의 설계 방향(Parent Run → Child Run → Child Step
  waiting_approval → Parent에도 approval_required 전달 → approve/reject → Child
  Run resume → Parent Run resume)은 사용자가 준 그대로 "다음 계획"에 기록.

**추가로 발견해 함께 고친 것 (요청 범위는 아니었으나 직접 관련)**
- `bff/src/documents/document-repository.ts`의 `getKnowledgeCorpus` 쿼리에
  `ORDER BY`가 없어 병렬 테스트 실행 시 chunk 순서가 흔들리는 실제 버그 발견 →
  `ORDER BY dc.document_id, dc.chunk_index` 추가

**최종 테스트 결과**: Brain **109 passed + 1 skipped(opt-in)**, BFF **94 passed**
(Phase 8 최초 라운드 86 + `select-auth-provider` 3 + `web-types-drift` 4 +
Nested Approval 매트릭스 확장 1). 회귀 없음.

---

## Phase 8 이후 — 실LLM 실사용 검증 + Web UI 개선 (2026-09-30 ~ 10-01)

Phase 8 완료 보고 후, 사용자가 실제 OpenAI API Key를 제공해 "진짜로 써보면서" 확인한
라운드. Skill-first Standalone Platform이 문서/테스트상으로만이 아니라 실제 자연어
Builder + 실제 LLM + 실제 Web UI로 동작하는지 끝까지 검증했다.

### 00번 유즈케이스 6개 전부 실제 OpenAI로 재현

이전 Phase 8에서는 Heuristic Builder나 수동 구성 Spec으로 검증했지만, 이번엔
`My Skills`에 쌓여있던 538개의 과거 테스트 fixture Skill을 전부 정리(soft-delete)한
뒤, 00번 문서의 생성 프롬프트를 **그대로** 입력해 실제 OpenAI(gpt-4o-mini)로 하나씩
Skill을 만들고 실행까지 확인했다.

| UC | 결과 |
|---|---|
| 1. 번역 Skill | "안녕하세요."→"Hello.", "너는 누구야?"→"Who are you?", "오늘 날씨 알려줘."→"Tell me the weather today." 전부 정확 |
| 2. 문서 검색 Skill | 운영 가이드 문서 업로드 후 근거 있는 질문엔 정확한 답변, 무관한 질문("우주여행 예약은 어떻게 해?")엔 "정보를 확인할 수 없습니다" |
| 3. CSV 분석 Skill | 월별 집계(500/9400) + 이상치 탐지(zScore 3) 정확 |
| 4. API 조회 Skill | service-status 호출, 시스템 변경 없음, 1회 시도로 정확한 Spec 생성 |
| 5. 승인 필요 운영 변경 Skill | 조회(자동)→승인 대기→approve→재시작 실행→재확인까지 전부 실제 동작, outputMap 수동 보정 1회 |
| 6. Composite 배포 검증 Skill | Nested pre-check/deploy(승인)/post-check 전부 성공. **덤으로**: 승인 게이트가 있는 Skill을 Nested Child로 참조했을 때 `NESTED_SKILL_APPROVAL_NOT_SUPPORTED`가 실제 자연스러운 시나리오에서 안전하게 발동하는 것도 함께 확인(Parent 자체 approvalRequired는 정상 동작, Child 내부 approvalRequired만 막힘) |

실제 LLM이 만든 초안은 대부분 Registry 참조(refId)는 맞았지만 outputSchema가 실제
Tool/Step 출력과 다르거나 `outputMap`이 없어 Output Validation에서 막히는 경우가
있었다 — 이건 이미 확정된 **정상 동작**(P8 사용자 결정 #3)이라 "구성" 탭에서 수동으로
보정하는 realistic한 워크플로를 그대로 따랐다(실제 서비스에서 Draft Skill을 사람이
검수하는 것과 동일한 흐름).

### 이 과정에서 실제로 처음 발견된 Builder 프롬프트 버그 4건 (즉시 수정)

지금까지 이 Builder 파이프라인은 실제 LLM(Anthropic이든 OpenAI든)으로 "진짜 생성"을
해본 적이 한 번도 없었다 — Heuristic Builder는 키워드 기반이라 이 결함들을 전혀
드러내지 못했다. 전부 `brain/app/skills/prompts.py` / `builder_service.py` 수정:

1. **SkillSpec 구조를 모델에게 전혀 보여주지 않음**: 시스템 프롬프트가 `...SkillSpecV1...`
   자리표시자만 쓰고 있어 필드명을 모델이 추측해야 했음 → 완전히 유효한 예시 SkillSpec을
   프롬프트에 리터럴로 포함
2. **`tool`/`skill` Step에 `refId` 필수라는 것을 모델이 모름** → 명시적 규칙 추가, 동시에
   `maxToolCalls`/`maxNestedSkillDepth` 기본값 0이 모든 호출을 막는다는 것도 함께 명시
3. **`approvalRequired`가 플랫폼 메커니즘이라는 것을 모델이 몰라서 가짜 "승인 요청" LLM
   Step을 직접 만들어냄**(실제로는 아무것도 막지 못함) → Human Approval은 Step에
   `approvalRequired: true`를 직접 설정하는 것이라고 명시
4. **복잡한 요청(Composite)에서 `{action, spec}` envelope을 통째로 빼먹고 SkillSpec을
   최상위에 바로 반환** → Repair 힌트를 "action이 없다 + bare spec처럼 보이면 envelope으로
   감싸라"고 구체적으로 개선

네 가지 전부 Brain 테스트(109 passed) 회귀 없이 수정 완료. 이 결함들은 Anthropic으로도
동일하게 존재했을 가능성이 높다 — 지금까지 실제 Key로 테스트된 적이 없어 발견되지 않았을
뿐이다(Phase 8 "미완료 항목"이었던 라이브 LLM 체크포인트가 바로 이걸 잡으려던 것).

### Web UI 개선

- **My Skills를 카드 그리드로 변경**(`web/app/skills/page.tsx`, `globals.css`) — 기존
  세로 리스트 대신 반응형 카드(`auto-fill, minmax(260px,1fr)`)
- **Chat 테스트 탭 신규 추가**(`web/components/ChatTestPanel.tsx`, Preview/Debug 사이):
  - inputSchema의 property가 정확히 1개이고 string 타입일 때만 활성화(그 외엔 "Preview
    탭을 사용하세요" 안내) — 복잡한 다중 필드 Skill까지 억지로 챗봇화하지 않음
  - 매 메시지가 독립된 `/skill-runs`(mode: preview) Run — 별도의 Fake 대화 엔진이
    아니라 Preview와 동일한 Runtime 경로, 메시지 간 세션 컨텍스트는 없음(Skill은
    원래 stateless 단발 실행 단위라는 00번/09번 원칙 그대로)
  - 승인 대기 시 채팅 흐름 안에 Approve/Reject/Cancel 카드가 바로 뜨고, 처리 후 결과가
    다음 말풍선으로 이어짐 — Service Restart Skill로 실제 확인
  - Output이 단일 string 필드면 그 값을, 아니면 JSON 전체를 말풍선으로 표시

### Dev 운영 이슈 2건 발견 및 수정

1. **자동화 테스트가 실제 개발 DB를 오염시킴**: `npm test`가 Web UI와 동일한
   `ai_builder_platform` DB에 연결되어 있어, 테스트를 반복 실행할 때마다 Skill fixture
   가 "My Skills"에 그대로 쌓였다(한 세션 동안 538개까지 누적되어 실제로 발견). 수정:
   별도의 `ai_builder_platform_test` DB를 만들고 `bff/vitest.config.ts`가 기본으로
   그쪽을 가리키게 함(`DATABASE_URL`을 셸에서 직접 export하면 그 값이 우선). 재확인 결과
   테스트를 반복 실행해도 실제 dev DB의 Skill 개수(7개)는 전혀 변하지 않음.
   `scripts/dev-up.sh`가 두 DB 모두에 동일한 마이그레이션/시드를 적용하도록 갱신.
2. **BFF↔Brain HTTP 타임아웃이 실제 LLM 지연 시간엔 너무 짧음**: `BRAIN_TIMEOUT_MS`
   기본값(10초)이 실제 OpenAI 응답(특히 Repair 포함 시 2회 호출)엔 부족해 504가 발생.
   로컬 개발 시 `BRAIN_TIMEOUT_MS=60000`으로 기동하는 것을 권장(README/스크립트에 반영
   필요 시 후속 작업).

### 운영 중 실제로 두 번 발생한 재시작

세션 중간에 머신이 재시작되며 Postgres 컨테이너/Brain/BFF/Web이 전부 내려간 적이
두 번 있었다 — 매번 컨테이너만 다시 `start`하고 세 서버만 재기동하면 **Skill/Run 데이터가
전부 그대로 복구**됐다(Phase 8의 Restart Recovery 테스트가 자동화로 보장한 것을 실제
운영 상황에서도 그대로 재확인한 셈).

**최종 상태**: My Skills에는 00번 유즈케이스 6개 + Composite이 참조하는 헬퍼 Skill
1개, 총 7개만 깨끗하게 남아있음. Brain 109 passed + 1 skipped, BFF 94 passed, 둘 다
회귀 없음.

---

## Phase 9 — Skill Export / Portability (2026-10-06 ~ 10-07)

공식 기준: Notion 10번 "Skill Export / Portable Skill 설계" + 09번. 목표는 Skill Builder에서
만든 Skill을 특정 Provider에 종속시키지 않고 외부 환경(첫 Target: **Claude**)에서 바로
쓸 수 있게 Export하는 **Skill Portability Layer**다.

### 아키텍처

```
SkillSpec ──(BFF: Version/Child/Document 해석·잠금·권한)──▶ Brain
   Portable Skill Compiler → PortableSkill → Export Sanitizer → Compatibility Analyzer
        → Export Adapter(target, format) → Manifest → 파일 목록 ──▶ BFF: ZIP/다운로드
```

- **역할 분리**(06번 유지): Brain은 DB 없는 순수 변환(`brain/app/exports/`), BFF는 Version·Child
  Skill·문서 권한 해석, ZIP 패키징, 다운로드 응답(`bff/src/skill-exports/`).
- `SkillSpec`은 내부 Source of Truth로 유지. **Provider 전용 필드를 SkillSpec/PortableSkill에 넣지 않는다.**
  Provider 차이는 **Target Profile + Adapter**가 담당한다.

### PortableSkill (`contracts/portable-skill.{schema.json,ts}`, `brain/app/exports/models.py`)

Provider 비종속 Export 전용 중간 표현. 10번 §3 + 확정 결정: `guardrails`, `runtimeLimits`(선언값일 뿐
모든 Target에서 강제된다고 가정하지 않음), `dependencies[{ref}]`, 선택적 `source`/`sourceSpec`.

- Registry Model id(`spec.model`)는 내보내지 않는다. 내부 `skillId`/`documentId`도 쓰지 않고
  Package-local alias(`child:<slug>`, `doc:<slug>`)만 쓴다. 내부 ID는 `includeSourceSpec`을 켠 경우의
  `source`에만 나타난다.
- JSON Schema 하나를 Brain(Pydantic)과 BFF(ajv)가 같은 fixture로 검증하고, BFF는 Brain이 만든
  모든 `skill.json`을 패키징 전에 스키마로 재검증한다(계약 가드).

### Adapter / Target 구조

`brain/app/exports/profiles/` (무엇을 지원하는가) + `adapters/` (어떻게 변환하는가).
새 Target은 **Profile 등록 + Adapter 등록**만으로 추가된다(SkillSpec/Runtime 수정 없음 — 테스트로 실증:
`test_adding_a_target_needs_only_a_profile_and_an_adapter`).

| Target | Format | Adapter | 비고 |
|---|---|---|---|
| `generic` | `portable-package` | PortablePackageAdapter | ZIP: SKILL.md(frontmatter 없음)/skill.json/manifest.json/references/children |
| `generic` | `markdown` | GenericMarkdownAdapter | 단일 `.md`, Provider frontmatter 없음 |
| `generic` | `raw-spec` | RawSpecAdapter | 저장된 SkillSpec 그대로(Sanitizer 예외 없음) |
| `claude` | `skill-package` | ClaudeSkillAdapter | Claude/Agent Skill 형식(아래) |

공개 API는 `format: "target"` 같은 추상값 없이 `{ target, format }`을 명시한다.
에러 구분: 미지원 Target `EXPORT_TARGET_UNSUPPORTED`, Target이 제공하지 않는 Format
`EXPORT_FORMAT_UNSUPPORTED`, 지원 Target인데 Adapter 미등록 `EXPORT_TARGET_ADAPTER_UNAVAILABLE`
(`GET /export/targets`가 `adapterAvailable`로 알려 UI가 쓸 수 없는 항목을 노출하지 않음).
BFF는 Skill을 조회하기 **전에** 이 검사를 수행해 Skill 존재 여부가 새지 않는다.

### Claude Adapter

Claude 공식 문서(Agent Skills / authoring best practices)의 규칙을 Adapter가 전담한다.

- `SKILL.md` + YAML frontmatter(`name`, `description`). **name**: ≤64자, 소문자·숫자·하이픈, XML 태그 금지,
  예약어(`anthropic`, `claude`) 금지. **description**: 비어있지 않음, ≤1024자, XML 태그 금지, "무엇을 + 언제 쓰는지".
- 본문 500줄 미만(JSON Schema가 크면 `references/schemas.md`로 이동, 그래도 넘으면 export 거부),
  `SKILL.md`에서 한 단계 깊이로 링크, 슬래시 경로, MCP 도구는 `ServerName:tool_name` 표기.
- 본문은 **Claude를 독자로 쓴 전용 렌더러**(명령형 지시: 단계 순서, 승인 시 "사용자에게 먼저 확인",
  onError 지시 등). Generic Markdown 렌더러를 이름만 바꿔 쓰지 않는다.
- 이름 규칙: root name = ASCII slug(없으면 `skill-<id8>`), 예약어가 들어가면 안전한 이름으로 대체하고 경고.
  description이 1024자를 넘으면 frontmatter만 줄이고(전체는 `skill.json`) `CLAUDE_DESCRIPTION_TRUNCATED` 경고.
  description에는 "Use when: <objective>"를 (이미 포함되지 않은 경우) 덧붙인다.
- **검증기**(`validate_claude_package`): SKILL.md 존재, frontmatter 존재·YAML 유효, name/description 규칙과 길이,
  500줄, 모든 상대 링크가 패키지 안의 실제 파일을 가리키고 밖으로 나가지 않음, 모든 경로 ASCII-safe, 중복 없음,
  `skill.json`/`manifest.json` 존재. 자식 Skill의 SKILL.md도 동일 검증. 위반 시 `EXPORT_PACKAGE_INVALID`.
- **Claude Profile**(정직한 보정): 순서/조건/입출력 매핑은 지시로 따를 수 있어 지원, 오류 **정책**(retry/fallback/skip/fail)과
  runtime limit은 패키지가 보장할 수 없어 미지원, 이 플랫폼의 builtin Tool은 Claude에 없어 미지원(MCP 서버로 대체 필요),
  MCP는 사용 가능하지만 패키지가 서버를 설정할 수는 없어 항상 `partial`, Code Execution은 환경 의존이라 약속하지 않음.
  Target별 설명은 Profile `notes`로 사유에 덧붙인다.

### Generic Markdown Adapter

단일 `.md`(Description/Objective/Instructions/Guardrails/Input·Output Contract/Workflow/Required Tools/
Knowledge/Dependencies/Runtime Limits/Examples). Provider frontmatter 없음. Tool/MCP/RAG를 구성할 수는 없고
문서를 담을 수 없어(`References Only` 강제) Compatibility가 그대로 알린다. Child Skill은 같은 파일 뒤에 섹션으로 포함 가능.

### ZIP Archive Path 정책 (ASCII-safe, 확정 결정)

외부 환경 간 이식성이 목표이므로 **모든 ZIP entry path는 ASCII**다(`brain/app/exports/archive.py`).

```
skill-a31fc912/                       # 한글 이름 → skill-<id8>, 영문 이름 → sales-analyzer-<id8>
├─ SKILL.md  skill.json  manifest.json
├─ references/document-928ac031.md    # 원본 이름이 아니라 stable id 기반
└─ children/parser-1a2b3c4d/{SKILL.md,skill.json}
```

- 규칙: ASCII 영숫자와 `._-`만, 각 segment는 영숫자로 시작(`.`/`..`/숨김 파일 불가), 구분자는 `/`뿐, 절대경로·`../`·
  백슬래시·제어문자·빈 segment 금지, 결정론적, 충돌 방지(stable id + 유일성 보정).
- 표시 이름은 `manifest.json`(`skill.displayName`/`archivePath`, `knowledge[].fileName`/`path`,
  `dependencies[].displayName`/`path`)과 SKILL.md 본문 텍스트에 **보존**. Skill 이름은 UI에서 바뀌지 않음.
- Brain이 경로를 만들고, BFF `package.service.ts`가 같은 규칙으로 **다시 검증**(비-ASCII/traversal/중복 거부).
- 동기: 구형 Info-ZIP `unzip`(macOS 기본)이 한글 엔트리명을 추출하지 못했다. 변경 후 같은 한글 Skill/문서 패키지를
  기본 `unzip`으로 `-t` 및 추출 성공을 실제 서버에서 확인.

### Knowledge Export 정책

- `knowledge.mode='selected'`만 Include Documents 가능. `workspace` 모드는 **항상 References Only**(경고 `EXPORT_KNOWLEDGE_WORKSPACE_REFERENCES_ONLY`).
- 포함 조건: `workspace 권한 ∧ document 접근 권한 ∧ documents.export_allowed = true`
  (`bff/src/skill-exports/export-permissions.ts`에 조건별 함수로 분리). `export_allowed` 기본값 `false`(fail-closed),
  마이그레이션 `003_document_export_permission.sql`. **Workspace 소속 + ready만으로는 허용하지 않는다.**
  문서별 ACL이 데이터 모델에 없어 현재 "접근 권한" = 같은 Workspace + `ready` 상태이며, 함수 하나만 바꾸면 교체된다.
- `PATCH /documents/:id { exportAllowed }` — **admin 전용**(`RequestContext.workspaceRole`).
- **Compatibility = 설명, Export = 강제**: Compatibility는 HTTP 200 + `level: "blocked"` + `blockers[KNOWLEDGE_EXPORT_FORBIDDEN]`로
  이유를 알려주고, 실제 `POST /export`는 403. 두 경우 모두 접근 불가 문서의 이름·ID·내용·개수를 노출하지 않는다
  (`lock`도 null, 사유는 reason별 집계만). Brain의 Compatibility 사유에서도 문서 **이름 대신 개수**만 쓴다
  (테스트가 잡은 실제 노출 결함 — 아래).
- 내용: 줄바꿈 LF 정규화 후 sha256을 Manifest에 기록. 텍스트 문서만 지원(Phase 6 범위).

### Child Skill / 재현성

- Export 시작 시 Dependency Resolution으로 Child Version을 **잠그고**(현재 Version) Manifest에 `child:<alias>`별
  `version`/`contentHash`를 기록. content hash는 Child의 자기 Child까지 포함하는 Merkle 구조.
- Cycle/깊이(16) 방지, Child가 soft-delete/타 Workspace/없음이면 `EXPORT_CHILD_UNAVAILABLE`로 실패(조용히 제외하지 않음).
- **정확한 재현성 기준**: 같은 Parent Version + 같은 resolved Child Versions + 같은 Knowledge Content + 같은 Export Options +
  같은 Target/Format ⇒ 바이트 동일. "같은 Parent Version이면 항상 같은 파일"은 보장하지 않는다.
- 결정론: ZIP entry 순서 고정, 고정 mtime(1980-01-01 00:00:00, 로컬 컴포넌트로 생성해 타임존 무관), UTF-8, JSON key 정렬,
  LF 정규화, `fflate`를 `0.8.3`으로 고정. `exportedAt`은 Package 내부에 없고 응답 헤더 `X-Exported-At`/로그에만 있다.

### Export Sanitizer 정책

모든 Target/Format(Raw SkillSpec, Generic Markdown 포함)에 **필수 적용**. 탐지 시 redact하지 않고 **차단**
(`EXPORT_SECRET_DETECTED`), 응답에는 `path`와 `category`만(값 절대 미포함).

- **Hard Block**: 벤더 API Key, Bearer Token 값, Authorization/API-Key 헤더 값, JWT, Private Key, URL userinfo credential,
  `?access_token=…`/`api_key=…`/`client_secret=…` 같은 credential query, password/secret/client_secret/access_token/api_key 할당(실값처럼 보이는 값),
  구조화 데이터의 secret 필드.
- **Allow**: 인증 Endpoint를 설명하는 일반 URL(`/oauth/token`, `/authorize`, `/saml`, `/sso` …), placeholder(`<token>`, `{token}`, `${KEY}`,
  `YOUR_KEY`, `****`), credential에 대한 서술. **기준은 경로 이름이 아니라 Credential 값의 존재 여부.**
- 입력(Spec/Child/문서)을 먼저, 생성 파일을 안전망으로 한 번 더 검사. Compatibility에서는 차단 대신 `blocked`로 미리 알림.

### Compatibility 정책

- `full | partial | unsupported | blocked`(API/DB/Contract는 소문자, UI만 대문자). `blocked`는 Analyzer가 만들지 않고
  "지금은 Export 불가(Secret/Knowledge 권한)"일 때만.
- Target Profile: `llm`, `workflowSemantics`(sequentialSteps/condition/retry/fallback/skip/fail/inputMapping/outputMapping),
  `runtimeLimits`, `declarative`(carrier 여부), `notes`. 응답에 `summary`(`requiredMcp`, `knowledge`, `unsupportedCapabilities`)와 `manualSteps`.
- **Advisory**(예: timeout 미강제)는 경고로 보고하되 level을 낮추지 않음. `condition`은 원본 Runtime도 평가하지 않으므로
  항상 `partial`. Nested Skill 자식의 Approval(`NESTED_SKILL_APPROVAL_NOT_SUPPORTED`)은 `unsupported`.
- `acknowledgeWarnings` 없이는 `partial`/`unsupported` export 불가. Target Optimized Format(`claude`)은 `unsupported`면 acknowledge해도
  `EXPORT_COMPATIBILITY_UNSUPPORTED`로 차단(generic은 경고 후 허용).

### API

`GET /export/targets`, `GET /skills/:id/export/compatibility?version=&target=&format=&include…`, `POST /skills/:id/export`
(`version` 필수 — "latest" 암묵 적용 없음), `PATCH /documents/:id`. 새 HTTP 에러 코드는 만들지 않고 `details.code`에 기계 판별 코드.
다운로드 메타데이터는 응답 헤더(`X-Export-Compatibility`, `X-Export-Content-Hash`, `X-Export-Skill-Version`, `X-Exported-At`), CORS `exposedHeaders` 설정.

### Web UI

Skill 헤더 `Export ▾`: Claude Skill / Generic Markdown / Raw SkillSpec / Portable Skill Package(Adapter가 있는 항목만).
다이얼로그: Version 선택 → Compatibility(FULL/PARTIAL/UNSUPPORTED/BLOCKED), Required MCP, Knowledge, Unsupported Capabilities,
Warnings, 수동 설정 → 옵션(Include Knowledge / Child Skills / source SkillSpec) → 경고 확인 → 다운로드.
`exportAllowed=false` 문서는 Include Knowledge 비활성화 + Blocker 표시(+ admin용 "Allow export"). Web 값은 신뢰하지 않으며 BFF가
Export마다 권한을 다시 검증. `web/lib/types.ts`에 `DocumentRecord.exportAllowed` 및 Export 타입 반영, drift는
`tests/contract/web-export-types-drift.test.ts`가 `types.ts`를 직접 파싱해 실제 응답과 비교.

### 보안: workspaceRole

Role 테이블 없이 `AuthContextProvider`가 `workspaceRole`을 `RequestContext`로 해석(없으면 `member` = fail-closed).
Domain은 Header/Body를 직접 읽지 않고 `canManageDocumentExport(context)`만 소비(소스 스캔 테스트로 고정).
Production에서는 Dev Provider가 기동 자체를 거부(`selectAuthProvider`)하고 override header도 꺼져 있어, 클라이언트가 보낸 값으로는
admin이 될 수 없다. 실제 JWT/RBAC는 Provider 구현 하나만 교체.

### 테스트 결과

| 대상 | Phase 8 종료 | Phase 9 종료 | 증가 |
|---|---|---|---|
| Brain (pytest) | 109 (+1 skip) | **361 (+1 skip)** | +252 |
| BFF (vitest, contract/e2e 포함) | 94 | **228** | +134 |
| BFF/Web 타입체크 | 0 오류 | 0 오류 | — |

- Phase 9 E2E(`tests/e2e/phase9-export.test.ts`): Prompt / Knowledge / Tool / 권한 없는 Knowledge 시나리오를 Skill Builder부터
  ZIP 해제·검증까지 실제 경로로 수행, ZIP은 외부 `unzip -t`로도 검증, YAML은 `js-yaml`로 Brain 검증기와 독립적으로 검증.
- 방어선을 일부러 깨뜨려 테스트가 실제로 실패하는지 확인(export_allowed 검사 제거, raw-spec Sanitizer 우회, frontmatter name 제거,
  Claude 검증기 무력화, Web 타입에서 `exportAllowed` 제거 → 모두 해당 테스트가 실패, 원복 확인).
- 실제 기동 서버 + 실제 브라우저(Web UI)로 Knowledge Allow → Include → FULL → 다운로드, Tool Skill의 Required MCP, Secret의 BLOCKED 렌더링 확인.

### 테스트가 잡아낸 결함 (모두 수정)

| 결함 | 수정 |
|---|---|
| `formatVersion`이 기본값이라 `exclude_unset` 직렬화에서 누락(golden도 그 상태로 생성되어 있었음) | 컴파일러에서 명시 설정 |
| `timeoutSec` 30이 Pydantic `float`로 `30.0`이 됨 | `int | float` |
| ZIP mtime을 모듈 로드 시 1회 생성 → 이후 TZ가 다르면 DOS 범위를 벗어남 / UTC로 만들면 TZ별로 바이트가 달라지거나 예외 | 호출마다 로컬 컴포넌트로 생성, TZ 5종 동일 바이트 테스트 |
| **Compatibility `blocked` 응답의 `reasons`/`warnings`에 접근 불가 문서의 파일명이 들어감**(lock만 null로 막았던 구멍) | 문서 이름 대신 개수만 보고 |
| 한글 엔트리명을 구형 `unzip`이 추출하지 못함(실제 서버에서 발견) | ASCII Archive Path 정책 |
| Claude 프로파일을 처음엔 순서/매핑까지 미지원으로 둬 단순 2-step Skill도 `partial` | Skill의 본래 용도에 맞게 보정(오류 정책/limit만 미지원) |
| Sanitizer가 `/oauth/token` 같은 URL 경로와 `{token}`, `user:<password>@host` placeholder까지 차단 | Credential 값 기준으로 재정의, 오탐 회귀 테스트 |

### Known Limitations

- **Claude 호환은 공식 문서의 규칙을 구현·검증한 것이지, 실제 Claude 환경에 업로드해 확인한 것이 아니다**(업로드 수단 없음).
  frontmatter/구조/링크 규칙은 독립 검증기 2종(Brain, E2E의 js-yaml)으로 확인.
- Claude는 이 플랫폼의 builtin Tool(file-parser 등)을 가지지 않는다 → Tool Skill은 항상 `partial`이며 MCP 서버를 사용자가 구성해야 한다.
  MCP 서버 이름을 알 수 없어 `ServerName:tool_name`으로 표기. 패키지는 MCP 서버를 설정하지 못한다.
- Code Execution은 Claude 환경(Claude Code/코드 실행 도구)에 의존해 약속하지 않는다.
- Child Skill은 `children/<slug>-<id8>/SKILL.md`로 포함되어 부모가 링크로 안내한다. Claude 환경이 중첩 폴더를 별도 Skill로 자동 인식하는지는 보장하지 않는다.
- Nested Skill 자식의 Approval(Phase 8 Known Limitation)과 `condition`(Runtime 미평가)은 어떤 Target에서도 재현을 보장하지 않으며 Compatibility에 명시.
- `SKILL.md`가 500줄을 넘으면(Schema는 reference로 이동 후에도) export를 거부한다. 비정상적으로 큰 Workflow(수백 Step)에서만 발생.
- `scripts/`, `assets/`는 Skill이 소유한 스크립트/자산이 없어 생성하지 않는다.
- 문서 ACL이 없어 "문서 접근 권한" = 같은 Workspace + `ready`. admin 권한은 `workspaceRole`로만 판단(Role 테이블 없음).
- Export 감사는 서버 로그뿐이며 별도 감사 테이블은 없다.
- Sanitizer는 정규식 기반 휴리스틱(DLP 아님). 8자 미만 또는 숫자/기호가 없는 짧은 값(`password=abcdefgh`)은 탐지하지 못한다.
- 웹 UI에서 member 역할을 시험할 방법은 없다(Dev Provider가 admin 고정). 서버 측은 테스트로 검증.
- 이전부터의 제약: `tsc` 빌드 산출물(`dist/`)에 JSON 계약 파일이 복사되지 않아 `NODE_ENV=production node dist/...` 실행은 불가(개발은 `tsx`).

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
| Skill Playground(Web UI) | ✅ (Phase 7 — My Skills/만들기/구성/Version History/Preview·Debug) |
| Skill Export (Claude Skill / Generic Markdown / Raw SkillSpec / Portable Package) | ✅ (Phase 9 — Compatibility 분석, ASCII Archive Path, Knowledge 권한, Sanitizer) |
| Export Target 확장 | ✅ Profile + Adapter 등록으로 추가(SkillSpec/Runtime 무수정) |

---

## 2. 설계 이슈 종합 (전체 Phase 취합)

Phase 1~8 전체에서 나온 설계 이슈를 한곳에 모은 것. 각 항목의 상세 근거/수정 내용은
해당 Phase 섹션에 있고, 여기서는 지금 시점 상태만 정리한다.

### 2-1. 아직 열려있는 이슈 (사용자 결정 완료, 구현은 보류)

| 이슈 | 결정 | 다시 꺼내려면 |
|---|---|---|
| **Nested Skill 자식의 Human Approval이 Parent Run으로 전파되지 않음** — Composite Skill의 자식이 `waiting_approval`이 되면 Parent Run은 대기가 아니라 그냥 실패한다(00번 UC6이 요구하는 조합). | Known Limitation으로 확정. 전파 기능은 구현하지 않되, 알 수 없는 에러가 아니라 기계 판별 가능한 `NESTED_SKILL_APPROVAL_NOT_SUPPORTED` 코드 + 고정 메시지로 명확히 실패(`brain/app/skills/execution_engine.py`의 `NestedApprovalNotSupportedError`). Child의 Tool/Side Effect는 승인 우회 없이 절대 실행되지 않음을 테스트로 실증(`childRuns` 0건). 사용자가 요구한 6개 필수 테스트 케이스 전부 구현·통과. | 사용자가 제시한 설계: Parent Run → Child Run → Child Step `waiting_approval` → Parent에도 `approval_required` 전달 → approve/reject → Child Run resume → Parent Run resume. Brain의 재귀 실행 엔진 + BFF의 approve/resume 로직을 함께 바꾸는 별도 설계 작업. |

### 2-2. 알려진 제약 / 의도적 범위 결정 (버그 아님 — 확장하려면 별도 작업)

| 영역 | 현재 상태 | 비고 |
|---|---|---|
| Sandbox | 프로세스 수준 격리(subprocess)만 있고 컨테이너/VM 격리 없음 | 신뢰 못하는 임의 코드를 다중 테넌트 운영에서 실행하기엔 부족(06번이 열어둔 선택, 최종 결정 아님) |
| RAG/Knowledge | 진짜 임베딩이 아니라 결정론적 해싱 기반 TF 벡터 + 코사인 유사도, 매 호출 재계산(`document_chunks.embedding`은 여전히 미사용) | Phase4/5 Heuristic LLM과 같은 성격의 투명한 placeholder |
| Web ↔ BFF 인증 | 실제 로그인/JWT/OAuth 없음 — `DevAuthContextProvider`(고정 seed identity) 유지가 확정된 결정. CORS는 인증 수단이 아님. | Phase 1 결정 연장선, 실제 인증은 운영 전환 시 별도 Phase. **단, Production에서 실수로 활성화되는 것은 이번에 코드로 차단**(2-3 참고) — 결정 자체가 열려있는 이슈는 아님 |
| Cancel | `waiting_approval`에서만 가능, 동기 실행 중(`running`)인 Run은 라이브 취소 불가 | 비동기 Job Queue 아키텍처가 없어서(Phase 6 결정) — 지금은 명확한 에러로 안내 |
| Streaming(SSE) | 미구현, 명시적 보류 | 동기 호출 구조를 바꾸는 별도 아키텍처 작업 필요 |
| MCP | 미구현, 명시적 보류 | 연동 테스트할 실제 MCP 서버가 없었음 |
| `web/lib/types.ts` | `contracts/*.ts`를 런타임 의존성으로 import하지 않고 독립적으로 타입을 미러링(Web 독립 배포 특성 유지, 사용자 확정) | **Drift 검출 테스트는 이번에 추가함**(`tests/contract/web-types-drift.test.ts`) — 대규모 OpenAPI 코드젠은 검토했으나 이번 라운드에서는 보류 |
| One-Chat 실제 연동 | Phase 8 범위에서 제외 | 외부 서비스 연동이라 Agent/외부 연동을 다루는 이후 Phase 소관(09번 원칙) |
| Skill Export 한계 | 위 Phase 9 "Known Limitations" 참고 (Claude 실환경 업로드 미검증, Tool은 MCP 구성 필요 등) | 의도적 범위 결정 |
| 03/08/10번 Notion 문서 미반영 | 아래 3절 "문서 반영 필요 항목" 참고 | 코드에는 이미 반영됨, Notion 문서 자체는 수정하지 않기로 함 |

### 2-3. 발견 즉시 수정한 버그 (참고 기록 — 더 이상 열려있지 않음)

| Phase | 버그 | 수정 |
|---|---|---|
| 1 | Fastify가 `request.context`를 내부적으로 예약해 충돌 | `request.appContext`로 전부 rename |
| 1 | `contracts/`가 `bff/` 바깥에 있어 TS `rootDir` 빌드 실패 | `bff/tsconfig.json`에서 `rootDir` 명시 제거 |
| 2 | `ajv` default import가 NodeNext에서 타입체크 실패 | named import(`{ Ajv }`)로 변경 |
| 6 | Fallback 무한루프 탐지가 "시작 Step으로 되돌아오는" 케이스를 못 잡던 gap | 진입한 모든 step id(`visited_step_ids`)를 추적하도록 보강 |
| 6 | macOS 커널이 `RLIMIT_AS` 하향 설정 자체를 거부 | try/except로 감싸고 알려진 플랫폼 제약으로 문서화(Linux는 영향 없음) |
| 7 | Web이 body 없는 POST에도 `content-type: application/json`을 붙여 Fastify가 500 반환 | body가 있을 때만 헤더 설정하도록 수정 |
| 7 | `pendingApproval`이 API 계약 최상위에 전혀 노출되지 않고 `run.output.__pendingApproval` 내부 구현에만 존재 | `toPublicRun()`으로 정리, `markRunTerminal`도 마커 제거하도록 수정 |
| 8 | Heuristic Builder가 만든 knowledge Skill이 `search` Step에 `inputMap`이 없어 항상 실패 | `inputMap: {"query": {"$ref": "input.question"}}` 추가 |
| 8 | Heuristic Builder가 만든 tool Skill이 `maxToolCalls: 0`을 그대로 물려받아 항상 실패 | tool Skill 생성 시 `maxToolCalls`를 5로 override |
| 8 | Builder 시스템 프롬프트가 SkillSpec 구조를 `...SkillSpecV1...` 자리표시자로만 설명해, 어떤 Provider도 정확한 필드 구조를 알 방법이 없었음(이 경로가 실제로 실행된 적이 없어 지금까지 발견되지 않음) | 완전히 유효한 예시 SkillSpec을 시스템 프롬프트에 리터럴로 포함 |
| 8(2차) | **BFF에 Production 오발동 방지 가드가 전혀 없었음** — `config.mode`와 무관하게 `DevAuthContextProvider`가 무조건 wiring됨(Brain의 `ModelClientConfigurationError`와 대칭되는 가드가 없었음) | `select-auth-provider.ts`(`AuthProviderConfigurationError`) 신설 — `NODE_ENV=production`이면 기동 자체를 거부 |
| 8(2차) | `getKnowledgeCorpus` SQL에 `ORDER BY`가 없어 병렬 실행 시 chunk 순서가 흔들림(실제 발견: 병렬 테스트 중 `[0,1,2]`가 `[2,0,1]`로 반환) | `ORDER BY dc.document_id, dc.chunk_index` 추가 |
| 8(2차) | Output Schema Validation 실패 시 실제 output 값이 완전히 버려지고, Web Debug 탭에는 Run 레벨 output/error가 애초에 렌더링되지 않아 "왜 실패했는지" Debug에서 확인 불가능했음 | Brain이 실패 시에도 실제 output + 구조화된 validation error를 보존, Web Debug 탭에 Run Output/Error/Expected Output Schema 표시 추가 |
| 8+(실LLM) | Builder 시스템 프롬프트가 `tool`/`skill` Step에 `refId`가 필수라는 것을 전혀 설명하지 않아 실제 GPT가 refId를 빈 값으로 생성 | 명시적 규칙 추가(`prompts.py`) |
| 8+(실LLM) | `maxToolCalls`/`maxNestedSkillDepth` 기본값 0이 Tool/Nested Skill 호출을 전부 막는다는 것을 모델이 몰라 항상 0으로 생성 | "Tool/Skill Step이 있으면 최소 1 이상으로 설정하라"는 규칙 추가 |
| 8+(실LLM) | `approvalRequired`가 플랫폼 메커니즘이라는 것을 모델이 몰라 가짜 "승인 요청" LLM Step을 직접 만들어냄(실제로는 아무것도 막지 못함) | "Human Approval은 Step에 approvalRequired:true를 직접 설정하는 것"이라고 명시 |
| 8+(실LLM) | 복잡한 요청(Composite)에서 모델이 `{action, spec}` envelope을 통째로 빼먹고 SkillSpec을 최상위에 바로 반환 — 기존 Repair 힌트("unknown action: None")로는 반복 수정 실패 | Repair 힌트를 "action이 없고 bare spec처럼 보이면 envelope으로 감싸라"고 구체화 |
| 8+(운영) | 자동화 테스트(`npm test`)가 Web UI와 동일한 dev DB에 연결되어 반복 실행마다 Skill fixture가 "My Skills"에 쌓임(한 세션 동안 538개까지 누적) | 별도 `ai_builder_platform_test` DB 신설, `bff/vitest.config.ts` 기본값으로 분리 |
| 8+(운영) | `BRAIN_TIMEOUT_MS` 기본값(10초)이 실제 LLM 응답 지연(Repair 포함 시 2회 호출)엔 부족해 504 발생 | 로컬 개발 시 `BRAIN_TIMEOUT_MS=60000` 권장(환경변수로 이미 조정 가능, 기본값 자체는 변경 안 함) |
| 9 | 위 Phase 9 "테스트가 잡아낸 결함" 표 참고(`formatVersion` 누락, `30.0`, ZIP mtime/TZ, **Compatibility의 문서 이름 노출**, 비-ASCII ZIP 경로, Claude 프로파일 보정, Sanitizer 오탐) | 모두 수정 + 회귀 테스트 |

---

## 3. 문서 반영 필요 항목 (Notion, 미반영)

Phase 5에서 사용자 결정으로 도입했으나 **Notion 03/08번 문서에는 아직 반영되지
않은** 규칙:

1. **Run Output 규칙**: `execution.outputMap`이 있으면 그것을 최종 Output으로,
   없으면 "뒤에서부터 스캔한 마지막 성공 Step" output을 기본값으로 사용
2. **Mapping 참조 문법**: `inputMap`/`outputMap` 값은 `{"$ref": "input.<path>"}` /
   `{"$ref": "steps.<stepId>.output.<path>"}` 객체만 참조로 인정, 그 외 값(문자열
   포함)은 전부 Static Value

Phase 9에서 사용자 결정으로 **10번 문서와 달라졌으나 Notion에는 반영되지 않은** 항목:

3. **API 형태**: `format: "target"` + `target`/`profile` 대신 `{ target, format }`을 명시
   (`claude`/`skill-package`, `generic`/`markdown|portable-package|raw-spec`). `GET .../compatibility`에
   `version`이 필수, `profile`/`runtimeProfile` 개념은 사용하지 않음
4. **Compatibility level**: `full|partial|unsupported` + `blocked`(Secret/Knowledge 권한으로 지금 Export 불가). 소문자 canonical
5. **Target Profile 확장**: `llm`, `workflowSemantics` 세부 8개 flag, `runtimeLimits` 지원 flag, `declarative`, `notes`
6. **PortableSkill 확장**: `guardrails`, `runtimeLimits`, `dependencies`, Package-local alias(`child:`/`doc:`), 선택적 `source`/`sourceSpec`
7. **ZIP 경로**: 모든 entry path ASCII-safe(`skill-<id8>`, `references/document-<id8>.<ext>`), 표시 이름은 manifest에 보존
8. **Manifest**: `exportedAt` 없음(Stable metadata만), `skill.displayName`/`archivePath`, Child는 `version`+`contentHash`로 잠금
9. **Document**: `documents.export_allowed`(기본 false) + admin 전용 `PATCH /documents/:id`, `workspace` knowledge는 References Only 강제
10. **Sanitizer**: 값 기반 Hard Block, 인증 Endpoint 경로명/placeholder는 허용, redact 없이 차단

---

## 4. 다음 계획

Phase 1~8(Standalone Skill Platform)이 완료되었다 — 09번이 요구하는 실제 LLM Provider
연동 확인까지 OpenAI로 완료(위 Phase 8 참고). 남은 항목:

- **Nested Skill + Human Approval 전파**: Phase 8에서 발견했고 사용자 결정으로 이번
  범위에서는 "명확한 에러"로만 수정. 실제로 전파를 구현하기로 하면 Brain 재귀 실행
  엔진 + BFF approve/resume 로직을 함께 바꾸는 별도 작업 필요
- 보류 항목(Streaming, MCP 실행, 컨테이너 기반 Sandbox 강화, 실제 임베딩 Provider 연동,
  One-Chat 실제 연동)은 Agent/외부 서비스 연동을 다루는 이후 Phase에서 진행
- **Export 이후 후보**(자동 진행하지 않음): Import(Raw SkillSpec/Portable Package 재가져오기), 추가 Target Adapter(예: OpenAI-compatible,
  Gemini — Profile + Adapter 추가만으로 가능), 실제 Claude 환경에서의 패키지 인식 검증, Export 감사 테이블, 문서 ACL
