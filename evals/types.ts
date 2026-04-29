/**
 * Shared types for the Tarot prompt eval harness.
 */

export type AgentName =
  | 'intention-clarifier'
  | 'card-interpreter'
  | 'spread-synthesizer'
  | 'reflection-prompter';

// ---------------------------------------------------------------------------
// Golden examples
// ---------------------------------------------------------------------------

export interface GoldenExample {
  /** Unique identifier, e.g. "ci_001" */
  id: string;
  agent: AgentName;
  /** Short slug describing the case, e.g. "major_arcana_reversed_present" */
  label: string;
  /** Human-readable explanation of what this case is testing */
  description: string;
  /** Template variables injected into the agent's system prompt */
  input: Record<string, string | string[] | boolean | null>;
  /**
   * An exemplary hand-written output for this input.
   * Used as a quality anchor for the LLM judge — NOT for exact-match comparison.
   */
  reference_output: string;
}

// ---------------------------------------------------------------------------
// Hard constraint checks (rule-based, no LLM)
// ---------------------------------------------------------------------------

export interface HardCheckResult {
  id: string;
  result: 'PASS' | 'FAIL' | 'N/A';
  reasoning: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Soft criteria (LLM judge)
// ---------------------------------------------------------------------------

export interface SoftCriterionResult {
  id: string;
  score: 1 | 2 | 3;
  reasoning: string;
}

export interface JudgeOutput {
  hard_constraints: Record<string, HardCheckResult>;
  soft_criteria: Record<string, SoftCriterionResult>;
  overall: {
    hard_pass: boolean;
    soft_score: number;
    soft_score_normalized: number;
    regression: boolean;
    summary: string;
  };
}

// ---------------------------------------------------------------------------
// Eval results
// ---------------------------------------------------------------------------

export interface EvalResult {
  example: GoldenExample;
  /** Raw string returned by the agent */
  agent_output: string;
  /** Parsed JSON from agent output, or null if unparseable */
  parsed_output: Record<string, unknown> | null;
  /** Results of rule-based hard checks */
  rule_checks: HardCheckResult[];
  /** True if all rule-based hard checks passed */
  rule_pass: boolean;
  /** LLM judge output — null if rule checks failed or judge was skipped */
  judge_output: JudgeOutput | null;
  duration_ms: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

export interface AgentBaseline {
  /** Average soft score per criterion ID */
  soft_scores: Record<string, number>;
  overall_soft_score: number;
  /** overall_soft_score / (num_criteria * 3) */
  overall_soft_normalized: number;
  evaluated_at: string;
  /** Git SHA of the commit this baseline was captured on */
  commit: string;
}

export interface Baselines {
  [agent: string]: AgentBaseline;
}
