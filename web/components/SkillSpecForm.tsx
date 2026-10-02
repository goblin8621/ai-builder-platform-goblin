'use client';

import { useEffect, useState } from 'react';
import * as api from '../lib/api';
import type { CapabilityFlags, ModelDescriptor, SkillSpecV1, SkillStep } from '../lib/types';
import { JsonField } from './JsonField';
import { StepEditor } from './StepEditor';

const CAPABILITY_KEYS: (keyof CapabilityFlags)[] = [
  'webSearch',
  'imageGeneration',
  'codeExecution',
  'dataAnalysis',
  'fileAnalysis',
  'knowledgeSearch',
  'mcp',
];

let stepCounter = 0;
function nextStepId() {
  stepCounter += 1;
  return `step-${stepCounter}`;
}

/**
 * "구성" tab (01번): direct Skill Spec editing. `inputSchema`/`outputSchema`
 * and each Step's `inputMap`/`execution.outputMap` are edited as raw JSON
 * (JsonField) rather than a fully visual schema/mapping builder — a
 * deliberate Phase 7 scoping choice to ship a complete-enough editor for
 * every field 01번 lists, without building a JSON-Schema-aware visual
 * editor (a substantial project on its own).
 */
export function SkillSpecForm({
  spec,
  onChange,
}: {
  spec: SkillSpecV1;
  onChange: (spec: SkillSpecV1) => void;
}) {
  const [supportedCapabilities, setSupportedCapabilities] = useState<Record<string, boolean> | null>(null);
  const [models, setModels] = useState<ModelDescriptor[]>([]);

  useEffect(() => {
    api.getCapabilities().then((r) => setSupportedCapabilities(r.capabilities)).catch(() => setSupportedCapabilities({}));
    api.listModels().then((r) => setModels(r.models)).catch(() => setModels([]));
  }, []);

  function set<K extends keyof SkillSpecV1>(key: K, value: SkillSpecV1[K]) {
    onChange({ ...spec, [key]: value });
  }

  function addStep() {
    set('execution', {
      ...spec.execution,
      steps: [...spec.execution.steps, { id: nextStepId(), name: 'New step', type: 'llm' }],
    });
  }

  function updateStep(index: number, step: SkillStep) {
    const steps = [...spec.execution.steps];
    steps[index] = step;
    set('execution', { ...spec.execution, steps });
  }

  function removeStep(index: number) {
    const steps = spec.execution.steps.filter((_, i) => i !== index);
    set('execution', { ...spec.execution, steps });
  }

  return (
    <div>
      <div className="field">
        <label>Name</label>
        <input type="text" value={spec.name} onChange={(e) => set('name', e.target.value)} />
      </div>

      <div className="field">
        <label>Description</label>
        <textarea rows={2} value={spec.description} onChange={(e) => set('description', e.target.value)} />
      </div>

      <div className="field">
        <label>Skill Type</label>
        <select value={spec.skillType} onChange={(e) => set('skillType', e.target.value as SkillSpecV1['skillType'])}>
          {(['prompt', 'knowledge', 'tool', 'workflow', 'composite'] as const).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Instructions — objective</label>
        <textarea
          rows={2}
          value={spec.instructions.objective}
          onChange={(e) => set('instructions', { ...spec.instructions, objective: e.target.value })}
        />
      </div>
      <div className="field">
        <label>Instructions — rules (한 줄에 하나씩)</label>
        <textarea
          rows={3}
          value={spec.instructions.rules.join('\n')}
          onChange={(e) =>
            set('instructions', { ...spec.instructions, rules: e.target.value.split('\n').filter(Boolean) })
          }
        />
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Model mode</label>
          <select
            value={spec.model.mode}
            onChange={(e) => set('model', { ...spec.model, mode: e.target.value as SkillSpecV1['model']['mode'] })}
          >
            <option value="user">user</option>
            <option value="recommended">recommended</option>
            <option value="fixed">fixed</option>
          </select>
        </div>
        {spec.model.mode !== 'user' && (
          <div className="field" style={{ flex: 1 }}>
            <label>modelId</label>
            <select value={spec.model.modelId ?? ''} onChange={(e) => set('model', { ...spec.model, modelId: e.target.value })}>
              <option value="">(선택)</option>
              {models.map((m) => (
                <option key={m.modelId} value={m.modelId}>
                  {m.displayName} ({m.modelId})
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field" style={{ flex: 1 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              checked={spec.model.allowUserOverride}
              onChange={(e) => set('model', { ...spec.model, allowUserOverride: e.target.checked })}
            />
            allowUserOverride
          </label>
        </div>
      </div>

      <div className="field">
        <label>Capabilities (서버 미지원 항목은 선택 불가)</label>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {CAPABILITY_KEYS.map((key) => {
            const supported = supportedCapabilities?.[key] ?? false;
            return (
              <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, margin: 0, opacity: supported ? 1 : 0.4 }}>
                <input
                  type="checkbox"
                  checked={spec.capabilities[key]}
                  disabled={!supported}
                  onChange={(e) => set('capabilities', { ...spec.capabilities, [key]: e.target.checked })}
                />
                {key}
              </label>
            );
          })}
        </div>
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Knowledge mode</label>
          <select
            value={spec.knowledge.mode}
            onChange={(e) => set('knowledge', { ...spec.knowledge, mode: e.target.value as SkillSpecV1['knowledge']['mode'] })}
          >
            <option value="none">none</option>
            <option value="workspace">workspace</option>
            <option value="selected">selected</option>
          </select>
        </div>
        {spec.knowledge.mode === 'selected' && (
          <div className="field" style={{ flex: 2 }}>
            <label>documentIds (쉼표로 구분)</label>
            <input
              type="text"
              value={spec.knowledge.documentIds.join(',')}
              onChange={(e) =>
                set('knowledge', {
                  ...spec.knowledge,
                  documentIds: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
            />
          </div>
        )}
      </div>

      <JsonField label="Input Schema" value={spec.inputSchema} onChange={(v) => set('inputSchema', v as Record<string, unknown>)} />
      <JsonField label="Output Schema" value={spec.outputSchema} onChange={(v) => set('outputSchema', v as Record<string, unknown>)} />

      <div className="field">
        <label>Execution Steps</label>
        {spec.execution.steps.map((step, index) => (
          <StepEditor
            key={index}
            step={step}
            allStepIds={spec.execution.steps.map((s) => s.id)}
            onChange={(s) => updateStep(index, s)}
            onRemove={() => removeStep(index)}
          />
        ))}
        <button onClick={addStep}>+ Step 추가</button>
      </div>

      <JsonField
        label="execution.outputMap (선택)"
        value={spec.execution.outputMap ?? {}}
        onChange={(v) => set('execution', { ...spec.execution, outputMap: v as Record<string, unknown> })}
        rows={3}
      />

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>timeoutSec</label>
          <input
            type="number"
            value={spec.runtime.timeoutSec}
            onChange={(e) => set('runtime', { ...spec.runtime, timeoutSec: Number(e.target.value) })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>retryCount</label>
          <input
            type="number"
            value={spec.runtime.retryCount}
            onChange={(e) => set('runtime', { ...spec.runtime, retryCount: Number(e.target.value) })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>maxToolCalls</label>
          <input
            type="number"
            value={spec.runtime.maxToolCalls}
            onChange={(e) => set('runtime', { ...spec.runtime, maxToolCalls: Number(e.target.value) })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>maxNestedSkillDepth</label>
          <input
            type="number"
            value={spec.runtime.maxNestedSkillDepth}
            onChange={(e) => set('runtime', { ...spec.runtime, maxNestedSkillDepth: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="field">
        <label>Guardrails (한 줄에 하나씩)</label>
        <textarea
          rows={2}
          value={spec.guardrails.join('\n')}
          onChange={(e) => set('guardrails', e.target.value.split('\n').filter(Boolean))}
        />
      </div>

      <div className="row">
        <div className="field" style={{ flex: 1 }}>
          <label>Category</label>
          <input
            type="text"
            value={spec.metadata.category}
            onChange={(e) => set('metadata', { ...spec.metadata, category: e.target.value })}
          />
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Tags (쉼표로 구분)</label>
          <input
            type="text"
            value={spec.metadata.tags.join(',')}
            onChange={(e) =>
              set('metadata', { ...spec.metadata, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
            }
          />
        </div>
      </div>
    </div>
  );
}
