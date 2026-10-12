'use client';

import { useEffect, useMemo, useState } from 'react';
import * as api from '../lib/api';
import { ApiError } from '../lib/api';
import type {
  DocumentRecord,
  ExportCompatibilityResponse,
  ExportFormatDescriptor,
  SkillVersionRecord,
} from '../lib/types';

export type ExportChoice = { target: string; format: string; label: string };

const CHOICES: ExportChoice[] = [
  { target: 'claude', format: 'skill-package', label: 'Claude Skill' },
  { target: 'generic', format: 'markdown', label: 'Generic Markdown' },
  { target: 'generic', format: 'raw-spec', label: 'Raw SkillSpec' },
  { target: 'generic', format: 'portable-package', label: 'Portable Skill Package' },
];

/** `Export ▼` — offers only the targets/formats that actually have an Adapter (the catalog says which). */
export function ExportMenu({ onChoose }: { onChoose: (choice: ExportChoice) => void }) {
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState<ExportChoice[] | null>(null);

  useEffect(() => {
    api
      .getExportTargets()
      .then(({ targets }) => {
        const ready = new Set(
          targets.flatMap((t) => t.formats.filter((f) => f.adapterAvailable).map((f) => `${t.id}/${f.id}`)),
        );
        setAvailable(CHOICES.filter((c) => ready.has(`${c.target}/${c.format}`)));
      })
      .catch(() => setAvailable([]));
  }, []);

  return (
    <div className="menu-wrap">
      <button onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        Export ▾
      </button>
      {open && (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="menu" role="menu">
            {available === null && <div className="muted menu-item">불러오는 중…</div>}
            {available?.length === 0 && <div className="muted menu-item">사용 가능한 Export 대상이 없습니다</div>}
            {available?.map((choice) => (
              <button
                key={`${choice.target}/${choice.format}`}
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onChoose(choice);
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const LEVEL_HELP: Record<string, string> = {
  full: '대상 환경에서 거의 동일하게 재현됩니다.',
  partial: 'Export는 가능하지만 수동 설정이나 외부 연결이 필요합니다.',
  unsupported: '동일한 실행 의미를 보장하기 어렵습니다.',
  blocked: '지금은 Export할 수 없습니다. 아래 사유를 해결해 주세요.',
};

function describeExportError(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  const code = (err.details as { code?: string } | undefined)?.code;
  switch (code) {
    case 'EXPORT_DOCUMENT_NOT_ALLOWED':
      return 'Export가 허용되지 않은 Knowledge 문서가 있어 차단되었습니다. 워크스페이스 관리자가 허용하거나 Include Knowledge를 끄세요.';
    case 'EXPORT_SECRET_DETECTED':
      return 'Secret/민감값이 발견되어 Export가 차단되었습니다.';
    case 'EXPORT_ACK_REQUIRED':
      return '경고를 확인(체크)한 뒤 다시 시도하세요.';
    case 'EXPORT_COMPATIBILITY_UNSUPPORTED':
      return '이 대상에서는 Skill을 재현할 수 없어 Export가 차단되었습니다.';
    default:
      return `${err.message}${code ? ` (${code})` : ''}`;
  }
}

export function ExportDialog({
  skillId,
  choice,
  isDirty,
  onClose,
}: {
  skillId: string;
  choice: ExportChoice;
  /** The editor has unsaved changes — only SAVED Versions can be exported. */
  isDirty: boolean;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<SkillVersionRecord[] | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  const [format, setFormat] = useState<ExportFormatDescriptor | null>(null);
  const [docs, setDocs] = useState<DocumentRecord[]>([]);
  const [includeKnowledge, setIncludeKnowledge] = useState(false);
  const [includeChildSkills, setIncludeChildSkills] = useState(false);
  const [includeSourceSpec, setIncludeSourceSpec] = useState(false);

  const [compat, setCompat] = useState<ExportCompatibilityResponse | null>(null);
  const [compatError, setCompatError] = useState<string | null>(null);
  const [compatLoading, setCompatLoading] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  async function loadDocs() {
    try {
      setDocs((await api.listDocuments()).documents);
    } catch (err) {
      setDocError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    api
      .listSkillVersions(skillId)
      .then(({ versions }) => {
        setVersions(versions);
        setVersion(versions[0]?.version ?? null); // newest = the saved current Version, chosen explicitly
      })
      .catch((err) => setCompatError(err instanceof Error ? err.message : String(err)));
    api
      .getExportTargets()
      .then(({ targets }) =>
        setFormat(targets.find((t) => t.id === choice.target)?.formats.find((f) => f.id === choice.format) ?? null),
      )
      .catch((err) => setCompatError(err instanceof Error ? err.message : String(err)));
    loadDocs();
  }, [skillId, choice.target, choice.format]);

  const spec = useMemo(() => versions?.find((v) => v.version === version)?.spec ?? null, [versions, version]);
  const hasChildSkills = spec?.execution.steps.some((s) => s.type === 'skill') ?? false;
  const selectedDocIds = spec?.knowledge.mode === 'selected' ? spec.knowledge.documentIds : [];
  const skillDocs = docs.filter((d) => selectedDocIds.includes(d.id));
  const notAllowedDocs = skillDocs.filter((d) => !d.exportAllowed);
  const workspaceKnowledge = spec?.knowledge.mode === 'workspace';
  const knowledgeOption = Boolean(format?.embedsKnowledge) && skillDocs.length > 0;
  const knowledgeCheckboxDisabled = !knowledgeOption || notAllowedDocs.length > 0;

  // Re-run Compatibility whenever the version / options change. The server is the authority.
  useEffect(() => {
    if (version === null || !format) return;
    let cancelled = false;
    setCompatLoading(true);
    setCompatError(null);
    setAcknowledged(false);
    api
      .getExportCompatibility(skillId, {
        version,
        target: choice.target,
        format: choice.format,
        includeKnowledge: includeKnowledge && !knowledgeCheckboxDisabled,
        includeChildSkills: includeChildSkills && hasChildSkills && Boolean(format.embedsChildSkills),
        includeSourceSpec: includeSourceSpec && Boolean(format.embedsSourceSpec),
      })
      .then((result) => !cancelled && setCompat(result))
      .catch((err) => !cancelled && (setCompat(null), setCompatError(describeExportError(err))))
      .finally(() => !cancelled && setCompatLoading(false));
    return () => {
      cancelled = true;
    };
  }, [skillId, version, format, choice.target, choice.format, includeKnowledge, includeChildSkills, includeSourceSpec, knowledgeCheckboxDisabled, hasChildSkills]);

  const level = compat?.compatibility.level;
  const blocked = level === 'blocked' || (Boolean(format?.targetOptimized) && level === 'unsupported');
  const needsAcknowledgement = level === 'partial' || level === 'unsupported';
  const canExport = Boolean(compat) && !compatLoading && !blocked && (!needsAcknowledgement || acknowledged) && !exporting && version !== null;

  async function doExport() {
    if (version === null || !compat) return;
    setExporting(true);
    setExportError(null);
    setExported(null);
    try {
      const file = await api.exportSkill(skillId, {
        version,
        target: choice.target,
        format: choice.format,
        includeKnowledge: compat.effectiveOptions.includeKnowledge,
        includeChildSkills: compat.effectiveOptions.includeChildSkills,
        includeSourceSpec: compat.effectiveOptions.includeSourceSpec,
        acknowledgeWarnings: acknowledged,
      });
      const url = URL.createObjectURL(file.blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setExported(`${file.filename} (${file.level})`);
    } catch (err) {
      setExportError(describeExportError(err));
    } finally {
      setExporting(false);
    }
  }

  async function allowDocument(id: string) {
    setDocError(null);
    try {
      await api.setDocumentExportAllowed(id, true);
      await loadDocs(); // permission state changed → the Compatibility effect re-runs on its own
    } catch (err) {
      setDocError(
        err instanceof ApiError && err.code === 'forbidden'
          ? 'Export 허용은 워크스페이스 관리자만 변경할 수 있습니다.'
          : err instanceof Error
            ? err.message
            : String(err),
      );
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={`Export ${choice.label}`} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Export — {choice.label}</h2>
          <button onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        {isDirty && (
          <p className="muted" style={{ marginTop: 8 }}>
            저장하지 않은 변경은 포함되지 않습니다. 저장된 Version만 Export됩니다.
          </p>
        )}

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="export-version">Version</label>
          <select id="export-version" value={version ?? ''} onChange={(e) => setVersion(Number(e.target.value))} disabled={!versions}>
            {versions?.map((v) => (
              <option key={v.id} value={v.version}>
                v{v.version}
                {v.version === versions[0].version ? ' (current)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          {format?.embedsKnowledge && (
            <label className="check" title={knowledgeCheckboxDisabled ? '문서 포함 불가' : undefined}>
              <input
                type="checkbox"
                checked={includeKnowledge && !knowledgeCheckboxDisabled}
                disabled={knowledgeCheckboxDisabled}
                onChange={(e) => setIncludeKnowledge(e.target.checked)}
              />{' '}
              Include Knowledge
              {workspaceKnowledge && <span className="muted"> — workspace 전체 문서는 항상 References Only</span>}
              {!workspaceKnowledge && skillDocs.length === 0 && <span className="muted"> — 연결된 문서 없음</span>}
            </label>
          )}
          {format?.embedsChildSkills && hasChildSkills && (
            <label className="check">
              <input type="checkbox" checked={includeChildSkills} onChange={(e) => setIncludeChildSkills(e.target.checked)} /> Include Child Skills
            </label>
          )}
          {format?.embedsSourceSpec && (
            <label className="check">
              <input type="checkbox" checked={includeSourceSpec} onChange={(e) => setIncludeSourceSpec(e.target.checked)} /> Include source SkillSpec (내부 ID 포함)
            </label>
          )}
        </div>

        {skillDocs.length > 0 && format?.embedsKnowledge && (
          <div className="field">
            <label>Knowledge 문서 Export 권한</label>
            {skillDocs.map((doc) => (
              <div className="step-row row" key={doc.id} style={{ justifyContent: 'space-between' }}>
                <span>{doc.fileName}</span>
                {doc.exportAllowed ? (
                  <span className="badge full">Allowed</span>
                ) : (
                  <span className="row">
                    <span className="badge blocked">Not Allowed</span>
                    <button onClick={() => allowDocument(doc.id)}>Allow export</button>
                  </span>
                )}
              </div>
            ))}
            {notAllowedDocs.length > 0 && (
              <div className="error-box">
                Export가 허용되지 않은 문서가 {notAllowedDocs.length}개 있어 Include Knowledge를 사용할 수 없습니다. (허용은 워크스페이스 관리자만 가능)
              </div>
            )}
            {docError && <div className="error-box">{docError}</div>}
          </div>
        )}

        <div className="field">
          <label>Compatibility</label>
          {compatLoading && <p className="muted">분석 중…</p>}
          {compatError && <div className="error-box">{compatError}</div>}
          {compat && !compatLoading && (
            <div className="compat-panel" data-testid="compatibility">
              <div className="row">
                <span className={`badge ${compat.compatibility.level}`} data-testid="compat-level">
                  {compat.compatibility.level.toUpperCase()}
                </span>
                <span className="muted">{LEVEL_HELP[compat.compatibility.level]}</span>
              </div>

              {compat.blockers.length > 0 && (
                <div className="error-box" data-testid="blockers" style={{ marginTop: 8 }}>
                  {compat.blockers.map((b) => (
                    <div key={b.code}>
                      <strong>{b.code}</strong> — {b.message}
                      {b.findings.map((f) => (
                        <div key={`${f.path}:${f.category}`} className="muted">
                          · {f.path} ({f.category})
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              <dl className="kv">
                <dt>Required MCP</dt>
                <dd data-testid="required-mcp">
                  {compat.compatibility.summary.requiredMcp.length > 0
                    ? compat.compatibility.summary.requiredMcp.map((t) => <code key={t}>{t}</code>)
                    : <span className="muted">없음</span>}
                </dd>
                <dt>Knowledge</dt>
                <dd data-testid="knowledge-summary">
                  문서 {compat.compatibility.summary.knowledge.documents}개 · 포함 {compat.compatibility.summary.knowledge.included}개
                  {compat.compatibility.summary.knowledge.workspaceScope && ' · workspace 전체(References Only)'}
                </dd>
                <dt>Unsupported Capabilities</dt>
                <dd data-testid="unsupported-capabilities">
                  {compat.compatibility.summary.unsupportedCapabilities.length > 0
                    ? compat.compatibility.summary.unsupportedCapabilities.map((c) => (
                        <span key={c.id} className={`badge ${c.status}`} style={{ marginRight: 4 }}>
                          {c.label}
                        </span>
                      ))
                    : <span className="muted">없음</span>}
                </dd>
              </dl>

              {compat.compatibility.warnings.length > 0 && (
                <div data-testid="warnings">
                  <strong>Warnings</strong>
                  <ul>
                    {compat.compatibility.warnings.map((w, i) => (
                      <li key={`${w.code}-${i}`} className="warn">
                        {w.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {compat.compatibility.manualSteps.length > 0 && (
                <div data-testid="manual-steps">
                  <strong>필요한 수동 설정</strong>
                  <ul>
                    {compat.compatibility.manualSteps.map((s) => (
                      <li key={s}>{s}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {needsAcknowledgement && !blocked && compat && !compatLoading && (
          <label className="check">
            <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} /> 위 경고를 확인했으며 그대로 Export합니다
          </label>
        )}
        {format?.targetOptimized && level === 'unsupported' && (
          <div className="error-box">이 대상에서는 Skill을 재현할 수 없어 Export가 차단됩니다.</div>
        )}

        {exportError && <div className="error-box" style={{ marginTop: 8 }}>{exportError}</div>}
        {exported && <p style={{ color: 'var(--color-ok)' }}>다운로드됨: {exported}</p>}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button onClick={onClose}>닫기</button>
          <button className="primary" onClick={doExport} disabled={!canExport} data-testid="export-button">
            {exporting ? 'Export 중…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
