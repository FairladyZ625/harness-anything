import { serializePersistedCanonicalEvent } from "../domain/doc-sync.contract.ts";
import { VcsCommandError } from "../ports/version-control-system.ts";
import {
  canonicalDocumentClaims,
  canonicalDocumentMode,
  canonicalDocumentRetirements,
  TaskEventStoreError,
} from "./task-event-store.ts";
import { ledgerGitPath, resolveLedgerGitLayout } from "./ledger-git-layout.ts";
import { localGitObjectRefStore, localGitWorktreeSettlement } from "./local-version-control-system.ts";
import { makeTaskEventStore as makeGitEventStore } from "./task-event-store.ts";
import { openWalDurablePrefix, type WalEventRecord } from "./wal-event-log.ts";
import { flushWalToGit, WalMaterializerDivergedError, WalMaterializerRefChangedError } from "./wal-git-materializer.ts";
import {
  WAL_MATERIALIZATION_RESPONSE_SCHEMA,
  type WalBaselineDeltaV1,
  type WalMaterializationFailureV1,
  type WalMaterializationFenceV1,
  type WalMaterializationRequestV1,
  type WalMaterializationResponseV1,
  type WalMaterializationSuccessV1,
  type WalMaterializationWorkerConfig,
} from "./wal-materialization-protocol.ts";

export function runWalMaterializationRequest(
  config: WalMaterializationWorkerConfig,
  request: WalMaterializationRequestV1,
  options: {
    readonly withFinalizeFence?: <T>(fence: WalMaterializationFenceV1, operation: () => T) => T;
  } = {},
): WalMaterializationResponseV1 {
  try {
    if (request.testFault?.point === "worker_exit") throw new Error("simulated retired materializer worker exit");
    if (request.testFault?.point === "before_materialization")
      throw new Error("simulated worker materialization failure");
    const source = openWalDurablePrefix(config.rootDir, request.cut),
      records = source.records(),
      finalizeFence = request.fence,
      git = makeGitEventStore({
        repoId: config.repoId,
        rootDir: config.rootDir,
        ...(config.authoredBranch ? { authoredBranch: config.authoredBranch } : {}),
      }),
      actualRevision = git.readHead()?.revision ?? 0;
    if (
      actualRevision < request.expectedGit.revision ||
      actualRevision > request.cut.throughRevision ||
      (actualRevision === request.expectedGit.revision && git.currentCommit().sha !== request.expectedGit.commitSha)
    )
      throw new TaskEventStoreError(
        "publication_indeterminate",
        "Git cut changed before the WAL materialization worker accepted its durable prefix",
      );
    const materializationStarted = performance.now(),
      result = flushWalToGit(source, git, {
        rootDir: config.rootDir,
        layout: request.expectedGit.layout,
        ...(config.authoredBranch ? { authoredBranch: config.authoredBranch } : {}),
        compactWorktree: request.compactWorktree,
        ...(finalizeFence
          ? {
              withAppendFence: <T>(operation: () => T): T => {
                if (!options.withFinalizeFence)
                  throw new TaskEventStoreError(
                    "publication_indeterminate",
                    "WAL materialization fence cannot be verified by this worker",
                  );
                return options.withFinalizeFence(finalizeFence, operation);
              },
            }
          : {}),
        killpoint: (point) => {
          if (request.testFault?.point === point) throw new Error(`simulated ${point} materializer failure`);
        },
      }),
      materializationMs = performance.now() - materializationStarted,
      fingerprintStarted = performance.now(),
      ledger = resolveLedgerGitLayout(config.rootDir),
      ignored = new Set(
        records.flatMap((record) => [
          ...canonicalDocumentClaims(record.event).map((claim) => ledgerGitPath(ledger, claim.path)),
          ...canonicalDocumentRetirements(record.event).map((retirement) => ledgerGitPath(ledger, retirement.path)),
        ]),
      ),
      fingerprint = localGitWorktreeSettlement.changesFingerprint(
        ledger.rootDir,
        ledger.authoredPrefix || ".",
        ignored,
      ),
      actor = records.at(-1)?.event.actor,
      response: WalMaterializationSuccessV1 = {
        schema: WAL_MATERIALIZATION_RESPONSE_SCHEMA,
        requestId: request.requestId,
        outcome: "materialized",
        cut: request.cut,
        git: result,
        baselineDelta: baselineDelta(ledger, source.readContentBlob, records),
        settlementFingerprint: fingerprint,
        settlementIntent:
          actor && fingerprint !== null && fingerprint !== request.previousSettlementFingerprint
            ? { schema: "harness-doc-settlement-intent/v1", actor, fingerprint, inventory: null }
            : null,
        spans: {
          materializationMs,
          fingerprintMs: performance.now() - fingerprintStarted,
        },
      };
    return response;
  } catch (error) {
    return failureResponse(request.requestId, request.cut, error, request.testFault !== undefined);
  }
}

function baselineDelta(
  ledger: ReturnType<typeof resolveLedgerGitLayout>,
  readContentBlob: (sha256: string) => Uint8Array | null,
  records: readonly WalEventRecord[],
): WalBaselineDeltaV1 {
  const events = records.map((record) => ({
      opId: record.opId,
      oid: localGitObjectRefStore.blobOid(serializePersistedCanonicalEvent(record.event)),
    })),
    files = new Map<string, WalBaselineDeltaV1["files"][number]>();
  for (const record of records) {
    for (const retirement of canonicalDocumentRetirements(record.event)) {
      const target = ledgerGitPath(ledger, retirement.path);
      files.set(target, { delete: target });
    }
    for (const claim of canonicalDocumentClaims(record.event)) {
      const bytes = readContentBlob(claim.sha256);
      if (bytes === null)
        throw new TaskEventStoreError("invalid_store", `WAL content object ${claim.sha256} is missing`);
      const target = ledgerGitPath(ledger, claim.path);
      files.set(target, {
        target,
        mode: canonicalDocumentMode(record.event, claim.path),
        oid: localGitObjectRefStore.blobOid(bytes),
      });
    }
  }
  return { events, files: [...files.values()] };
}

function failureResponse(
  requestId: string,
  cut: WalMaterializationRequestV1["cut"] | null,
  error: unknown,
  injectedTransientFault = false,
): WalMaterializationFailureV1 {
  const failure = error instanceof Error ? error : new Error(String(error));
  const classification =
    failure instanceof WalMaterializerDivergedError
      ? "git_diverged"
      : injectedTransientFault || isRetryableWalMaterializationError(failure)
        ? "retryable"
        : "deterministic_failure";
  return {
    schema: WAL_MATERIALIZATION_RESPONSE_SCHEMA,
    requestId,
    outcome: "failed",
    cut: cut ?? {
      schema: "harness-wal-durable-cut/v1",
      throughRevision: 1,
      lastOffset: 1,
      headDigest: `sha256:${"0".repeat(64)}`,
    },
    error: {
      name: failure.name,
      message: failure.message,
      code: materializationErrorCode(failure),
      classification,
      canonicalSha: failure instanceof WalMaterializerDivergedError ? failure.canonicalSha : null,
    },
  };
}

const transientSystemErrorCodes = new Set(["EAGAIN", "EBUSY", "EINTR", "EMFILE", "ENFILE", "ENOBUFS", "ETIMEDOUT"]);
const transientGitLock =
  /(?:another git process seems to be running|(?:unable to create|could not lock)[^\n]*\.lock['"]?: file exists)/iu;

// Retry only proven ref races or recognized Git lock/resource/I/O pressure; invariant failures latch.
export function isRetryableWalMaterializationError(error: unknown): boolean {
  if (error instanceof WalMaterializerRefChangedError) return true;
  const systemCode = materializationErrorCode(error);
  if (systemCode !== null && transientSystemErrorCodes.has(systemCode)) return true;
  if (error instanceof VcsCommandError) {
    if (typeof error.exitCode === "string" && transientSystemErrorCodes.has(error.exitCode)) return true;
    return transientGitLock.test(error.stderrSummary ?? "");
  }
  return (
    error instanceof Error &&
    (transientGitLock.test(error.message) ||
      new RegExp(`\\b(?:${[...transientSystemErrorCodes].join("|")})\\b`, "u").test(error.message))
  );
}

function materializationErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}
