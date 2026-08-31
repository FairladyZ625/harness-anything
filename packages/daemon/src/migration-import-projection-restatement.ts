import {
  canonicalMigrationProvenance,
  renderDecisionDocument,
  renderFactsDocument,
  sha256Text,
  consumeKnownError,
  type DecisionDocumentState,
} from "../../kernel/src/index.ts";
import type { MigrationImportContext } from "./migration-import-run.ts";
import type { ProjectionOracleDecision, ProjectionOracleFact } from "./migration-import-oracle.ts";
import { isMigrationImportRecord, nonEmpty } from "./migration-import-report.ts";

export function addOracleDecision(context: MigrationImportContext, source: ProjectionOracleDecision): boolean {
  if (context.decisionMap.has(source.decisionId)) return true;
  const fields = source.fields,
    state = context.legacyDecisionState(String(fields.state ?? "")),
    proposedAt = context.timestamp(fields.proposed_at),
    decidedAt = fields.decided_at === null ? null : context.timestamp(fields.decided_at),
    proposer = jsonRecord(fields.proposer_json),
    arbiter = fields.arbiter_json === null ? null : jsonRecord(fields.arbiter_json),
    appliesTo = jsonRecord(fields.applies_json),
    provenance = jsonArray(fields.provenance_json);
  if (
    state === null ||
    proposedAt === null ||
    (fields.decided_at !== null && decidedAt === null) ||
    !nonEmpty(fields.title) ||
    !nonEmpty(fields.question) ||
    !nonEmpty(fields.vertical) ||
    !nonEmpty(fields.preset) ||
    proposer === null ||
    appliesTo === null ||
    provenance === null
  )
    return false;
  const targetDecisionId = context.mappedIdentifier(
      "decision",
      source.decisionId,
      context.existingDecisions,
      new Set(context.decisionMap.values()),
    ),
    decision = {
      decisionId: targetDecisionId,
      state,
      title: fields.title,
      question: fields.question,
      riskTier: fields.risk_tier,
      urgency: fields.urgency,
      vertical: fields.vertical,
      preset: fields.preset,
      decisionClass: fields.decision_class,
      appliesTo,
      proposer,
      arbiter,
      proposedAt,
      decidedAt,
      workspaceRevision: 0,
      chosen: source.chosen,
      rejected: source.rejected,
      claims: source.claims,
      relations: [],
      provenance,
      judgmentConsents: [],
    } as unknown as DecisionDocumentState,
    sourcePath = `decisions/decision-${source.decisionId}/decision.md`,
    sourceBody = context.utf8File(context.sourceLayout.authoredRoot, sourcePath),
    occurredAt = decidedAt ?? proposedAt;
  context.decisionMap.set(source.decisionId, targetDecisionId);
  recordDerivation(context, "decision", source.decisionId, "entity", `projection:decision@${context.oracle.watermark}`);
  context.drafts.push({
    kind: "decision",
    migratedFrom: source.decisionId,
    occurredAt,
    build: (workspaceRevision: number) => {
      const migrated = { ...decision, workspaceRevision },
        body = renderDecisionDocument(migrated, null, context.preservedSourceDocument(sourceBody ?? "", "")),
        documentClaim = context.claim(`decisions/decision-${targetDecisionId}/decision.md`, body, "text/markdown");
      return context.prepare(
        context.sourceKey,
        context.actorFor(`decision/${source.decisionId}`),
        "decision",
        source.decisionId,
        occurredAt,
        workspaceRevision,
        { kind: "decision", decision: migrated, documentClaim },
        [context.blob(body, "text/markdown")],
      );
    },
  });
  return true;
}

export function addOracleFact(context: MigrationImportContext, source: ProjectionOracleFact): boolean {
  const fields = source.fields,
    sourceRef = `fact/${source.factId}`;
  if ([...context.factMap.values()].includes(sourceRef) || context.factMap.has(sourceRef)) return true;
  const observedAt = context.timestamp(fields.observedAt),
    taskId = typeof fields.taskId === "string" ? fields.taskId : undefined,
    mappedTaskId = taskId === undefined ? undefined : context.taskMap.get(taskId);
  if (
    observedAt === null ||
    (taskId !== undefined && mappedTaskId === undefined) ||
    !nonEmpty(fields.statement) ||
    !nonEmpty(fields.evidenceSource) ||
    !Array.isArray(fields.memoryTags) ||
    !Array.isArray(fields.provenance)
  )
    return false;
  const provenance = (fields.provenance as readonly unknown[]).map((entry, index) => {
    if (!isMigrationImportRecord(entry) || entry.runtime !== "claude") return entry;
    recordDerivation(
      context,
      "fact",
      source.factId,
      `provenance[${index}].runtime`,
      `projection:fact/${source.factId} legacy-runtime:claude`,
    );
    return { ...entry, runtime: "claude-code" };
  });
  let targetFactId = source.factId,
    targetRef = `fact/${targetFactId}`;
  if (context.existingFacts.has(targetRef) || [...context.factMap.values()].includes(targetRef)) {
    targetFactId = `F-${sha256Text(`${context.sourceKey}\0${sourceRef}`).slice(0, 8).toUpperCase()}`;
    targetRef = `fact/${targetFactId}`;
    if (context.existingFacts.has(targetRef) || [...context.factMap.values()].includes(targetRef))
      throw context.idRemapConflict("fact", sourceRef, targetRef);
    context.remappings.push({
      entityType: "fact",
      sourceId: sourceRef,
      targetId: targetRef,
      reason: `same-cut projection fact ${sourceRef} collided in the destination`,
    });
  }
  context.factMap.set(sourceRef, targetRef);
  recordDerivation(context, "fact", source.factId, "entity", `projection:fact@${context.oracle.watermark}`);
  context.drafts.push({
    kind: "fact",
    migratedFrom: sourceRef,
    occurredAt: observedAt,
    build: (workspaceRevision: number) => {
      const fact = {
          ...(mappedTaskId ? { taskId: mappedTaskId } : {}),
          factId: targetFactId,
          statement: String(fields.statement),
          evidenceSource: String(fields.evidenceSource),
          observedAt,
          confidence: fields.confidence as "low" | "medium" | "high",
          memoryClass: fields.memoryClass as "semantic" | "episodic" | "procedural",
          memoryTags: fields.memoryTags as never,
          provenance: canonicalMigrationProvenance(provenance) as never,
        },
        record = {
          factId: targetFactId,
          statement: fact.statement,
          evidenceSource: fact.evidenceSource,
          observedAt,
          confidence: fact.confidence,
          state: "standing" as const,
          workspaceRevision,
        },
        body = renderFactsDocument([record]),
        documentClaim = context.claim(`facts/${targetFactId}.md`, body, "text/markdown");
      return context.prepare(
        context.sourceKey,
        context.actorFor(taskId ? `task/${taskId}` : sourceRef),
        "fact",
        sourceRef,
        observedAt,
        workspaceRevision,
        { kind: "fact", fact, documentClaim },
        [context.blob(body, "text/markdown")],
      );
    },
  });
  return true;
}

function recordDerivation(
  context: MigrationImportContext,
  entityType: "decision" | "fact",
  entityId: string,
  field: string,
  derivedFrom: string,
): void {
  context.fieldDerivations.push({ entityType, entityId, field, derived_from: derivedFrom });
  context.derivedIds[entityType].add(entityId);
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  const parsed = jsonValue(value);
  return isMigrationImportRecord(parsed) ? parsed : null;
}

function jsonArray(value: unknown): readonly unknown[] | null {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
