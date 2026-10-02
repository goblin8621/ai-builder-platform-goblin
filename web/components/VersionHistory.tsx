'use client';

import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { SkillVersionRecord } from '../lib/types';

export function VersionHistory({ skillId, onRestored }: { skillId: string; onRestored: () => void }) {
  const [versions, setVersions] = useState<SkillVersionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const { versions } = await api.listSkillVersions(skillId);
      setVersions(versions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillId]);

  async function restore(version: number) {
    if (!confirm(`v${version}을 복원할까요? (기존 Version을 덮어쓰지 않고 새 Version이 생성됩니다)`)) return;
    await api.restoreSkillVersion(skillId, version);
    await refresh();
    onRestored();
  }

  if (error) return <div className="error-box">{error}</div>;
  if (!versions) return <p className="muted">불러오는 중…</p>;

  return (
    <div>
      {versions.map((v) => (
        <div className="step-row" key={v.id}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong>v{v.version}</strong> <span className="muted">({v.changeSource})</span>
              {v.changeSummary && <div className="muted">{v.changeSummary}</div>}
              <div className="muted">{new Date(v.createdAt).toLocaleString()}</div>
            </div>
            <button onClick={() => restore(v.version)}>Restore</button>
          </div>
        </div>
      ))}
    </div>
  );
}
