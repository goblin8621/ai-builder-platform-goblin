'use client';

import { JsonField } from './JsonField';

type JsonSchemaProp = { type?: string; [key: string]: unknown };

/**
 * Auto-generates a Form from a Skill's `inputSchema` (01번: "Input Schema
 * 기반 입력 Form 자동 생성"). Simple property types (string/number/boolean)
 * get a native input; anything else (object/array/unknown) falls back to
 * a JSON textarea — a pragmatic Phase 7 scope limit rather than a full
 * JSON-Schema-driven form generator.
 */
export function InputForm({
  schema,
  value,
  onChange,
}: {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
}) {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchemaProp>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const keys = Object.keys(properties);

  if (keys.length === 0) {
    return <JsonField label="Input (raw JSON — inputSchema에 properties가 없음)" value={value} onChange={(v) => onChange(v as Record<string, unknown>)} />;
  }

  function setField(key: string, fieldValue: unknown) {
    onChange({ ...value, [key]: fieldValue });
  }

  return (
    <div>
      {keys.map((key) => {
        const prop = properties[key];
        const label = `${key}${required.has(key) ? ' *' : ''}`;
        const current = value[key];

        if (prop.type === 'string') {
          return (
            <div className="field" key={key}>
              <label>{label}</label>
              <input type="text" value={(current as string) ?? ''} onChange={(e) => setField(key, e.target.value)} />
            </div>
          );
        }
        if (prop.type === 'number' || prop.type === 'integer') {
          return (
            <div className="field" key={key}>
              <label>{label}</label>
              <input
                type="number"
                value={(current as number) ?? ''}
                onChange={(e) => setField(key, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            </div>
          );
        }
        if (prop.type === 'boolean') {
          return (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <input type="checkbox" checked={Boolean(current)} onChange={(e) => setField(key, e.target.checked)} />
              {label}
            </label>
          );
        }
        return (
          <JsonField key={key} label={label} value={current ?? null} onChange={(v) => setField(key, v)} rows={2} />
        );
      })}
    </div>
  );
}
