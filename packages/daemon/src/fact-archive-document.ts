import { createHash } from "node:crypto";
import {
  compileFactArchiveWrite,
  compileFactUnarchiveWrite,
  readAcceptedCommandOutcome,
  type AuthorizationDecision,
  type CanonicalEventStore,
  type CompiledFactWrite,
  type EventPublicationKillpoint,
  type FactEventDraftV1,
  type TaskProjection,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { factDocumentRecord } from "./entity-document-rematerialize.ts";
import { publicationKillpoints, reject } from "./entity-action-relation.ts";
import { workspaceText } from "./repo-cell-packets.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";

/** Per-Fact mechanical preconditions shared by the single and batch archive paths: the row must
 * exist, must not already be archived, and its managed document must still be projected — the
 * document's blob hash is the delete proof the event carries. Whether the Fact *ought* to be
 * archived is the caller's judgment, never checked here. */
export function factArchiveBundle(
  projection: TaskProjection,
  event: FactEventDraftV1,
): ReturnType<typeof compileFactArchiveWrite> {
  const fact = projection.readFact(event.factId).fact;
  if (!fact) reject("invalid_command", `Fact fact/${event.factId} does not exist.`);
  if (fact!.archived === true) reject("invalid_command", `Fact fact/${event.factId} is already archived.`);
  const path = `facts/${event.factId}.md`,
    document = projection.readDocument(path).document;
  if (!document) reject("content_not_ready", `Fact document ${path} is unavailable.`);
  return compileFactArchiveWrite({ event, retiredDocumentSha256: document!.blobSha256 });
}

export function factUnarchiveBundle(
  projection: TaskProjection,
  event: FactEventDraftV1,
): ReturnType<typeof compileFactUnarchiveWrite> {
  const fact = projection.readFact(event.factId).fact;
  if (!fact) reject("invalid_command", `Fact fact/${event.factId} does not exist.`);
  if (fact!.archived !== true) reject("invalid_command", `Fact fact/${event.factId} is not archived.`);
  return compileFactUnarchiveWrite({
    event,
    document: { ...factDocumentRecord(projection, fact!), workspaceRevision: event.workspaceRevision },
  });
}

/** The archive payload carries the Fact's observation snapshot, copied from the projection row the
 * same way `reclassificationAction` does; `reason` is the only authored field the caller supplies. */
export function factArchivePreload(
  projection: TaskProjection,
  action: Readonly<Record<string, unknown>>,
  factId: string,
): Readonly<Record<string, unknown>> {
  const fact = projection.readFact(factId).fact;
  if (!fact) reject("invalid_command", `Fact fact/${factId} does not exist.`);
  return {
    ...action,
    factId,
    ...(fact.taskId ? { taskId: fact.taskId } : {}),
    statement: fact.statement,
    evidenceSource: fact.evidenceSource,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
    memoryClass: fact.memoryClass,
    memoryTags: fact.memoryTags,
  };
}

/** Batch id source: `--ids-file` (one Fact id per line, `#` comments and blanks ignored) or a
 * literal `factIds` array. Every id is validated individually before any write is compiled. */
export function factArchiveIds(rootDir: string, action: RepoTaskAction): readonly string[] {
  const listed = Array.isArray(action.factIds) ? action.factIds.map(String) : null,
    fromFile = typeof action.idsFile === "string" ? action.idsFile : null;
  if (listed !== null && fromFile !== null)
    reject("invalid_command", "Use either factIds or --ids-file for fact archive, not both.");
  const raw = fromFile !== null ? workspaceText(rootDir, fromFile, "idsFile") : null,
    ids =
      raw !== null
        ? raw
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"))
        : (listed ?? []),
    invalid = ids.find((id) => !/^F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(id));
  if (invalid !== undefined) reject("invalid_command", `Fact archive id ${invalid} is not a canonical Fact id.`);
  if (new Set(ids).size !== ids.length) reject("invalid_command", "Fact archive ids must not contain duplicates.");
  return ids;
}

/** `ha fact archive --ids-file`: one `fact_archived` event per Fact, appended as one ledger batch
 * through the same central write queue as a single archive. The batch opId is the terminal event's
 * opId so replay of the same request returns `applied` without writing again; member events get
 * deterministic derived opIds. */
export function archiveAllFacts(
  input: {
    readonly rootDir?: string;
    readonly store: CanonicalEventStore;
    readonly projection: TaskProjection;
    readonly now: () => string;
    readonly killpoint?: (point: EventPublicationKillpoint) => void;
    readonly authorize: () => AuthorizationDecision;
    readonly compile: (
      action: Readonly<Record<string, unknown>>,
      opId: string,
      occurredAt: string,
      allocatedRevision: number,
    ) => CompiledFactWrite;
  },
  action: RepoTaskAction,
  opId: string,
): WriteReceipt {
  const ids = factArchiveIds(input.rootDir ?? process.cwd(), action),
    initialRevision = input.store.readHead()?.revision ?? 0,
    existingOutcome = readAcceptedCommandOutcome(input.store, opId),
    authorizationDecision = input.authorize(),
    occurredAt = input.store.readEvent(opId)?.occurredAt ?? input.now(),
    pendingCut = input.projection.readCut(),
    base = {
      opId,
      revision: existingOutcome?.lastRevision ?? initialRevision,
      evidence: JSON.stringify({
        schema: "fact-archive-batch-report/v1",
        factIds: ids,
        reason: action.reason,
      }),
      visibility: "center" as const,
      proof: {
        committedRevision: existingOutcome?.lastRevision ?? initialRevision,
        appliedCut: pendingCut.watermark,
        durable: existingOutcome !== null,
        canonicalVisible: existingOutcome?.lastRevision != null && pendingCut.watermark >= existingOutcome.lastRevision,
        worktreeVisible: false,
      },
      authorizationDecision,
    };
  if (existingOutcome !== null) return { outcome: "applied", ...base };
  if (ids.length === 0) return { outcome: "no_changes", ...base };
  if (action.dryRun === true) return { outcome: "pending", ...base };
  const bundles = ids.map((factId, index) => {
      const memberOpId =
        index === ids.length - 1 ? opId : `${opId}-${createHash("sha256").update(factId).digest("hex").slice(0, 12)}`;
      return input.compile(
        factArchivePreload(input.projection, action, factId),
        memberOpId,
        occurredAt,
        initialRevision + index + 1,
      );
    }),
    terminal = bundles.at(-1)!;
  input.store.append({ ...terminal, preceding: bundles.slice(0, -1) });
  for (const bundle of bundles) input.projection.apply(bundle.event, bundle.plan);
  publicationKillpoints(input.killpoint);
  const outcome = readAcceptedCommandOutcome(input.store, opId),
    revision = outcome?.lastRevision ?? terminal.event.workspaceRevision,
    appliedCut = input.projection.readCut().watermark,
    canonicalVisible = appliedCut >= revision;
  return {
    outcome: canonicalVisible ? "applied" : "pending",
    ...base,
    revision,
    evidence: JSON.stringify({
      schema: "fact-archive-batch-report/v1",
      factIds: ids,
      reason: action.reason,
      results: bundles.map((bundle) => ({
        factId: bundle.event.factId,
        opId: bundle.event.opId,
        eventId: bundle.event.eventId,
        path: `facts/${bundle.event.factId}.md`,
      })),
    }),
    proof: {
      committedRevision: revision,
      appliedCut,
      durable: outcome !== null,
      canonicalVisible,
      worktreeVisible: false,
    },
  };
}
