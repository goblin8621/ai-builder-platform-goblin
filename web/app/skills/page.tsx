'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as api from '../../lib/api';
import type { SkillRecord } from '../../lib/types';

export default function MySkillsPage() {
  const router = useRouter();
  const [skills, setSkills] = useState<SkillRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [building, setBuilding] = useState(false);
  const [clarifyMessage, setClarifyMessage] = useState<string | null>(null);

  async function refresh() {
    try {
      const { skills } = await api.listSkills();
      setSkills(skills);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleBuild() {
    if (!request.trim()) return;
    setBuilding(true);
    setClarifyMessage(null);
    setError(null);
    try {
      const result = await api.buildSkill(request);
      if (result.action === 'clarify') {
        setClarifyMessage(result.message ?? '추가 정보가 필요합니다.');
        return;
      }
      router.push(`/skills/${result.skill.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  }

  async function handleActivate(id: string) {
    await api.activateSkill(id);
    refresh();
  }

  async function handleDuplicate(id: string) {
    const { skill } = await api.duplicateSkill(id);
    router.push(`/skills/${skill.id}`);
  }

  async function handleDelete(id: string) {
    if (!confirm('이 Skill을 보관(삭제) 처리할까요?')) return;
    await api.deleteSkill(id);
    refresh();
  }

  return (
    <main style={{ padding: '20px', maxWidth: 900, margin: '0 auto' }}>
      <div className="card" style={{ marginBottom: 20 }}>
        <label>자연어로 새 Skill 만들기</label>
        <div className="row">
          <textarea
            rows={2}
            placeholder='예: "입력받은 한국어 문장을 자연스러운 영어로 번역하는 Skill 만들어줘"'
            value={request}
            onChange={(e) => setRequest(e.target.value)}
          />
          <button className="primary" onClick={handleBuild} disabled={building || !request.trim()}>
            {building ? '생성 중…' : '만들기'}
          </button>
        </div>
        {clarifyMessage && <p className="muted">Builder: {clarifyMessage}</p>}
      </div>

      {error && <div className="error-box" style={{ marginBottom: 16 }}>{error}</div>}

      <h2 style={{ fontSize: 16 }}>My Skills</h2>
      {skills === null && <p className="muted">불러오는 중…</p>}
      {skills?.length === 0 && <p className="muted">아직 Skill이 없습니다. 위에서 자연어로 만들어보세요.</p>}

      <div className="skill-grid">
        {skills?.map((skill) => (
          <div key={skill.id} className="skill-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className={`badge ${skill.status}`}>{skill.status}</span>
              <span className="muted">v{skill.currentVersion}</span>
            </div>
            <a href={`/skills/${skill.id}`} className="skill-card-title">
              {skill.name}
            </a>
            <div className="muted" style={{ fontSize: 11 }}>
              {skill.skillType}
            </div>
            <div className="skill-card-desc">{skill.description}</div>
            <div className="skill-card-actions">
              {skill.status !== 'active' && <button onClick={() => handleActivate(skill.id)}>Activate</button>}
              <button onClick={() => handleDuplicate(skill.id)}>Duplicate</button>
              <button className="danger" onClick={() => handleDelete(skill.id)}>
                Archive
              </button>
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
