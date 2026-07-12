import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Effect, Schema } from "effect";
import {
  executionDeclaration,
  formatFactFlowRecord,
  parseFactFlowRecords,
  resolveHarnessLayout,
  sha256Text,
  stablePayloadHash,
  validateOutputEvidence,
  writeCoordinatedTaskDocuments,
  type ExecutionRecord,
  type FactMigrationTrace,
  type HarnessLayoutInput,
  type OutputEvidence,
  type TaskId,
  type WriteError
} from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CommandRunnerContext } from "../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import {
  classifyFactExecutionCandidates,
  deliveryEvidenceTerms,
  type FactExecutionCandidate
} from "./fact-execution-classifier.ts";

type MigrateFactExecutionAction = Extract<ParsedCommand["action"], { readonly kind: "migrate-fact-execution" }>;

interface TargetPlan {
  readonly candidate: FactExecutionCandidate;
  readonly target: { readonly kind: "existing" | "archival"; readonly executionId: string } | null;
  readonly skipReason?: "non_done_without_active_execution" | "multiple_active_executions";
}

interface ManualSelection {
  readonly file: string;
  readonly requestedRefs: ReadonlyArray<string>;
  readonly candidates: ReadonlyArray<FactExecutionCandidate>;
  readonly unresolvedRefs: ReadonlyArray<string>;
  readonly invalidLines: ReadonlyArray<string>;
}

export function runMigrateFactExecution(
  context: CommandRunnerContext,
  rootInput: HarnessLayoutInput,
  action: MigrateFactExecutionAction
): Effect.Effect<CliResult, WriteError> {
  const classification = classifyFactExecutionCandidates(rootInput);
  const manual = action.manualListFile ? readManualSelection(rootInput, action.manualListFile, classification.orphans) : undefined;
  const candidates = manual?.candidates ?? classification.automatic;
  const planId = manual ? manualMigrationPlanId(manual) : migrationPlanId(classification.orphans);
  const batchCount = Math.ceil(candidates.length / action.batchSize);
  const start = (action.batch - 1) * action.batchSize;
  const allTargets = candidates.map((candidate) => targetPlan(rootInput, candidate, planId));
  const targets = allTargets.slice(start, start + action.batchSize);
  const pendingTargets = targets.filter((entry) => !entry.candidate.fact.migration && entry.target);
  const report = (appliedFacts: number, appliedTasks: number) => buildReport(
    action, planId, batchCount, classification, allTargets, targets, manual, appliedFacts, appliedTasks
  );

  if (action.mode === "dry-run") {
    return Effect.succeed(migrationResult(action, report(0, 0)));
  }
  if (manual && (manual.unresolvedRefs.length > 0 || manual.invalidLines.length > 0)) {
    return Effect.succeed({
      ok: false,
      command: "migrate-fact-execution",
      error: cliError(CliErrorCode.RefNotFound, "Manual Fact list contains invalid or unresolved refs; inspect the dry-run report."),
      report: report(0, 0)
    });
  }
  if (pendingTargets.length === 0) return Effect.succeed(migrationResult(action, report(0, 0)));
  if (action.confirmPlan !== planId) {
    return Effect.succeed({
      ok: false,
      command: "migrate-fact-execution",
      error: cliError(
        CliErrorCode.PlanConfirmationRequired,
        `Inspect the dry-run and rerun with --apply --confirm-plan ${planId}.`
      ),
      report: report(0, 0)
    });
  }

  const migratedAt = new Date().toISOString();
  const writes = migrationWrites(rootInput, pendingTargets as ReadonlyArray<TargetPlan & { readonly target: NonNullable<TargetPlan["target"]> }>, planId, migratedAt);
  const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "fact-execution-migration" });
  return writeCoordinatedTaskDocuments(coordinator, stablePayloadHash, writes).pipe(
    Effect.map(() => migrationResult(action, report(pendingTargets.length, new Set(pendingTargets.map((entry) => entry.candidate.taskId)).size)))
  );
}

function buildReport(
  action: MigrateFactExecutionAction,
  planId: string,
  batchCount: number,
  classification: ReturnType<typeof classifyFactExecutionCandidates>,
  allTargets: ReadonlyArray<TargetPlan>,
  targets: ReadonlyArray<TargetPlan>,
  manual: ManualSelection | undefined,
  appliedFacts: number,
  appliedTasks: number
): Record<string, unknown> {
  const row = (candidate: FactExecutionCandidate) => ({
    factRef: candidate.factRef,
    taskStatus: candidate.taskStatus,
    statement: candidate.fact.statement,
    memoryClass: candidate.fact.memoryClass,
    matchedTerms: candidate.signals.matchedTerms,
    migrated: candidate.fact.migration?.state === "migrated"
  });
  const sample = (entries: ReadonlyArray<FactExecutionCandidate>) => entries.slice(0, action.sampleSize).map(row);
  const episodicOrphans = classification.orphans.filter((entry) => entry.signals.episodic).length;
  const wordingOrphans = classification.orphans.filter((entry) => entry.signals.deliveryWording).length;
  return {
    schema: "fact-execution-migration-report/v1",
    mode: action.mode,
    selectionMode: manual ? "manual-list" : "automatic-intersection",
    planId,
    classifier: {
      signals: ["memoryClass=episodic", "no active evidenced-by reference", "delivery wording"],
      deliveryEvidenceTerms
    },
    batch: { number: action.batch, size: action.batchSize, count: batchCount },
    summary: {
      scannedFacts: classification.scannedFacts,
      referencedFacts: classification.referencedFacts,
      orphanFacts: classification.orphans.length,
      episodicOrphans,
      deliveryWordingOrphans: wordingOrphans,
      automaticIntersection: classification.automatic.length,
      ...(manual ? {
        manualRequested: manual.requestedRefs.length,
        manualResolved: manual.candidates.length,
        manualUnresolved: manual.unresolvedRefs.length,
        manualReady: allTargets.filter((entry) => entry.target && !entry.candidate.fact.migration).length,
        manualSkipped: allTargets.filter((entry) => !entry.target).length
      } : {
        automaticReady: allTargets.filter((entry) => entry.target && !entry.candidate.fact.migration).length,
        automaticSkipped: allTargets.filter((entry) => !entry.target).length
      }),
      manualDifference: classification.manual.length,
      bearingObservations: classification.bearingObservations.length,
      alreadyMigrated: classification.alreadyMigrated,
      selectedInBatch: targets.length,
      readyInBatch: targets.filter((entry) => entry.target && !entry.candidate.fact.migration).length,
      skippedInBatch: targets.filter((entry) => !entry.target).length,
      appliedFacts,
      appliedTasks
    },
    [manual ? "manualSkipReasons" : "automaticSkipReasons"]: Object.fromEntries([...Map.groupBy(
      allTargets.filter((entry) => entry.skipReason),
      (entry) => entry.skipReason!
    )].map(([reason, entries]) => [reason, entries.length])),
    selected: targets.map((entry) => ({
      ...row(entry.candidate),
      target: entry.target,
      ...(entry.skipReason ? { skipReason: entry.skipReason } : {})
    })),
    ...(manual ? { manualList: { file: manual.file, unresolvedRefs: manual.unresolvedRefs, invalidLines: manual.invalidLines } } : {}),
    manualConfirmation: classification.manual.map(row),
    samples: {
      automatic: sample(classification.automatic),
      manual: sample(classification.manual),
      bearingObservations: sample(classification.bearingObservations)
    },
    rollback: {
      strategy: "git-revert",
      note: "Each applied batch is one coordinated journal flush. Revert its generated repository commit; facts and executions are never hard-deleted by this command."
    }
  };
}

function readManualSelection(
  rootInput: HarnessLayoutInput,
  listFile: string,
  candidates: ReadonlyArray<FactExecutionCandidate>
): ManualSelection {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const file = path.isAbsolute(listFile) ? listFile : path.join(rootDir, listFile);
  const lines = readFileSync(file, "utf8").split(/\r?\n/u).map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const invalidLines = lines.filter((line) => !/^fact\/task_[0-9A-Z]+\/F-[0-9A-Z]+$/u.test(line));
  const requestedRefs = [...new Set(lines.filter((line) => !invalidLines.includes(line)))];
  const byRef = new Map(candidates.map((candidate) => [candidate.factRef, candidate]));
  return {
    file,
    requestedRefs,
    candidates: requestedRefs.flatMap((factRef) => byRef.get(factRef) ?? []),
    unresolvedRefs: requestedRefs.filter((factRef) => !byRef.has(factRef)),
    invalidLines
  };
}

function migrationResult(action: MigrateFactExecutionAction, report: Record<string, any>): CliResult {
  return {
    ok: true,
    command: "migrate-fact-execution",
    migrationMode: action.mode === "apply" ? "apply" : "plan",
    rows: report.summary.selectedInBatch,
    report
  };
}

function targetPlan(rootInput: HarnessLayoutInput, candidate: FactExecutionCandidate, planId: string): TargetPlan {
  const executions = readExecutions(rootInput, candidate);
  const active = executions.filter((execution) => execution.state === "active");
  if (active.length > 1) return { candidate, target: null, skipReason: "multiple_active_executions" };
  if (active.length === 1) {
    return { candidate, target: { kind: "existing", executionId: active[0]!.execution_id } };
  }
  if (candidate.taskStatus === "done") {
    return { candidate, target: { kind: "archival", executionId: archivalExecutionId(planId, candidate.taskId) } };
  }
  return { candidate, target: null, skipReason: "non_done_without_active_execution" };
}

function readExecutions(rootInput: HarnessLayoutInput, candidate: FactExecutionCandidate): ReadonlyArray<ExecutionRecord> {
  const rootDir = resolveHarnessLayout(rootInput).rootDir;
  const directory = path.join(rootDir, candidate.taskPath, "executions");
  if (!existsSync(directory)) return [];
  const executions: ExecutionRecord[] = [];
  for (const name of readdirSync(directory).filter((entry) => /^exe_.+\.md$/u.test(entry)).sort()) {
    try {
      const body = readFileSync(path.join(directory, name), "utf8");
      executions.push(Schema.decodeUnknownSync(executionDeclaration.schema)(executionDeclaration.documentCodec.decode(body)) as ExecutionRecord);
    } catch {
      // Existing malformed executions are not migration targets.
    }
  }
  return executions;
}

function migrationWrites(
  rootInput: HarnessLayoutInput,
  targets: ReadonlyArray<TargetPlan & { readonly target: NonNullable<TargetPlan["target"]> }>,
  planId: string,
  migratedAt: string
): ReadonlyArray<{ readonly taskId: TaskId; readonly path: string; readonly body: string; readonly kind: "doc_write" }> {
  const layout = resolveHarnessLayout(rootInput);
  const grouped = Map.groupBy(targets, (entry) => entry.candidate.taskId);
  const writes: Array<{ taskId: TaskId; path: string; body: string; kind: "doc_write" }> = [];
  for (const [taskId, taskTargets] of grouped) {
    const factsPath = path.join(layout.rootDir, taskTargets[0]!.candidate.factsPath);
    const migrationByFact = new Map(taskTargets.map((entry) => [entry.candidate.fact.fact_id, migrationTrace(entry, planId, migratedAt)]));
    writes.push({ taskId: taskId as TaskId, path: "facts.md", body: migrateFactsBody(readFileSync(factsPath, "utf8"), migrationByFact), kind: "doc_write" });
    const byExecution = Map.groupBy(taskTargets, (entry) => entry.target.executionId);
    for (const [executionId, executionTargets] of byExecution) {
      const evidence = executionTargets.map((entry) => outputEvidence(entry.candidate, taskId, executionId, planId));
      const execution = migratedExecution(rootInput, executionTargets[0]!, taskId, executionId, evidence, planId, migratedAt);
      validateOutputEvidence({ rootInput, taskId, executionId, evidence: execution.outputs });
      writes.push({ taskId: taskId as TaskId, path: `executions/${executionId}.md`, body: executionDeclaration.documentCodec.encode(execution), kind: "doc_write" });
    }
  }
  return writes;
}

function migratedExecution(
  rootInput: HarnessLayoutInput,
  target: TargetPlan & { readonly target: NonNullable<TargetPlan["target"]> },
  taskId: string,
  executionId: string,
  evidence: ReadonlyArray<OutputEvidence>,
  planId: string,
  migratedAt: string
): ExecutionRecord {
  const existing = readExecutions(rootInput, target.candidate).find((execution) => execution.execution_id === executionId);
  if (existing) {
    const newEvidence = evidence.filter((item) => !existing.outputs.some((current) => current.evidence_id === item.evidence_id));
    return existing.state === "active"
      ? { ...existing, outputs: [...existing.outputs, ...newEvidence] }
      : appendArchivalEvidence(existing, newEvidence);
  }
  return {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "accepted",
    primary_actor: {
      principal: { personId: "person_historical_task_owner" },
      executor: { kind: "agent", id: "fact-execution-migration" },
      responsibleHuman: "person:historical_task_owner"
    },
    claimed_at: migratedAt,
    submitted_at: migratedAt,
    closed_at: migratedAt,
    session_bindings: [],
    outputs: evidence,
    submission: archivalSubmission(evidence, planId)
  };
}

function appendArchivalEvidence(execution: ExecutionRecord, evidence: ReadonlyArray<OutputEvidence>): ExecutionRecord {
  if (execution.primary_actor.executor?.id !== "fact-execution-migration") {
    throw new Error(`closed execution is not a fact-migration archive: ${execution.execution_id}`);
  }
  const outputs = [...execution.outputs, ...evidence];
  return { ...execution, outputs, submission: archivalSubmission(outputs, migrationPlanFromExecution(execution)) };
}

function archivalSubmission(evidence: ReadonlyArray<OutputEvidence>, planId: string): NonNullable<ExecutionRecord["submission"]> {
  return {
    completion_claim: "Historical delivery evidence migrated from orphan Facts.",
    deliverables: evidence.map((item) => item.locator.substrate === "inline" ? item.locator.text : item.evidence_id),
    evidence_refs: evidence.map((item) => item.evidence_id),
    verification_notes: [`source=fact-migration`, `plan=${planId}`],
    known_gaps: ["Historical inline evidence is preserved without a checker receipt."],
    residual_risks: []
  };
}

function migrationPlanFromExecution(execution: ExecutionRecord): string {
  return execution.submission?.verification_notes.find((note) => note.startsWith("plan="))?.slice("plan=".length) ?? "unknown";
}

function outputEvidence(candidate: FactExecutionCandidate, taskId: string, executionId: string, planId: string): OutputEvidence {
  return {
    evidence_id: `fact-migration:${planId}:${candidate.fact.fact_id}`,
    execution_ref: `execution/${taskId}/${executionId}`,
    locator: { substrate: "inline", text: candidate.fact.statement }
  };
}

function migrationTrace(
  target: TargetPlan & { readonly target: NonNullable<TargetPlan["target"]> },
  planId: string,
  migratedAt: string
): FactMigrationTrace {
  return {
    schema: "fact-migration/v1",
    state: "migrated",
    plan_id: planId,
    execution_ref: `execution/${target.candidate.taskId}/${target.target.executionId}`,
    evidence_id: `fact-migration:${planId}:${target.candidate.fact.fact_id}`,
    migrated_at: migratedAt
  };
}

function migrateFactsBody(body: string, migrations: ReadonlyMap<string, FactMigrationTrace>): string {
  return body.split(/(?<=\n)/u).map((line) => {
    const fact = parseFactFlowRecords(line)[0];
    const migration = fact ? migrations.get(fact.fact_id) : undefined;
    if (!fact || !migration) return line;
    const newline = line.endsWith("\n") ? "\n" : "";
    return `${formatFactFlowRecord({ ...fact, migration })}${newline}`;
  }).join("");
}

function migrationPlanId(candidates: ReadonlyArray<FactExecutionCandidate>): string {
  return `fxm_${sha256Text(candidates.map((entry) => `${entry.classification}\n${entry.factRef}\n${entry.fact.statement}`).join("\n")).slice(0, 16)}`;
}

function manualMigrationPlanId(selection: ManualSelection): string {
  const statementByRef = new Map(selection.candidates.map((entry) => [entry.factRef, entry.fact.statement]));
  const payload = selection.requestedRefs.map((factRef) => `${factRef}\n${statementByRef.get(factRef) ?? "unresolved"}`).join("\n");
  return `fxm_${sha256Text(`manual-list\n${payload}`).slice(0, 16)}`;
}

function archivalExecutionId(planId: string, taskId: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value = BigInt(`0x${sha256Text(`${planId}:${taskId}`).slice(0, 32)}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)] + encoded;
    value >>= 5n;
  }
  return `exe_${encoded}`;
}
