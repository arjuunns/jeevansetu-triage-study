import type { AgentType, SafetyScreenResult, TriageResult } from '@jeevansetu/types';

/**
 * Phase 12 — Supervisor Agent.
 *
 * The supervisor validates every other agent's output before it is allowed to
 * propagate. Validation is primarily DETERMINISTIC (the safety-consistency and
 * structural checks below), because patient-safety gating must not itself depend
 * on a probabilistic model. The verdict is attached to each AgentExecution.
 */
export interface SupervisorVerdict {
  agentType: AgentType;
  approved: boolean;
  issues: string[];
  notes: string;
}

/** Validate the triage agent's output against the deterministic safety verdict. */
export function superviseTriage(result: TriageResult, safety: SafetyScreenResult): SupervisorVerdict {
  const issues: string[] = [];

  // Hard rule: safety-critical patients must remain CRITICAL.
  if (safety.isCritical && result.severity !== 'CRITICAL') {
    issues.push('Triage severity is below CRITICAL despite a critical safety verdict (rules override AI).');
  }
  if (safety.isCritical && result.esiLevel !== 1) {
    issues.push('ESI level must be 1 for a safety-critical patient.');
  }
  // Structural sanity.
  if (result.confidence < 0 || result.confidence > 1) issues.push('Confidence out of [0,1] range.');
  if (!result.reasoning || result.reasoning.trim().length < 10) {
    issues.push('Reasoning is missing or too short — every recommendation must be explainable.');
  }
  if (result.possibleConditions.length === 0) issues.push('No possible conditions provided.');
  if (!result.recommendedDepartment) issues.push('No recommended department.');

  // Low-confidence high-severity outputs are allowed but flagged for the doctor.
  const notes =
    result.confidence < 0.5
      ? 'Low model confidence — doctor review is mandatory before any action.'
      : 'Output structurally valid and consistent with the safety verdict.';

  return { agentType: 'TRIAGE', approved: issues.length === 0, issues, notes };
}

/** Validate routing output: at least one candidate, scores in range, ordered. */
export function superviseRouting(candidates: { score: number }[]): SupervisorVerdict {
  const issues: string[] = [];
  if (candidates.length === 0) issues.push('Routing produced no candidate hospitals.');
  if (candidates.some((c) => c.score < 0 || c.score > 1)) issues.push('Candidate score out of [0,1] range.');
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i - 1]!.score < candidates[i]!.score) {
      issues.push('Candidates are not sorted by descending score.');
      break;
    }
  }
  return {
    agentType: 'ROUTING',
    approved: issues.length === 0,
    issues,
    notes: issues.length === 0 ? 'Ranked candidate list is well-formed.' : 'Routing output rejected.',
  };
}

/** Generic guard the orchestrator applies to any agent step. */
export function requireApproval(verdict: SupervisorVerdict): void {
  if (!verdict.approved) {
    throw new Error(
      `Supervisor rejected ${verdict.agentType} output: ${verdict.issues.join('; ')}`,
    );
  }
}
