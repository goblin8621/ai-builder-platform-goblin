# ai-builder-platform

Standalone Skill Platform. Skill-first: Agent/외부 서비스 연동은 이후 별도 Phase.

현재 상태: **Phase 1~9 완료** (Skill Playground/Web UI, E2E·Stabilization, 실LLM(OpenAI) 연동 검증, Skill Export/Portability — Claude Skill·Generic Markdown 포함).

## 구조

```
contracts/   BFF/Brain/Web가 공유하는 타입, OpenAPI 계약
web/         Next.js 14 App Router — Skill Playground (My Skills/만들기/구성/
             Version History/Preview·Debug), Client Component만 사용
bff/         Node.js/Fastify — Skill API, Auth Context, Brain Client
brain/       Python/FastAPI — Skill Builder/Runtime, Common Foundation 인터페이스
db/          SQL Migration / Seed
tests/       BFF(vitest) / Brain(pytest) / Contract 테스트
```

## 로컬 개발 환경 실행

### 1. PostgreSQL (Docker Compose)

```bash
docker-compose up -d postgres
psql "postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform" -f db/migrations/001_init.sql
psql "postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform" -f db/migrations/002_skill_registry.sql
psql "postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform" -f db/migrations/003_document_export_permission.sql
psql "postgresql://ai_builder:ai_builder@localhost:5477/ai_builder_platform" -f db/seeds/001_seed_workspace.sql
```

(로컬에 `psql` 클라이언트가 없다면 컨테이너 안에서 실행: `podman exec -i ai-builder-platform-postgres psql -U ai_builder -d ai_builder_platform < db/migrations/001_init.sql` 형태로 대체)

### 2. Python Brain

프로젝트는 **Python 3.11 계열로 고정**합니다(`brain/.python-version` = `3.11.12`, `brain/pyproject.toml`의
`requires-python = ">=3.11,<3.12"`). 시스템 기본 `python3`가 3.13 등 다른 버전이면 반드시 3.11 인터프리터를
명시적으로 지정해 가상환경을 만드세요(pyenv 사용 시 `brain/` 진입 시 `.python-version`으로 자동 전환됩니다).

```bash
cd brain
python3.11 -m venv .venv   # 시스템에 3.11이 없다면 pyenv 등으로 3.11.12 설치 후 사용
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 3. BFF

```bash
cd bff
npm install
npm run dev
```

기본 포트: BFF `4000`, Brain `8000`, Postgres `5477`(host) → `5432`(container).

### 4. 동작 확인

```bash
curl http://localhost:4000/health
```

`db`와 `brain` 의존성이 모두 `ok`이면 Phase 1 Bootstrap이 정상 동작하는 상태입니다.

개발용 identity(RequestContext)는 기본 seed 값(`DevAuthContextProvider`)을 사용하며,
아래 헤더로 임시 override할 수 있습니다(운영 환경에서는 비활성화):

```bash
curl http://localhost:4000/health \
  -H "x-dev-user-id: 00000000-0000-0000-0000-000000000099" \
  -H "x-dev-workspace-id: 00000000-0000-0000-0000-0000000000b2"
```

## SkillSpec v1 계약

`contracts/skill-spec.schema.json`이 유일한 검증 기준(canonical)입니다.

- TS: `contracts/skill-spec.ts` (타입만, 검증 로직 없음), `bff/src/skills/skill-spec-validator.ts` (ajv로 위 JSON Schema를 그대로 로드해 검증 + 시맨틱 체크)
- Python: `brain/app/skills/schemas.py` (Pydantic 타입만), `brain/app/skills/validator.py` (`jsonschema`로 동일 JSON Schema 파일을 로드해 검증 + 동일 시맨틱 체크)
- `tests/contract/fixtures/skill-spec/*.json`을 TS(`tests/contract/skill-spec.test.ts`)와 Python(`tests/brain/test_skill_spec_validator.py`) 양쪽이 함께 사용해 동일 판정을 내리는지 검증합니다.
- Registry(Model/Tool/Skill/Document 존재 여부, Capability 서버 지원 여부, Nested Skill Cycle/Depth)에 의존하는 검증은 Phase 3(Registry)/Phase 4(Builder)에서 추가됩니다. 현재는 Skill Spec 자체로 판단 가능한 구조적/의미적 검증만 수행합니다.

## Skill CRUD / Registry API (Phase 3)

```
GET    /skills                 workspace 범위 목록
POST   /skills                 수동 생성 (spec 전체 제공, Builder 아님)
GET    /skills/:id             현재 Version 포함 조회
PATCH  /skills/:id             expectedVersion 검증 후 새 Version 생성
POST   /skills/:id/activate    draft -> active
POST   /skills/:id/duplicate   현재 Version spec 복제 -> 새 Skill v1
DELETE /skills/:id             soft delete
GET    /skills/:id/versions    Version 이력
POST   /skills/:id/versions/:version/restore   과거 spec 재검증 후 새 Version

GET    /models                 Model Registry (Brain 프록시, 정적 카탈로그)
GET    /tools                  Tool Registry (Brain 프록시, 정적 카탈로그)
GET    /capabilities           Capability 지원 여부 (codeExecution/dataAnalysis/fileAnalysis/knowledgeSearch는 true, webSearch/imageGeneration/mcp는 false — 아래 "Extended Runtime" 참고)
```

`/skills/:id/preview/stream`(SSE Streaming)만 아직 없습니다 — 아래 "Extended Runtime" 참고.

모든 생성/수정은 3단계 검증을 통과해야 저장됩니다: 구조적(JSON Schema) → 시맨틱(Step id/fallback) → Registry(모델·도구 존재, Capability 지원, Skill 참조 cycle/문서 존재).

## Skill Builder (Phase 4)

```
POST /skills/build            { "request": "..." } -> Builder가 생성한 spec을 검증 후 저장(v1)
POST /skills/:id/refine       { "expectedVersion": n, "request": "..." } -> 검증 후 새 Version(change_source=ai_refine)
```

- Builder는 Brain(`brain/app/skills/builder_service.py`)에 있고, `POST /builder/build`,`POST /builder/refine`(Brain 내부 API)를 BFF가 호출합니다.
- Builder 출력은 **절대 그대로 신뢰하지 않고**, 수동으로 제출한 Spec과 동일한 3단계 검증(Phase2 구조/시맨틱 + Phase3 Registry/Cycle)을 다시 통과해야 저장됩니다.
- Builder 내부적으로는 구조 검증 실패 시 최대 1회 Repair(같은 LLM에게 오류 목록을 주고 재요청)를 시도하고, 그래도 실패하면 `400 validation_error`를 반환합니다(04번 문서 기준).
- **LLM 연동**: `brain/app/common/models/selection.py`가 유일한 선택 지점입니다.
  - `ANTHROPIC_API_KEY`가 있으면 항상 실제 Anthropic API(`anthropic_client.py`) 사용.
  - 없고 `OPENAI_API_KEY`가 있으면 실제 OpenAI API(`openai_client.py`, Phase 8 추가) 사용 — Model Registry의 추상 modelId(`model-001` 등)는 그대로, 실제 Provider 모델 문자열만 `OPENAI_API_KEY`/`MODEL_00N_OPENAI_MODEL_ID`로 분리됩니다.
  - 둘 다 없고 `BRAIN_ENV`가 `production`이면 **앱 기동 자체가 `ModelClientConfigurationError`로 실패**합니다(운영에서 dev/test Heuristic으로 조용히 대체되는 것을 원천 차단).
  - 둘 다 없고 `BRAIN_ENV`가 `development`/`test`(기본값)면 결정론적 Fallback인 `HeuristicModelClient`가 사용됩니다 — 실제 자연어 이해가 아니라 키워드 기반의 데모/테스트 전용 구현입니다(Phase1의 `DevAuthContextProvider`와 동일한 패턴).

## Skill Run

```
POST /skill-runs                 { "skillId": "...", "input": {...}, "mode"?: "run"|"preview" } -> 동기 실행 후 결과 반환
GET  /skill-runs/:id             Run + Step + Child Run 조회
POST /skill-runs/:id/approve     waiting_approval 상태의 Run을 재개
POST /skill-runs/:id/reject      waiting_approval 상태의 Run을 종료(Brain 재호출 없음)
POST /skill-runs/:id/cancel      waiting_approval 상태에서만 취소 가능(아래 참고)
```

- 흐름(08번): Skill+Version Load → **Input Schema Validation(실패 시 Run 행조차 만들지 않음)** → Run 저장(Skill Version 고정) → Brain의 Execution Engine 호출 → Output Schema Validation(Brain) → Run/Step 상태 저장
- **지원 Step**: `llm`, `transform`, `tool`, `knowledge`, `skill`(Nested). `condition`만 아직 미지원("not supported" 에러로 명확히 실패, 무시/성공 처리하지 않음).
- **동기 실행 유지**: `POST /skill-runs`는 여전히 실행 완료(또는 Approval 대기)까지 기다렸다가 응답합니다. Streaming(SSE)은 이번에도 의도적으로 보류했습니다 — 지금 구조를 실시간 스트리밍으로 바꾸려면 BFF↔Brain 호출 자체를 청크 전송으로 바꿔야 해서 별도 아키텍처 작업으로 분리했습니다.
- **LLM 연동**: Builder와 동일한 선택 게이트(`select_model_client`)를 사용합니다 — 운영에서 자동으로 Heuristic으로 대체되지 않습니다(아래 참고).

## Extended Runtime (Phase 6)

### Retry / Fallback / Skip

- `onError.action`이 실제로 동작합니다: `retry`(최대 `retryCount+1`회 시도, 각 attempt를 별도 `skill_run_steps` 행으로 저장), `fallback`(`fallbackStepId`로 실행 포인터 이동), `skip`(해당 Step만 `skipped` 처리 후 다음 Step 진행).
- **무한 Fallback Loop 차단**(08번 6.): 한 Skill 실행 내에서 이미 진입했던 Step id로 다시 점프하려 하면(시작 Step으로 되돌아오는 경우 포함) 즉시 명확한 에러로 종료합니다.
- Skip된 Step의 output을 `$ref`로 참조하면 "not yet executed"류의 명확한 Mapping 오류로 실패합니다(조용히 무시하지 않음).

### Tool 실행 / Sandbox

- `brain/app/tools/executors.py`가 Phase 3 정적 카탈로그(`file-parser`, `python-data-analysis`, `service-status`)에 실제 로직을 연결합니다. 전부 **로컬/결정론적**이며 외부 서비스 호출은 없습니다(`service-status`는 명시적으로 시뮬레이션된 응답).
- `python-data-analysis`(월별 합계, 이상치 탐지)는 `brain/app/sandbox/subprocess_sandbox.py`(고정된 스크립트 + stdin으로 전달한 데이터만 실행)를 통해서만 실행됩니다.
- **Sandbox 보안 경계를 명확히 함**: 이번 구현은 **프로세스 수준 격리**(`python -I` subprocess, 리소스 제한, 타임아웃, 출력 크기 제한)이지 컨테이너/VM 격리(Docker/gVisor/Firecracker)가 아닙니다. 이 플랫폼이 직접 작성·검수한 고정 스크립트를 신뢰할 수 있는 개발 환경에서 실행하는 데는 적합하지만, 신뢰할 수 없는 사용자가 임의 코드를 제출하는 다중 테넌트 운영 환경에는 아직 충분하지 않습니다(06번이 열어둔 선택지 — 최종 결정 아님). macOS에서는 커널이 메모리 제한(RLIMIT_AS)을 거부하는 경우가 있어 그 경우 조용히 건너뛰고 타임아웃/출력 제한만 적용합니다(자세한 내용은 해당 파일 docstring 참고).
- `runtime.maxToolCalls`를 Run 전체(Nested Skill 포함 누적)에 대해 강제합니다.

### Nested Skill (`skill` Step)

- BFF가 Run 시작 시 `maxNestedSkillDepth`까지 참조 가능한 모든 Child Skill의 **현재 Version을 재귀적으로 고정**해서(08번: "Child Version을 호출 시점에 고정") Brain에 데이터로 전달합니다(Brain은 DB에 접근하지 않음, 06번 역할 분리).
- Brain은 전달받은 Child Spec을 in-process로 재귀 실행하고, 전체 트레이스를 BFF에 반환합니다. BFF는 이를 실제 `skill_runs`(parent_run_id 포함)/`skill_run_steps` 행으로 풀어서 저장합니다.
- Cycle/Depth는 이미 Phase 3 저장 시점에 차단되어 있으므로, Runtime에서는 "제공되지 않은 Child" = "존재하지 않거나 Depth 초과"로만 처리해도 안전합니다(Brain이 직접 세지 않음).

### Human Approval / Cancel

- `approvalRequired: true`인 Step은 **실행 전에** 멈춥니다. Brain은 "대기" 개념이 없으므로, 그 즉시 `status="waiting_approval"`과 대기 중인 Step 정보만 반환하고 끝냅니다 — 승인 전 Tool은 절대 호출되지 않습니다.
- `approve`는 BFF가 이미 저장해둔 완료 Step들의 output으로 `priorStepOutputs`를 재구성해서 Brain에 "이 Step부터 재개, 이번엔 승인된 것으로 간주" 요청을 다시 보냅니다. 같은 Skill에 승인 게이트가 여러 개면 순서대로 다시 멈춥니다.
- `reject`는 Brain을 다시 호출하지 않고 그대로 Run을 종료합니다(위험 Side Effect 없음).
- **Cancel 범위 제한(설계 결정)**: 현재 구조는 Streaming/비동기 Job Queue 없이 BFF→Brain 호출이 동기로 블로킹됩니다. 따라서 `waiting_approval`(진짜로 멈춰 있는 상태)에서만 취소가 의미 있고, `running` 상태의 Run은 실시간으로 중단할 방법이 없습니다 — `cancel`은 이 경우 조용히 성공한 척하지 않고 "비동기 Job 아키텍처가 아직 없어 지원하지 않는다"는 명확한 에러를 반환합니다. 이미 종료된 Run도 거부합니다(05번: "이미 완료된 Run은 취소 불가").

### RAG / Knowledge

- `POST/GET /documents`, `DELETE /documents/:id` 신규 구현. **Phase 6 범위: 순수 텍스트 콘텐츠만** 지원(바이너리 업로드·오브젝트 스토리지 없음), 업로드 즉시 800자 고정 크기로 청크 분할해 `document_chunks`에 저장합니다.
- **임베딩 모델 없음**: `brain/app/rag/vectorizer.py`가 결정론적 해싱 기반 TF 벡터(고정 256차원, FNV-1a 해시)로 매 검색마다 코퍼스와 질의를 함께 벡터화해 코사인 유사도로 순위를 매깁니다. 실제 의미 기반 임베딩이 아니라 키워드 중첩 기반이며, 성능/정합성 문제로 `document_chunks.embedding`(jsonb, 02번)은 여전히 사용하지 않습니다(매 호출 재계산). 실제 임베딩 Provider가 생기면 이 부분과 저장 방식을 함께 교체해야 합니다.
- `knowledge` Step은 반드시 resolved input에 `query` 문자열이 있어야 하며, 코퍼스가 비어 있으면 에러가 아니라 빈 결과(`{"results": []}`)를 반환합니다 — "근거 없음"은 정상적인 결과입니다(00번 유즈케이스 #2).
- `knowledgeSearch`/`codeExecution`/`dataAnalysis`/`fileAnalysis` Capability가 이번에 `true`로 전환되었습니다(실제 구현이 생겼으므로). `webSearch`/`imageGeneration`/`mcp`는 외부 서비스 연동이 없어 계속 `false`입니다.

### 명시적으로 보류한 것

- **Streaming(SSE)**: 위 참고. RunResult/StepResult가 이미 필요한 정보를 다 담고 있어, 나중에 "다 끝나고 한 번에 반환" 대신 "완료되는 대로 하나씩 보내기"로 바꾸는 점진적 작업이 될 것으로 예상합니다.
- **MCP**: 연동해서 테스트해볼 실제 MCP 서버가 없어 이번 범위에서 제외했습니다. `mcp` Capability는 계속 `false`입니다.

### Mapping (`inputMap` / `outputMap`) — `$ref` 문법

Step의 `inputMap`과 `execution.outputMap`은 오직 **명시적 `{"$ref": "..."}` 객체**만 참조로 취급합니다. 그 외 값(문자열 포함, 예: `"input.text"`처럼 참조처럼 보이는 문자열도)은 전부 Static Value로 그대로 사용됩니다.

```
{ "$ref": "input" }                          -> Run Input 전체
{ "$ref": "input.<path>" }                   -> Run Input의 특정 필드
{ "$ref": "steps.<stepId>.output" }          -> 이전 Step의 output 전체
{ "$ref": "steps.<stepId>.output.<path>" }   -> 이전 Step output의 특정 필드
그 외 모든 값                                  -> Static Value (리터럴 그대로 사용)
```

- 유일한 구현체: `brain/app/skills/mapping_resolver.py` (임의 코드/표현식 실행 없음). BFF는 Step을 실행하지 않으므로 별도 Resolver가 없고, 대신 `bff/src/skills/mapping-ref.ts`의 `isMappingRef`로 같은 `$ref` 모양만 판별해 **저장 시점 정적 검증**(`skill-spec-validator.ts` / Python `validator.py`)에 사용합니다: 존재하지 않는 Step id, `inputMap`에서 아직 실행되지 않은(더 뒤에 있는) Step 참조를 저장 시점에 차단합니다.
- **Run Output 규칙**: `execution.outputMap`이 있으면 그것으로 최종 Output을 구성하고 `outputSchema`로 검증합니다. 없으면 **마지막으로 성공적으로 완료된 Step의 output**을 기본값으로 사용합니다(배열의 마지막 항목이 아니라 뒤에서부터 `status: completed`를 찾음 — Phase 6에서 fallback/skip이 추가돼도 트레일링 Step이 실수로 최종 결과가 되지 않도록 미리 대비).
- 이 규칙은 03(Skill Spec 계약)·08(Runtime) 문서에 반영이 필요합니다(코드에는 반영 완료, **Notion 문서 자체는 이번 변경에서 수정하지 않았습니다** — 별도로 갱신해 주세요).

### 실제 LLM Provider 연동 확인 (opt-in) — Phase 8에서 OpenAI로 완료

```bash
LIVE_LLM_TEST=true ANTHROPIC_API_KEY=sk-... pytest tests/brain/test_live_llm_smoke.py
# 또는
LIVE_LLM_TEST=true OPENAI_API_KEY=sk-... pytest tests/brain/test_live_llm_smoke.py
```

일반 테스트 스위트는 이 파일을 항상 skip합니다(자격증명 없이도 전체 통과). `LIVE_LLM_TEST=true`일 때만 `select_model_client`가 실제로 고른 Provider(Anthropic 또는 OpenAI, 둘 다 있으면 Anthropic 우선)로 Build → Run → Output Validation을 한 번에 확인합니다 — 09번 문서의 "Phase 8 이전 최소 1개 실제 Provider 연동" 체크포인트이며, Phase 8에서 OpenAI로 실제 통과를 확인했습니다.

## Skill Export / Portability (Phase 9)

`SkillSpec → Portable Skill Compiler → PortableSkill → Sanitizer → Compatibility Analyzer → Export Adapter(target, format) → 파일/ZIP`.
`SkillSpec`은 내부 Source of Truth로 유지하고, Provider/Runtime 차이는 **Target Profile + Adapter**가 담당합니다
(`brain/app/exports/`). Brain은 DB 없이 변환만, BFF는 Version·Child·권한 해석과 ZIP 패키징/다운로드를 맡습니다.
자세한 설계·정책·Known Limitations는 `DEVELOPMENT_LOG.md`의 Phase 9 절.

```
GET   /export/targets                                    Target / Format 목록 (adapterAvailable 포함)
GET   /skills/:id/export/compatibility?version=N&target=claude&format=skill-package[&includeKnowledge=true][&includeChildSkills=true]
POST  /skills/:id/export   { version, target, format, includeKnowledge?, includeChildSkills?,
                             includeSourceSpec?, acknowledgeWarnings? }
PATCH /documents/:id       { exportAllowed }             workspace admin 전용
```

| target | format | 결과 |
|---|---|---|
| `claude` | `skill-package` | Claude/Agent Skill ZIP (SKILL.md + YAML frontmatter + references) |
| `generic` | `markdown` | 일반 Markdown(Provider frontmatter 없음) |
| `generic` | `portable-package` | Portable Skill Package ZIP |
| `generic` | `raw-spec` | 저장된 SkillSpec JSON |

- `version`은 필수이며 "latest"를 암묵 적용하지 않습니다. 미지원 target은 `EXPORT_TARGET_UNSUPPORTED`, target이 제공하지 않는 format은
  `EXPORT_FORMAT_UNSUPPORTED`, Adapter 누락은 `EXPORT_TARGET_ADAPTER_UNAVAILABLE`.
- **호환성**: `full | partial | unsupported | blocked`(API는 소문자, UI만 대문자). 사유·`summary`(Required MCP / Knowledge / Unsupported Capabilities)·수동 설정을
  반환합니다. `partial`/`unsupported`는 `acknowledgeWarnings=true`가 있어야 Export되고, Target Optimized(`claude`)는 `unsupported`면 차단됩니다.
  `blocked`(Secret 탐지 / Knowledge 권한 없음)는 Compatibility에서 HTTP 200으로 설명하고, 실제 Export는 차단합니다(Secret 400 / Knowledge 403).
- **ZIP 경로는 모두 ASCII-safe**(`skill-a31fc912/references/document-928ac031.md`): 한글 이름이어도 안전하게 풀립니다.
  표시 이름은 `manifest.json`(`displayName`, `archivePath`, `fileName`)에 보존됩니다.
- **Sanitizer**: 모든 형식(Raw SkillSpec 포함)에 적용. Credential **값**(API Key, Bearer 값, 비밀번호/secret 할당, `?access_token=…`, URL userinfo, Private Key 등)이
  있으면 redact 없이 `EXPORT_SECRET_DETECTED`로 차단하고 `path`/`category`만 알려줍니다. `/oauth/token` 같은 경로나 placeholder는 허용합니다.
- **Knowledge**: `selected`만 Include 가능, 조건은 `workspace ∧ document 접근 ∧ documents.export_allowed`(기본 `false`). `workspace` 모드는 항상 References Only.
- **Child Skill**: Export 시점의 Child Version을 잠그고 Manifest에 version/content hash를 기록합니다. PortableSkill에는 내부 ID 대신 `child:`/`doc:` alias만 사용합니다.
- **재현성**: 같은 Parent Version + resolved Child Versions + Knowledge Content + Options + Target/Format이면 바이트 동일(ZIP 순서·mtime 고정, JSON 정렬, LF).
  Export 시각은 `X-Exported-At` 헤더/로그에만 있습니다.
- Web UI: Skill 헤더 `Export ▾`(Claude Skill / Generic Markdown / Raw SkillSpec / Portable Skill Package) → Compatibility 확인 → 다운로드.

## Skill Playground (Web, Phase 7)

```bash
cd web
npm install
npm run dev   # http://localhost:3000
```

- `NEXT_PUBLIC_BFF_URL`(기본 `http://localhost:4000`)로 BFF 주소를 지정합니다. 브라우저가
  BFF를 직접 호출하므로 BFF에 `WEB_ORIGINS=http://localhost:3000`(기본값) CORS 설정이
  필요합니다.
- **My Skills**: 목록 조회 + 자연어로 신규 Skill 생성(`POST /skills/build`) + Activate/
  Duplicate/Archive.
- **Skill Workspace**(`/skills/:id`): 만들기(자연어 수정 요청) / 구성(SkillSpecV1 수동
  편집, `expectedVersion` 낙관적 동시성) / Version History(Restore) 탭 + **Preview/Debug**
  패널.
- **Preview**는 저장된 Version만 실행 가능하며 `POST /skill-runs`(`mode: "preview"`)를
  그대로 호출합니다 — Web 전용 Fake Runtime은 없습니다. **Debug**는 Run/Step 상태와
  Nested Skill Child Run을 그대로 노출하며, Human Approval 대기 중이면 Preview/Debug
  어느 탭에서도 Approve/Reject/Cancel 배너가 보입니다.
- Web에는 Runtime 판단 로직이 없습니다 — 모든 검증/실행 결과는 BFF/Brain 응답을 그대로
  표시할 뿐입니다.

## 테스트

```bash
# BFF (tests/bff, tests/contract, tests/e2e 전부 포함)
cd bff && npm test

# Brain
cd brain && source .venv/bin/activate && pytest
```

`tests/e2e/`(Phase 8)는 00번 유즈케이스 E2E, Workspace/Knowledge Isolation, Restart
Recovery를 실제 BFF→Brain→Postgres 경로로 검증합니다 — 다른 통합 테스트와 마찬가지로
Postgres/Brain이 실행 중이어야 하며, 없으면 자동으로 skip됩니다. `tests/e2e/phase9-export.test.ts`(Phase 9)는
Skill Builder → 저장 → Claude Export → ZIP 해제 → SKILL.md/YAML 검증(+ 외부 `unzip -t`)과 Knowledge/Tool/권한 없는 문서 시나리오를 검증합니다.
Brain은 reload 없이 기동되므로 Brain 코드를 바꾼 뒤에는 재시작해야 BFF 통합 테스트가 새 코드를 봅니다.

**테스트 DB 격리**: `npm test`는 기본적으로 실제 개발용 DB(`ai_builder_platform`)가
아니라 별도의 `ai_builder_platform_test` DB를 사용합니다(`bff/vitest.config.ts`) — 테스트가
만드는 Skill/Document fixture가 Web UI의 "My Skills"에 쌓이는 것을 막기 위함입니다.
`scripts/dev-up.sh`가 두 DB 모두에 동일한 마이그레이션/시드를 적용해줍니다. 셸에
`DATABASE_URL`을 직접 export해두면 그 값이 우선합니다.

## 설계 원칙 (요약)

- Frontend에 Runtime 판단 로직 없음, Builder/Runtime 역할 분리
- Preview는 실제 Skill Runtime과 동일 경로 사용
- Model/Tool/Knowledge/Skill은 Registry ID로만 참조
- Secret/API Key/Token은 Skill Spec에 저장하지 않음
- Skill Version append-only, Run 시작 시 Version 고정
- Code Execution은 Sandbox 경계로만 실행
- Approval 전 Side Effect 금지
- Skill Runtime에 Planning/Reflection/Re-planning을 넣지 않음 (Agent는 이후 별도 계층)

세부 설계는 사내 Notion "AI Builder Platform 기능 기획안" 00~09번 문서를 따른다.
