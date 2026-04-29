/**
 * Rule-based hard constraint checks.
 *
 * These run before the LLM judge — they are fast, deterministic, and free.
 * Each maps directly to a constraint bullet in the agent's system prompt.
 * A single FAIL here blocks the eval from reaching the judge and fails CI.
 */

import { AgentName, GoldenExample, HardCheckResult } from './types.js';

// ---------------------------------------------------------------------------
// Shared constraint lists (used across all LLM agents)
// ---------------------------------------------------------------------------

const FORBIDDEN_WORDS: string[] = [
  'journey',
  'path',
  'universe',
  'energy',
  'manifest',
  'aligned',
  'destiny',
  'fate',
  'meant to be',
];

const PREDICTIVE_PATTERNS: RegExp[] = [
  /\byou will\b/i,
  /\bthis will\b/i,
  /\bwill happen\b/i,
  /\bsoon you'?ll\b/i,
  /\bthis predicts\b/i,
  /\bwhat will\b/i,
];

const PRESCRIPTIVE_PATTERNS: RegExp[] = [
  /\byou should\b/i,
  /\byou need to\b/i,
  /\byou must\b/i,
  /\bit'?s time to\b/i,
  /\byou have to\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function findForbiddenWords(text: string): string[] {
  return FORBIDDEN_WORDS.filter((word) =>
    new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`, 'i').test(text)
  );
}

function findPatternMatches(text: string, patterns: RegExp[]): string[] {
  return patterns
    .filter((p) => p.test(text))
    .map((p) => p.source);
}

// ---------------------------------------------------------------------------
// Shared checks applied to all LLM agent outputs
// ---------------------------------------------------------------------------

function sharedChecks(text: string): HardCheckResult[] {
  const predictiveMatches = findPatternMatches(text, PREDICTIVE_PATTERNS);
  const prescriptiveMatches = findPatternMatches(text, PRESCRIPTIVE_PATTERNS);
  const forbiddenFound = findForbiddenWords(text);

  return [
    {
      id: 'HC-predictive',
      result: predictiveMatches.length === 0 ? 'PASS' : 'FAIL',
      reasoning:
        predictiveMatches.length === 0
          ? 'No predictive language detected.'
          : `Predictive phrases found: ${predictiveMatches.join(', ')}`,
    },
    {
      id: 'HC-prescriptive',
      result: prescriptiveMatches.length === 0 ? 'PASS' : 'FAIL',
      reasoning:
        prescriptiveMatches.length === 0
          ? 'No prescriptive language detected.'
          : `Prescriptive phrases found: ${prescriptiveMatches.join(', ')}`,
    },
    {
      id: 'HC-forbidden-words',
      result: forbiddenFound.length === 0 ? 'PASS' : 'FAIL',
      reasoning:
        forbiddenFound.length === 0
          ? 'No forbidden words detected.'
          : `Forbidden words found: ${forbiddenFound.join(', ')}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Per-agent check functions
// ---------------------------------------------------------------------------

function checkCardInterpreter(
  parsed: Record<string, unknown>,
  input: GoldenExample['input']
): HardCheckResult[] {
  const interpretation =
    typeof parsed.interpretation === 'string' ? parsed.interpretation : '';
  const keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
  const wordCount = countWords(interpretation);
  const isReversed = input.orientation === 'reversed';

  // Heuristic: did the output acknowledge reversed orientation?
  const REVERSED_INDICATORS = [
    /\breversed\b/i,
    /\binward\b/i,
    /\bblocked?\b/i,
    /\bshadow\b/i,
    /\bsuppressed?\b/i,
    /\bresistance\b/i,
    /\bunexpressed\b/i,
    /\bwithdrawn\b/i,
    /\bturned inward\b/i,
  ];
  const acknowledgesReversed = REVERSED_INDICATORS.some((p) =>
    p.test(interpretation)
  );

  return [
    ...sharedChecks(interpretation),
    {
      id: 'HC-word-count',
      result: wordCount >= 100 && wordCount <= 180 ? 'PASS' : 'FAIL',
      reasoning: `Interpretation is ${wordCount} words (required: 100–180).`,
      detail: { word_count: wordCount },
    },
    {
      id: 'HC-keywords',
      result: keywords.length >= 3 && keywords.length <= 5 ? 'PASS' : 'FAIL',
      reasoning: `keywords array has ${keywords.length} item(s) (required: 3–5).`,
    },
    {
      id: 'HC-schema',
      result:
        typeof parsed.card_id === 'string' &&
        typeof parsed.position_label === 'string' &&
        typeof parsed.interpretation === 'string' &&
        Array.isArray(parsed.keywords)
          ? 'PASS'
          : 'FAIL',
      reasoning:
        'Validates presence of card_id (string), position_label (string), interpretation (string), keywords (array).',
    },
    {
      id: 'HC-reversed-orientation',
      result: isReversed ? (acknowledgesReversed ? 'PASS' : 'FAIL') : 'N/A',
      reasoning: isReversed
        ? acknowledgesReversed
          ? 'Output acknowledges reversed orientation (inward/blocked/shadow dimension found).'
          : 'Reversed card but no acknowledgment of inward, blocked, or shadow dimension detected.'
        : 'Card is upright; reversed check not applicable.',
    },
  ];
}

function checkIntentionClarifier(
  parsed: Record<string, unknown> | null,
  rawOutput: string,
  _input: GoldenExample['input']
): HardCheckResult[] {
  const isReadyToDraw = parsed?.ready_to_draw === true;

  if (!isReadyToDraw) {
    // Not yet ready — output should be natural language only (no JSON to the user)
    const questionCount = (rawOutput.match(/\?/g) ?? []).length;
    const TAROT_TERMS = /\b(card|spread|arcana|tarot|draw|pull|deck)\b/i;
    const hasTarotTerms = TAROT_TERMS.test(rawOutput);

    return [
      ...sharedChecks(rawOutput),
      {
        id: 'HC-one-question-max',
        result: questionCount <= 1 ? 'PASS' : 'FAIL',
        reasoning: `Output contains ${questionCount} question mark(s). Maximum 1 allowed per clarification turn.`,
      },
      {
        id: 'HC-no-tarot-language',
        result: hasTarotTerms ? 'FAIL' : 'PASS',
        reasoning: hasTarotTerms
          ? 'Output references tarot cards or spread before intention is confirmed.'
          : 'No premature tarot references detected.',
      },
    ];
  }

  // Ready to draw — validate the JSON handoff schema
  const intentionText =
    typeof parsed?.intention === 'string' ? parsed.intention : '';

  return [
    ...sharedChecks(intentionText),
    {
      id: 'HC-schema',
      result:
        typeof parsed?.intention === 'string' &&
        (parsed?.intention as string).length > 0 &&
        Array.isArray(parsed?.theme_tags) &&
        (parsed?.theme_tags as unknown[]).length > 0 &&
        parsed?.ready_to_draw === true
          ? 'PASS'
          : 'FAIL',
      reasoning:
        'Validates intention (non-empty string), theme_tags (non-empty array), ready_to_draw (true).',
    },
  ];
}

function checkSpreadSynthesizer(
  parsed: Record<string, unknown>
): HardCheckResult[] {
  const narrative =
    typeof parsed.narrative === 'string' ? parsed.narrative : '';
  const coreTension =
    typeof parsed.core_tension === 'string' ? parsed.core_tension : '';
  const integrationInsight =
    typeof parsed.integration_insight === 'string'
      ? parsed.integration_insight
      : '';

  const wordCount = countWords(narrative);

  return [
    ...sharedChecks(narrative),
    {
      id: 'HC-word-count',
      result: wordCount >= 200 && wordCount <= 300 ? 'PASS' : 'FAIL',
      reasoning: `Narrative is ${wordCount} words (required: 200–300).`,
      detail: { word_count: wordCount },
    },
    {
      id: 'HC-schema',
      result:
        narrative.length > 0 &&
        coreTension.length > 0 &&
        integrationInsight.length > 0
          ? 'PASS'
          : 'FAIL',
      reasoning:
        'Validates narrative, core_tension, and integration_insight are all non-empty strings.',
    },
  ];
}

function checkReflectionPrompter(
  parsed: Record<string, unknown>
): HardCheckResult[] {
  const prompts = Array.isArray(parsed.reflection_prompts)
    ? (parsed.reflection_prompts as unknown[])
    : [];

  const combined = prompts
    .filter((p): p is string => typeof p === 'string')
    .join(' ');

  // Detect yes/no questions by their opening auxiliary verb
  const YES_NO_OPENER =
    /^(are|is|was|were|did|do|does|have|has|had|will|would|could|should|can)\s/i;
  const hasYesNoQuestion = prompts
    .filter((p): p is string => typeof p === 'string')
    .some((p) => YES_NO_OPENER.test(p.trim()));

  // Detect single-question-per-prompt violation (multiple ? in one prompt)
  const hasMultipleQuestionsInOnePrompt = prompts
    .filter((p): p is string => typeof p === 'string')
    .some((p) => (p.match(/\?/g) ?? []).length > 1);

  return [
    ...sharedChecks(combined),
    {
      id: 'HC-prompt-count',
      result: prompts.length >= 2 && prompts.length <= 3 ? 'PASS' : 'FAIL',
      reasoning: `Output contains ${prompts.length} prompt(s) (required: 2–3).`,
    },
    {
      id: 'HC-no-yes-no-questions',
      result: hasYesNoQuestion ? 'FAIL' : 'PASS',
      reasoning: hasYesNoQuestion
        ? 'One or more prompts appear to open as a yes/no question.'
        : 'All prompts appear open-ended.',
    },
    {
      id: 'HC-one-question-per-prompt',
      result: hasMultipleQuestionsInOnePrompt ? 'FAIL' : 'PASS',
      reasoning: hasMultipleQuestionsInOnePrompt
        ? 'One or more prompts contain multiple questions. Maximum one question mark per prompt.'
        : 'Each prompt contains at most one question.',
    },
    {
      id: 'HC-schema',
      result: Array.isArray(parsed.reflection_prompts) ? 'PASS' : 'FAIL',
      reasoning: 'Validates reflection_prompts is an array.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Run all rule-based hard checks for a given agent.
 * Returns a FAIL result for schema if the output couldn't be parsed at all.
 */
export function runHardChecks(
  agent: AgentName,
  rawOutput: string,
  parsed: Record<string, unknown> | null,
  input: GoldenExample['input']
): HardCheckResult[] {
  if (!parsed && agent !== 'intention-clarifier') {
    return [
      {
        id: 'HC-parse',
        result: 'FAIL',
        reasoning:
          'Agent output could not be parsed as valid JSON. All downstream checks skipped.',
      },
    ];
  }

  switch (agent) {
    case 'card-interpreter':
      return checkCardInterpreter(parsed!, input);
    case 'intention-clarifier':
      return checkIntentionClarifier(parsed, rawOutput, input);
    case 'spread-synthesizer':
      return checkSpreadSynthesizer(parsed!);
    case 'reflection-prompter':
      return checkReflectionPrompter(parsed!);
  }
}

/** True if every check passed or was not applicable. */
export function allHardChecksPassed(checks: HardCheckResult[]): boolean {
  return checks.every((c) => c.result === 'PASS' || c.result === 'N/A');
}
