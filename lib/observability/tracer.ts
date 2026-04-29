/**
 * ReadingTracer — accumulates spans over a reading session's lifetime.
 *
 * Usage pattern:
 *
 *   const tracer = new ReadingTracer({ readingId, userIdHash, sessionId, spreadType });
 *
 *   const span = tracer.startSpan('card-interpreter');
 *   span.setInputHash(hashInput(input));
 *   try {
 *     const result = await callLLM(...);
 *     span.complete({ tokens_in: usage.input_tokens, tokens_out: usage.output_tokens });
 *   } catch (err) {
 *     span.fail(err);
 *     throw;
 *   }
 *
 *   tracer.complete();
 *   await tracer.flush(); // async, non-blocking — call after reading is displayed
 */

import { createHash, randomUUID } from 'crypto';
import { AgentName, AgentSpan, ReadingTrace } from './types';
import { deriveSignals } from './signals';
import { flushTrace } from './logger';

// ---------------------------------------------------------------------------
// SpanHandle — returned by startSpan(), closed by the caller
// ---------------------------------------------------------------------------

export class SpanHandle {
  constructor(private readonly span: AgentSpan) {}

  /** Call when the LLM call completed successfully. */
  complete(opts: { tokens_in?: number; tokens_out?: number } = {}): void {
    this.span.ended_at = Date.now();
    this.span.latency_ms = this.span.ended_at - this.span.started_at;
    this.span.status = 'success';
    this.span.tokens_in = opts.tokens_in ?? null;
    this.span.tokens_out = opts.tokens_out ?? null;
  }

  /** Call when the LLM call failed unrecoverably. */
  fail(error: unknown): void {
    this.span.ended_at = Date.now();
    this.span.latency_ms = this.span.ended_at - this.span.started_at;
    this.span.status = 'error';
    this.span.error =
      error instanceof Error ? error.message : String(error);
  }

  /**
   * Increment retry count. Called before each retry attempt.
   * The span remains open (status = 'pending') until complete() or fail().
   */
  incrementRetry(): void {
    this.span.retry_count++;
  }

  /**
   * Record that a JSON repair prompt was attempted.
   * @param succeeded - whether the repair produced valid JSON
   */
  recordRepairAttempt(succeeded: boolean): void {
    this.span.repair_attempted = true;
    this.span.repair_succeeded = succeeded;
  }

  /** Set the SHA-256 hash of the serialized agent input. */
  setInputHash(hash: string): void {
    this.span.input_hash = hash;
  }

  get retryCount(): number {
    return this.span.retry_count;
  }
}

// ---------------------------------------------------------------------------
// ReadingTracer — lifecycle manager for the full reading trace
// ---------------------------------------------------------------------------

export class ReadingTracer {
  private readonly trace: ReadingTrace;

  constructor(opts: {
    readingId: string;
    userIdHash: string;
    sessionId: string;
    spreadType: string;
  }) {
    this.trace = {
      trace_id: opts.readingId,
      user_id_hash: opts.userIdHash,
      session_id: opts.sessionId,
      spread_type: opts.spreadType,
      started_at: Date.now(),
      ended_at: null,
      completed: false,
      spans: [],
    };
  }

  /**
   * Opens a new span for an agent invocation.
   * The span is added to the trace immediately; the caller closes it
   * via SpanHandle.complete() or SpanHandle.fail().
   */
  startSpan(agent: AgentName): SpanHandle {
    const span: AgentSpan = {
      span_id: randomUUID(),
      agent,
      started_at: Date.now(),
      ended_at: null,
      latency_ms: null,
      status: 'pending',
      tokens_in: null,
      tokens_out: null,
      retry_count: 0,
      repair_attempted: false,
      repair_succeeded: null,
      input_hash: null,
    };
    this.trace.spans.push(span);
    return new SpanHandle(span);
  }

  /** Mark the reading as successfully completed. */
  complete(): void {
    this.trace.ended_at = Date.now();
    this.trace.completed = true;
  }

  /** Mark the reading as failed. */
  fail(): void {
    this.trace.ended_at = Date.now();
    this.trace.completed = false;
  }

  /**
   * Derives behavioral signals and flushes the trace to the log sink.
   * Should be called after the reading is fully displayed to the user —
   * non-blocking, runs async.
   */
  async flush(): Promise<void> {
    this.trace.signals = deriveSignals(this.trace);
    await flushTrace(this.trace);
  }

  /** Returns a shallow copy of the current trace state. */
  snapshot(): ReadingTrace {
    return { ...this.trace, spans: [...this.trace.spans] };
  }
}

// ---------------------------------------------------------------------------
// Utility: hash an agent input for correlation without logging PII
// ---------------------------------------------------------------------------

/**
 * Returns a short (16-char) SHA-256 hex prefix of the serialized input.
 * Long enough for collision resistance in a single reading; short enough
 * to keep log lines readable.
 */
export function hashInput(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Returns the SHA-256 hash of a user ID for storage in traces.
 * Full hash retained here (unlike input hashes) for cross-reading correlation.
 */
export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId).digest('hex');
}
