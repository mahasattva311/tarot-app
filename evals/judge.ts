/**
 * LLM-as-judge dispatch.
 *
 * Loads the per-agent judge prompt from evals/judges/{agent}.judge.md,
 * constructs a user message containing the agent's input, actual output,
 * and the reference anchor output, then calls the model at temperature 0
 * for maximum consistency.
 *
 * The judge prompt instructs the model to evaluate criteria independently
 * (criterion-by-criterion reasoning before any overall score) and return
 * a structured JSON result matching JudgeOutput.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentName, GoldenExample, JudgeOutput } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JUDGES_DIR = join(__dirname, 'judges');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Use the same model as the agents by default; can be overridden to a more
// capable model for higher-stakes eval runs.
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? 'claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// User message construction
// ---------------------------------------------------------------------------

/**
 * Builds the structured user turn sent to the judge.
 * Separating the three components (input, output, reference) with clear headers
 * helps the judge parse them reliably without hallucinating boundaries.
 */
function buildJudgeUserMessage(
  example: GoldenExample,
  agentOutput: string
): string {
  const inputBlock = JSON.stringify(example.input, null, 2);

  return [
    '## Agent input',
    '',
    '```json',
    inputBlock,
    '```',
    '',
    '## Agent output (evaluate this)',
    '',
    agentOutput.trim(),
    '',
    '## Reference output (quality anchor — not an exact-match target)',
    '',
    example.reference_output.trim(),
    '',
    'Please evaluate the agent output against each criterion in your instructions.',
    'Return your assessment as a single JSON object.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

function parseJudgeOutput(raw: string): JudgeOutput {
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  // Try direct parse
  try {
    return JSON.parse(stripped) as JudgeOutput;
  } catch {
    // Extract the first {...} block
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]) as JudgeOutput;
    }
    throw new Error(
      `Judge returned unparseable output. Raw response:\n${raw.slice(0, 500)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * Runs the LLM judge for a single golden example.
 *
 * @param agent     - Which agent's judge prompt to load
 * @param example   - The golden example (provides input + reference output)
 * @param agentOutput - The raw string the agent produced
 * @returns Parsed JudgeOutput with per-criterion scores and overall summary
 */
export async function runJudge(
  agent: AgentName,
  example: GoldenExample,
  agentOutput: string
): Promise<JudgeOutput> {
  const judgePromptPath = join(JUDGES_DIR, `${agent}.judge.md`);
  const judgeSystemPrompt = readFileSync(judgePromptPath, 'utf-8');

  const userMessage = buildJudgeUserMessage(example, agentOutput);

  const response = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 2500,
    // Temperature 0 for maximum consistency across runs.
    // The judge should be deterministic — creativity is not wanted here.
    temperature: 0,
    system: judgeSystemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error(
      `Judge returned unexpected content block type: ${content.type}`
    );
  }

  return parseJudgeOutput(content.text);
}
