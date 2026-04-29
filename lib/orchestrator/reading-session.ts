/**
 * Reading session orchestrator.
 *
 * Implements the end-to-end reading flow from ARCHITECTURE.md:
 *
 *   1. IntentionClarifier  — loops until ready_to_draw: true
 *   2. CardDealer          — deterministic draw (no LLM)
 *   3. CardInterpreter × 3 — parallelized LLM calls
 *   4. SpreadSynthesizer   — sequential, depends on all three interpretations
 *   5. ReflectionPrompter  — sequential, depends on synthesis
 *   6. SessionArchivist    — async, non-blocking, fires after display
 *
 * Each step emits ReadingEvents via the onEvent callback, which the API
 * layer forwards to the frontend over SSE.
 *
 * The ReadingTracer is threaded through every agent call so that the full
 * reading is captured in a single trace, flushed after SessionArchivist
 * completes.
 */

import { randomUUID } from 'crypto';
import { ReadingTracer, hashUserId } from '../observability/tracer';
import { runAgent, extractJson } from './agent-runner';
import {
  CardDefinition,
  CardInterpreterOutput,
  CompletedReading,
  DrawnCard,
  IntentionClarifierOutput,
  OrchestratorOptions,
  Orientation,
  ReadingEvent,
  ReflectionPrompterOutput,
  SpreadSynthesizerOutput,
  SpreadType,
} from './types';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface StartReadingOptions {
  userId: string;
  sessionId: string;
  userInput: string;
  spreadType?: SpreadType;
  priorThemes?: string[];
  cardDefinitions: Map<string, CardDefinition>;
  onEvent: (event: ReadingEvent) => void;
  orchestratorOptions?: OrchestratorOptions;
}

/**
 * Runs a complete reading session.
 *
 * Returns the completed reading payload — also persisted asynchronously
 * by the SessionArchivist before this function resolves.
 *
 * Throws if any non-archivist step fails unrecoverably.
 */
export async function runReadingSession(
  opts: StartReadingOptions
): Promise<CompletedReading> {
  const {
    userId,
    sessionId,
    userInput,
    spreadType = 'three_card',
    priorThemes = [],
    cardDefinitions,
    onEvent,
    orchestratorOptions = {},
  } = opts;

  const readingId = randomUUID();

  const tracer = new ReadingTracer({
    readingId,
    userIdHash: hashUserId(userId),
    sessionId,
    spreadType,
  });

  try {
    // -----------------------------------------------------------------------
    // Step 1: IntentionClarifier — loop until ready_to_draw
    // -----------------------------------------------------------------------

    let intention = '';
    let themeTags: string[] = [];
    let clarificationTurns = 0;
    let currentInput = userInput;

    while (true) {
      clarificationTurns++;

      const clarifierOutput = await runAgent<IntentionClarifierOutput>({
        agent: 'intention-clarifier',
        input: {
          user_raw_input: currentInput,
          prior_themes: priorThemes,
        },
        userMessage: currentInput,
        parseOutput: (raw) => {
          // The clarifier returns JSON only when ready_to_draw: true.
          // When still clarifying, it returns natural language — which is
          // a valid output we surface to the user directly.
          const json = extractJson<IntentionClarifierOutput>(raw);
          if (json.ready_to_draw !== true) {
            throw new Error('Output is not a ready-to-draw handoff');
          }
          return json;
        },
        tracer,
        ...orchestratorOptions,
      }).catch(async (_err) => {
        // Not yet ready — the raw output IS the clarifying response for the user.
        // We emit it as a clarification event and wait for the next user turn.
        onEvent({ type: 'clarification.needed', payload: { clarificationTurns } });
        // In the real app, the API layer would pause here and wait for the
        // next user message. For the orchestrator, we surface this as a
        // thrown error that the API route catches and handles.
        throw new ClarificationNeededError(clarificationTurns);
      });

      intention = clarifierOutput.intention;
      themeTags = clarifierOutput.theme_tags;
      break;
    }

    onEvent({ type: 'intention.confirmed', payload: { intention, theme_tags: themeTags } });

    // -----------------------------------------------------------------------
    // Step 2: CardDealer — deterministic, no LLM
    // -----------------------------------------------------------------------

    const spread = dealCards(spreadType, cardDefinitions);
    onEvent({ type: 'cards.dealt', payload: { spread } });

    // -----------------------------------------------------------------------
    // Step 3: CardInterpreter × 3 — parallelized
    // -----------------------------------------------------------------------

    const interpretationPromises = spread.map((card) =>
      runAgent<CardInterpreterOutput>({
        agent: 'card-interpreter',
        input: {
          card_id: card.card_id,
          card_name: card.card_name,
          position_label: card.position_label,
          position_meaning: POSITION_MEANINGS[card.position_label],
          orientation: card.orientation,
          intention,
          theme_tags: themeTags,
          card_definition: formatCardDefinition(
            cardDefinitions.get(card.card_id)!
          ),
        },
        userMessage: 'Please interpret this card for the reading context provided.',
        parseOutput: (raw) => extractJson<CardInterpreterOutput>(raw),
        tracer,
        ...orchestratorOptions,
      }).then((result) => {
        onEvent({
          type: 'interpretation.complete',
          payload: { card_id: card.card_id, position_label: card.position_label },
        });
        return result;
      })
    );

    // All three fire simultaneously — Promise.all preserves order
    const interpretations = await Promise.all(interpretationPromises);

    // -----------------------------------------------------------------------
    // Step 4: SpreadSynthesizer
    // -----------------------------------------------------------------------

    const [past, present, future] = interpretations;
    const [pastCard, presentCard, futureCard] = spread;

    const synthesis = await runAgent<SpreadSynthesizerOutput>({
      agent: 'spread-synthesizer',
      input: {
        intention,
        theme_tags: themeTags,
        past_card_name: pastCard.card_name,
        past_orientation: pastCard.orientation,
        past_interpretation: past.interpretation,
        present_card_name: presentCard.card_name,
        present_orientation: presentCard.orientation,
        present_interpretation: present.interpretation,
        future_card_name: futureCard.card_name,
        future_orientation: futureCard.orientation,
        future_interpretation: future.interpretation,
        prior_reading_themes: priorThemes,
      },
      userMessage:
        'Please synthesize these three card interpretations into a unified narrative.',
      parseOutput: (raw) => extractJson<SpreadSynthesizerOutput>(raw),
      tracer,
      ...orchestratorOptions,
    });

    onEvent({
      type: 'synthesis.complete',
      payload: {
        narrative: synthesis.narrative,
        core_tension: synthesis.core_tension,
        integration_insight: synthesis.integration_insight,
      },
    });

    // -----------------------------------------------------------------------
    // Step 5: ReflectionPrompter
    // -----------------------------------------------------------------------

    const reflection = await runAgent<ReflectionPrompterOutput>({
      agent: 'reflection-prompter',
      input: {
        intention,
        core_tension: synthesis.core_tension,
        integration_insight: synthesis.integration_insight,
        narrative: synthesis.narrative,
      },
      userMessage: 'Please write the reflection prompts to close this reading.',
      parseOutput: (raw) => extractJson<ReflectionPrompterOutput>(raw),
      tracer,
      ...orchestratorOptions,
    });

    onEvent({
      type: 'reflection.complete',
      payload: { reflection_prompts: reflection.reflection_prompts },
    });

    // -----------------------------------------------------------------------
    // Assemble completed reading
    // -----------------------------------------------------------------------

    const completedReading: CompletedReading = {
      reading_id: readingId,
      user_id: userId,
      intention,
      theme_tags: themeTags,
      spread_type: spreadType,
      spread,
      interpretations,
      narrative: synthesis.narrative,
      core_tension: synthesis.core_tension,
      integration_insight: synthesis.integration_insight,
      reflection_prompts: reflection.reflection_prompts,
      created_at: new Date().toISOString(),
    };

    // -----------------------------------------------------------------------
    // Step 6: SessionArchivist — async, non-blocking
    // Mark reading complete and flush trace before returning to the caller.
    // -----------------------------------------------------------------------

    tracer.complete();

    persistReadingAsync(completedReading, tracer, onEvent);

    return completedReading;
  } catch (err) {
    if (err instanceof ClarificationNeededError) throw err;

    tracer.fail();
    // Best-effort flush on failure — we want the error trace in our logs
    tracer.flush().catch(() => {});

    onEvent({
      type: 'reading.error',
      payload: {
        message:
          err instanceof Error ? err.message : 'An unexpected error occurred.',
      },
    });

    throw err;
  }
}

// ---------------------------------------------------------------------------
// SessionArchivist — fires async after the reading is displayed
// ---------------------------------------------------------------------------

function persistReadingAsync(
  reading: CompletedReading,
  tracer: ReadingTracer,
  onEvent: (event: ReadingEvent) => void
): void {
  // Non-blocking: the UI is already showing the reading by the time this runs.
  Promise.resolve()
    .then(() => persistToDatabase(reading))
    .then(() => {
      onEvent({ type: 'reading.saved', payload: { reading_id: reading.reading_id } });
    })
    .catch((err) => {
      // Archivist failure is logged but never surfaced to the user.
      console.error(
        '[archivist] Failed to persist reading:',
        reading.reading_id,
        err instanceof Error ? err.message : err
      );
      // TODO: enqueue for async retry (reading.reading_id)
    })
    .finally(() => {
      // Flush the trace after the archivist completes (or fails) so that
      // the archivist span is included in the trace log.
      tracer.flush().catch((err) => {
        console.error('[observability] Trace flush failed:', err);
      });
    });
}

/**
 * Stub — replace with your actual Prisma/database write.
 * Should be idempotent (safe to retry on failure).
 *
 * Currently a no-op so the app runs in guest mode without a database.
 * When DATABASE_URL is configured, swap in your Prisma client calls:
 *
 *   await prisma.readings.create({ data: { ... } });
 *   await prisma.cards_drawn.createMany({ data: [...] });
 *   await upsertUserThemes(reading.user_id, reading.theme_tags);
 */
async function persistToDatabase(_reading: CompletedReading): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // Guest / no-database mode — skip persistence silently.
    return;
  }
  // TODO: replace with real Prisma writes when DATABASE_URL is set.
  console.warn('[archivist] DATABASE_URL is set but persistToDatabase() is not yet implemented.');
}

// ---------------------------------------------------------------------------
// CardDealer — deterministic, no LLM
// ---------------------------------------------------------------------------

const POSITION_LABELS = ['Past', 'Present', 'Future'] as const;
const POSITION_MEANINGS: Record<string, string> = {
  Past: 'What has shaped this situation; patterns, energies, or events that led here',
  Present: 'What is active right now; the current dynamic or core tension',
  Future: 'What is emerging or possible; an invitation, not a prediction',
};

const REVERSED_PROBABILITY = 0.3;

function dealCards(
  _spreadType: SpreadType,
  cardDefinitions: Map<string, CardDefinition>
): DrawnCard[] {
  const allCardIds = Array.from(cardDefinitions.keys());

  // Fisher-Yates shuffle on a copy
  const shuffled = [...allCardIds];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return POSITION_LABELS.map((label, index) => {
    const card_id = shuffled[index];
    const card = cardDefinitions.get(card_id)!;
    const orientation: Orientation =
      Math.random() < REVERSED_PROBABILITY ? 'reversed' : 'upright';
    return {
      position: (index + 1) as 1 | 2 | 3,
      position_label: label,
      card_id,
      card_name: card.card_name,
      orientation,
    };
  });
}

// ---------------------------------------------------------------------------
// Card definition formatter — for injection into CardInterpreter prompt
// ---------------------------------------------------------------------------

function formatCardDefinition(card: CardDefinition): string {
  return [
    `Keywords: ${card.keywords.join(', ')}`,
    `Symbolism: ${card.symbolism}`,
    `Shadow aspect: ${card.shadow_aspect}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// ClarificationNeededError — signals to the API layer that the orchestrator
// needs another user turn before it can proceed
// ---------------------------------------------------------------------------

export class ClarificationNeededError extends Error {
  constructor(public readonly turnsCompleted: number) {
    super(`Intention not yet confirmed after ${turnsCompleted} turn(s).`);
    this.name = 'ClarificationNeededError';
  }
}
