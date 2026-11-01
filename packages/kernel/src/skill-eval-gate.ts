import type { ArtifactDelivery, ExecutionV1 } from "./domain/execution.ts";
import { claimGateRun, settleGateRun, type CompletionWitnessResult } from "./domain/gate-run.ts";
import { judgeGateWitnesses } from "./domain/closeout-readiness.ts";
import { completionEvidenceBasis, type CompletionEvidenceV1 } from "./domain/completion-evidence.ts";
import { validateCompletionGateWitnessV1, type CompletionGateWitnessV1 } from "./domain/completion-gate-witness.ts";
import { resolveCompletionContract } from "./domain/completion-contract.ts";
import { completionPredicateIssues } from "./schemas/completion-predicate.ts";
import { sha256Text, stableStringify } from "./integrity/stable-hash.ts";
import { consumeKnownError } from "./error-consumption.ts";

export const SKILL_EVAL_GATE = "skill-eval";
export const SKILL_EVAL_SOURCE = "ha-skill-platform-run";
export const SKILL_EVAL_PREDICATE = "ha.skill-eval/v1";

export interface SkillEvalCaseExpectation {
  readonly contains?: readonly string[];
  readonly regex?: readonly { readonly pattern: string; readonly flags?: string }[];
  readonly json?: Readonly<Record<string, unknown>>;
  readonly forbidden?: readonly string[];
}

export interface SkillEvalCaseInput {
  readonly id: string;
  readonly output: string;
  readonly expect?: SkillEvalCaseExpectation;
  readonly hidden?: boolean;
}

export interface SkillEvalDraftContract {
  readonly usageMarker?: string;
  readonly requiredText?: readonly string[];
}

export interface SkillEvalCaseResult {
  readonly id: string;
  readonly hidden: boolean;
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly output: string;
}

export interface SkillEvalOutcome {
  readonly skillId: string;
  readonly version: string;
  readonly versionDigest: string;
  readonly evaluationId: string;
  readonly outputs: readonly { readonly caseId: string; readonly output: string }[];
  readonly passed: number;
  readonly total: number;
  readonly threshold: number;
  readonly occurredAt: string;
}

export interface SkillEvalJudgment {
  readonly execution: ExecutionV1;
  readonly witness: CompletionGateWitnessV1;
  readonly status: string;
}

const declaration = {
  sources: {
    [SKILL_EVAL_SOURCE]: {
      kind: "command" as const,
      entrypoint: "builtin:skill-eval",
      predicateType: SKILL_EVAL_PREDICATE,
      resultSchema: {
        type: "object",
        additionalProperties: false,
        required: ["passed", "total", "threshold", "versionDigest"],
        properties: {
          passed: { type: "integer", minimum: 0 },
          total: { type: "integer", minimum: 1 },
          threshold: { type: "number", exclusiveMinimum: 0, maximum: 1 },
          versionDigest: { type: "string", pattern: "^[a-f0-9]{64}$" },
        },
      },
    },
  },
  gates: {
    [SKILL_EVAL_GATE]: {
      source: SKILL_EVAL_SOURCE,
      appliesTo: "artifacts" as const,
      subjects: "all-artifacts" as const,
    },
  },
  closeoutDefaults: {},
};

const owner = { principal: { personId: "system:skill-eval" }, executor: null } as const;
const runner = {
  principal: { personId: "system:skill-eval" },
  executor: { kind: "agent" as const, id: `completion-source:${SKILL_EVAL_SOURCE}` },
};

/** Score only mechanical expectations. Hidden-case presentation is enforced by the daemon runner. */
export function evaluateSkillCase(skill: SkillEvalDraftContract, item: SkillEvalCaseInput): SkillEvalCaseResult {
  const failures: string[] = [],
    output = item.output;
  if (skill.usageMarker && !output.includes(skill.usageMarker)) failures.push("missing skill usage marker");
  for (const text of skill.requiredText ?? [])
    if (!output.includes(text)) failures.push(`missing required skill text: ${text}`);
  for (const text of item.expect?.contains ?? []) {
    if (!text) throw skillEvalError("VALIDATION_ERROR", "expected text must not be empty");
    if (!output.includes(text)) failures.push(`missing expected text: ${text}`);
  }
  for (const rule of item.expect?.regex ?? []) {
    const expression = compileExpectationRegex(rule);
    if (!expression.test(output)) failures.push(`regular expression did not match: ${rule.pattern}`);
  }
  if (item.expect?.json) {
    const parsed = firstJsonObject(output);
    if (!parsed) failures.push("output contains no parseable JSON object");
    else {
      for (const [key, expected] of Object.entries(item.expect.json)) {
        if (!Object.hasOwn(parsed, key)) failures.push(`JSON object is missing field: ${key}`);
        else if (expected !== null && stableStringify(parsed[key]) !== stableStringify(expected))
          failures.push(`JSON field does not match expectation: ${key}`);
      }
    }
  }
  for (const word of item.expect?.forbidden ?? []) {
    if (!word) throw skillEvalError("VALIDATION_ERROR", "forbidden text must not be empty");
    if (output.includes(word)) failures.push(`forbidden text present: ${word}`);
  }
  return {
    id: item.id,
    hidden: item.hidden === true,
    pass: failures.length === 0,
    failures,
    output: output.slice(0, 4000),
  };
}

/** Build one skill evaluation cut and judge it with the same gate-run rules used by task witnesses. */
export function judgeSkillEvaluation(input: SkillEvalOutcome): SkillEvalJudgment {
  validateOutcome(input);
  const digest = `sha256:${sha256Text(stableStringify(declaration))}`;
  const resolved = resolveCompletionContract([SKILL_EVAL_GATE], { gates: [] }, { digest, completion: declaration });
  if (!resolved.ok) throw skillEvalError("INVALID_COMPLETION_CONTRACT", resolved.message);

  const artifacts: ArtifactDelivery[] = input.outputs.map(({ caseId, output }) => ({
    path: `case/${caseId}`,
    revision: 1,
    blobSha256: sha256Text(output),
  }));
  const taskId = `skill:${input.skillId}@${input.version}`;
  const execution: ExecutionV1 = {
    schema: "execution/v1",
    gateRuns: [],
    executionId: `skill-eval:${input.evaluationId}`,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor: owner,
    claimedAt: input.occurredAt,
    submittedAt: input.occurredAt,
    closedAt: null,
    submission: {
      commitSha: null,
      artifacts,
      completionClaim: `Skill evaluation ${input.skillId}@${input.version}`,
      deliverables: artifacts.map(({ path }) => path),
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      completionContract: resolved.contract,
    },
  };
  const requirement = resolved.contract.gates[0];
  if (!requirement) throw skillEvalError("INVALID_COMPLETION_CONTRACT", "skill evaluation gate was not resolved");
  const runId = `gate-${input.evaluationId}`;
  const run = claimGateRun({
    execution,
    repoId: "harness-anything",
    requirement,
    runId,
    claimFence: 1,
    actor: runner,
    occurredAt: input.occurredAt,
    expiresAt: new Date(Date.parse(input.occurredAt) + 60 * 60 * 1000).toISOString(),
  });
  const claimedExecution: ExecutionV1 = { ...execution, gateRuns: [run] };
  const result = input.passed / input.total >= input.threshold ? "pass" : "fail";
  const predicate = {
    passed: input.passed,
    total: input.total,
    threshold: input.threshold,
    versionDigest: input.versionDigest,
  };
  const witnessResult: CompletionWitnessResult = {
    result,
    subjects: artifacts,
    predicateType: SKILL_EVAL_PREDICATE,
    predicate,
    diagnostic: `Skill evaluation passed ${input.passed} of ${input.total} cases at threshold ${input.threshold}.`,
  };
  const issues = completionPredicateIssues(requirement, witnessResult, artifacts, () => undefined);
  if (issues.length) throw skillEvalError("INVALID_PROOF", issues.join("; "));

  const evidence: CompletionEvidenceV1 = {
    schema: "completion-evidence/v1",
    subjects: artifacts,
    predicateType: SKILL_EVAL_PREDICATE,
    predicate,
    diagnostic: witnessResult.diagnostic,
    evidenceId: run.runId,
    checkerId: SKILL_EVAL_GATE,
    gateId: SKILL_EVAL_GATE,
    result,
    observed: true,
    basis: completionEvidenceBasis(claimedExecution),
    provenance: {
      source: "runner",
      adapterId: SKILL_EVAL_SOURCE,
      runId: run.runId,
      claimFence: run.claimFence,
      rawResult: `platform-run:${input.evaluationId}`,
    },
  };
  const witness: CompletionGateWitnessV1 = {
    schema: "completion-gate-witness/v1",
    subjects: evidence.subjects,
    predicateType: evidence.predicateType,
    predicate: evidence.predicate,
    diagnostic: evidence.diagnostic,
    witnessId: `gate-${input.evaluationId}`,
    receiptId: `skill-eval-${input.evaluationId}`,
    checkerId: SKILL_EVAL_GATE,
    gateId: SKILL_EVAL_GATE,
    result,
    taskId,
    executionId: execution.executionId,
    commitSha: null,
    iteration: 0,
    actor: runner,
    source: "local",
    verifiedAt: input.occurredAt,
    observed: evidence.observed,
    basis: evidence.basis,
    provenance: evidence.provenance,
  };
  const witnessIssues = validateCompletionGateWitnessV1(witness);
  if (witnessIssues.length)
    throw skillEvalError("INVALID_PROOF", witnessIssues.map(({ message }) => message).join("; "));
  const settledRun = settleGateRun({
    execution: claimedExecution,
    runId,
    claimFence: run.claimFence,
    actor: runner,
    occurredAt: input.occurredAt,
    outcome: { availability: "available", result, diagnostic: evidence.diagnostic },
  });
  const settledExecution: ExecutionV1 = { ...claimedExecution, gateRuns: [settledRun] };
  return {
    execution: settledExecution,
    witness,
    status: judgeGateWitnesses([witness], settledExecution, SKILL_EVAL_GATE, requirement).status,
  };
}

function validateOutcome(input: SkillEvalOutcome): void {
  const validText = (value: string) => typeof value === "string" && value.length > 0;
  if (
    !input ||
    typeof input !== "object" ||
    !validText(input.skillId) ||
    !validText(input.version) ||
    !/^[a-f0-9]{64}$/u.test(input.versionDigest) ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(input.evaluationId) ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(input.occurredAt) ||
    !Number.isSafeInteger(input.total) ||
    input.total < 1 ||
    !Number.isSafeInteger(input.passed) ||
    input.passed < 0 ||
    input.passed > input.total ||
    !(input.threshold > 0 && input.threshold <= 1) ||
    !Array.isArray(input.outputs) ||
    input.outputs.length !== input.total ||
    new Set(input.outputs.map(({ caseId }) => caseId)).size !== input.outputs.length ||
    input.outputs.some(({ caseId, output }) => !/^[A-Za-z0-9_-]{1,64}$/u.test(caseId) || typeof output !== "string")
  )
    throw skillEvalError("VALIDATION_ERROR", "skill evaluation outcome is invalid or incomplete");
}

function compileExpectationRegex(rule: { readonly pattern: string; readonly flags?: string }): RegExp {
  const flags = rule.flags ?? "";
  if (
    typeof rule.pattern !== "string" ||
    rule.pattern.length > 512 ||
    /[^imsu]/u.test(flags) ||
    new Set(flags).size !== flags.length
  )
    throw skillEvalError("VALIDATION_ERROR", "regular expression pattern or flags are invalid");
  try {
    return new RegExp(rule.pattern, flags);
  } catch {
    throw skillEvalError("VALIDATION_ERROR", "regular expression pattern is invalid");
  }
}

function firstJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0,
    inString = false,
    escaped = false;
  for (let index = start; index < text.length && index - start < 200_000; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try {
        const value: unknown = JSON.parse(text.slice(start, index + 1));
        return value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        consumeKnownError(error);
        return null;
      }
    }
  }
  return null;
}

function skillEvalError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
/** @slice-activation kernel skill evaluation gate is consumed by preset skill execution. */
