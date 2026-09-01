import { randomUUID } from "node:crypto";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { serializePersistedCanonicalEvent } from "../domain/doc-sync.contract.ts";
import { consumeKnownError } from "../error-consumption.ts";
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
import { flushWalToGit, WalMaterializerDivergedError } from "./wal-git-materializer.ts";
import {
  WAL_MATERIALIZATION_REQUEST_SCHEMA,
  WAL_MATERIALIZATION_RESPONSE_SCHEMA,
  type WalBaselineDeltaV1,
  type WalMaterializationFailureV1,
  type WalMaterializationFenceV1,
  type WalMaterializationRequestV1,
  type WalMaterializationResponseV1,
  type WalMaterializationSuccessV1,
  type WalMaterializationWorkerConfig,
} from "./wal-materialization-protocol.ts";

export const WAL_MATERIALIZATION_WORKER_KIND = "harness-wal-materialization-worker/v1";

export interface WalMaterializationWorker {
  readonly materialize: (
    request: Omit<WalMaterializationRequestV1, "requestId">,
  ) => Promise<WalMaterializationResponseV1>;
  readonly close: () => Promise<void>;
}

export function openWalMaterializationWorker(
  config: WalMaterializationWorkerConfig,
  workerUrl = new URL(import.meta.url),
): WalMaterializationWorker {
  let worker: Worker | null = null,
    starting: Promise<Worker> | null = null,
    closed = false;
  const pending = new Map<
    string,
    {
      readonly resolve: (response: WalMaterializationResponseV1) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  const failPending = (error: Error): void => {
    for (const operation of pending.values()) operation.reject(error);
    pending.clear();
  };
  const start = (): Promise<Worker> => {
    if (closed) return Promise.reject(new Error("WAL materialization worker is closed"));
    if (worker) return Promise.resolve(worker);
    if (starting) return starting;
    starting = new Promise<Worker>((resolve, reject) => {
      const candidate = new Worker(workerUrl, {
        execArgv: process.execArgv.filter(
          (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
        ),
        workerData: {
          kind: WAL_MATERIALIZATION_WORKER_KIND,
          entry: workerUrl.href === new URL(import.meta.url).href ? "kernel" : "custom",
          config,
        },
      });
      let ready = false;
      const failStart = (error: Error): void => {
        if (!ready) reject(error);
        failPending(error);
        if (worker === candidate) worker = null;
        starting = null;
      };
      candidate.on("message", (message: unknown) => {
        if (isReadyMessage(message)) {
          ready = true;
          worker = candidate;
          starting = null;
          candidate.unref();
          resolve(candidate);
          return;
        }
        if (!isWalMaterializationResponse(message)) {
          failStart(new Error("WAL materialization worker returned an unknown message"));
          void candidate.terminate();
          return;
        }
        const operation = pending.get(message.requestId);
        if (!operation) {
          failStart(new Error(`WAL materialization worker returned unknown request ${message.requestId}`));
          void candidate.terminate();
          return;
        }
        pending.delete(message.requestId);
        operation.resolve(message);
        if (pending.size === 0) candidate.unref();
      });
      candidate.once("error", (error) => failStart(error));
      candidate.once("exit", (code) => {
        if (worker === candidate) worker = null;
        starting = null;
        if (!closed || code !== 0) failStart(new Error(`WAL materialization worker exited with code ${code}`));
      });
    });
    return starting;
  };
  return {
    materialize: async (input) => {
      const active = await start(),
        request: WalMaterializationRequestV1 = { ...input, requestId: randomUUID() };
      active.ref();
      return new Promise<WalMaterializationResponseV1>((resolve, reject) => {
        pending.set(request.requestId, { resolve, reject });
        try {
          active.postMessage(request);
        } catch (error) {
          pending.delete(request.requestId);
          if (pending.size === 0) active.unref();
          consumeKnownError(error);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    close: async () => {
      closed = true;
      const active = worker;
      worker = null;
      starting = null;
      failPending(new Error("WAL materialization worker closed"));
      if (active) await active.terminate();
    },
  };
}

if (!isMainThread && workerData?.kind === WAL_MATERIALIZATION_WORKER_KIND && workerData?.entry === "kernel") {
  const config = workerData.config as WalMaterializationWorkerConfig;
  parentPort!.on("message", (message: unknown) => {
    if (!isWalMaterializationRequest(message)) {
      parentPort!.postMessage(failureResponse("unknown", null, new Error("invalid WAL materialization request")));
      return;
    }
    parentPort!.postMessage(runWalMaterializationRequest(config, message));
  });
  parentPort!.postMessage({ schema: "harness-wal-materialization-worker-ready/v1" });
}

export function runWalMaterializationRequest(
  config: WalMaterializationWorkerConfig,
  request: WalMaterializationRequestV1,
  options: {
    readonly withFinalizeFence?: <T>(fence: WalMaterializationFenceV1, operation: () => T) => T;
  } = {},
): WalMaterializationResponseV1 {
  try {
    if (request.testFault?.point === "worker_exit") process.exit(86);
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
    return failureResponse(request.requestId, request.cut, error);
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
): WalMaterializationFailureV1 {
  const failure = error instanceof Error ? error : new Error(String(error));
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
      code: failure instanceof TaskEventStoreError ? failure.code : null,
      diverged: failure instanceof WalMaterializerDivergedError,
      canonicalSha: failure instanceof WalMaterializerDivergedError ? failure.canonicalSha : null,
    },
  };
}

function isReadyMessage(value: unknown): value is { readonly schema: "harness-wal-materialization-worker-ready/v1" } {
  return isWorkerRecord(value) && value.schema === "harness-wal-materialization-worker-ready/v1";
}

function isWalMaterializationRequest(value: unknown): value is WalMaterializationRequestV1 {
  return (
    isWorkerRecord(value) &&
    value.schema === WAL_MATERIALIZATION_REQUEST_SCHEMA &&
    typeof value.requestId === "string" &&
    isWorkerRecord(value.cut) &&
    (value.fence === null || (isWorkerRecord(value.fence) && value.fence.schema === "harness-writer-epoch-fence/v1"))
  );
}

function isWalMaterializationResponse(value: unknown): value is WalMaterializationResponseV1 {
  return (
    isWorkerRecord(value) &&
    value.schema === WAL_MATERIALIZATION_RESPONSE_SCHEMA &&
    typeof value.requestId === "string" &&
    (value.outcome === "materialized" || value.outcome === "failed")
  );
}

function isWorkerRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
