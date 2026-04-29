/**
 * Instrumented agent runner — multi-provider edition.
 *
 * Supports three LLM backends, selected by environment variables:
 *
 *   USE_MOCK_LLM=true          → instant stubs, no API key, no model
 *   LLM_PROVIDER=ollama        → local Ollama (free, no key required)
 *   LLM_PROVIDER=anthropic     → Anthropic API (default)
 *
 * For Ollama, install from https://ollama.com, then:
 *   ollama pull llama3.2       (or mistral, gemma2, etc.)
 *   ollama serve               (starts the local API on port 11434)
 *
 * Every LLM call goes through runAgent() regardless of provider.
 * Retry, repair, observability, and template rendering are provider-agnostic.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ReadingTracer, hashInput } from '../observability/tracer';
import { logSpanEvent } from '../observability/logger';
import { AgentName } from '../observability/types';
import { getMockResponse } from './mock-responses';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', '..', 'docs', 'prompts');

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

type Provider = 'anthropic' | 'ollama' | 'mock';

function detectProvider(): Provider {
  if (process.env.USE_MOCK_LLM === 'true') return 'mock';
  const declared = process.env.LLM_PROVIDER?.toLowerCase();
  if (declared === 'ollama') return 'ollama';
  return 'anthropic';
}

const PROVIDER = detectProvider();

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_BY_PROVIDER: Record<Provider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  ollama: 'llama3.2',
  mock: 'mock',
};

const DEFAULT_MODEL =
  process.env.LLM_MODEL ?? DEFAULT_MODEL_BY_PROVIDER[PROVIDER];

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_BASE_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

const AGENT_MAX_TOKENS: Record<AgentName, number> = {
  'intention-clarifier': 400,
  'card-interpreter': 500,
  'spread-synthesizer': 800,
  'reflection-prompter': 300,
  'session-archivist': 0,
};

const AGENT_PROMPT_FILE: Partial<Record<AgentName, string>> = {
  'intention-clarifier': 'intention-clarifier.system.md',
  'card-interpreter': 'card-interpreter.system.md',
  'spread-synthesizer': 'spread-synthesizer.system.md',
  'reflection-prompter': 'reflection-prompter.system.md',
};

// ---------------------------------------------------------------------------
// runAgent — single entry point for all LLM calls
// ---------------------------------------------------------------------------

export interface RunAgentOptions<TOutput> {
  agent: AgentName;
  input: Record<string, unknown>;
  userMessage: string;
  parseOutput: (raw: string) => TOutput;
  tracer: ReadingTracer;
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
  temperature?: number;
}

export async function runAgent<TOutput>(
  opts: RunAgentOptions<TOutput>
): Promise<TOutput> {
  const {
    agent,
    input,
    userMessage,
    parseOutput,
    tracer,
    model = DEFAULT_MODEL,
    maxRetries = DEFAULT_MAX_RETRIES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    temperature = 0.7,
  } = opts;

  const span = tracer.startSpan(agent);
  span.setInputHash(hashInput(input));

  const traceId = tracer.snapshot().trace_id;
  logSpanEvent(traceId, 'span.started', { agent, provider: PROVIDER });

  // -------------------------------------------------------------------------
  // Mock path — bypass all real LLM machinery
  // -------------------------------------------------------------------------
  if (PROVIDER === 'mock') {
    try {
      const raw = await getMockResponse(agent, input);
      const value = parseOutput(raw);
      span.complete({ tokens_in: 0, tokens_out: 0 });
      logSpanEvent(traceId, 'span.completed', { agent, provider: 'mock' });
      return value;
    } catch (err) {
      span.fail(err);
      logSpanEvent(traceId, 'span.failed', { agent, provider: 'mock', error: String(err) });
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Real LLM path (Anthropic or Ollama)
  // -------------------------------------------------------------------------
  const systemPrompt = loadAndRenderPrompt(agent, input);
  const messages: ChatMessage[] = [{ role: 'user', content: userMessage }];

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      span.incrementRetry();
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logSpanEvent(traceId, 'span.retry', { agent, attempt, delay_ms: delay });
      await sleep(delay);
    }

    try {
      const raw = await callWithTimeout(
        { model, maxTokens: AGENT_MAX_TOKENS[agent], temperature, system: systemPrompt, messages },
        timeoutMs
      );

      const parsed = tryParse(raw, parseOutput);

      if (parsed.ok) {
        span.complete({ tokens_in: parsed.tokens_in, tokens_out: parsed.tokens_out });
        logSpanEvent(traceId, 'span.completed', {
          agent,
          provider: PROVIDER,
          latency_ms: tracer.snapshot().spans.at(-1)?.latency_ms,
        });
        return parsed.value;
      }

      // JSON parse failed — one repair attempt before retrying
      if (attempt === 0 && span.retryCount === 0) {
        const repaired = await attemptRepair(
          { model, maxTokens: AGENT_MAX_TOKENS[agent], temperature, system: systemPrompt },
          messages,
          raw.text,
          parsed.error,
          parseOutput
        );

        if (repaired.ok) {
          span.recordRepairAttempt(true);
          span.complete({ tokens_in: repaired.tokens_in, tokens_out: repaired.tokens_out });
          logSpanEvent(traceId, 'span.completed', { agent, repair_used: true });
          return repaired.value;
        }

        span.recordRepairAttempt(false);
        lastError = new Error(`JSON parse failed after repair: ${repaired.error}`);
        continue;
      }

      lastError = new Error(`JSON parse failed: ${parsed.error}`);
      continue;
    } catch (err) {
      lastError = err;
      if (err instanceof TimeoutError) break;
    }
  }

  span.fail(lastError);
  logSpanEvent(traceId, 'span.failed', {
    agent,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    retry_count: span.retryCount,
  });
  throw lastError;
}

// ---------------------------------------------------------------------------
// Provider-agnostic HTTP call layer
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface RawResponse {
  text: string;
  tokens_in?: number;
  tokens_out?: number;
}

async function callWithTimeout(
  params: {
    model: string;
    maxTokens: number;
    temperature: number;
    system: string;
    messages: ChatMessage[];
  },
  timeoutMs: number
): Promise<RawResponse> {
  const callPromise =
    PROVIDER === 'anthropic'
      ? callAnthropic(params)
      : callOllama(params);

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs)
  );

  return Promise.race([callPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// Anthropic provider
// ---------------------------------------------------------------------------

async function callAnthropic(params: {
  model: string;
  maxTokens: number;
  temperature: number;
  system: string;
  messages: ChatMessage[];
}): Promise<RawResponse> {
  // Dynamic import so the module doesn't error when USE_MOCK_LLM=true
  // and @anthropic-ai/sdk is not installed.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: params.model,
    max_tokens: params.maxTokens,
    temperature: params.temperature,
    system: params.system,
    messages: params.messages,
  });

  const content = response.content[0];
  if (content.type !== 'text') throw new Error(`Unexpected content type: ${content.type}`);

  return {
    text: content.text,
    tokens_in: response.usage?.input_tokens,
    tokens_out: response.usage?.output_tokens,
  };
}

// ---------------------------------------------------------------------------
// Ollama provider
// Ollama exposes an OpenAI-compatible /v1/chat/completions endpoint.
// No SDK required — plain fetch works perfectly.
// ---------------------------------------------------------------------------

async function callOllama(params: {
  model: string;
  maxTokens: number;
  temperature: number;
  system: string;
  messages: ChatMessage[];
}): Promise<RawResponse> {
  const url = `${OLLAMA_BASE_URL}/v1/chat/completions`;

  const body = {
    model: params.model,
    temperature: params.temperature,
    // Ollama respects max_tokens as num_predict
    max_tokens: params.maxTokens,
    messages: [
      { role: 'system', content: params.system },
      ...params.messages,
    ],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '(no body)');
    throw new Error(
      `Ollama request failed: ${response.status} ${response.statusText}\n${errorText}\n` +
      `Is Ollama running? Try: ollama serve`
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Ollama returned an empty response.');

  return {
    text,
    tokens_in: data.usage?.prompt_tokens,
    tokens_out: data.usage?.completion_tokens,
  };
}

// ---------------------------------------------------------------------------
// Repair prompt — sent when JSON parsing fails on first attempt
// ---------------------------------------------------------------------------

async function attemptRepair<T>(
  params: { model: string; maxTokens: number; temperature: number; system: string },
  originalMessages: ChatMessage[],
  malformedOutput: string,
  parseError: string,
  parseOutput: (text: string) => T
): Promise<ParseResult<T>> {
  const repairMessages: ChatMessage[] = [
    ...originalMessages,
    { role: 'assistant', content: malformedOutput },
    {
      role: 'user',
      content:
        `Your previous response could not be parsed as valid JSON. ` +
        `Parse error: ${parseError}\n\n` +
        `Please rewrite your response as a valid JSON object only — ` +
        `no markdown code fences, no prose before or after, just the JSON object.`,
    },
  ];

  try {
    const repaired = await callWithTimeout(
      { ...params, temperature: 0, messages: repairMessages },
      DEFAULT_TIMEOUT_MS
    );
    return tryParse(repaired, parseOutput);
  } catch (err) {
    return {
      ok: false,
      error: `Repair call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

type ParseResult<T> =
  | { ok: true; value: T; tokens_in?: number; tokens_out?: number }
  | { ok: false; error: string };

function tryParse<T>(raw: RawResponse, parseOutput: (text: string) => T): ParseResult<T> {
  try {
    return { ok: true, value: parseOutput(raw.text), tokens_in: raw.tokens_in, tokens_out: raw.tokens_out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

function loadAndRenderPrompt(agent: AgentName, vars: Record<string, unknown>): string {
  const promptFile = AGENT_PROMPT_FILE[agent];
  if (!promptFile) throw new Error(`Agent "${agent}" has no system prompt.`);
  const template = readFileSync(join(PROMPTS_DIR, promptFile), 'utf-8');
  return renderTemplate(template, vars);
}

function renderTemplate(template: string, vars: Record<string, unknown>): string {
  let result = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, varName: string, content: string) => {
      const value = vars[varName];
      const present =
        value !== undefined && value !== null && value !== '' &&
        !(Array.isArray(value) && value.length === 0);
      return present ? content : '';
    }
  );
  result = result.replace(/\{\{(\w+)\}\}/g, (_, varName: string) => {
    const value = vars[varName];
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`LLM call timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extracts and parses JSON from a model response.
 * Strips markdown code fences if present.
 * Throws a descriptive error if no valid JSON is found.
 */
export function extractJson<T = Record<string, unknown>>(raw: string): T {
  const stripped = raw
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(stripped) as T;
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]) as T; } catch { /* fall through */ }
    }
    throw new Error(`Could not extract JSON. First 200 chars: ${raw.slice(0, 200)}`);
  }
}
