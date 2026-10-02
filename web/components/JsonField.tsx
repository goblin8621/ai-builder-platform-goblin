'use client';

import { useEffect, useState } from 'react';

/**
 * A textarea that holds raw JSON text, only parsing (and reporting errors)
 * on blur — typing invalid intermediate JSON while editing must not crash
 * the form. `onChange` fires with the parsed value only when it's valid.
 */
export function JsonField({
  label,
  value,
  onChange,
  rows = 4,
}: {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  rows?: number;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
  }, [value]);

  function handleBlur() {
    try {
      const parsed = JSON.parse(text);
      setError(null);
      onChange(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'invalid JSON');
    }
  }

  return (
    <div className="field">
      <label>{label} (JSON)</label>
      <textarea rows={rows} value={text} onChange={(e) => setText(e.target.value)} onBlur={handleBlur} />
      {error && <div className="error-box" style={{ marginTop: 4 }}>{error}</div>}
    </div>
  );
}
