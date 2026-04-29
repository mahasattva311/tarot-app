/**
 * Derives behavioral signals from a completed ReadingTrace.
 *
 * Signals are computed once at flush time and embedded in the trace log.
 * They are designed to answer:
 *   - Is the system healthy? (retries, repairs, parallelization)
 *   - Is the UX flowing well? (clarification turns, total latency)
 *   - Where should we look first? (slowest agent, token outliers)
 *
 * All computations are pure functions of the trace — no external I/O.
 */

import { AgentSpan, ReadingSignals, ReadingTrace } from './types';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export function deriveSignals(trace: ReadingTrace): ReadingSignals {
  const allSpans = trace.spans;
  const completedSpans = allSpans.filter((s) => s.status === 'success');

  const clarificationSpans = allSpans.filter(
    (s) => s.agent === 'intention-clarifier'
  );
  const interpreterSpans = allSpans.filter(
    (s) => s.agent === 'card-interpreter'
  );

  const totalTokensIn = sum(completedSpans.map((s) => s.tokens_in ?? 0));
  const totalTokensOut = sum(completedSpans.map((s) => s.tokens_out ?? 0));

  const slowestSpan = findSlowest(completedSpans);
  const totalLatency =
    trace.ended_at !== null ? trace.ended_at - trace.started_at : null;

  return {
    clarification_turns: clarificationSpans.length,
    had_retries: allSpans.some((s) => s.retry_count > 0),
    had_json_repairs: allSpans.some((s) => s.repair_attempted),
    interpreters_parallelized: checkParallelization(interpreterSpans),
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    total_tokens: totalTokensIn + totalTokensOut,
    total_latency_ms: totalLatency,
    slowest_agent: slowestSpan?.agent ?? null,
    slowest_agent_latency_ms: slowestSpan?.latency_ms ?? null,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

function findSlowest(spans: AgentSpan[]): AgentSpan | null {
  const withLatency = spans.filter((s) => s.latency_ms !== null);
  if (withLatency.length === 0) return null;
  return withLatency.reduce((prev, curr) =>
    (curr.latency_ms ?? 0) > (prev.latency_ms ?? 0) ? curr : prev
  );
}

/**
 * CardInterpreter calls are supposed to be parallelized — all three should
 * start within a narrow window of each other. If they start more than 500ms
 * apart, the orchestrator is running them sequentially, which adds ~2–3s
 * of unnecessary latency to every reading.
 *
 * 500ms is a conservative threshold: even on cold starts, parallel kicks
 * should arrive within this window.
 */
function checkParallelization(interpreterSpans: AgentSpan[]): boolean {
  if (interpreterSpans.length < 3) return false;
  const starts = interpreterSpans
    .map((s) => s.started_at)
    .sort((a, b) => a - b);
  return starts[2] - starts[0] < 500;
}
