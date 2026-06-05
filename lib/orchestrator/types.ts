/**
 * Agent input/output contracts for the orchestrator.
 *
 * These types mirror the JSON schemas defined in AGENTS.md and act as
 * the typed interface between the orchestrator and each agent's output.
 * Keeping them here (separate from the observability layer) means the
 * orchestrator can be understood and tested independently.
 */

// ---------------------------------------------------------------------------
// Card reference data (loaded from data/cards.json at startup)
// ---------------------------------------------------------------------------

export interface CardDefinition {
  card_id: string;
  card_name: string;
  arcana: 'major' | 'minor';
  suit?: 'wands' | 'cups' | 'swords' | 'pentacles';
  keywords: string[];
  /** 2–3 sentence description of key imagery and symbolism */
  symbolism: string;
  /** Brief note on reversed/shadow meaning */
  shadow_aspect: string;
}

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

export type SpreadType = 'three_card';
export type Orientation = 'upright' | 'reversed';

export interface DrawnCard {
  position: 1 | 2 | 3;
  position_label: string;
  card_id: string;
  card_name: string;
  orientation: Orientation;
}

// ---------------------------------------------------------------------------
// Agent outputs — match the JSON schemas in AGENTS.md exactly
// ---------------------------------------------------------------------------

export interface IntentionClarifierOutput {
  intention: string;
  theme_tags: string[];
  ready_to_draw: true;
}

export interface CardInterpreterOutput {
  card_id: string;
  position_label: string;
  interpretation: string;
  keywords: string[];
}

export interface SpreadSynthesizerOutput {
  narrative: string;
  core_tension: string;
  integration_insight: string;
}

export interface ReflectionPrompterOutput {
  reflection_prompts: [string, string] | [string, string, string];
}

// ---------------------------------------------------------------------------
// Completed reading payload — assembled by the orchestrator, persisted by
// SessionArchivist, and returned to the API layer for streaming
// ---------------------------------------------------------------------------

export interface CompletedReading {
  reading_id: string;
  user_id: string;
  intention: string;
  theme_tags: string[];
  spread_type: SpreadType;
  spread: DrawnCard[];
  interpretations: CardInterpreterOutput[];
  narrative: string;
  core_tension: string;
  integration_insight: string;
  reflection_prompts: string[];
  created_at: string; // ISO 8601
}

// ---------------------------------------------------------------------------
// Streaming events — emitted over SSE during the reading
// ---------------------------------------------------------------------------

export type ReadingEventType =
  | 'clarification.needed'     // IntentionClarifier needs another turn
  | 'intention.confirmed'       // IntentionClarifier ready, cards about to be drawn
  | 'cards.dealt'               // CardDealer finished; spread sent to client
  | 'interpretation.streaming'  // CardInterpreter streaming (card_id + position)
  | 'interpretation.complete'   // One CardInterpreter finished
  | 'synthesis.streaming'       // SpreadSynthesizer streaming
  | 'synthesis.complete'        // SpreadSynthesizer finished
  | 'reflection.complete'       // ReflectionPrompter finished; reading fully visible
  | 'reading.saved'             // SessionArchivist persisted (async, post-display)
  | 'reading.error';            // Unrecoverable error

export interface ReadingEvent {
  type: ReadingEventType;
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// Orchestrator options
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  /** The Anthropic model to use. Pulled from LLM_MODEL env var if not specified. */
  model?: string;
  /** Max retries per agent call. Default: 2 */
  maxRetries?: number;
  /** Timeout per LLM call in ms. Default: 30_000 */
  timeoutMs?: number;
}
