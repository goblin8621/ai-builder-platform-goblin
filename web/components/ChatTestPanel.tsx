'use client';

import { useEffect, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { SkillSpecV1 } from '../lib/types';
import type { RunResponse } from '../lib/api';

type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'error'; content: string }
  | { role: 'approval'; runId: string; stepId: string; stepType: string; input: Record<string, unknown> };

/**
 * Chat mode only works when the Skill has exactly one meaningful input
 * field to type a message into. Multi-field Skills (e.g. CSV analysis,
 * structured deployment input) stay on the Preview tab's auto-generated
 * form — this deliberately does not try to be a general-purpose multi-turn
 * wizard.
 */
function findPrimaryField(schema: Record<string, unknown>): string | null {
  const properties = (schema.properties as Record<string, { type?: string }> | undefined) ?? {};
  const keys = Object.keys(properties);
  if (keys.length !== 1) return null;
  return properties[keys[0]]?.type === 'string' ? keys[0] : null;
}

function extractReply(output: Record<string, unknown> | null): string {
  if (!output) return '(빈 응답)';
  const values = Object.values(output);
  if (values.length === 1 && typeof values[0] === 'string') return values[0];
  return JSON.stringify(output, null, 2);
}

function runErrorText(error: Record<string, unknown> | null): string {
  if (error && typeof error.message === 'string') return error.message;
  return JSON.stringify(error);
}

/**
 * Chat-style testing surface — a thin UI convenience over the exact same
 * `/skill-runs` Runtime path Preview uses (`mode: "preview"`), not a
 * separate conversational engine. Each message is its own independent Run:
 * Skills are stateless single-shot units (00번/09번 원칙), so there is no
 * cross-turn memory/context threaded between messages — only the chat
 * transcript itself is kept, client-side, for readability.
 */
export function ChatTestPanel({ skillId, spec }: { skillId: string; spec: SkillSpecV1 }) {
  const primaryField = findPrimaryField(spec.inputSchema);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, sending]);

  async function handleResult(response: RunResponse) {
    if (response.pendingApproval) {
      setMessages((m) => [
        ...m,
        {
          role: 'approval',
          runId: response.run.id,
          stepId: response.pendingApproval!.stepId,
          stepType: response.pendingApproval!.stepType,
          input: response.pendingApproval!.input,
        },
      ]);
      return;
    }
    if (response.run.status === 'failed') {
      setMessages((m) => [...m, { role: 'error', content: runErrorText(response.run.error) }]);
      return;
    }
    setMessages((m) => [...m, { role: 'assistant', content: extractReply(response.run.output) }]);
  }

  async function send() {
    if (!input.trim() || !primaryField || sending) return;
    const text = input.trim();
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setInput('');
    setSending(true);
    try {
      const response = await api.createRun(skillId, { [primaryField]: text }, 'preview');
      await handleResult(response);
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', content: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setSending(false);
    }
  }

  async function act(runId: string, action: 'approve' | 'reject' | 'cancel') {
    setSending(true);
    try {
      const fn = action === 'approve' ? api.approveRun : action === 'reject' ? api.rejectRun : api.cancelRun;
      const response = await fn(runId);
      setMessages((m) => m.filter((msg) => !(msg.role === 'approval' && msg.runId === runId)));
      await handleResult(response);
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', content: err instanceof Error ? err.message : String(err) }]);
    } finally {
      setSending(false);
    }
  }

  if (!primaryField) {
    return (
      <p className="muted">
        이 Skill은 입력 필드가 없거나 여러 개(또는 문자열이 아닌 필드)라 Chat 테스트를 지원하지 않습니다. Preview 탭을
        사용하세요.
      </p>
    );
  }

  return (
    <div>
      <div className="chat-log" ref={logRef}>
        {messages.length === 0 && <p className="muted">메시지를 입력해 이 Skill과 대화해보세요.</p>}
        {messages.map((msg, i) => {
          if (msg.role === 'approval') {
            return (
              <div className="chat-bubble approval" key={i}>
                <p>
                  승인 대기 중: <strong>{msg.stepId}</strong> ({msg.stepType})
                </p>
                <pre className="json">{JSON.stringify(msg.input, null, 2)}</pre>
                <div className="row">
                  <button className="primary" onClick={() => act(msg.runId, 'approve')} disabled={sending}>
                    Approve
                  </button>
                  <button className="danger" onClick={() => act(msg.runId, 'reject')} disabled={sending}>
                    Reject
                  </button>
                  <button onClick={() => act(msg.runId, 'cancel')} disabled={sending}>
                    Cancel
                  </button>
                </div>
              </div>
            );
          }
          return (
            <div className={`chat-bubble ${msg.role}`} key={i}>
              {msg.content}
            </div>
          );
        })}
        {sending && <div className="chat-bubble assistant muted">…</div>}
      </div>
      <div className="chat-input-row">
        <textarea
          rows={2}
          placeholder={`${primaryField} 입력… (Enter로 전송, Shift+Enter로 줄바꿈)`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="primary" onClick={send} disabled={sending || !input.trim()}>
          전송
        </button>
      </div>
    </div>
  );
}
