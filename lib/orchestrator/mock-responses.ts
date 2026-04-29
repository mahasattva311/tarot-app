/**
 * Mock LLM responses for development without an API key.
 *
 * Activated by setting USE_MOCK_LLM=true in .env.local.
 *
 * These stubs return realistic-looking JSON that matches each agent's schema
 * exactly, so the full UI flow can be built and tested before any API
 * credentials are configured. Responses are clearly tagged [MOCK] so they
 * are never mistaken for real output in logs.
 *
 * The stubs are not random — they read from the actual input so that card
 * names and the user's intention appear in the output, making the mock
 * feel coherent in the UI.
 */

import { AgentName } from '../observability/types';

// Small artificial delay so the UI can render streaming states correctly.
// Set to 0 in tests; keep at ~300ms for realistic UI development.
const MOCK_DELAY_MS = parseInt(process.env.MOCK_DELAY_MS ?? '300', 10);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Per-agent mock response generators
// Each receives the rendered input variables and returns a JSON string
// matching the agent's output schema exactly.
// ---------------------------------------------------------------------------

function mockIntentionClarifier(input: Record<string, unknown>): string {
  const raw = String(input.user_raw_input ?? 'what is on my mind right now');
  // If the input looks like a question, reflect it back as an open intention.
  const isQuestion = raw.trim().endsWith('?');
  const intention = isQuestion
    ? `I want to understand ${raw.replace(/\?$/, '').toLowerCase().trim()}`
    : raw;

  return JSON.stringify({
    intention,
    theme_tags: ['self-reflection', 'transition', 'clarity'],
    ready_to_draw: true,
  });
}

function mockCardInterpreter(input: Record<string, unknown>): string {
  const cardName = String(input.card_name ?? 'this card');
  const positionLabel = String(input.position_label ?? 'this position');
  const orientation = String(input.orientation ?? 'upright');
  const intention = String(input.intention ?? 'your question');
  const isReversed = orientation === 'reversed';

  const reversedNote = isReversed
    ? ` Reversed here, the card's energy turns inward — what is usually expressed outwardly now asks to be examined in shadow form, the blocked or suppressed dimension of this archetype.`
    : '';

  const interpretation =
    `[MOCK] ${cardName} appears in the ${positionLabel} position of your reading, ` +
    `and it speaks directly to the question you've brought: ${intention}. ` +
    `This card carries an invitation to look at what has shaped this moment — ` +
    `not as explanation, but as context for the choices now available to you.` +
    reversedNote +
    ` Something in the symbolism of ${cardName} is asking you to sit with ` +
    `what you already know but may not yet have named. ` +
    `What part of this feels most familiar to you right now?`;

  return JSON.stringify({
    card_id: String(input.card_id ?? 'unknown'),
    position_label: positionLabel,
    interpretation,
    keywords: ['reflection', 'awareness', 'threshold', 'inner knowing'],
  });
}

function mockSpreadSynthesizer(input: Record<string, unknown>): string {
  const intention = String(input.intention ?? 'your question');
  const pastCard = String(input.past_card_name ?? 'the Past card');
  const presentCard = String(input.present_card_name ?? 'the Present card');
  const futureCard = String(input.future_card_name ?? 'the Future card');

  const narrative =
    `[MOCK] Taken together, these three cards trace a movement that speaks directly ` +
    `to your intention around ${intention}. ` +
    `${pastCard} in the past position establishes what has been carried into this moment — ` +
    `not as burden necessarily, but as the ground from which the present grows. ` +
    `${presentCard} at the center names what is most alive right now: the active tension, ` +
    `the thing that cannot be deferred much longer. ` +
    `And ${futureCard} does not predict what will happen; it describes what is becoming ` +
    `possible, the quality of what opens if you meet this moment honestly. ` +
    `The arc between these three is not a resolution — it is an invitation. ` +
    `What the spread holds is the shape of something you are already in the middle of.`;

  return JSON.stringify({
    narrative,
    core_tension: `[MOCK] The tension between what has been established and what is genuinely new.`,
    integration_insight: `[MOCK] What is asked of you here is not a decision so much as a quality of attention.`,
  });
}

function mockReflectionPrompter(_input: Record<string, unknown>): string {
  return JSON.stringify({
    reflection_prompts: [
      `[MOCK] When you imagine the version of yourself that has moved through this, what is different about how they hold this situation?`,
      `[MOCK] What would it mean to trust what you already know here, even before you feel certain?`,
      `[MOCK] What are you protecting by keeping things as they are — and is that thing still worth protecting?`,
    ],
  });
}

// ---------------------------------------------------------------------------
// Public interface — called by agent-runner when USE_MOCK_LLM=true
// ---------------------------------------------------------------------------

export async function getMockResponse(
  agent: AgentName,
  input: Record<string, unknown>
): Promise<string> {
  await sleep(MOCK_DELAY_MS);

  switch (agent) {
    case 'intention-clarifier':
      return mockIntentionClarifier(input);
    case 'card-interpreter':
      return mockCardInterpreter(input);
    case 'spread-synthesizer':
      return mockSpreadSynthesizer(input);
    case 'reflection-prompter':
      return mockReflectionPrompter(input);
    case 'session-archivist':
      return '{}';
  }
}
