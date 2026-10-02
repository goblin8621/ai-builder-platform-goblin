'use client';

import { useState } from 'react';
import * as api from '../lib/api';
import type { SkillSpecV1 } from '../lib/types';
import type { RunResponse } from '../lib/api';
import { InputForm } from './InputForm';
import { ChatTestPanel } from './ChatTestPanel';

/** `run.error` is a loosely-typed `Record<string, unknown>` on the wire — these
 * pull out the two shapes BFF actually sends (see skill-run-service.ts):
 * `{ message: string }` always, plus `{ validationErrors: [...] }` only for
 * an Output Schema Validation failure. */
function runErrorMessage(error: Record<string, unknown> | null): string {
  if (error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}
function runErrorValidationErrors(
  error: Record<string, unknown> | null,
): { path: string; message: string }[] | null {
  const errors = error?.validationErrors;
  return Array.isArray(errors) ? (errors as { path: string; message: string }[]) : null;
}

/**
 * Preview | Debug (01번 5.). Preview always runs the Skill's currently
 * SAVED Version through the real `/skill-runs` endpoint — `mode: "preview"`
 * is the only difference from an ordinary Run, so there is no separate
 * Fake Runtime. Unsaved 구성/만들기 edits are not previewable until saved;
 * this is a direct consequence of Skill Version Pinning (a Run always
 * pins a persisted Version) rather than a shortcut taken here.
 */
export function PreviewDebugPanel({ skillId, spec }: { skillId: string; spec: SkillSpecV1 }) {
  const [tab, setTab] = useState<'preview' | 'chat' | 'debug'>('preview');
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const response = await api.createRun(skillId, input, 'preview');
      setResult(response);
      setTab('debug');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function act(action: 'approve' | 'reject' | 'cancel') {
    if (!result) return;
    setRunning(true);
    setError(null);
    try {
      const fn = action === 'approve' ? api.approveRun : action === 'reject' ? api.rejectRun : api.cancelRun;
      const response = await fn(result.run.id);
      setResult(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="card">
      <div className="tabs">
        <button className={tab === 'preview' ? 'active' : ''} onClick={() => setTab('preview')}>
          Preview
        </button>
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
          Chat
        </button>
        <button className={tab === 'debug' ? 'active' : ''} onClick={() => setTab('debug')}>
          Debug
        </button>
      </div>

      {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}

      {/* Always visible regardless of the active tab — a paused approval
          gate must be actionable whether the user is looking at Preview
          or Debug, not hidden behind a tab switch. */}
      {result?.pendingApproval && (
        <div className="card" style={{ marginBottom: 12, background: 'rgba(229,169,65,0.08)' }}>
          <p>
            승인 대기 중: <strong>{result.pendingApproval.stepId}</strong> ({result.pendingApproval.stepType})
          </p>
          <pre className="json">{JSON.stringify(result.pendingApproval.input, null, 2)}</pre>
          <div className="row">
            <button className="primary" onClick={() => act('approve')} disabled={running}>
              Approve
            </button>
            <button className="danger" onClick={() => act('reject')} disabled={running}>
              Reject
            </button>
            <button onClick={() => act('cancel')} disabled={running}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {tab === 'preview' && (
        <div>
          <InputForm schema={spec.inputSchema} value={input} onChange={setInput} />
          <button className="primary" onClick={run} disabled={running}>
            {running ? '실행 중…' : 'Run Skill (Preview)'}
          </button>

          {result && (
            <div style={{ marginTop: 16 }}>
              <div className="row">
                <span className={`badge ${result.run.status}`}>{result.run.status}</span>
                <span className="muted">v{result.run.skillVersionId.slice(0, 8)}</span>
              </div>

              {result.run.output && (
                <>
                  <label style={{ marginTop: 12 }}>Output</label>
                  <pre className="json">{JSON.stringify(result.run.output, null, 2)}</pre>
                </>
              )}
              {result.run.error && (
                <div className="error-box" style={{ marginTop: 8 }}>
                  {JSON.stringify(result.run.error)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'chat' && <ChatTestPanel skillId={skillId} spec={spec} />}

      {tab === 'debug' && (
        <div>
          {!result && <p className="muted">아직 실행된 Run이 없습니다. Preview에서 먼저 실행하세요.</p>}
          {result && (
            <>
              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
                <tbody>
                  <tr>
                    <td className="muted">Run ID</td>
                    <td>{result.run.id}</td>
                  </tr>
                  <tr>
                    <td className="muted">Status</td>
                    <td>
                      <span className={`badge ${result.run.status}`}>{result.run.status}</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Mode</td>
                    <td>{result.run.mode}</td>
                  </tr>
                  <tr>
                    <td className="muted">Started</td>
                    <td>{result.run.startedAt}</td>
                  </tr>
                  <tr>
                    <td className="muted">Completed</td>
                    <td>{result.run.completedAt ?? '-'}</td>
                  </tr>
                </tbody>
              </table>

              {/* Run-level Output/Error — separate from per-Step output/error
                  below. Matters most for an Output Schema Validation
                  failure: the failing Step can show status=completed (the
                  Step itself succeeded) while the *Run* is still failed
                  because its combined Output didn't match outputSchema —
                  that distinction (Builder outputSchema quality vs. a real
                  Runtime Contract violation) is only visible here (P8
                  사용자 결정 #3). Previously only rendered in the Preview
                  tab, which `run()` immediately switches away from. */}
              {result.run.output != null && (
                <>
                  <label>Run Output</label>
                  <pre className="json">{JSON.stringify(result.run.output, null, 2)}</pre>
                </>
              )}
              {result.run.error != null && (
                <div className="error-box" style={{ marginBottom: 12 }}>
                  <div>{runErrorMessage(result.run.error)}</div>
                  {runErrorValidationErrors(result.run.error) && (
                    <table style={{ width: '100%', marginTop: 8, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <td className="muted">path</td>
                          <td className="muted">message</td>
                        </tr>
                      </thead>
                      <tbody>
                        {runErrorValidationErrors(result.run.error)!.map((e, i) => (
                          <tr key={i}>
                            <td>{e.path}</td>
                            <td>{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
              {runErrorValidationErrors(result.run.error) && (
                <details style={{ marginBottom: 12 }}>
                  <summary className="muted">Expected Output Schema</summary>
                  <pre className="json">{JSON.stringify(spec.outputSchema, null, 2)}</pre>
                </details>
              )}

              <label>Steps</label>
              {result.steps.map((step) => (
                <div className="step-row" key={step.id}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <strong>
                      {step.stepId} <span className="muted">({step.stepType})</span>
                    </strong>
                    <span className={`badge ${step.status}`}>{step.status}</span>
                  </div>
                  <div className="muted">attempt {step.attempt}</div>
                  {step.output && <pre className="json">{JSON.stringify(step.output, null, 2)}</pre>}
                  {step.error && <div className="error-box">{JSON.stringify(step.error)}</div>}
                </div>
              ))}

              {result.childRuns && result.childRuns.length > 0 && (
                <>
                  <label>Child Runs (Nested Skill)</label>
                  {result.childRuns.map((child) => (
                    <div className="step-row" key={child.id}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span>{child.skillId}</span>
                        <span className={`badge ${child.status}`}>{child.status}</span>
                      </div>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
