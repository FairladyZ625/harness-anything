import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import {
  cleanupRetiredAttributionFields,
  countContentPinArbitersInDocument,
  decisionEntityId,
  hasRetiredAttributionFields,
  resolveHarnessLayout,
  sha256Text,
  taskEntityId,
  type EntityId,
  type HarnessLayoutInput,
  type RetiredAttributionDocumentKind,
  type WriteError
} from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { relativePath } from "../cli/path.ts";
import type { CommandRunnerContext } from "../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";

type MigrateRetiredAttributionFieldsAction = Extract<
  ParsedCommand["action"],
  { readonly kind: "migrate-retired-attribution-fields" }
>;

interface CleanupCandidate {
  readonly entityId: EntityId;
  readonly documentKind: RetiredAttributionDocumentKind;
  readonly path: string;
  readonly expectedSha256: string;
  readonly resultSha256: string;
  readonly removedKeys: ReadonlyArray<string>;
  readonly removedByteCount: number;
  readonly beforeByteCount: number;
  readonly afterByteCount: number;
  readonly authoredBodySha256Before: string;
  readonly authoredBodySha256After: string;
  readonly contentPinArbitersBefore: number;
  readonly contentPinArbitersAfter: number;
}

interface InvalidCandidate {
  readonly documentKind: RetiredAttributionDocumentKind;
  readonly path: string;
  readonly reason: string;
}

interface CleanupInventory {
  readonly scannedTaskIndexes: number;
  readonly scannedDecisionDocuments: number;
  readonly contentPinArbitersBefore: number;
  readonly candidates: ReadonlyArray<CleanupCandidate>;
  readonly invalid: ReadonlyArray<InvalidCandidate>;
}

export function runMigrateRetiredAttributionFields(
  context: CommandRunnerContext,
  rootInput: HarnessLayoutInput,
  action: MigrateRetiredAttributionFieldsAction
): Effect.Effect<CliResult, WriteError> {
  const inventory = cleanupInventory(rootInput);
  const planId = cleanupPlanId(inventory);
  const selected = inventory.candidates.slice(0, action.batchSize);
  const report = (applied: number) => cleanupReport(action, inventory, selected, planId, applied);

  if (action.mode === "dry-run") return Effect.succeed(cleanupResult(action, report(0)));
  if (inventory.invalid.length > 0) {
    return Effect.succeed({
      ok: false,
      command: "migrate-retired-attribution-fields",
      error: cliError(CliErrorCode.WriteRejected, "Cleanup inventory contains malformed or partial candidates; inspect the dry-run report."),
      report: report(0)
    });
  }
  if (action.confirmPlan !== planId) {
    return Effect.succeed({
      ok: false,
      command: "migrate-retired-attribution-fields",
      error: cliError(CliErrorCode.PlanConfirmationRequired, `Inspect the dry-run and rerun with --apply --confirm-plan ${planId}.`),
      report: report(0)
    });
  }
  if (!action.evidenceRef?.trim()) {
    return Effect.succeed({
      ok: false,
      command: "migrate-retired-attribution-fields",
      error: cliError(CliErrorCode.InvalidEvidence, "Apply requires --evidence-ref <approved-report-reference>."),
      report: report(0)
    });
  }
  if (selected.length === 0) return Effect.succeed(cleanupResult(action, report(0)));

  const coordinator = context.makeMigrationWriteCoordinator(
    { scope: "operational", kind: "agent", id: "retired-attribution-field-migration" },
    action.evidenceRef
  );
  return Effect.gen(function* () {
    for (const candidate of selected) {
      yield* coordinator.enqueue({
        opId: cleanupOpId(planId, candidate),
        entityId: candidate.entityId,
        kind: "migration_retired_attribution_fields",
        payload: {
          schema: "retired-attribution-field-cleanup/v1",
          documentKind: candidate.documentKind,
          planId,
          expectedSha256: candidate.expectedSha256,
          resultSha256: candidate.resultSha256
        }
      });
    }
    yield* coordinator.flush("explicit");
    return cleanupResult(action, report(selected.length));
  });
}

function cleanupInventory(rootInput: HarnessLayoutInput): CleanupInventory {
  const layout = resolveHarnessLayout(rootInput);
  const candidates: CleanupCandidate[] = [];
  const invalid: InvalidCandidate[] = [];
  let scannedTaskIndexes = 0;
  let scannedDecisionDocuments = 0;
  let contentPinArbitersBefore = 0;

  if (existsSync(layout.tasksRoot)) {
    for (const entry of readdirSync(layout.tasksRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).sort(byName)) {
      const targetPath = path.join(layout.tasksRoot, entry.name, "INDEX.md");
      if (!existsSync(targetPath)) continue;
      scannedTaskIndexes += 1;
      const body = readFileSync(targetPath, "utf8");
      if (!/^createdBy:/mu.test(body)) continue;
      collectCandidate(layout.rootDir, targetPath, body, "task-index", candidates, invalid);
    }
  }

  if (existsSync(layout.decisionsRoot)) {
    for (const entry of readdirSync(layout.decisionsRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).sort(byName)) {
      const targetPath = path.join(layout.decisionsRoot, entry.name, "decision.md");
      if (!existsSync(targetPath)) continue;
      scannedDecisionDocuments += 1;
      const body = readFileSync(targetPath, "utf8");
      try {
        contentPinArbitersBefore += countContentPinArbitersInDocument(body);
      } catch (error) {
        invalid.push({ documentKind: "decision", path: relativePath(layout.rootDir, targetPath), reason: describe(error) });
        continue;
      }
      if (!/^(?:proposedBy|arbiter):/mu.test(body)) continue;
      collectCandidate(layout.rootDir, targetPath, body, "decision", candidates, invalid);
    }
  }

  return {
    scannedTaskIndexes,
    scannedDecisionDocuments,
    contentPinArbitersBefore,
    candidates: candidates.sort((left, right) => left.path.localeCompare(right.path)),
    invalid: invalid.sort((left, right) => left.path.localeCompare(right.path))
  };
}

function collectCandidate(
  rootDir: string,
  targetPath: string,
  body: string,
  documentKind: RetiredAttributionDocumentKind,
  candidates: CleanupCandidate[],
  invalid: InvalidCandidate[]
): void {
  const documentPath = relativePath(rootDir, targetPath);
  try {
    if (!hasRetiredAttributionFields(body, documentKind)) return;
    const cleanup = cleanupRetiredAttributionFields(body, documentKind);
    const entityId = cleanupEntityId(body, documentKind);
    candidates.push({
      entityId,
      documentKind,
      path: documentPath,
      expectedSha256: sha256Text(body),
      resultSha256: sha256Text(cleanup.body),
      removedKeys: cleanup.removedKeys,
      removedByteCount: cleanup.removedByteCount,
      beforeByteCount: Buffer.byteLength(body, "utf8"),
      afterByteCount: Buffer.byteLength(cleanup.body, "utf8"),
      authoredBodySha256Before: sha256Text(cleanup.authoredBodyBefore),
      authoredBodySha256After: sha256Text(cleanup.authoredBodyAfter),
      contentPinArbitersBefore: cleanup.contentPinArbitersBefore,
      contentPinArbitersAfter: cleanup.contentPinArbitersAfter
    });
  } catch (error) {
    invalid.push({ documentKind, path: documentPath, reason: describe(error) });
  }
}

function cleanupEntityId(body: string, documentKind: RetiredAttributionDocumentKind): EntityId {
  if (documentKind === "task-index") {
    const taskId = /^task_id:\s*(\S+)/mu.exec(body)?.[1];
    if (!taskId) throw new Error("task cleanup candidate is missing task_id");
    return taskEntityId(taskId);
  }
  const decisionId = /^decision_id:\s*(\S+)/mu.exec(body)?.[1];
  if (!decisionId) throw new Error("decision cleanup candidate is missing decision_id");
  return decisionEntityId(decisionId);
}

function cleanupPlanId(inventory: CleanupInventory): string {
  const payload = [
    ...inventory.candidates.map((candidate) => [candidate.entityId, candidate.path, candidate.expectedSha256, candidate.resultSha256].join("\0")),
    ...inventory.invalid.map((candidate) => [candidate.documentKind, candidate.path, candidate.reason].join("\0"))
  ].join("\n");
  return `rafm_${sha256Text(payload).slice(0, 16)}`;
}

function cleanupOpId(planId: string, candidate: CleanupCandidate): string {
  return `${planId}-${sha256Text(`${candidate.entityId}\0${candidate.expectedSha256}`).slice(0, 16)}`;
}

function cleanupReport(
  action: MigrateRetiredAttributionFieldsAction,
  inventory: CleanupInventory,
  selected: ReadonlyArray<CleanupCandidate>,
  planId: string,
  applied: number
): Record<string, any> {
  const taskCandidates = inventory.candidates.filter((candidate) => candidate.documentKind === "task-index").length;
  const decisionCandidates = inventory.candidates.length - taskCandidates;
  const selectedTasks = selected.filter((candidate) => candidate.documentKind === "task-index").length;
  const selectedDecisions = selected.length - selectedTasks;
  const targetContentPinArbitersBefore = inventory.candidates.reduce(
    (count, candidate) => count + candidate.contentPinArbitersBefore,
    0
  );
  const targetContentPinArbitersAfter = inventory.candidates.reduce(
    (count, candidate) => count + candidate.contentPinArbitersAfter,
    0
  );
  const expectedContentPinArbitersAfter = inventory.contentPinArbitersBefore + inventory.candidates.reduce(
    (delta, candidate) => delta + candidate.contentPinArbitersAfter - candidate.contentPinArbitersBefore,
    0
  );
  return {
    schema: "retired-attribution-field-migration-report/v1",
    mode: action.mode,
    transform: "frontmatter-top-level-delete-ranges-only",
    planId,
    batchSize: action.batchSize,
    summary: {
      scannedTaskIndexes: inventory.scannedTaskIndexes,
      scannedDecisionDocuments: inventory.scannedDecisionDocuments,
      taskCandidates,
      decisionCandidates,
      candidateDocuments: inventory.candidates.length,
      invalidCandidates: inventory.invalid.length,
      selectedDocuments: selected.length,
      selectedTasks,
      selectedDecisions,
      appliedDocuments: applied,
      expectedRetiredFieldDocumentsAfterFullApply: 0,
      expectedRemainingAfterSelectedBatch: inventory.candidates.length - selected.length,
      contentPinArbitersBefore: inventory.contentPinArbitersBefore,
      expectedContentPinArbitersAfter,
      targetContentPinArbitersBefore,
      targetContentPinArbitersAfter
    },
    invariants: {
      addedBytes: 0,
      allAuthoredBodiesByteIdentical: inventory.candidates.every((candidate) => candidate.authoredBodySha256Before === candidate.authoredBodySha256After),
      allContentPinArbitersPreserved: inventory.candidates.every((candidate) => candidate.contentPinArbitersBefore === candidate.contentPinArbitersAfter),
      allTransformsAreStrictDeletions: inventory.candidates.every((candidate) => candidate.removedByteCount > 0 && candidate.afterByteCount + candidate.removedByteCount === candidate.beforeByteCount)
    },
    invalid: inventory.invalid,
    selected: selected.map(candidateReport),
    candidates: inventory.candidates.map(candidateReport),
    applyPolicy: {
      requiresPlanConfirmation: true,
      requiresEvidenceRef: true,
      principalSource: "migration",
      nextBatchRequiresFreshDryRun: true
    }
  };
}

function candidateReport(candidate: CleanupCandidate): Record<string, unknown> {
  return {
    ...candidate,
    authoredBodyByteIdentical: candidate.authoredBodySha256Before === candidate.authoredBodySha256After,
    contentPinArbitersPreserved: candidate.contentPinArbitersBefore === candidate.contentPinArbitersAfter
  };
}

function cleanupResult(
  action: MigrateRetiredAttributionFieldsAction,
  report: Record<string, any>
): CliResult {
  return {
    ok: true,
    command: "migrate-retired-attribution-fields",
    migrationMode: action.mode === "apply" ? "apply" : "plan",
    rows: report.summary.candidateDocuments,
    report
  };
}

function byName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
