import { renderDecisionDocument, type ColdDecisionProjectionRow } from "../../kernel/src/index.ts";
import type { MigrationImportContext } from "./migration-import-run.ts";

export function addDecision(context: MigrationImportContext, row: ColdDecisionProjectionRow): void {
  const occurredAt = context.timestamp(row.decidedAt) ?? context.timestamp(row.proposedAt);
  if (!occurredAt || !context.validDecision(row)) {
    context.skips.push({
      entityType: "decision",
      migratedFrom: row.decisionId,
      sourcePath: row.path,
      reason: "decision fields or occurredAt are invalid",
      coverage: row.claimRecords.filter(({ loadBearing }) => loadBearing).length,
    });
    return;
  }
  if (context.decisionMap.has(row.decisionId)) {
    context.skips.push({
      entityType: "decision",
      migratedFrom: row.decisionId,
      sourcePath: row.path,
      reason: "decision id occurs more than once in the same source repository",
      coverage: row.claimRecords.filter(({ loadBearing }) => loadBearing).length,
    });
    return;
  }
  const held = context.existingSourceEntity("decision", row.decisionId);
  if (held?.kind === "decision") {
    context.decisionMap.set(row.decisionId, held.decision.decisionId);
    context.alreadyImported.decision += 1;
    return;
  }
  const targetDecisionId = context.mappedIdentifier(
    "decision",
    row.decisionId,
    context.existingDecisions,
    new Set(context.decisionMap.values()),
  );
  context.decisionMap.set(row.decisionId, targetDecisionId);
  context.drafts.push({
    kind: "decision",
    migratedFrom: row.decisionId,
    occurredAt,
    build: (workspaceRevision: number) => {
      const decision = {
          decisionId: targetDecisionId,
          state: context.legacyDecisionState(row.state)!,
          title: row.title,
          question: row.question,
          riskTier: row.riskTier as "low" | "medium" | "high",
          urgency: row.urgency as "low" | "medium" | "high",
          vertical: row.vertical!,
          preset: row.preset!,
          decisionClass: row.decisionClass === "standing-policy" ? ("standing_policy" as const) : ("ordinary" as const),
          appliesTo: {
            modules: row.moduleKeys,
            productLines: row.productLineKeys,
          },
          proposer: context.actor,
          arbiter: row.state === "proposed" ? null : context.actor,
          proposedAt: row.proposedAt!,
          decidedAt: row.decidedAt ?? null,
          workspaceRevision,
          chosen: row.chosenRecords,
          rejected: row.rejectedRecords,
          claims: row.claimRecords.map((item) => ({
            ...item,
            fulfillment: item.fulfillment === "standing-policy" ? ("standing_policy" as const) : item.fulfillment,
          })),
          relations: [],
          provenance: [],
          judgmentConsents: [],
        },
        sourceBody = context.utf8File(context.sourceRoot, row.path),
        body = renderDecisionDocument(
          decision,
          null,
          sourceBody === null ? row.body : context.preservedSourceDocument(sourceBody, row.body),
        ),
        documentClaim = context.claim(`decisions/decision-${targetDecisionId}/decision.md`, body, "text/markdown");
      return context.prepare(
        context.sourceKey,
        context.actorFor(`decision/${row.decisionId}`),
        "decision",
        row.decisionId,
        occurredAt,
        workspaceRevision,
        { kind: "decision", decision, documentClaim },
        [context.blob(body, "text/markdown")],
      );
    },
  });
}
