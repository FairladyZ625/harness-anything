import {
  canonicalMigrationProvenance,
  renderFactsDocument,
  sha256Text,
  stableStringify,
  makeTaskProjection,
  serializePersistedCanonicalEvent,
  type CanonicalEventStore,
  type CanonicalEventV1,
  type CanonicalWriteBundle,
  type MigrationImportEventV1,
  type RelationFactRow,
} from "../../kernel/src/index.ts";
import {
  runSingleMigrationImport,
  type MigrationImportContext,
  type MigrationImportRunInput,
} from "./migration-import-run.ts";
import { combineMigrationReceipts, migrationSourceRoots } from "./migration-import-source.ts";
import { migrationImportError } from "./migration-import-report.ts";
import { createMigrationPlanningWorkspace } from "./migration-import-oracle-rebuild.ts";
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
    return runSingleMigrationImport({ ...input, action: { ...input.action, sourceRoot: sourceRoots[0] } }, addFact);
  const staged = stagedImportView(input),
    receipts: MigrationImportReceipt[] = [];
  try {
    for (const sourceRoot of sourceRoots) {
      const receipt = await runSingleMigrationImport(
        {
          ...input,
          rootDir: staged.rootDir,
          action: { ...input.action, sourceRoot },
          store: staged.store,
          projection: staged.projection,
          stagePrepared: staged.accept,
        },
        addFact,
      );
      receipts.push(receipt);
      if (receipt.exitCode === 1) {
        const failed = combineMigrationReceipts(receipts, sourceRoots);
        return {
          ...failed,
          proof: { ...failed.proof!, durable: false, canonicalVisible: false, worktreeVisible: false },
        };
      }
    }
    if (input.shouldStop?.())
      throw migrationImportError(
        "daemon_shutdown",
        "Daemon shutdown interrupted migration planning before acceptance.",
      );
    const bundles = staged.bundles();
    let terminal: CanonicalWriteBundle | undefined;
    if (bundles.length > 0) {
      terminal = bundles.at(-1)!;
      input.store.append({ ...terminal, preceding: bundles.slice(0, -1) });
      input.projection.catchUp?.();
    }
    const combined = combineMigrationReceipts(receipts, sourceRoots),
      appliedCut = input.projection.readCut().watermark;
    return terminal
      ? {
          ...combined,
          opId: terminal.event.opId,
          revision: terminal.event.workspaceRevision,
          proof: {
            committedRevision: terminal.event.workspaceRevision,
            appliedCut,
            durable: true,
            canonicalVisible: appliedCut >= terminal.event.workspaceRevision,
            worktreeVisible: false,
          },
        }
      : {
          ...combined,
          outcome: "no_changes",
          opId: `migration-import-no-changes-${sha256Text(sourceRoots.join("\0"))}`,
          proof: {
            committedRevision: input.store.readHead()?.revision ?? 0,
            appliedCut,
            durable: false,
            canonicalVisible: false,
            worktreeVisible: false,
          },
        };
  } finally {
    staged.close();
  }
}

function stagedImportView(input: MigrationImportRunInput): {
  readonly store: CanonicalEventStore;
  readonly rootDir: string;
  readonly projection: ReturnType<typeof makeTaskProjection>;
  readonly accept: (prepared: readonly CanonicalWriteBundle[]) => void;
  readonly bundles: () => readonly CanonicalWriteBundle[];
  readonly close: () => void;
} {
  const workspace = createMigrationPlanningWorkspace(input.rootDir),
    rootDir = workspace.rootDir;
  const accepted: CanonicalWriteBundle[] = [],
    events = new Map<string, CanonicalWriteBundle>(),
    outcomes = new Map<string, ReturnType<CanonicalEventStore["readCommandOutcome"]>>(),
    content = new Map<string, Uint8Array>();
  const projectionHolder: { current: ReturnType<typeof makeTaskProjection> | null } = { current: null };
  const store = new Proxy(input.store, {
    get(target, property) {
      if (property === "readEvent") return (opId: string) => events.get(opId)?.event ?? target.readEvent(opId);
      if (property === "readCommandOutcome")
        return (opId: string) => outcomes.get(opId) ?? target.readCommandOutcome(opId);
      if (property === "readContentBlob")
        return (sha256: string) => content.get(sha256) ?? target.readContentBlob(sha256);
      if (property === "read")
        return () => {
          const base = target.read();
          return {
            ...base,
            revision: accepted.at(-1)?.event.workspaceRevision ?? base.revision,
            events: [...base.events, ...accepted.map(({ event }) => event)],
          };
        };
      if (property === "readHead")
        return () => {
          const last = accepted.at(-1)?.event;
          return last
            ? {
                revision: last.workspaceRevision,
                opId: last.opId,
                eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(last))}`,
              }
            : target.readHead();
        };
      if (property === "append")
        return (bundle: CanonicalWriteBundle) => {
          const members = [...(bundle.preceding ?? []), bundle];
          accepted.push(...members);
          for (const member of members) {
            events.set(member.event.opId, member);
            for (const blob of member.blobs) content.set(blob.sha256, Buffer.from(blob.body));
            projectionHolder.current!.apply(member.event, member.plan);
            workspace.stage(member);
          }
          outcomes.set(bundle.event.opId, {
            opId: bundle.event.opId,
            status: "accepted_durable",
            firstRevision: members[0]!.event.workspaceRevision,
            lastRevision: bundle.event.workspaceRevision,
            recordedAt: input.now(),
            memberOpIds: members.map(({ event }) => event.opId),
          });
          return {
            status: "applied",
            event: bundle.event,
            revision: bundle.event.workspaceRevision,
            commitSha: null,
            cut: target.publication(bundle.event).cut,
          };
        };
      if (property === "publication")
        return (event: CanonicalEventV1) => ({
          cut: {
            repoId: input.store.ledgerMetadata().repoId,
            revision: event.workspaceRevision,
            headDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
            opId: event.opId,
          },
          commitSha: null,
        });
      return Reflect.get(target, property);
    },
  }) as CanonicalEventStore;
  const projection = makeTaskProjection({ rootDir, eventStore: store });
  projectionHolder.current = projection;
  projection.catchUp?.();
  return {
    store,
    rootDir,
    projection,
    accept: (prepared) => store.append({ ...prepared.at(-1)!, preceding: prepared.slice(0, -1) }),
    bundles: () => accepted,
    close: () => {
      projection.close();
      workspace.close();
    },
  };
}

function addFact(context: MigrationImportContext, row: RelationFactRow): void {
  const legacyRef = row.taskId ? `fact/${row.taskId}/${row.factId}` : row.ref,
    factRef = context.cold.legacyFactRefs.has(legacyRef) ? legacyRef : row.ref,
    occurredAt = context.timestamp(row.observedAt),
    mappedTaskId = row.taskId ? context.taskMap.get(row.taskId) : undefined;
  if (!occurredAt || (row.taskId !== undefined && !mappedTaskId) || !context.validFact(row)) {
    context.skips.push({
      entityType: "fact",
      migratedFrom: factRef,
      sourcePath: context.cold.truth.factAnchors.find(({ factRef: ref }) => ref === row.ref)?.sourcePath ?? factRef,
      reason:
        row.taskId !== undefined && !mappedTaskId
          ? "fact owner task was skipped"
          : "fact fields or occurredAt are invalid",
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
  const held = context.existingSourceEntity("fact", factRef, (event) =>
    matchesRestatedFact(context, row, mappedTaskId, occurredAt, event),
  );
  if (held?.kind === "fact") {
    const targetRef = `fact/${held.fact.factId}`;
    context.factMap.set(factRef, targetRef);
    context.factTargets.add(targetRef);
    if (row.ref !== factRef && !context.factMap.has(row.ref)) context.factMap.set(row.ref, targetRef);
    context.alreadyImported.fact += 1;
    return;
  }
  let targetFactId = row.factId,
    targetRef = `fact/${targetFactId}`;
  const sourceTargetOccupied = context.factTargets.has(targetRef);
  if (context.existingFacts.has(targetRef) || sourceTargetOccupied) {
    targetFactId = `F-${sha256Text(`${context.sourceKey}\0${factRef}`).slice(0, 8).toUpperCase()}`;
    targetRef = `fact/${targetFactId}`;
    if (context.existingFacts.has(targetRef) || context.factTargets.has(targetRef))
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
  context.factTargets.add(targetRef);
  if (row.ref !== factRef && !context.factMap.has(row.ref)) context.factMap.set(row.ref, targetRef);
  context.drafts.push({
    kind: "fact",
    migratedFrom: factRef,
    occurredAt,
    build: (workspaceRevision: number) => {
      const fact = {
          ...(mappedTaskId ? { taskId: mappedTaskId } : {}),
          factId: targetFactId,
          statement: row.statement,
          evidenceSource: row.source,
          observedAt: row.observedAt,
          confidence: row.confidence,
          memoryClass: row.memoryClass,
          memoryTags: row.memoryTags as never,
          provenance: canonicalMigrationProvenance(row.provenance) as never,
        },
        record = {
          factId: targetFactId,
          statement: row.statement,
          evidenceSource: row.source,
          observedAt: row.observedAt,
          confidence: row.confidence,
          state: "standing" as const,
          workspaceRevision,
        },
        records = mappedTaskId ? [...(context.factDocuments.get(mappedTaskId) ?? []), record] : [];
      if (mappedTaskId) context.factDocuments.set(mappedTaskId, records);
      const body = renderFactsDocument([record]),
        documentClaim = context.claim(`facts/${targetFactId}.md`, body, "text/markdown");
      return context.prepare(
        context.sourceKey,
        context.actorFor(row.taskId ? `task/${row.taskId}` : factRef),
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

function matchesRestatedFact(
  context: MigrationImportContext,
  row: RelationFactRow,
  mappedTaskId: string | undefined,
  occurredAt: string,
  event: MigrationImportEventV1,
): boolean {
  const target = /^fact\/(F-[0-9A-HJKMNP-TV-Z]{8})$/u.exec(event.payload.migratedFrom);
  if (!target || event.payload.entity.kind !== "fact" || event.occurredAt !== occurredAt) return false;
  const factId = target[1]!,
    fact = {
      ...(mappedTaskId ? { taskId: mappedTaskId } : {}),
      factId,
      statement: row.statement,
      evidenceSource: row.source,
      observedAt: row.observedAt,
      confidence: row.confidence,
      memoryClass: row.memoryClass,
      memoryTags: row.memoryTags,
      provenance: canonicalMigrationProvenance(row.provenance),
    },
    record = {
      factId,
      statement: row.statement,
      evidenceSource: row.source,
      observedAt: row.observedAt,
      confidence: row.confidence,
      state: "standing" as const,
      workspaceRevision: event.workspaceRevision,
    },
    body = renderFactsDocument([record]),
    expected = {
      kind: "fact" as const,
      fact: comparableFact(fact),
      documentClaim: context.claim(`facts/${factId}.md`, body, "text/markdown"),
    },
    actual = {
      ...event.payload.entity,
      fact: comparableFact(event.payload.entity.fact),
    };
  return stableStringify(actual) === stableStringify(expected);
}

function comparableFact<T extends { readonly provenance: readonly Readonly<Record<string, unknown>>[] }>(
  fact: T,
): Omit<T, "provenance"> & {
  readonly provenance: readonly Readonly<Record<string, unknown>>[];
} {
  return {
    ...fact,
    provenance: fact.provenance.map(({ transcriptReachability: _reachability, ...entry }) => entry),
  };
}
