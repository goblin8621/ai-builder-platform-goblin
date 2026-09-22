/**
 * Minimal structured logger. Every log line carries requestId when available
 * so BFF <-> Brain calls can be correlated (see 05번 문서 Correlation ID 원칙).
 */

type LogFields = Record<string, unknown> & { requestId?: string };

function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: LogFields) {
  const line = {
    level,
    msg,
    time: new Date().toISOString(),
    ...fields,
  };
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(JSON.stringify(line));
}

export const logger = {
  info: (msg: string, fields?: LogFields) => emit('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => emit('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => emit('error', msg, fields),
};
