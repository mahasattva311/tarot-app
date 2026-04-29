/**
 * Observability type definitions.
 *
 * A ReadingTrace is created at the start of each reading session and
 * accumulates AgentSpans as each LLM agent runs. It is flushed as a
 * structured log line once the reading completes (or fails).
 *
 * Design decisions:
 * - Raw user input is never logged. Input hashes allow correlation without PII.
 * - User IDs are stored as SHA-256 hashes for the same reason.
 * - Token counts are included for cost attribution and anomaly detection.
 * - Retry and repair counts surface prompt fragility over time.
 */

export type AgentName =
  | 'intention-clarifier'
  | 'card-interpreter'
  | 'spread-synthesizer'
  | 'reflection-prompter'
  | 'session-archivist';

export type SpanStatus = 'pending' | 'success' | 'error';

// ---------------------------------------------------------------------------
// Spans — one per agent invocation
// ---------------------------------------------------------------------------

export interface AgentSpan {
  span_id: string;
  agent: AgentName;
  /** Unix ms — when the LLM call was initiated */
  started_at: number;
  /** Unix ms — when the call completed or failed. Null while pending. */
  ended_at: number | null;
  /** ended_at - started_at, in ms. Null while pending. */
  latency_ms: number | null;
  status: SpanStatus;
  /** Tokens in the system + user prompt */
  tokens_in: number | null;
  /** Tokens in the model's response */
  tokens_out: number | null;
  /**
   * Number of retries attempted after the first call failed.
   * 0 = first call succeeded. Max 2 per RELIABILITY.md policy.
   */
  retry_count: number;
  /**
   * True if the agent's output failed JSON parsing and a repair prompt
   * was sent. This is a signal of prompt fragility.
   */
  repair_attempted: boolean;
  /** True if the repair prompt produced valid JSON. Null if no repair was attempted. */
  repair_succeeded: boolean | null;
  /**
   * SHA-256 of the serialized agent input.
   * Allows correlating a production failure with the matching golden example
   * without logging raw input content.
   */
  input_hash: string | null;
  /** Present only when status = 'error' */
  error?: string;
}

// ---------------------------------------------------------------------------
// Trace — one per reading session
// ---------------------------------------------------------------------------

export interface ReadingTrace {
  /** Same value as the reading's database ID */
  trace_id: string;
  /** SHA-256 of the authenticated user's ID. Never the raw ID. */
  user_id_hash: string;
  session_id: string;
  spread_type: string;
  /** Unix ms — when the reading session opened */
  started_at: number;
  /** Unix ms — when the reading fully completed or was abandoned */
  ended_at: number | null;
  /**
   * True only when all agents completed successfully and the reading
   * was fully displayed to the user. False on any unrecovered error.
   */
  completed: boolean;
  spans: AgentSpan[];
  /** Populated at flush time by deriveSignals() */
  signals?: ReadingSignals;
}

// ---------------------------------------------------------------------------
// Signals — behavioral metrics derived from the trace
// ---------------------------------------------------------------------------

export interface ReadingSignals {
  /**
   * How many times IntentionClarifier ran before ready_to_draw: true.
   * 1 = the user's first input was already a clear intention.
   * 2+ = at least one clarification exchange happened.
   */
  clarification_turns: number;
  /** Any agent required at least one retry */
  had_retries: boolean;
  /** Any agent output failed JSON parsing and triggered a repair call */
  had_json_repairs: boolean;
  /**
   * True if all three CardInterpreter calls started within a 500ms window,
   * indicating they ran in parallel as designed. False signals a regression
   * in the orchestrator's parallelization logic.
   */
  interpreters_parallelized: boolean;
  total_tokens_in: number;
  total_tokens_out: number;
  total_tokens: number;
  /** Wall-clock time from reading open to reading complete, in ms */
  total_latency_ms: number | null;
  /** The agent with the highest individual latency */
  slowest_agent: AgentName | null;
  slowest_agent_latency_ms: number | null;
}

// ---------------------------------------------------------------------------
// Log event envelope — what gets written to the log sink
// ---------------------------------------------------------------------------

export interface TraceLogEvent {
  event: 'reading.completed' | 'reading.failed';
  timestamp: string; // ISO 8601
  trace: ReadingTrace;
}
