import {
  isDecisionEvent,
  isDocEvent,
  ledgerCommitSha,
  serializePersistedCanonicalEvent,
} from "../domain/doc-sync.contract.ts";
import {
  isLedgerLayoutMigrationEvent,
  ledgerLayoutMigrationWritePlan,
  type LedgerLayoutMigrationEventV1,
} from "../domain/ledger-layout-migration-event.ts";
import { serializeEventHead } from "../domain/write-chain.contract.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { isPeopleEvent } from "../domain/people-event.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { type LedgerObjectLayout } from "../layout/ledger-object-layout.ts";
import { ledgerGitPath } from "./ledger-git-layout.ts";
import { localGitObjectRefStore as gitObjects } from "./local-version-control-system.ts";
import type {
  CanonicalWriteBundle,
  CanonicalEventAppendReceipt,
  CanonicalEventStore,
  EventRecoveryReceipt,
  PublicationDelete,
  PublicationFile,
  PublicationRename,
} from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import type { StoreRuntime } from "./task-event-store-runtime.ts";
import { assertBundle, validatePrepared } from "./task-event-store-validation.ts";
import { canonicalLedgerCut, readBlobsAt, readEventAt, receipt } from "./task-event-store-reads.ts";
import {
  blobObjectPath,
  checkedEventBytes,
  contentEntriesFromShards,
  eventEntriesFromShards,
  eventObjectPath,
  mixedLayoutError,
  scanContentRoot,
  scanEventsRoot,
  writeLayoutAt,
} from "./task-event-store-layout.ts";
import {
  assertPublicationCut,
  deleteRef,
  finalizeRefs,
  prepareCommit,
  preparedRefs,
  publicationRef,
} from "./task-event-store-git-refs.ts";
import {
  auditLayoutMigration,
  canonicalDocumentClaims,
  canonicalDocumentRetirements,
  commitParent,
  flatLayoutAt,
} from "./task-event-store-claims-layout.ts";
import { assertAuthorizedReplacement, changedPublication } from "./task-event-store-publication-audit.ts";
import { documentMode, messageOf, settleFiles, showText, workspacePath } from "./task-event-store-materialization.ts";

// Append protocol, layout migration, normalization, and prepared-publication recovery.
export function createPublicationApi(runtime: StoreRuntime) {
  const publish = (
    bundle: CanonicalWriteBundle,
    additionalFiles: readonly PublicationRename[] = [],
  ): CanonicalEventAppendReceipt => {
    const { event, blobs } = bundle;
    assertBundle(bundle);
    const started = gitObjects.processCount();
    const eventBytes = checkedEventBytes(event);
    const parent = runtime.currentCommit();
    const previousHead = runtime.readHead();
    const writeLayout: LedgerObjectLayout = isLedgerLayoutMigrationEvent(event)
      ? "sharded-sha256-2/v1"
      : runtime.layoutState === undefined
        ? (runtime.layoutState = writeLayoutAt(runtime.ledger, parent.sha))
        : runtime.layoutState === "mixed"
          ? (() => {
              throw mixedLayoutError(scanEventsRoot(runtime.ledger, parent.sha)!);
            })()
          : runtime.layoutState;
    const existing =
      runtime.recentEvents.get(event.opId) ??
      (runtime.knownOpIds !== null && !runtime.knownOpIds.has(event.opId)
        ? null
        : readEventAt(runtime.ledger, parent.sha, event.opId));
    if (existing !== null) {
      runtime.rememberEvents([existing]);
      if (serializePersistedCanonicalEvent(existing) !== eventBytes)
        throw new TaskEventStoreError("op_conflict", `opId ${event.opId} already names different event bytes`);
      return receipt(event, parent, started, []);
    }
    if (isDecisionEvent(event)) {
      const current = showText(
        runtime.repoRoot,
        parent.sha,
        ledgerGitPath(runtime.ledger, event.payload.decisionDocumentClaim.path),
      );
      const base = current === null ? null : sha256Text(current);
      if (event.payload.baseDocumentSha256 !== base)
        throw new TaskEventStoreError("revision_conflict", `Decision ${event.decisionId} document base changed`);
    }
    if (event.workspaceRevision !== (previousHead?.revision ?? 0) + 1)
      throw new TaskEventStoreError(
        "revision_conflict",
        `workspace revision ${event.workspaceRevision} must follow ${previousHead?.revision ?? 0}`,
      );
    const replacementClaim = isSettingsEvent(event)
        ? event.payload.harnessDocumentClaim
        : isPeopleEvent(event)
          ? event.payload.peopleDocumentClaim
          : null,
      replacementCandidate = replacementClaim
        ? blobs.find((blob) => blob.sha256 === replacementClaim.sha256)?.body
        : undefined;
    assertAuthorizedReplacement(runtime.ledger, parent.sha, event, false, replacementCandidate);
    if (
      isDocEvent(event) &&
      stableStringify(event.payload.baseLedgerSha) !== stableStringify(canonicalLedgerCut(runtime.repoId, previousHead))
    )
      throw new TaskEventStoreError(
        "repo_mismatch",
        "doc event base cut must equal its repo-bound canonical event cut",
      );
    const head = {
      revision: event.workspaceRevision,
      opId: event.opId,
      eventDigest: `sha256:${sha256Text(eventBytes)}` as const,
    };
    const files: PublicationFile[] = [
      {
        target: eventObjectPath(runtime.ledger, event.opId, writeLayout),
        body: eventBytes,
        mode: "100644",
      },
      {
        target: ledgerGitPath(runtime.ledger, "events/head.json"),
        body: serializeEventHead(head),
        mode: "100644",
      },
      ...additionalFiles,
    ];
    const uncached = blobs.filter((blob) => !runtime.recentContent.has(blob.sha256)).map((blob) => blob.sha256);
    const existingBlobs = readBlobsAt(runtime.ledger, parent.sha, uncached);
    for (const claim of blobs) {
      const existingBlob = runtime.recentContent.get(claim.sha256) ?? existingBlobs.get(claim.sha256) ?? null;
      if (existingBlob !== null) {
        if (sha256Text(Buffer.from(existingBlob).toString("utf8")) !== claim.sha256)
          throw new TaskEventStoreError("invalid_store", `reachable content blob ${claim.sha256} is corrupt`);
      } else {
        files.push({
          target: blobObjectPath(runtime.ledger, claim.sha256, writeLayout),
          body: claim.body,
          mode: "100644",
        });
      }
    }
    for (const claim of canonicalDocumentClaims(event)) {
      const blob = blobs.find((candidate) => candidate.sha256 === claim.sha256);
      if (!blob)
        throw new TaskEventStoreError("invalid_write_plan", `authored file ${claim.path} has no content input`);
      files.push({
        target: ledgerGitPath(runtime.ledger, claim.path),
        body: blob.body,
        mode: documentMode(event, claim.path),
      });
    }
    for (const retirement of canonicalDocumentRetirements(event))
      files.push({ delete: ledgerGitPath(runtime.ledger, retirement.path) });
    const changedPaths = files
      .flatMap((file) => ("target" in file ? [file.target] : "from" in file ? [file.from, file.to] : [file.delete]))
      .map((target) => workspacePath(runtime.layout.rootDir, runtime.layout.authoredRoot, runtime.ledger, target))
      .sort();
    runtime.options.beforeAppend?.();
    const preparedRef = publicationRef(event.opId);
    runtime.initialPrepared = null;
    runtime.options.killpoint?.("before_event_write");
    runtime.options.killpoint?.("after_event_write");
    const preparedSha = prepareCommit(runtime.repoRoot, preparedRef, parent.sha, files, event.opId, event.occurredAt);
    runtime.options.killpoint?.("after_head_write");
    let nodeSyncs: number;
    try {
      nodeSyncs = settleFiles(runtime.repoRoot, preparedSha, files, runtime.options.killpoint, () => {
        const finalize = () => {
          runtime.options.beforeAppend?.();
          assertAuthorizedReplacement(runtime.ledger, parent.sha, event, false, replacementCandidate);
          try {
            finalizeRefs(runtime.repoRoot, runtime.authoredRef, preparedSha, parent.sha);
          } catch (error) {
            try {
              deleteRef(runtime.repoRoot, preparedRef);
            } catch (cleanupError) {
              throw new TaskEventStoreError(
                "publication_indeterminate",
                `canonical ref CAS failed and prepared-ref cleanup also failed: ${messageOf(cleanupError)}`,
              );
            }
            throw new TaskEventStoreError(
              "publication_indeterminate",
              [
                `runtime.ledger ${runtime.authoredRef} must point at the last published event commit ${parent.sha},`,
                "but a commit was made outside the daemon. Recover with:",
                `git -C ${runtime.repoRoot} update-ref ${runtime.authoredRef} ${parent.sha} —`,
                "this moves only the branch pointer and leaves every file in place.",
                `Then run ha daemon stop and retry. Cause: ${messageOf(error)}`,
              ].join(" "),
            );
          }
          runtime.canonicalCommit = preparedSha;
          runtime.authoredCommit = preparedSha;
          runtime.canonicalHead = head;
          runtime.rememberEvents([event]);
          if (blobs.length) runtime.recentContent = new Map(blobs.map((blob) => [blob.sha256, Buffer.from(blob.body)]));
          runtime.options.killpoint?.("after_git_commit");
        };
        (runtime.options.withAppendFence ? () => runtime.options.withAppendFence!(finalize) : finalize)();
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "writer_epoch_stale") {
        try {
          deleteRef(runtime.repoRoot, preparedRef);
        } catch (cleanupError) {
          throw new TaskEventStoreError(
            "publication_indeterminate",
            `prepared-ref cleanup failed after writer epoch rejection: ${messageOf(cleanupError)}`,
          );
        }
        throw error;
      }
      if (!(error instanceof TaskEventStoreError) || error.code !== "revision_conflict") throw error;
      try {
        deleteRef(runtime.repoRoot, preparedRef);
      } catch (cleanupError) {
        throw new TaskEventStoreError(
          "publication_indeterminate",
          `prepared-ref cleanup failed after destination preimage rejection: ${messageOf(cleanupError)}`,
        );
      }
      throw error;
    }
    deleteRef(runtime.repoRoot, preparedRef);
    return receipt(event, ledgerCommitSha(runtime.repoId, preparedSha), started, changedPaths, nodeSyncs);
  };
  const migrateLayout: CanonicalEventStore["migrateLayout"] = (migration) => {
    assertPublicationCut(runtime.repoRoot, runtime.authoredRef, runtime.canonicalCommit);
    const started = gitObjects.processCount();
    let parent = runtime.currentCommit();
    const previousHead = runtime.readHead();
    let flat = flatLayoutAt(runtime.ledger, parent.sha);
    if (flat.events.length === 0 && flat.blobs.length === 0) {
      const event = previousHead ? runtime.readEvent(previousHead.opId) : null;
      if (event && isLedgerLayoutMigrationEvent(event)) {
        const before = commitParent(runtime.repoRoot, parent.sha);
        auditLayoutMigration(runtime.ledger, before, parent.sha, event);
        runtime.layoutState = "sharded-sha256-2/v1";
        return receipt(event, parent, started, []);
      }
      throw new TaskEventStoreError("invalid_store", "runtime.ledger has no flat runtime.layout to migrate");
    }
    if (flat.hasShardedEvents || flat.hasShardedBlobs) {
      normalizeMixedLayout(parent.sha, migration.occurredAt);
      parent = runtime.currentCommit();
      flat = flatLayoutAt(runtime.ledger, parent.sha);
      if (flat.hasShardedEvents || flat.hasShardedBlobs)
        throw new TaskEventStoreError("invalid_store", "mixed ledger normalization left sharded entries behind");
    }
    if (flat.events.length !== (previousHead?.revision ?? 0))
      throw new TaskEventStoreError("invalid_store", "flat event count does not match the canonical head revision");
    const opId = `op_${sha256Text(`ledger-layout-migrate\0${parent.sha}`)}`;
    const event: LedgerLayoutMigrationEventV1 = {
      schema: "ledger-layout-event/v1",
      eventId: `event-${sha256Text(opId)}`,
      workspaceRevision: (previousHead?.revision ?? 0) + 1,
      opId,
      type: "ledger_layout_migrated",
      actor: migration.actor,
      source: migration.source,
      occurredAt: migration.occurredAt,
      payload: {
        from: "flat/v1",
        to: "sharded-sha256-2/v1",
        eventCount: flat.events.length,
        blobCount: flat.blobs.length,
        preEventsTreeSha: flat.preEventsTreeSha,
      },
    };
    const renames: PublicationRename[] = [
      ...flat.events.map(({ name }) => ({
        from: ledgerGitPath(runtime.ledger, `events/${name}`),
        to: eventObjectPath(runtime.ledger, name.slice(0, -5)),
      })),
      ...flat.blobs.map(({ name }) => ({
        from: ledgerGitPath(runtime.ledger, `objects/sha256/${name}`),
        to: blobObjectPath(runtime.ledger, name),
      })),
    ];
    const appended = publish({ event, plan: ledgerLayoutMigrationWritePlan(event), blobs: [] }, renames);
    auditLayoutMigration(runtime.ledger, parent.sha, appended.commitSha!.sha, event);
    runtime.layoutState = "sharded-sha256-2/v1";
    return appended;
  };
  /** Fold a mixed flat/sharded events root back onto one complete flat/v1 cut: sharded entries
   * move to their flat spelling, twins (the same bytes at both spellings) drop their sharded
   * copy, and one path-limited commit lands under the same CAS discipline as an event
   * publication. A crash before the ref update only leaves a deterministic re-do. */
  const normalizeMixedLayout = (parent: string, occurredAt: string): string => {
    const events = scanEventsRoot(runtime.ledger, parent),
      content = scanContentRoot(runtime.ledger, parent);
    if (events === null) throw new TaskEventStoreError("invalid_store", "flat runtime.ledger has no events tree");
    const shardedEvents = eventEntriesFromShards(runtime.ledger, events.shards),
      shardedBlobs = contentEntriesFromShards(runtime.ledger, content?.shards ?? []);
    const flatEvents = new Map(events.flat.map((entry) => [entry.name, entry.oid] as const)),
      flatBlobs = new Map((content?.flat ?? []).map((entry) => [entry.name, entry.oid] as const));
    const renames: PublicationRename[] = [],
      deletions: PublicationDelete[] = [];
    for (const { name, oid } of shardedEvents) {
      const flatName = name.slice(name.indexOf("/") + 1),
        from = ledgerGitPath(runtime.ledger, `events/${name}`),
        twin = flatEvents.get(flatName);
      if (twin === undefined) renames.push({ from, to: ledgerGitPath(runtime.ledger, `events/${flatName}`) });
      else if (twin !== oid)
        throw new TaskEventStoreError(
          "invalid_store",
          `event ${flatName} names different bytes at its flat and sharded paths`,
        );
      else deletions.push({ delete: from });
    }
    for (const { name, oid } of shardedBlobs) {
      const flatName = name.replace("/", ""),
        from = ledgerGitPath(runtime.ledger, `objects/sha256/${name}`),
        twin = flatBlobs.get(flatName);
      if (twin === undefined)
        renames.push({
          from,
          to: ledgerGitPath(runtime.ledger, `objects/sha256/${flatName}`),
        });
      else if (twin !== oid)
        throw new TaskEventStoreError(
          "invalid_store",
          `content object ${flatName} names different bytes at its flat and sharded paths`,
        );
      else deletions.push({ delete: from });
    }
    if (renames.length + deletions.length === 0)
      throw new TaskEventStoreError("invalid_store", "mixed ledger has no sharded entries to normalize");
    assertPublicationCut(runtime.repoRoot, runtime.authoredRef, parent);
    const ref = `refs/ha-runtime.layout-normalized/${sha256Text(parent)}`,
      sha = prepareCommit(
        runtime.repoRoot,
        ref,
        parent,
        [...renames, ...deletions],
        `harness runtime.layout normalize ${parent}`,
        occurredAt,
      );
    settleFiles(runtime.repoRoot, sha, [...renames, ...deletions]);
    finalizeRefs(runtime.repoRoot, runtime.authoredRef, sha, parent);
    deleteRef(runtime.repoRoot, ref);
    runtime.canonicalCommit = sha;
    runtime.authoredCommit = sha;
    return sha;
  };
  const recover = (): EventRecoveryReceipt => {
    const started = performance.now();
    const prepared = runtime.initialPrepared ?? preparedRefs(runtime.repoRoot);
    runtime.initialPrepared = null;
    if (runtime.options.rejectPreparedRecovery && prepared.length > 0) {
      for (const [ref] of prepared) deleteRef(runtime.repoRoot, ref);
      return {
        status: "none",
        publications: 0,
        elapsedMs: performance.now() - started,
      };
    }
    if (prepared.length === 0)
      return {
        status: "none",
        publications: 0,
        elapsedMs: performance.now() - started,
      };
    if (prepared.length !== 1)
      return {
        status: "indeterminate",
        publications: 0,
        elapsedMs: performance.now() - started,
      };
    const [ref, sha] = prepared[0]!;
    try {
      const changed = changedPublication(runtime.ledger, sha);
      validatePrepared(runtime.ledger, sha, changed.files, changed.head);
      if (runtime.canonicalCommit === sha && runtime.authoredCommit === sha) {
        assertAuthorizedReplacement(
          runtime.ledger,
          changed.parent,
          changed.event,
          true,
          isSettingsEvent(changed.event) || isPeopleEvent(changed.event)
            ? (showText(
                runtime.repoRoot,
                sha,
                ledgerGitPath(
                  runtime.ledger,
                  isSettingsEvent(changed.event)
                    ? changed.event.payload.harnessDocumentClaim.path
                    : changed.event.payload.peopleDocumentClaim.path,
                ),
              ) ?? undefined)
            : undefined,
        );
        runtime.canonicalHead = changed.head;
        runtime.rememberEvents([changed.event]);
        settleFiles(runtime.repoRoot, sha, changed.files);
        deleteRef(runtime.repoRoot, ref);
        return {
          status: "already_committed",
          publications: 0,
          elapsedMs: performance.now() - started,
        };
      }
      if (runtime.canonicalCommit === changed.parent && runtime.authoredCommit === changed.parent) {
        assertAuthorizedReplacement(
          runtime.ledger,
          changed.parent,
          changed.event,
          false,
          isSettingsEvent(changed.event) || isPeopleEvent(changed.event)
            ? (showText(
                runtime.repoRoot,
                sha,
                ledgerGitPath(
                  runtime.ledger,
                  isSettingsEvent(changed.event)
                    ? changed.event.payload.harnessDocumentClaim.path
                    : changed.event.payload.peopleDocumentClaim.path,
                ),
              ) ?? undefined)
            : undefined,
        );
        settleFiles(runtime.repoRoot, sha, changed.files);
        finalizeRefs(runtime.repoRoot, runtime.authoredRef, sha, changed.parent, [ref, sha]);
        runtime.canonicalCommit = sha;
        runtime.authoredCommit = sha;
        runtime.canonicalHead = changed.head;
        runtime.rememberEvents([changed.event]);
        return {
          status: "committed",
          publications: 1,
          elapsedMs: performance.now() - started,
        };
      }
    } catch {
      return {
        status: "indeterminate",
        publications: 0,
        elapsedMs: performance.now() - started,
      };
    }
    return {
      status: "indeterminate",
      publications: 0,
      elapsedMs: performance.now() - started,
    };
  };
  return { publish, migrateLayout, recover };
}
