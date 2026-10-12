'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import * as api from '../../../lib/api';
import { ApiError } from '../../../lib/api';
import type { SkillRecord, SkillSpecV1 } from '../../../lib/types';
import { SkillSpecForm } from '../../../components/SkillSpecForm';
import { PreviewDebugPanel } from '../../../components/PreviewDebugPanel';
import { VersionHistory } from '../../../components/VersionHistory';
import { ExportDialog, ExportMenu, type ExportChoice } from '../../../components/ExportDialog';

type LeftTab = 'build' | 'configure' | 'history';

export default function SkillWorkspacePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const skillId = params.id;

  const [skill, setSkill] = useState<SkillRecord | null>(null);
  const [expectedVersion, setExpectedVersion] = useState<number | null>(null);
  const [savedSpec, setSavedSpec] = useState<SkillSpecV1 | null>(null);
  const [draftSpec, setDraftSpec] = useState<SkillSpecV1 | null>(null);
  const [leftTab, setLeftTab] = useState<LeftTab>('build');
  const [error, setError] = useState<string | null>(null);

  const [refineRequest, setRefineRequest] = useState('');
  const [refining, setRefining] = useState(false);
  const [clarifyMessage, setClarifyMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportChoice, setExportChoice] = useState<ExportChoice | null>(null);

  async function load() {
    try {
      const { skill, version } = await api.getSkill(skillId);
      setSkill(skill);
      setExpectedVersion(skill.currentVersion);
      setSavedSpec(version.spec);
      setDraftSpec(version.spec);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId]);

  async function handleRefine() {
    if (!refineRequest.trim() || expectedVersion === null) return;
    setRefining(true);
    setClarifyMessage(null);
    setError(null);
    try {
      const result = await api.refineSkill(skillId, expectedVersion, refineRequest);
      if (result.action === 'clarify') {
        setClarifyMessage(result.message ?? '추가 정보가 필요합니다.');
        return;
      }
      setSkill(result.skill);
      setExpectedVersion(result.skill.currentVersion);
      setSavedSpec(result.version.spec);
      setDraftSpec(result.version.spec);
      setRefineRequest('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        setError('다른 곳에서 이미 수정되었습니다. 최신 내용을 다시 불러옵니다.');
        await load();
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRefining(false);
    }
  }

  async function handleSaveConfigure() {
    if (!draftSpec || expectedVersion === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.updateSkill(skillId, expectedVersion, draftSpec);
      setSkill(result.skill);
      setExpectedVersion(result.skill.currentVersion);
      setSavedSpec(result.version.spec);
      setDraftSpec(result.version.spec);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'version_conflict') {
        setError('다른 곳에서 이미 수정되었습니다. 최신 내용을 다시 불러옵니다.');
        await load();
      } else if (err instanceof ApiError && err.code === 'validation_error') {
        setError(`검증 실패: ${JSON.stringify(err.details ?? {}, null, 2)}`);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate() {
    const { skill } = await api.activateSkill(skillId);
    setSkill(skill);
  }

  if (error && !skill) {
    return (
      <main style={{ padding: 20 }}>
        <div className="error-box">{error}</div>
        <button onClick={() => router.push('/skills')} style={{ marginTop: 12 }}>
          ← My Skills
        </button>
      </main>
    );
  }

  if (!skill || !draftSpec || !savedSpec) {
    return (
      <main style={{ padding: 20 }}>
        <p className="muted">불러오는 중…</p>
      </main>
    );
  }

  const isDirty = JSON.stringify(draftSpec) !== JSON.stringify(savedSpec);

  return (
    <main>
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <button onClick={() => router.push('/skills')}>← My Skills</button>
            <strong style={{ marginLeft: 12 }}>{skill.name}</strong>
            <span className={`badge ${skill.status}`} style={{ marginLeft: 8 }}>
              {skill.status}
            </span>
            <span className="muted" style={{ marginLeft: 8 }}>
              v{skill.currentVersion}
            </span>
          </div>
          <div className="row">
            <ExportMenu onChoose={setExportChoice} />
            {skill.status !== 'active' && <button onClick={handleActivate}>Activate</button>}
          </div>
        </div>
      </div>

      {error && (
        <div className="error-box" style={{ margin: '12px 20px', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}

      <div className="workspace-grid">
        <div className="card">
          <div className="tabs">
            <button className={leftTab === 'build' ? 'active' : ''} onClick={() => setLeftTab('build')}>
              만들기
            </button>
            <button className={leftTab === 'configure' ? 'active' : ''} onClick={() => setLeftTab('configure')}>
              구성
            </button>
            <button className={leftTab === 'history' ? 'active' : ''} onClick={() => setLeftTab('history')}>
              Version History
            </button>
          </div>

          {leftTab === 'build' && (
            <div>
              <label>자연어로 수정 요청</label>
              <textarea
                rows={3}
                placeholder='예: "이상치 탐지 후 그래프도 생성하도록 바꿔줘"'
                value={refineRequest}
                onChange={(e) => setRefineRequest(e.target.value)}
              />
              <button className="primary" onClick={handleRefine} disabled={refining || !refineRequest.trim()}>
                {refining ? '수정 중…' : '수정 요청'}
              </button>
              {clarifyMessage && <p className="muted">Builder: {clarifyMessage}</p>}
              <p className="muted" style={{ marginTop: 12 }}>
                수정 결과는 새 Version으로 저장되며 "구성" 탭에 즉시 반영됩니다.
              </p>
            </div>
          )}

          {leftTab === 'configure' && (
            <div>
              {isDirty && <p className="muted">저장되지 않은 변경사항이 있습니다.</p>}
              <SkillSpecForm spec={draftSpec} onChange={setDraftSpec} />
              <button className="primary" onClick={handleSaveConfigure} disabled={saving || !isDirty}>
                {saving ? '저장 중…' : '저장'}
              </button>
            </div>
          )}

          {leftTab === 'history' && <VersionHistory skillId={skillId} onRestored={load} />}
        </div>

        <PreviewDebugPanel skillId={skillId} spec={savedSpec} />
      </div>

      {exportChoice && (
        <ExportDialog skillId={skillId} choice={exportChoice} isDirty={isDirty} onClose={() => setExportChoice(null)} />
      )}
    </main>
  );
}
