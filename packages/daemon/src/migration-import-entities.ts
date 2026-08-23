import {
  renderDecisionDocument,
  renderFactsDocument,
  sha256Text,
  type ColdDecisionProjectionRow,
  type RelationFactRow,
} from "../../kernel/src/index.ts";

export function addDecision(context: any, row: ColdDecisionProjectionRow): void {
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

export function addFact(context: any, row: RelationFactRow): void {
  const factRef = row.ref,
    occurredAt = context.timestamp(row.observedAt),
    mappedTaskId = context.taskMap.get(row.taskId);
  if (!occurredAt || !mappedTaskId || !context.validFact(row)) {
    context.skips.push({
      entityType: "fact",
      migratedFrom: factRef,
      sourcePath:
        context.cold.truth.factAnchors.find(({ factRef: ref }: { readonly factRef: string }) => ref === factRef)
          ?.sourcePath ?? factRef,
      reason: !mappedTaskId ? "fact owner task was skipped" : "fact fields or occurredAt are invalid",
    });
    return;
  }
  if (context.factMap.has(factRef)) {
    context.skips.push({
      entityType: "fact",
      migratedFrom: factRef,
      sourcePath: factRef,
      reason: "fact id occurs more than once in the same source repository",
    });
    return;
  }
  const held = context.existingSourceEntity("fact", factRef);
  if (held?.kind === "fact") {
    const targetRef = `fact/${held.fact.taskId}/${held.fact.factId}`;
    context.factMap.set(factRef, targetRef);
    context.alreadyImported.fact += 1;
    return;
  }
  let targetFactId = row.factId,
    targetRef = `fact/${mappedTaskId}/${targetFactId}`;
  if (context.existingFacts.has(targetRef)) {
    targetFactId = `F-${sha256Text(`${context.sourceKey}\0${factRef}`).slice(0, 8).toUpperCase()}`;
    targetRef = `fact/${mappedTaskId}/${targetFactId}`;
    if (context.existingFacts.has(targetRef) || [...context.factMap.values()].includes(targetRef))
      throw context.idRemapConflict("fact", factRef, targetRef);
    context.remappings.push({
      entityType: "fact",
      sourceId: factRef,
      targetId: targetRef,
      reason: [
        "destination already contains ",
        `${factRef}`,
        "; importing Git source ",
        `${context.sourceGit.rootCommit}`,
        " triggered a source-scoped fact id remap",
      ].join(""),
    });
  }
  context.factMap.set(factRef, targetRef);
  context.drafts.push({
    kind: "fact",
    migratedFrom: factRef,
    occurredAt,
    build: (workspaceRevision: number) => {
      const fact = {
          taskId: mappedTaskId,
          factId: targetFactId,
          statement: row.statement,
          evidenceSource: row.source,
          observedAt: row.observedAt,
          confidence: row.confidence,
          memoryClass: row.memoryClass,
          memoryTags: row.memoryTags as never,
          provenance: row.provenance as never,
        },
        records = [
          ...(context.factDocuments.get(mappedTaskId) ?? []),
          {
            factId: targetFactId,
            statement: row.statement,
            evidenceSource: row.source,
            observedAt: row.observedAt,
            confidence: row.confidence,
            state: "standing" as const,
            workspaceRevision,
          },
        ];
      context.factDocuments.set(mappedTaskId, records);
      const body = renderFactsDocument(records),
        documentClaim = context.claim(`${context.taskPackages.get(row.taskId)!}/facts.md`, body, "text/markdown");
      return context.prepare(
        context.sourceKey,
        context.actorFor(`task/${row.taskId}`),
        "fact",
        factRef,
        occurredAt,
        workspaceRevision,
        { kind: "fact", fact, documentClaim },
        [context.blob(body, "text/markdown")],
      );
    },
  });
}
