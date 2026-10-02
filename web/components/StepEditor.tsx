'use client';

import type { SkillStep } from '../lib/types';
import { JsonField } from './JsonField';

const STEP_TYPES: SkillStep['type'][] = ['llm', 'tool', 'knowledge', 'skill', 'transform', 'condition'];
const ERROR_ACTIONS: NonNullable<SkillStep['onError']>['action'][] = ['fail', 'retry', 'skip', 'fallback'];

export function StepEditor({
  step,
  allStepIds,
  onChange,
  onRemove,
}: {
  step: SkillStep;
  allStepIds: string[];
  onChange: (step: SkillStep) => void;
  onRemove: () => void;
}) {
  return (
    <div className="step-row">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row" style={{ flex: 1 }}>
          <input
            type="text"
            value={step.id}
            placeholder="step id"
            style={{ maxWidth: 140 }}
            onChange={(e) => onChange({ ...step, id: e.target.value })}
          />
          <input
            type="text"
            value={step.name}
            placeholder="Step name"
            onChange={(e) => onChange({ ...step, name: e.target.value })}
          />
          <select value={step.type} onChange={(e) => onChange({ ...step, type: e.target.value as SkillStep['type'] })}>
            {STEP_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <button className="danger" onClick={onRemove}>
          삭제
        </button>
      </div>

      {(step.type === 'tool' || step.type === 'skill') && (
        <div className="field">
          <label>{step.type === 'tool' ? 'Tool refId' : 'Child Skill id (refId)'}</label>
          <input type="text" value={step.refId ?? ''} onChange={(e) => onChange({ ...step, refId: e.target.value })} />
        </div>
      )}

      <div className="row">
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0 }}>
          <input
            type="checkbox"
            checked={step.approvalRequired ?? false}
            onChange={(e) => onChange({ ...step, approvalRequired: e.target.checked })}
          />
          승인 필요 (approvalRequired)
        </label>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>실패 시 (onError.action)</label>
          <select
            value={step.onError?.action ?? 'fail'}
            onChange={(e) =>
              onChange({
                ...step,
                onError: { ...step.onError, action: e.target.value as NonNullable<SkillStep['onError']>['action'] },
              })
            }
          >
            {ERROR_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        {step.onError?.action === 'retry' && (
          <div className="field" style={{ flex: 1 }}>
            <label>retryCount</label>
            <input
              type="number"
              value={step.onError?.retryCount ?? 1}
              onChange={(e) =>
                onChange({ ...step, onError: { ...step.onError!, retryCount: Number(e.target.value) } })
              }
            />
          </div>
        )}
        {step.onError?.action === 'fallback' && (
          <div className="field" style={{ flex: 1 }}>
            <label>fallbackStepId</label>
            <select
              value={step.onError?.fallbackStepId ?? ''}
              onChange={(e) => onChange({ ...step, onError: { ...step.onError!, fallbackStepId: e.target.value } })}
            >
              <option value="">(선택)</option>
              {allStepIds
                .filter((id) => id !== step.id)
                .map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
            </select>
          </div>
        )}
      </div>

      <JsonField label="inputMap" value={step.inputMap ?? {}} onChange={(v) => onChange({ ...step, inputMap: v as Record<string, unknown> })} rows={3} />
    </div>
  );
}
