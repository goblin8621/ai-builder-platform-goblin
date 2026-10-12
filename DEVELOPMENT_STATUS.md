# AI Builder Platform — 개발 현황 요약

> 기준일: 2026-10-12 · 저장소: `ai-builder-platform` · 상세 이력은 [DEVELOPMENT_LOG.md](DEVELOPMENT_LOG.md), 사용법은 [README.md](README.md).
> 이 문서는 "지금 어디까지 왔는가"를 한 번에 보기 위한 요약본이다.

## 1. 한눈에 보기

| 항목 | 상태 |
|---|---|
| 제품 | Standalone **Skill Platform** (Skill-first, Agent 기능 없음) |
| 완료 Phase | **Phase 1 ~ 9 전부 완료** (Phase 9 = Skill Export / Portability) |
| 자동화 테스트 | Brain **361** (+1 skip) · BFF **228** · 전부 통과 |
| 타입체크 | BFF 0 오류 · Web 0 오류 |
| 로컬 실행 | Postgres · Brain(:8000) · BFF(:4000) · Web(:3000) 정상 기동 확인 |
| Git | 커밋 2개(Phase 1~8)는 반영됨. **Phase 9 변경 47개 파일은 아직 커밋/푸시 전** |
| 다음 Phase | 없음. Agent / 외부 서비스 연동은 별도 착수 필요(자동 진행하지 않음) |

## 2. 아키텍처

```
Web (Next.js 14)  ─REST→  BFF (Node/Fastify)  ─REST→  Brain (Python/FastAPI)
                              │                          ├─ Skill Builder
                              ▼                          ├─ Skill Runtime / Execution Engine
                         PostgreSQL                      ├─ Model·Tool·Capability Registry, Sandbox, RAG
                     (BFF만 DB 접근)                     └─ Skill Export (PortableSkill · Adapter)
```

- **역할 분리**: Brain은 DB에 접근하지 않는다. BFF가 Version·Child Skill·문서·권한을 해석해 데이터로 넘기고, 패키징(ZIP)/다운로드는 BFF가 맡는다.
- **계약 중심**: `contracts/`(JSON Schema + TS 타입)가 기준이고 Brain(Pydantic)·BFF·Web이 미러링하며, drift 검출 테스트가 있다.
- **인증 경계**: `RequestContext` + `AuthContextProvider`(현재 Dev용). Production에서는 Dev Provider가 기동 자체를 거부한다.

## 3. Phase별 완료 현황

| Phase | 내용 | 상태 |
|---|---|---|
| 1 | Bootstrap / Common Foundation (Config·Error·Logging·Model/Tool/Knowledge/Capability/Approval/Streaming/Sandbox 인터페이스) | ✅ |
| 2 | SkillSpec v1 계약 (JSON Schema·TS·Pydantic) + DB 스키마/마이그레이션 | ✅ |
| 3 | Registry / Skill CRUD / Version / Restore | ✅ |
| 4 | Skill Builder (create / refine / repair, Registry 검증) | ✅ |
| 5 | Core Skill Runtime (Input/Output 검증, Execution Engine, `$ref` Mapping) | ✅ |
| 6 | Extended Runtime (Tool·RAG·Nested Skill·Retry/Fallback/Skip·Human Approval·Cancel·Sandbox) | ✅ (Streaming·MCP 실행은 보류) |
| 7 | Skill Playground Web UI (My Skills·만들기·구성·Version History·Preview/Debug) | ✅ |
| 8 | E2E / Stabilization (유즈케이스 6개, Isolation, Restart Recovery, Production 가드, 실LLM 검증) | ✅ |
| **9** | **Skill Export / Portability** (Claude Skill 포함) | ✅ |

## 4. 현재 제공 기능

- **Skill 제작**: 자연어로 Skill 생성/수정(Builder), SkillSpec 수동 편집, Version 관리(append-only, Restore는 새 Version 생성).
- **Skill 실행**: 동기 Run/Preview(동일 Runtime 경로), Step 추적, Input/Output Schema 검증, Retry/Fallback/Skip/Fail, Human Approval(승인·거절), Nested Skill(Parent/Child Run), Tool 실행(Sandbox), Knowledge 검색(로컬 해싱 유사도).
- **Skill Export (Phase 9)**: 아래 5절.
- **운영 안전장치**: Production 오발동 방지(BFF·Brain 양쪽), 테스트 전용 DB 분리, Workspace/Knowledge 격리.

## 5. Phase 9 — Skill Export / Portability

Skill Builder에서 만든 Skill을 특정 Provider에 종속되지 않는 **PortableSkill**로 변환한 뒤 Target별 Adapter로 내보낸다. Provider 차이는 SkillSpec이 아니라 **Target Profile + Adapter**가 담당하고, 새 Target은 둘을 등록하는 것만으로 추가된다(테스트로 실증).

| target | format | 결과 |
|---|---|---|
| `claude` | `skill-package` | Claude/Agent Skill ZIP (`SKILL.md` + YAML frontmatter + references) |
| `generic` | `markdown` | 일반 Markdown (Provider frontmatter 없음) |
| `generic` | `portable-package` | Portable Skill Package ZIP |
| `generic` | `raw-spec` | 저장된 SkillSpec JSON |

**API**: `GET /export/targets` · `GET /skills/:id/export/compatibility` · `POST /skills/:id/export` · `PATCH /documents/:id`(admin) — `version`은 필수("latest" 암묵 적용 없음).

**핵심 정책**

| 영역 | 정책 |
|---|---|
| Claude 형식 | `name`≤64자·소문자/숫자/하이픈·예약어(claude/anthropic) 금지, `description`≤1024자, 본문 500줄 미만, 링크 한 단계, 전용 검증기 |
| ZIP 경로 | **모두 ASCII-safe** (`skill-a31fc912/references/document-928ac031.md`), 표시 이름은 manifest에 보존, BFF가 재검증 |
| 호환성 | `full / partial / unsupported / blocked` + 사유·수동 설정·Required MCP·Unsupported Capabilities. partial은 경고 확인 필요, `claude`는 unsupported면 차단 |
| Knowledge | `selected`만 포함 가능, 조건 = `workspace ∧ 문서 접근 ∧ export_allowed`(기본 false, admin만 변경). workspace 모드는 항상 References Only |
| 권한 없는 문서 | Compatibility는 200 + `blocked`로 설명, 실제 Export는 403. 이름·ID·내용 비노출 |
| Sanitizer | 모든 형식 적용, 탐지 시 redact 없이 **차단**, `path`/`category`만 반환. 기준은 Credential **값**(경로명 `/oauth/token` 등은 허용) |
| Child Skill | Export 시점 Version 잠금 + content hash(Merkle), PortableSkill엔 내부 ID 대신 `child:`/`doc:` alias |
| 재현성 | 같은 Parent Version + 같은 Child Versions + 같은 Knowledge + 같은 옵션 + 같은 Target ⇒ 바이트 동일. Export 시각은 응답 헤더/로그에만 |
| 권한 | `workspaceRole`은 AuthProvider만 해석, 값 없으면 member(fail-closed), Domain은 Header/Body를 읽지 않음 |

**UI**: Skill 헤더 `Export ▾` → Claude Skill / Generic Markdown / Raw SkillSpec / Portable Skill Package → Compatibility 확인 → 다운로드. `exportAllowed=false` 문서는 Include Knowledge 비활성화 + Blocker 표시.

## 6. 테스트 현황

| 대상 | Phase 8 종료 | 현재 |
|---|---|---|
| Brain (pytest) | 109 (+1 skip) | **361 (+1 skip)** |
| BFF (vitest: unit·contract·integration·E2E) | 94 | **228** |

- Phase 9 E2E: Skill Builder → 저장 → Claude Export → ZIP → 압축 해제 → SKILL.md/YAML 검증(+ 외부 `unzip -t`), Knowledge·Tool·권한 없는 문서 시나리오.
- 방어선을 일부러 깨뜨려 테스트가 실제로 실패하는지 확인함(export_allowed 검사, Sanitizer 우회, frontmatter, 검증기, Web 타입).
- 실제 서버 + 실제 브라우저로 Knowledge 허용 → FULL → 다운로드, Required MCP, BLOCKED 렌더링을 확인함.

## 7. 알려진 한계 / 열린 사항

- **Claude 호환은 공식 문서의 규칙을 구현·검증한 것이며, 실제 Claude 환경에 업로드해 확인하지는 못했다.**
- Tool Skill은 Claude에 이 플랫폼의 builtin Tool이 없어 항상 `partial`(MCP 서버를 사용자가 구성해야 함). Code Execution은 Claude 환경 의존.
- Nested Skill 자식의 Human Approval은 Parent로 전파되지 않는다(명확한 에러 `NESTED_SKILL_APPROVAL_NOT_SUPPORTED`로 Known Limitation 확정). `condition`은 Runtime이 평가하지 않는다.
- Streaming(SSE)·MCP 실행·컨테이너 Sandbox·실제 임베딩은 보류. 문서는 텍스트만 지원. 실제 로그인/JWT 없음(Dev Provider).
- Sanitizer는 정규식 휴리스틱(DLP 아님). 문서별 ACL·Export 감사 테이블 없음.
- `tsc` 빌드 산출물(`dist/`)에 JSON 계약 파일이 복사되지 않아 `NODE_ENV=production node dist/...` 실행은 불가(개발은 `tsx` 사용).
- 자세한 목록: DEVELOPMENT_LOG.md 의 "Known Limitations"·"설계 이슈 종합".

## 8. 저장소 상태

- 커밋: `13c5f0d`(Phase 1~6) · `8450027`(Phase 7·8, OpenAI Provider). **Phase 9와 README/DEVELOPMENT_LOG 갱신은 커밋 전**(수정 22개 + 신규 25개 경로).
- 변경 요약: 신규 `brain/app/exports/`(Compiler·Sanitizer·Compatibility·Adapter), `bff/src/skill-exports/`, `contracts/{export,portable-skill}.*`, `db/migrations/003_document_export_permission.sql`, `web/components/ExportDialog.tsx`, 테스트 다수. 신규 의존성: `fflate 0.8.3`(BFF, 버전 고정), `PyYAML 6.0.3`(Brain).
- 로컬 dev DB에 검증용 Skill 4개(한글 이름 3 + 비밀값 포함 1)와 문서 2개가 남아 있다(원하면 정리 가능).

## 9. 로컬 실행

```bash
./scripts/dev-up.sh      # Postgres + 마이그레이션(001~003, dev/test DB) + Brain + BFF + Web
./scripts/dev-down.sh
cd brain && source .venv/bin/activate && pytest      # Brain 테스트
cd bff && npm test                                   # BFF 테스트 (Brain 코드를 바꿨다면 Brain 재시작 후)
```

## 10. 다음 후보 (요청 전에는 진행하지 않음)

1. Phase 9 변경 커밋/푸시 및 검증용 dev 데이터 정리
2. 실제 Claude 환경에서 패키지 인식 확인
3. Import (Raw SkillSpec / Portable Package 재가져오기)
4. 추가 Target Adapter (Profile + Adapter만 추가)
5. Agent 계층 / 외부 서비스 연동 (별도 Phase)
