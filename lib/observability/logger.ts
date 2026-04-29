/**
 * Structured trace logger.
 *
 * Emits newline-delimited JSON (NDJSON) log events to the configured transport.
 * Defaults to console.log, which is captured by Vercel, Datadog, and most
 * cloud log aggregators via stdout forwarding.
 *
 * To route traces to a dedicated sink (e.g., a /api/ingest endpoint,
 * Datadog HTTP intake, or BigQuery streaming insert), replace the default
 * transport via configureLogger().
 *
 * Log format:
 * {
 *   "event": "reading.completed",
 *   "timestamp": "2025-01-01T00:00:00.000Z",
 *   "trace": { ...ReadingTrace }
 * }
 */

import { ReadingTrace, TraceLogEvent } from './types';

// ---------------------------------------------------------------------------
// Transport interface
// ---------------------------------------------------------------------------

export type LogTransport = (event: TraceLogEvent) => Promise<void>;

/** Default: write structured JSON to console.log (captured by cloud log sinks) */
const consoleTransport: LogTransport = async (event) => {
  console.log(JSON.stringify(event));
};

let activeTransport: LogTransport = consoleTransport;

/**
 * Override the log transport. Call once at application startup.
 * Useful in tests (to capture instead of logging) and in production
 * (to route to a dedicated analytics endpoint).
 *
 * @example
 * configureLogger(async (event) => {
 *   await fetch('/api/ingest', {
 *     method: 'POST',
 *     body: JSON.stringify(event),
 *     headers: { 'Content-Type': 'application/json' },
 *   });
 * });
 */
export function configureLogger(transport: LogTransport): void {
  activeTransport = transport;
}

// ---------------------------------------------------------------------------
// Flush function — called by ReadingTracer.flush()
// ---------------------------------------------------------------------------

export async function flushTrace(trace: ReadingTrace): Promise<void> {
  const event: TraceLogEvent = {
    event: trace.completed ? 'reading.completed' : 'reading.failed',
    timestamp: new Date().toISOString(),
    trace,
  };

  try {
    await activeTransport(event);
  } catch (err) {
    // Logger failures must never surface to the user.
    // Log to stderr as a fallback so the failure is at least visible in raw logs.
    console.error(
      '[observability] Failed to flush trace:',
      err instanceof Error ? err.message : String(err),
      '| trace_id:', trace.trace_id
    );
  }
}

// ---------------------------------------------------------------------------
// Structured log helpers for individual events (pre-reading-completion)
// ---------------------------------------------------------------------------

/**
 * Logs a single agent span event. Useful for streaming environments where
 * you want visibility into in-progress readings, not just completed ones.
 */
export function logSpanEvent(
  traceId: string,
  event: 'span.started' | 'span.completed' | 'span.failed' | 'span.retry',
  detail: Record<string, unknown>
): void {
  console.log(
    JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      trace_id: traceId,
      ...detail,
    })
  );
}
