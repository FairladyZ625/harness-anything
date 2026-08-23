import { renderFactsDocument, sha256Text, type RelationFactRow } from "../../kernel/src/index.ts";
import { runSingleMigrationImport, type MigrationImportRunInput } from "./migration-import-run.ts";
import { combineMigrationReceipts, migrationSourceRoots } from "./migration-import-source.ts";
import { migrationImportError } from "./migration-import-report.ts";
import type { MigrationImportReceipt } from "./migration-import-types.ts";

export type { MigrationImportReceipt } from "./migration-import-types.ts";

export async function runMigrationImport(input: MigrationImportRunInput): Promise<MigrationImportReceipt> {
  const sourceRoots = migrationSourceRoots(input.action);
  if (sourceRoots.length > 1 && input.action.dryRun === true)
    throw migrationImportError(
      "multi_source_dry_run_requires_staging",
      [
        "A multi-source dry-run cannot truthfully predict later-source document ",
        "and id conflicts without staging earlier source writes. Run each ",
        "--source dry-run in order against a disposable initialized center, or ",
        "apply the ordered batch directly; completed sources are incremental ",
        "no-ops on retry.",
      ].join(""),
    );
  if (sourceRoots.length === 1)
    return runSingleMigrationImport(
      { ...input, action: { ...input.action, sourceRoot: sourceRoots[0] } },
      addFact,
    );
  const receipts: MigrationImportReceipt[] = [];
  for (const sourceRoot of sourceRoots) {
    const receipt = await runSingleMigrationImport(
      { ...input, action: { ...input.action, sourceRoot } },
      addFact,
    );
    receipts.push(receipt);
    if (receipt.exitCode === 1) break;
  }
  return combineMigrationReceipts(receipts, sourceRoots);
}

function addFact(context: any, row: RelationFactRow): void {
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
