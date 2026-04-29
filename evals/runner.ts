/**
 * Prompt eval runner — main entry point.
 *
 * Usage:
 *   npx tsx evals/runner.ts [options]
 *
 * Options:
 *   --agent=<name>       Run only examples for a specific agent
 *   --example=<id>       Run a single golden example by ID
 *   --skip-judge         Run only rule-based hard checks (no LLM judge)
 *   --output=terminal    Print terminal-formatted results (default)
 *   --output=markdown    Print GitHub Markdown results to stdout
 *   --update-baseline    Update baselines.json with current scores after run
 *
 * Exit codes:
 *   0   All hard checks passed (soft regressions are warnings, not failures)
 *   1   One or more hard constraint failures detected
 *   2   Fatal configuration or I/O error
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { callAgent, parseAgentOutput } from './agent-caller.js';
import { runHardChecks, allHardChecksPassed } from './hard-checks.js';
import { runJudge } from './judge.js';
import { buildReport } from './reporter.js';
import {
  AgentName,
  Baselines,
  EvalResult,
  GoldenExample,
  AgentBaseline,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, 'golden');
const BASELINES_FILE = join(__dirname, 'baselines.json');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const agentFilter = getArg('--agent=') as AgentName | undefined;
const exampleFilter = getArg('--example=');
const skipJudge = args.includes('--skip-judge');
const updateBaseline = args.includes('--update-baseline');
const outputFormat = getArg('--output=') ?? 'terminal';

// ---------------------------------------------------------------------------
// Golden example loading
// ---------------------------------------------------------------------------

function loadGoldenExamples(): GoldenExample[] {
  if (!existsSync(GOLDEN_DIR)) {
    console.error(
      `[eval] Golden directory not found: ${GOLDEN_DIR}\n` +
        `       Create evals/golden/<agent-name>/*.json to add examples.`
    );
    process.exit(2);
  }

  const examples: GoldenExample[] = [];

  const agentDirs = readdirSync(GOLDEN_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name as AgentName);

  for (const agentDir of agentDirs) {
    if (agentFilter && agentDir !== agentFilter) continue;

    const agentPath = join(GOLDEN_DIR, agentDir);
    const files = readdirSync(agentPath).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const raw = readFileSync(join(agentPath, file), 'utf-8');
      const example = JSON.parse(raw) as GoldenExample;
      if (exampleFilter && example.id !== exampleFilter) continue;
      examples.push(example);
    }
  }

  return examples;
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

function loadBaselines(): Baselines {
  if (!existsSync(BASELINES_FILE)) return {};
  try {
    return JSON.parse(readFileSync(BASELINES_FILE, 'utf-8')) as Baselines;
  } catch {
    console.error('[eval] Warning: baselines.json could not be parsed. Treating as empty.');
    return {};
  }
}

function computeUpdatedBaselines(
  results: EvalResult[],
  existing: Baselines
): Baselines {
  const updated: Baselines = { ...existing };

  // Group by agent
  const byAgent = new Map<AgentName, EvalResult[]>();
  for (const r of results) {
    if (!byAgent.has(r.example.agent)) byAgent.set(r.example.agent, []);
    byAgent.get(r.example.agent)!.push(r);
  }

  for (const [agent, agentResults] of byAgent) {
    const rawScores: Record<string, number[]> = {};
    for (const r of agentResults) {
      if (!r.judge_output) continue;
      for (const [id, criterion] of Object.entries(r.judge_output.soft_criteria)) {
        if (!rawScores[id]) rawScores[id] = [];
        rawScores[id].push(criterion.score);
      }
    }

    const softScores: Record<string, number> = {};
    for (const [id, scores] of Object.entries(rawScores)) {
      softScores[id] = scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    const scoreValues = Object.values(softScores);
    const overallSoftScore = scoreValues.reduce((a, b) => a + b, 0);
    const maxPossible = scoreValues.length * 3;
    const overallSoftNormalized =
      maxPossible > 0 ? overallSoftScore / maxPossible : 0;

    const baseline: AgentBaseline = {
      soft_scores: softScores,
      overall_soft_score: overallSoftScore,
      overall_soft_normalized: overallSoftNormalized,
      evaluated_at: new Date().toISOString(),
      commit: process.env.GITHUB_SHA ?? 'local',
    };

    updated[agent] = baseline;
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Single example runner
// ---------------------------------------------------------------------------

async function runExample(example: GoldenExample): Promise<EvalResult> {
  const start = Date.now();

  try {
    // 1. Call the agent with the rendered system prompt
    const agentOutput = await callAgent(example);

    // 2. Parse JSON from agent output
    const parsedOutput = parseAgentOutput(agentOutput);

    // 3. Rule-based hard checks (fast, free)
    const ruleChecks = runHardChecks(
      example.agent,
      agentOutput,
      parsedOutput,
      example.input
    );
    const rulePass = allHardChecksPassed(ruleChecks);

    // 4. LLM judge — only runs if hard checks pass and judge not skipped
    let judgeOutput = null;
    if (rulePass && !skipJudge && parsedOutput !== null) {
      judgeOutput = await runJudge(example.agent, example, agentOutput);
    }

    return {
      example,
      agent_output: agentOutput,
      parsed_output: parsedOutput,
      rule_checks: ruleChecks,
      rule_pass: rulePass,
      judge_output: judgeOutput,
      duration_ms: Date.now() - start,
    };
  } catch (error) {
    return {
      example,
      agent_output: '',
      parsed_output: null,
      rule_checks: [],
      rule_pass: false,
      judge_output: null,
      duration_ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Validate ANTHROPIC_API_KEY is present
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[eval] Error: ANTHROPIC_API_KEY environment variable is not set.');
    process.exit(2);
  }

  console.error('[eval] Loading golden examples...');
  const examples = loadGoldenExamples();

  if (examples.length === 0) {
    console.error('[eval] No golden examples found. Nothing to run.');
    process.exit(0);
  }

  console.error(`[eval] Found ${examples.length} example(s). Running...`);
  if (skipJudge) console.error('[eval] --skip-judge: LLM judge disabled.');

  const results: EvalResult[] = [];

  // Run sequentially to avoid API rate limits.
  // For larger suites, consider batching with a concurrency limit.
  for (const example of examples) {
    console.error(`[eval]   ${example.id} (${example.agent}: ${example.label})...`);
    const result = await runExample(example);
    results.push(result);

    // Surface errors immediately so they're visible in CI logs
    if (result.error) {
      console.error(`[eval]   ⚠  Error: ${result.error}`);
    } else if (!result.rule_pass) {
      const failedIds = result.rule_checks
        .filter((c) => c.result === 'FAIL')
        .map((c) => c.id)
        .join(', ');
      console.error(`[eval]   ✗  Hard check failures: ${failedIds}`);
    } else {
      const softScore = result.judge_output?.overall.soft_score_normalized;
      const scoreStr =
        softScore !== undefined
          ? ` (soft: ${(softScore * 100).toFixed(0)}%)`
          : '';
      console.error(`[eval]   ✓${scoreStr}`);
    }
  }

  console.error('[eval] Building report...');
  const baselines = loadBaselines();
  const { terminal, markdown, hasRegressions } = buildReport(results, baselines);

  // Output report to stdout (captured by CI for PR comment or log display)
  if (outputFormat === 'markdown') {
    process.stdout.write(markdown + '\n');
  } else {
    process.stdout.write(terminal + '\n');
  }

  // Optionally update baselines
  if (updateBaseline) {
    const updatedBaselines = computeUpdatedBaselines(results, baselines);
    // Ensure output directory exists
    const baselinesDir = dirname(BASELINES_FILE);
    if (!existsSync(baselinesDir)) mkdirSync(baselinesDir, { recursive: true });
    writeFileSync(
      BASELINES_FILE,
      JSON.stringify(updatedBaselines, null, 2) + '\n'
    );
    console.error('[eval] baselines.json updated.');
  }

  // Exit 1 on hard regressions so CI fails the check
  if (hasRegressions) {
    console.error(
      '[eval] Hard constraint regressions detected. See report above for details.'
    );
    process.exit(1);
  }

  console.error('[eval] Done. No hard regressions.');
}

main().catch((err: unknown) => {
  console.error(
    '[eval] Fatal error:',
    err instanceof Error ? err.message : String(err)
  );
  process.exit(2);
});
