/**
 * Formats eval results for two audiences:
 *   - Terminal output (for local runs and CI logs)
 *   - GitHub Markdown (for PR comments, posted by the CI bot)
 *
 * Both formats compare against the stored baseline so that regressions
 * and improvements are always presented relatively, not as raw numbers.
 */

import { AgentName, Baselines, EvalResult, HardCheckResult } from './types.js';

// ---------------------------------------------------------------------------
// Internal summary type
// ---------------------------------------------------------------------------

interface AgentSummary {
  agent: AgentName;
  results: EvalResult[];
  hardPass: boolean;
  /** Average soft score per criterion ID, across all golden examples for this agent */
  softScores: Record<string, number>;
  overallSoftScore: number;
  overallSoftNormalized: number;
  failures: EvalResult[];
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function groupByAgent(
  results: EvalResult[]
): Array<{ agent: AgentName; results: EvalResult[] }> {
  const map = new Map<AgentName, EvalResult[]>();
  for (const r of results) {
    const agent = r.example.agent;
    if (!map.has(agent)) map.set(agent, []);
    map.get(agent)!.push(r);
  }
  return Array.from(map.entries()).map(([agent, agentResults]) => ({
    agent,
    results: agentResults,
  }));
}

function summarizeAgent(agent: AgentName, results: EvalResult[]): AgentSummary {
  const hardPass = results.every(
    (r) => r.rule_pass && (r.judge_output?.overall.hard_pass ?? true)
  );

  const failures = results.filter(
    (r) => !r.rule_pass || r.judge_output?.overall.regression === true
  );

  // Average soft scores per criterion across all examples that have judge output
  const rawScores: Record<string, number[]> = {};
  for (const r of results) {
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

  return {
    agent,
    results,
    hardPass,
    softScores,
    overallSoftScore,
    overallSoftNormalized,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Delta formatting
// ---------------------------------------------------------------------------

function formatDeltaTerminal(
  current: number,
  baseline: number | undefined
): string {
  if (baseline === undefined) return '(no baseline)';
  const delta = current - baseline;
  if (Math.abs(delta) < 0.05) return '(no change)';
  const sign = delta > 0 ? '+' : '';
  const icon = delta > 0 ? '↑' : '↓';
  return `${icon} ${sign}${delta.toFixed(2)}`;
}

function formatDeltaMarkdown(
  current: number,
  baseline: number | undefined
): string {
  if (baseline === undefined) return '—';
  const delta = current - baseline;
  if (Math.abs(delta) < 0.05) return '→';
  const sign = delta > 0 ? '+' : '';
  const icon = delta > 0 ? '✅' : '⚠️';
  return `${sign}${delta.toFixed(2)} ${icon}`;
}

// ---------------------------------------------------------------------------
// Failed-check summary helpers
// ---------------------------------------------------------------------------

function failedChecks(result: EvalResult): HardCheckResult[] {
  return result.rule_checks.filter((c) => c.result === 'FAIL');
}

// ---------------------------------------------------------------------------
// Terminal renderer
// ---------------------------------------------------------------------------

function renderTerminal(summaries: AgentSummary[], baselines: Baselines): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('══════════════════════════════════════');
  lines.push('  Prompt Eval Results');
  lines.push('══════════════════════════════════════');

  for (const s of summaries) {
    const baseline = baselines[s.agent];
    lines.push('');
    lines.push(`  Agent: ${s.agent}`);
    lines.push(
      `  Hard constraints: ${s.hardPass ? '✅  PASS' : '❌  FAIL — regression detected'}`
    );

    if (Object.keys(s.softScores).length > 0) {
      const maxPossible = Object.keys(s.softScores).length * 3;
      const baselineSoft = baseline?.overall_soft_normalized;
      const delta = formatDeltaTerminal(s.overallSoftNormalized, baselineSoft);
      lines.push(
        `  Soft score:       ${s.overallSoftScore.toFixed(1)} / ${maxPossible}  (${(s.overallSoftNormalized * 100).toFixed(0)}%)  ${delta}`
      );

      for (const [id, score] of Object.entries(s.softScores)) {
        const baselineScore = baseline?.soft_scores[id];
        const d = formatDeltaTerminal(score, baselineScore);
        lines.push(`    ${id.padEnd(12)} ${score.toFixed(2)} / 3.00  ${d}`);
      }
    }

    if (s.failures.length > 0) {
      lines.push('');
      lines.push(`  Failures (${s.failures.length}):`);
      for (const f of s.failures) {
        const checks = failedChecks(f);
        const checkIds = checks.map((c) => c.id).join(', ');
        lines.push(`    [${f.example.id}] ${f.example.label}`);
        if (checkIds) lines.push(`      Rule failures: ${checkIds}`);
        if (f.judge_output?.overall.summary) {
          lines.push(`      Judge: ${f.judge_output.overall.summary}`);
        }
        if (f.error) {
          lines.push(`      Error: ${f.error}`);
        }
      }
    }
  }

  lines.push('');
  lines.push('══════════════════════════════════════');

  const totalHardPass = summaries.every((s) => s.hardPass);
  lines.push(
    totalHardPass
      ? '  Overall: ✅  No hard regressions.'
      : '  Overall: ❌  Hard regressions detected — CI will fail.'
  );
  lines.push('══════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Markdown renderer (GitHub PR comment)
// ---------------------------------------------------------------------------

function renderMarkdown(
  summaries: AgentSummary[],
  baselines: Baselines
): string {
  const lines: string[] = [];

  const anyHardFail = summaries.some((s) => !s.hardPass);
  const headline = anyHardFail
    ? '## ❌ Prompt Eval — Hard Regressions Detected'
    : '## ✅ Prompt Eval — All Hard Constraints Pass';

  lines.push(headline);
  lines.push('');

  for (const s of summaries) {
    const baseline = baselines[s.agent];

    lines.push(`### \`${s.agent}\``);
    lines.push('');
    lines.push(
      `**Hard constraints:** ${s.hardPass ? '✅ All pass' : '❌ One or more failed'}`
    );
    lines.push('');

    if (Object.keys(s.softScores).length > 0) {
      const maxPossible = Object.keys(s.softScores).length * 3;
      lines.push('**Soft quality scores:**');
      lines.push('');
      lines.push('| Criterion | Score | vs. Baseline |');
      lines.push('|-----------|------:|:-------------|');
      for (const [id, score] of Object.entries(s.softScores)) {
        const baselineScore = baseline?.soft_scores[id];
        lines.push(
          `| \`${id}\` | ${score.toFixed(2)} / 3.00 | ${formatDeltaMarkdown(score, baselineScore)} |`
        );
      }
      lines.push('');

      const overallDelta = formatDeltaMarkdown(
        s.overallSoftNormalized,
        baseline?.overall_soft_normalized
      );
      lines.push(
        `**Overall soft score:** ${s.overallSoftScore.toFixed(1)} / ${maxPossible} ` +
          `(${(s.overallSoftNormalized * 100).toFixed(0)}%)  ${overallDelta}`
      );
    } else {
      lines.push('_No soft scores — judge was skipped (hard checks failed or --skip-judge used)._');
    }

    if (s.failures.length > 0) {
      lines.push('');
      lines.push(`**Failures (${s.failures.length}):**`);
      lines.push('');
      for (const f of s.failures) {
        const checks = failedChecks(f);
        lines.push(
          `- \`${f.example.id}\` — **${f.example.label}**`
        );
        if (checks.length > 0) {
          for (const c of checks) {
            lines.push(`  - ${c.id}: ${c.reasoning}`);
          }
        }
        if (f.judge_output?.overall.summary) {
          lines.push(`  - Judge summary: _${f.judge_output.overall.summary}_`);
        }
        if (f.error) {
          lines.push(`  - Error: \`${f.error}\``);
        }
      }
    }

    lines.push('');
  }

  lines.push('---');
  lines.push(
    '_To update baselines after an intentional improvement, run:_  '
  );
  lines.push('```');
  lines.push('npx tsx evals/runner.ts --update-baseline');
  lines.push('```');
  lines.push(
    '_Commit the resulting changes to `evals/baselines.json` as part of this PR._'
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface Report {
  terminal: string;
  markdown: string;
  /** True if any agent has a hard constraint failure — causes CI exit code 1 */
  hasRegressions: boolean;
}

export function buildReport(results: EvalResult[], baselines: Baselines): Report {
  const groups = groupByAgent(results);
  const summaries = groups.map(({ agent, results: r }) =>
    summarizeAgent(agent, r)
  );

  const hasRegressions = summaries.some((s) => !s.hardPass);

  return {
    terminal: renderTerminal(summaries, baselines),
    markdown: renderMarkdown(summaries, baselines),
    hasRegressions,
  };
}
