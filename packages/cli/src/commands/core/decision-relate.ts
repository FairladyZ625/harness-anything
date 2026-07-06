import { readFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { readDecisionDocument, type DecisionWriteService, type DecisionWriteRejected } from "../../../../application/src/index.ts";
import { deriveRelationId, type DecisionPackage, type EntityRelationRecord, type WriteError } from "../../../../kernel/src/index.ts";
import { resolveHarnessLayout, taskDocumentPath, type HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { readFrontmatter, readScalar } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type DecisionRelateAction = Extract<ParsedCommand["action"], { readonly kind: "decision-relate" }>;
type DecisionRelationRetireAction = Extract<ParsedCommand["action"], { readonly kind: "decision-relation-retire" }>;
type DecisionRelationReplaceAction = Extract<ParsedCommand["action"], { readonly kind: "decision-relation-replace" }>;
type DecisionRelationCommand = "decision-relate" | "decision-relation-retire" | "decision-relation-replace";

export function runDecisionRelate(
  context: CommandRunnerContext,
  service: DecisionWriteService,
  action: DecisionRelateAction
): Effect.Effect<CliResult, WriteError> {
  const rootInput = context.layoutInput;
  let current: DecisionPackage;
  try {
    current = readDecisionDocument(rootInput, action.decisionId).decision;
  } catch {
    return Effect.succeed({
      ok: false,
      command: "decision-relate",
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult);
  }

  const relation = decisionRelation(current, action);
  if (!relation.ok) {
    return Effect.succeed({
      ok: false,
      command: "decision-relate",
      decisionId: current.decision_id,
      error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, relation.reason)
    } satisfies CliResult);
  }
  if (action.dryRun) return Effect.succeed(decisionRelateResult(rootInput, "decision-relate", current.decision_id, current.state, true));
  const taskWrites = materializedTaskPriorityWrites(rootInput, current, relation.record);
  if (!taskWrites.ok) {
    return Effect.succeed({
      ok: false,
      command: "decision-relate",
      decisionId: current.decision_id,
      error: taskWrites.error
    } satisfies CliResult);
  }
  return service.relate({ current, relation: relation.record, taskWrites: taskWrites.writes, body: action.body }).pipe(
    Effect.match({
      onFailure: (error): CliResult => decisionRelationFailure("decision-relate", current.decision_id, error),
      onSuccess: (result): CliResult => decisionRelateResult(rootInput, "decision-relate", result.decisionId, result.state, false)
    })
  );
}

export function runDecisionRelationRetire(
  rootInput: Parameters<typeof readDecisionDocument>[0],
  service: DecisionWriteService,
  action: DecisionRelationRetireAction
): Effect.Effect<CliResult, WriteError> {
  let current: DecisionPackage;
  try {
    current = readDecisionDocument(rootInput, action.decisionId).decision;
  } catch {
    return Effect.succeed({
      ok: false,
      command: "decision-relation-retire",
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult);
  }

  if (action.dryRun) return Effect.succeed(decisionRelateResult(rootInput, "decision-relation-retire", current.decision_id, current.state, true));
  return service.retireRelation({ current, relationId: action.relationId, body: action.body }).pipe(
    Effect.match({
      onFailure: (error): CliResult => decisionRelationFailure("decision-relation-retire", current.decision_id, error),
      onSuccess: (result): CliResult => decisionRelateResult(rootInput, "decision-relation-retire", result.decisionId, result.state, false)
    })
  );
}

export function runDecisionRelationReplace(
  context: CommandRunnerContext,
  service: DecisionWriteService,
  action: DecisionRelationReplaceAction
): Effect.Effect<CliResult, WriteError> {
  const rootInput = context.layoutInput;
  let current: DecisionPackage;
  try {
    current = readDecisionDocument(rootInput, action.decisionId).decision;
  } catch {
    return Effect.succeed({
      ok: false,
      command: "decision-relation-replace",
      decisionId: action.decisionId,
      error: cliError(CliErrorCode.DecisionReadFailed, `decision document could not be read: ${action.decisionId}`)
    } satisfies CliResult);
  }

  const relation = decisionRelation(current, action);
  if (!relation.ok) {
    return Effect.succeed({
      ok: false,
      command: "decision-relation-replace",
      decisionId: current.decision_id,
      error: cliError(CliErrorCode.InvalidDecisionEvidenceRelation, relation.reason)
    } satisfies CliResult);
  }
  if (action.dryRun) return Effect.succeed(decisionRelateResult(rootInput, "decision-relation-replace", current.decision_id, current.state, true));
  const taskWrites = materializedTaskPriorityWrites(rootInput, current, relation.record);
  if (!taskWrites.ok) {
    return Effect.succeed({
      ok: false,
      command: "decision-relation-replace",
      decisionId: current.decision_id,
      error: taskWrites.error
    } satisfies CliResult);
  }
  return service.replaceRelation({ current, relationId: action.relationId, replacement: relation.record, taskWrites: taskWrites.writes, body: action.body }).pipe(
    Effect.match({
      onFailure: (error): CliResult => decisionRelationFailure("decision-relation-replace", current.decision_id, error),
      onSuccess: (result): CliResult => decisionRelateResult(rootInput, "decision-relation-replace", result.decisionId, result.state, false)
    })
  );
}

function materializedTaskPriorityWrites(
  rootInput: HarnessLayoutInput,
  decision: DecisionPackage,
  relation: EntityRelationRecord
): { readonly ok: true; readonly writes: ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly body: string }> } | { readonly ok: false; readonly error: NonNullable<CliResult["error"]> } {
  if (relation.state !== "active" || relation.type !== "derives") return { ok: true, writes: [] };
  const taskId = taskIdFromTarget(relation.target);
  if (!taskId) return { ok: true, writes: [] };

  try {
    const body = readFileSync(taskDocumentPath(rootInput, taskId, "INDEX.md"), "utf8");
    const nextBody = seedTaskPriorityFrontmatter(body, decision);
    if (!nextBody) return { ok: true, writes: [] };
    return {
      ok: true,
      writes: [{
        taskId,
        path: "INDEX.md",
        body: nextBody
      }]
    };
  } catch {
    return { ok: false, error: cliError(CliErrorCode.TaskNotFound, `task not found for derives materialization: ${taskId}`) };
  }
}

function seedTaskPriorityFrontmatter(body: string, decision: DecisionPackage): string | null {
  const frontmatter = readFrontmatter(body);
  if (!frontmatter) throw new Error("task frontmatter missing");
  const additions = [
    ...(readScalar(frontmatter, "riskTier") ? [] : [`riskTier: ${decision.riskTier}`]),
    ...(readScalar(frontmatter, "urgency") ? [] : [`urgency: ${decision.urgency}`])
  ];
  if (additions.length === 0) return null;
  const nextFrontmatter = frontmatter.replace(/^packageDisposition:[^\n]*(?:\n|$)/mu, (line) => `${line.endsWith("\n") ? line : `${line}\n`}${additions.join("\n")}\n`);
  if (nextFrontmatter === frontmatter) throw new Error("task packageDisposition missing");
  return body.replace(`---\n${frontmatter}\n---`, `---\n${nextFrontmatter}\n---`);
}

function taskIdFromTarget(target: string): string | null {
  const match = /^task\/([^/]+)$/u.exec(target);
  return match?.[1] ?? null;
}

function decisionRelation(
  decision: DecisionPackage,
  action: DecisionRelateAction | DecisionRelationReplaceAction
): { readonly ok: true; readonly record: EntityRelationRecord } | { readonly ok: false; readonly reason: string } {
  const anchorIds = new Set([
    ...decision.claims.map((entry) => entry.id),
    ...decision.chosen.map((entry) => entry.id),
    ...decision.rejected.map((entry) => entry.id)
  ]);
  if (!anchorIds.has(action.anchor)) {
    return { ok: false, reason: `decision relation source anchor does not exist: ${action.anchor}` };
  }
  const base = {
    source: `decision/${decision.decision_id}/${action.anchor}`,
    target: action.target,
    type: action.relationType,
    strength: "strong",
    direction: "directed",
    origin: "declared",
    rationale: action.rationale,
    state: "active"
  } satisfies Omit<EntityRelationRecord, "relation_id">;
  return {
    ok: true,
    record: {
      relation_id: deriveRelationId(base),
      ...base
    }
  };
}

function decisionRelateResult(rootInput: HarnessLayoutInput, command: DecisionRelationCommand, decisionId: string, state: string, dryRun: boolean): CliResult {
  const layout = resolveHarnessLayout(rootInput);
  const documentPath = layout.decisionDocumentPath(decisionId);
  return {
    ok: true,
    command,
    decisionId,
    decisionState: state,
    path: path.relative(layout.rootDir, documentPath).split(path.sep).join("/"),
    report: { schema: "decision-write-cli-report/v1", dryRun }
  };
}

function decisionRelationFailure(command: DecisionRelationCommand, decisionId: string, error: DecisionWriteRejected | WriteError): CliResult {
  const reason = "_tag" in error && error._tag === "DecisionWriteRejected" ? error.reason : JSON.stringify(error);
  return {
    ok: false,
    command,
    decisionId,
    error: cliError(CliErrorCode.DecisionWriteRejected, reason)
  };
}
