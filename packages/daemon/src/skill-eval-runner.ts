import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  SKILL_EVAL_GATE,
  SKILL_EVAL_PREDICATE,
  SKILL_EVAL_SOURCE,
  consumeKnownError,
  evaluateSkillCase,
  judgeSkillEvaluation,
  type SkillEvalCaseInput,
  type SkillEvalCaseExpectation,
  type SkillEvalCaseResult,
  type SkillEvalDraftContract,
  type SkillEvalJudgment,
  type SkillEvalOutcome,
} from "@harness-anything/kernel";

const MAX_CASES = 20;
const MAX_CASE_ID = 64;
const MAX_INPUT_LENGTH = 20_000;

export type SkillEvalRole = "operator" | "admin" | "reviewer" | "drafter";

export interface SkillEvalScope {
  readonly principalId: string;
  readonly role: SkillEvalRole;
  /** A host may resolve project review authority without exposing its policy here. */
  readonly canReview?: boolean;
}

export interface SkillEvalSkill extends SkillEvalDraftContract {
  readonly skillId: string;
  readonly version: string;
  readonly digest?: string;
  readonly versionDigest?: string;
  readonly status: "draft" | "published";
  readonly createdBy: string;
  readonly name?: string;
  /** Rendered skill text mounted into the evaluation context. */
  readonly body?: string;
  readonly promptTemplate?: string;
}

export interface SkillEvalCase {
  readonly id: string;
  readonly input: string;
  readonly hidden: boolean;
  readonly expect?: SkillEvalCaseExpectation | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface SkillEvalCaseDraft {
  readonly id: string;
  readonly input: string;
  readonly hidden?: boolean;
  readonly expect?: SkillEvalCaseExpectation;
}

export interface SkillEvalCaseView {
  readonly id: string;
  readonly input: string | null;
  readonly hidden: boolean;
  readonly expect: SkillEvalCaseExpectation | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface SkillEvalStore {
  readonly getSkill: (skillId: string, version: string) => Promise<SkillEvalSkill | null> | SkillEvalSkill | null;
  readonly getLatestSkill?: (skillId: string) => Promise<SkillEvalSkill | null> | SkillEvalSkill | null;
  readonly listCases: (skillId: string) => Promise<readonly SkillEvalCase[]> | readonly SkillEvalCase[];
  readonly appendCase: (skillId: string, item: SkillEvalCase) => Promise<void> | void;
  readonly recordEvaluation?: (evaluation: SkillEvalRecord) => Promise<void> | void;
}

export interface SkillEvalSlotQueue {
  readonly acquire: (request: {
    readonly attemptId: string;
    readonly ownerKey: string;
    readonly flowKey: string;
  }) => Promise<void>;
  readonly release: (attemptId: string) => void;
}

export interface SkillEvalRuntimeBinding {
  readonly runtime: string;
  readonly profile?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly serviceTier?: string;
}

export interface SkillEvalRuntimeMessage {
  readonly role: string;
  readonly text: string;
}

export interface SkillEvalRuntimeResult {
  readonly status: string;
  readonly output?: string;
  readonly messages?: readonly SkillEvalRuntimeMessage[];
  readonly error?: string;
}

export interface SkillEvalRuntimeRequest {
  readonly attemptId: string;
  readonly cwd: string;
  readonly prompt: string;
  readonly context: { readonly body: string; readonly digest: string };
  readonly binding: SkillEvalRuntimeBinding;
}

export interface SkillEvalRuntimePort {
  readonly dispatch: (request: SkillEvalRuntimeRequest) => Promise<SkillEvalRuntimeResult>;
  readonly observe?: (attemptId: string) => Promise<SkillEvalRuntimeResult>;
  readonly stop?: (attemptId: string) => Promise<SkillEvalRuntimeResult>;
}

export interface SkillEvalRunnerOptions {
  readonly runRoot: string;
  readonly binding: SkillEvalRuntimeBinding | null;
  readonly queue?: SkillEvalSlotQueue;
  readonly clock?: () => Date;
  readonly nextEvaluationId?: () => string;
  readonly maxCases?: number;
}

export interface SkillEvalCaseResultRecord extends SkillEvalCaseView {
  readonly attemptId: string;
  readonly outputSha256: string | null;
  readonly runtimeStatus: string;
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly output: string;
}

export interface SkillEvalRecord {
  readonly id: string;
  readonly skillId: string;
  readonly version: string;
  readonly versionDigest: string;
  readonly result: "pass" | "fail";
  readonly passed: number;
  readonly total: number;
  readonly threshold: number;
  readonly cases: readonly SkillEvalCaseResultRecord[];
  readonly execution: SkillEvalJudgment["execution"];
  readonly witness: SkillEvalJudgment["witness"];
  readonly gateStatus: string;
  readonly gateId: typeof SKILL_EVAL_GATE;
  readonly source: typeof SKILL_EVAL_SOURCE;
  readonly predicateType: typeof SKILL_EVAL_PREDICATE;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface SkillEvalRunResult extends SkillEvalRecord {
  readonly runtime: SkillEvalRuntimeBinding;
}

/**
 * Runs platform-owned public and hidden cases against a frozen draft skill.
 * Case contents are read from the store only at run time; the caller never supplies hidden data.
 */
export class SkillEvalRunner {
  readonly #store: SkillEvalStore;
  readonly #runtime: SkillEvalRuntimePort;
  readonly #options: SkillEvalRunnerOptions;

  constructor(store: SkillEvalStore, runtime: SkillEvalRuntimePort, options: SkillEvalRunnerOptions);
  constructor(
    options: SkillEvalRunnerOptions & { readonly store: SkillEvalStore; readonly runtime: SkillEvalRuntimePort },
  );
  constructor(
    storeOrOptions:
      | SkillEvalStore
      | (SkillEvalRunnerOptions & { readonly store: SkillEvalStore; readonly runtime: SkillEvalRuntimePort }),
    runtime?: SkillEvalRuntimePort,
    options?: SkillEvalRunnerOptions,
  ) {
    if (runtime === undefined && "store" in storeOrOptions && "runtime" in storeOrOptions) {
      this.#store = storeOrOptions.store;
      this.#runtime = storeOrOptions.runtime;
      this.#options = storeOrOptions;
    } else {
      if (runtime === undefined || options === undefined)
        throw skillEvalRunnerError("VALIDATION_ERROR", "skill evaluation store, runtime, and options are required");
      this.#store = storeOrOptions as SkillEvalStore;
      this.#runtime = runtime;
      this.#options = options;
    }
    if (!this.#options || !path.isAbsolute(this.#options.runRoot))
      throw skillEvalRunnerError("VALIDATION_ERROR", "skill evaluation runRoot must be an absolute path");
  }

  async addCase(scope: SkillEvalScope, skillId: string, input: SkillEvalCaseDraft): Promise<SkillEvalCaseView> {
    const skill = await this.latestSkill(skillId);
    if (!skill) throw skillEvalRunnerError("NOT_FOUND", `skill ${skillId} was not found`);
    this.assertCurator(scope, skill);
    validateCaseDraft(input);
    const now = this.now().toISOString();
    const item: SkillEvalCase = {
      id: input.id,
      input: input.input,
      hidden: input.hidden === true,
      expect: input.expect ?? null,
      createdBy: scope.principalId,
      createdAt: now,
    };
    try {
      await this.#store.appendCase(skillId, item);
    } catch (error) {
      if (isConflict(error)) throw skillEvalRunnerError("CONFLICT", `evaluation case ${input.id} already exists`);
      throw error;
    }
    return publicCase(item);
  }

  async listCases(scope: SkillEvalScope, skillId: string): Promise<readonly SkillEvalCaseView[]> {
    const latest = await this.latestSkill(skillId);
    const cases = await this.#store.listCases(skillId);
    const mayCurateHidden =
      scope.role === "operator" ||
      (scope.role === "reviewer" && scope.canReview === true && latest?.createdBy !== scope.principalId);
    return cases.map((item) => (item.hidden && !mayCurateHidden ? redactedCase(item) : publicCase(item)));
  }

  async run(
    scope: SkillEvalScope,
    skillId: string,
    version: string,
    input: { readonly threshold?: number } = {},
  ): Promise<SkillEvalRunResult> {
    const skill = await this.#store.getSkill(skillId, version);
    if (!skill) throw skillEvalRunnerError("NOT_FOUND", `skill ${skillId}@${version} was not found`);
    if (!isOperator(scope) && !(scope.role === "reviewer" && scope.canReview === true))
      throw skillEvalRunnerError("FORBIDDEN", "only an operator or reviewer may run a skill evaluation");
    if (skill.status !== "draft")
      throw skillEvalRunnerError("INVALID_TRANSITION", "only draft skills may be evaluated");
    const binding = this.#options.binding;
    if (!binding) throw skillEvalRunnerError("EVAL_RUNTIME_UNAVAILABLE", "no admitted evaluation runtime is available");
    const threshold = input.threshold ?? 1;
    if (!(threshold > 0 && threshold <= 1))
      throw skillEvalRunnerError("VALIDATION_ERROR", "evaluation threshold must be in (0, 1]");
    const cases = [...(await this.#store.listCases(skillId))];
    const maxCases = this.#options.maxCases ?? MAX_CASES;
    if (!cases.length) throw skillEvalRunnerError("EVAL_CASES_REQUIRED", "at least one evaluation case is required");
    if (cases.length > maxCases)
      throw skillEvalRunnerError("VALIDATION_ERROR", `at most ${maxCases} evaluation cases are allowed`);
    const evaluationId = this.nextEvaluationId();
    const results: SkillEvalCaseResultRecord[] = [];
    const outputs: { readonly caseId: string; readonly output: string }[] = [];
    for (const item of cases) {
      const result = await this.runCase(skill, item, evaluationId, binding);
      results.push(result.record);
      outputs.push({ caseId: item.id, output: result.rawOutput });
    }
    const passed = results.filter((item) => item.pass).length;
    const total = results.length;
    const createdAt = this.now().toISOString();
    const outcome: SkillEvalOutcome = {
      skillId,
      version,
      versionDigest: skillDigest(skill),
      evaluationId,
      outputs,
      passed,
      total,
      threshold,
      occurredAt: createdAt,
    };
    const judged = judgeSkillEvaluation(outcome);
    const record: SkillEvalRecord = {
      id: evaluationId,
      skillId,
      version,
      versionDigest: skillDigest(skill),
      result: judged.status === "passed" ? "pass" : "fail",
      passed,
      total,
      threshold,
      cases: results,
      execution: judged.execution,
      witness: judged.witness,
      gateStatus: judged.status,
      gateId: SKILL_EVAL_GATE,
      source: SKILL_EVAL_SOURCE,
      predicateType: SKILL_EVAL_PREDICATE,
      createdBy: scope.principalId,
      createdAt,
    };
    await this.#store.recordEvaluation?.(record);
    return { ...record, runtime: binding };
  }

  async runCase(
    skill: SkillEvalSkill,
    item: SkillEvalCase,
    evaluationId: string,
    binding: SkillEvalRuntimeBinding,
  ): Promise<{ readonly record: SkillEvalCaseResultRecord; readonly rawOutput: string }> {
    const attemptId = `skill-eval-${evaluationId}-${item.id}`;
    const cwd = await this.sandboxDirectory(evaluationId, item.id);
    const body = mountSkill(skill);
    const prompt = `You are executing a platform skill evaluation. Follow the mounted skill exactly.\n\n${item.input}`;
    let runtimeStatus: string;
    let output = "";
    let acquired = false;
    try {
      if (this.#options.queue) {
        await this.#options.queue.acquire({ attemptId, ownerKey: "skill-eval", flowKey: `skill-eval:${evaluationId}` });
        acquired = true;
      }
      let observed = await this.#runtime.dispatch({
        attemptId,
        cwd,
        prompt,
        context: { body, digest: sha256(body) },
        binding,
      });
      let polls = 0;
      while (observed.status === "running" && this.#runtime.observe && polls++ < 1_000)
        observed = await this.#runtime.observe(attemptId);
      if (observed.status === "running" && this.#runtime.stop) observed = await this.#runtime.stop(attemptId);
      runtimeStatus = observed.status;
      output = runtimeOutput(observed);
    } catch (error) {
      consumeKnownError(error);
      runtimeStatus = `failed: ${errorText(error).slice(0, 200)}`;
    } finally {
      if (acquired) this.#options.queue!.release(attemptId);
    }
    const scored: SkillEvalCaseResult =
      runtimeStatus === "completed"
        ? scoreCase(skill, item, output)
        : {
            id: item.id,
            hidden: item.hidden,
            pass: false,
            failures: [`platform runtime did not complete (${runtimeStatus})`],
            output: "",
          };
    const visible = publicCase(item);
    return {
      rawOutput: output,
      record: {
        ...visible,
        attemptId,
        outputSha256: runtimeStatus === "completed" ? sha256(output) : null,
        runtimeStatus,
        pass: scored.pass,
        failures: scored.failures,
        output: scored.output,
      },
    };
  }

  assertCurator(scope: SkillEvalScope, _skill: SkillEvalSkill): void {
    if (!isOperator(scope) && !(scope.role === "reviewer" && scope.canReview === true))
      throw skillEvalRunnerError("FORBIDDEN", "only an operator or reviewer may maintain evaluation cases");
  }

  private async latestSkill(skillId: string): Promise<SkillEvalSkill | null> {
    return this.#store.getLatestSkill
      ? await this.#store.getLatestSkill(skillId)
      : await this.#store.getSkill(skillId, "latest");
  }

  private now(): Date {
    const value = this.#options.clock?.() ?? new Date();
    if (Number.isNaN(value.getTime()))
      throw skillEvalRunnerError("VALIDATION_ERROR", "evaluation clock returned an invalid date");
    return value;
  }

  private nextEvaluationId(): string {
    const value = this.#options.nextEvaluationId?.() ?? `eval-${Date.now().toString(36)}`;
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value))
      throw skillEvalRunnerError("VALIDATION_ERROR", "evaluation id is invalid");
    return value;
  }

  private async sandboxDirectory(evaluationId: string, caseId: string): Promise<string> {
    const root = path.resolve(this.#options.runRoot);
    const candidate = path.resolve(root, "skill-eval", evaluationId, caseId);
    const relative = path.relative(root, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw skillEvalRunnerError("VALIDATION_ERROR", "evaluation sandbox escaped its run root");
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    return candidate;
  }
}

function scoreCase(skill: SkillEvalSkill, item: SkillEvalCase, output: string): SkillEvalCaseResult {
  const input: SkillEvalCaseInput = {
    id: item.id,
    output,
    expect: item.expect ?? undefined,
    hidden: item.hidden,
  };
  return evaluateSkillCase(skill, input);
}

function validateCaseDraft(input: SkillEvalCaseDraft): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(input.id) || input.id.length > MAX_CASE_ID)
    throw skillEvalRunnerError("VALIDATION_ERROR", "evaluation case id is invalid");
  if (typeof input.input !== "string" || input.input.trim().length === 0 || input.input.length > MAX_INPUT_LENGTH)
    throw skillEvalRunnerError("VALIDATION_ERROR", "evaluation case input is invalid");
}

function publicCase(item: SkillEvalCase): SkillEvalCaseView {
  return {
    id: item.id,
    input: item.input,
    hidden: item.hidden,
    expect: item.expect ?? null,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
  };
}

function redactedCase(item: SkillEvalCase): SkillEvalCaseView {
  return { id: item.id, input: null, hidden: true, expect: null, createdBy: item.createdBy, createdAt: item.createdAt };
}

function mountSkill(skill: SkillEvalSkill): string {
  const digest = skillDigest(skill);
  return [
    `[Skill ${skill.skillId}@${skill.version} sha256=${digest}]${skill.name ? ` ${skill.name}` : ""}`,
    skill.body ?? "",
    skill.promptTemplate?.trim() ? `Prompt template:\n${skill.promptTemplate.trim()}` : "",
    skill.usageMarker ? `Usage marker: ${skill.usageMarker}` : "",
    "[/Skill]",
  ]
    .filter(Boolean)
    .join("\n");
}

function runtimeOutput(result: SkillEvalRuntimeResult): string {
  if (typeof result.output === "string") return result.output;
  return result.messages?.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
}

function skillDigest(skill: SkillEvalSkill): string {
  const digest = skill.digest ?? skill.versionDigest;
  if (!digest || !/^[a-f0-9]{64}$/u.test(digest))
    throw skillEvalRunnerError("VALIDATION_ERROR", "skill version digest must be a lowercase SHA-256 value");
  return digest;
}

function isOperator(scope: SkillEvalScope): boolean {
  return scope.role === "operator" || scope.role === "admin";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflict(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "CONFLICT"
  );
}

function skillEvalRunnerError(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
