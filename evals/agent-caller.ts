/**
 * Renders system prompt templates and calls the Anthropic API for each agent.
 *
 * Template syntax: {{variable}} for substitution, {{#if var}} ... {{/if}} for
 * optional blocks. Matches the Handlebars-like syntax used in the .system.md files.
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentName, GoldenExample } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prompts live at docs/prompts/ relative to the repo root (one level up from evals/)
const PROMPTS_DIR = join(__dirname, '..', 'docs', 'prompts');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

interface AgentConfig {
  promptFile: string;
  maxTokens: number;
  temperature: number;
}

const AGENT_CONFIGS: Record<AgentName, AgentConfig> = {
  'intention-clarifier': {
    promptFile: 'intention-clarifier.system.md',
    maxTokens: 400,
    temperature: 0.7,
  },
  'card-interpreter': {
    promptFile: 'card-interpreter.system.md',
    maxTokens: 500,
    temperature: 0.7,
  },
  'spread-synthesizer': {
    promptFile: 'spread-synthesizer.system.md',
    maxTokens: 800,
    temperature: 0.7,
  },
  'reflection-prompter': {
    promptFile: 'reflection-prompter.system.md',
    maxTokens: 300,
    temperature: 0.7,
  },
};

const LLM_MODEL =
  process.env.LLM_MODEL ?? 'claude-sonnet-4-20250514';

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/**
 * Renders a {{#if var}} ... {{/if}} block.
 * The block is included when the variable is truthy and non-empty.
 */
function renderConditionals(
  template: string,
  vars: Record<string, unknown>
): string {
  return template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, varName: string, content: string) => {
      const value = vars[varName];
      const isPresent =
        value !== undefined &&
        value !== null &&
        value !== '' &&
        !(Array.isArray(value) && value.length === 0);
      return isPresent ? content : '';
    }
  );
}

/**
 * Substitutes {{variable}} placeholders. Arrays are joined with ', '.
 * Unknown variables are replaced with an empty string.
 */
function renderVariables(
  template: string,
  vars: Record<string, unknown>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, varName: string) => {
    const value = vars[varName];
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  });
}

export function renderTemplate(
  template: string,
  vars: Record<string, unknown>
): string {
  return renderVariables(renderConditionals(template, vars), vars);
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

/**
 * Builds the user-turn message for each agent.
 * CardInterpreter and the downstream agents receive their context entirely
 * in the system prompt; the user turn is a minimal trigger phrase.
 */
function buildUserMessage(example: GoldenExample): string {
  switch (example.agent) {
    case 'intention-clarifier':
      // The raw user input IS the user turn for this agent
      return String(example.input.user_raw_input ?? '');
    case 'card-interpreter':
      return 'Please interpret this card for the reading context provided.';
    case 'spread-synthesizer':
      return 'Please synthesize these three card interpretations into a unified narrative.';
    case 'reflection-prompter':
      return 'Please write the reflection prompts to close this reading.';
  }
}

/**
 * Calls the agent with the rendered system prompt and returns the raw string output.
 * Throws on API errors; callers should handle and log.
 */
export async function callAgent(example: GoldenExample): Promise<string> {
  const config = AGENT_CONFIGS[example.agent];

  const promptTemplate = readFileSync(
    join(PROMPTS_DIR, config.promptFile),
    'utf-8'
  );
  const systemPrompt = renderTemplate(promptTemplate, example.input);

  const response = await client.messages.create({
    model: LLM_MODEL,
    max_tokens: config.maxTokens,
    temperature: config.temperature,
    system: systemPrompt,
    messages: [{ role: 'user', content: buildUserMessage(example) }],
  });

  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error(
      `Unexpected content block type from agent "${example.agent}": ${content.type}`
    );
  }

  return content.text;
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Attempts to parse the agent's raw output as JSON.
 * Handles markdown code fences (```json ... ```) that models sometimes emit.
 * Returns null if no valid JSON can be extracted.
 */
export function parseAgentOutput(
  rawOutput: string
): Record<string, unknown> | null {
  // Strip optional markdown code fence wrapper
  const stripped = rawOutput
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  // Try direct parse first
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    // Fall back: extract the first {...} block from the text
    const jsonMatch = stripped.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}
