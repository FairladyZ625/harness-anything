import type { AuthorityCommittedReceipt } from "@harness-anything/application";
import {
  defaultProductionRecoveryAdmissionTimeoutMs,
  type DurableRepoWriteOutcomeStoreV1,
  type HarnessDaemonRuntime,
  type ReceiptSettlementStore,
  type RepoWriteAuthorityRecoveryGate,
  type RepoWriteChildIpcTransport
} from "@harness-anything/daemon";
import {
  reconcileTerminalSettlements,
  recoverPendingSettlementMaterialization,
  type ReceiptSettlementRecoveryProgress
} from "./receipt-settlement-runtime.ts";

const defaultReceiptRecoveryTimeoutMs = 5_000;

export interface RepoWriteChildPostReadyRecovery {
  readonly recoverSettlements: (budgetMs?: number) => Promise<void>;
  readonly runInitialSweep: () => Promise<void>;
}

export function createRepoWriteChildPostReadyRecovery(input: {
  readonly repoId: string;
  readonly generation: number;
  readonly transport: RepoWriteChildIpcTransport;
  readonly settlements: ReceiptSettlementStore;
  readonly outcomes: DurableRepoWriteOutcomeStoreV1;
  readonly runtime: HarnessDaemonRuntime;
  readonly authoredRoot: string;
  readonly recoveryGate: Pick<RepoWriteAuthorityRecoveryGate, "recoverHistoricalProceeding">;
  readonly recoverCommittedReceipt: (opId: string) => Promise<AuthorityCommittedReceipt>;
  readonly recoverCanonicalPublication: (recovery: {
    readonly outerOpId: string;
    readonly canonicalCommitSha: string;
  }) => Promise<"live-owner" | "recovered" | "terminal" | "blocked">;
  readonly totalBudgetMs?: number;
  readonly perReceiptTimeoutMs?: number;
}): RepoWriteChildPostReadyRecovery {
  const totalBudgetMs = input.totalBudgetMs ?? defaultProductionRecoveryAdmissionTimeoutMs;
  const perReceiptTimeoutMs = input.perReceiptTimeoutMs ?? defaultReceiptRecoveryTimeoutMs;
  const reporter = createPostReadyRecoveryReporter(input.repoId, input.generation);
  const diagnosticDeliveries = new Set<Promise<void>>();
  let activeSettlementSweep: Promise<void> | undefined;

  const sendDeferred = (outerOpId: string, code: string, diagnostic: string): void => {
    let delivery: Promise<void>;
    try {
      delivery = Promise.resolve(input.transport.send({
        protocol: "harness-repo-write-ipc/v1",
        repoId: input.repoId,
        generation: input.generation,
        kind: "recovery-deferred",
        outerOpId,
        code,
        diagnostic
      })).catch((error) => {
        reporter.mark("diagnostic-delivery", outerOpId, "deferred", {
          lastPhase: boundedRecoveryError(error)
        });
      });
    } catch (error) {
      reporter.mark("diagnostic-delivery", outerOpId, "deferred", {
        lastPhase: boundedRecoveryError(error)
      });
      return;
    }
    diagnosticDeliveries.add(delivery);
    void delivery.finally(() => diagnosticDeliveries.delete(delivery));
  };

  const reportReceiptProgress = (progress: ReceiptSettlementRecoveryProgress): void => {
    reporter.mark("receipt-settlement", progress.receiptId, progress.status, {
      lastPhase: progress.phase
    });
    if (progress.status !== "timed-out") return;
    sendDeferred(
      progress.receiptId,
      "RECEIPT_SETTLEMENT_RECOVERY_TIMEOUT",
      `Receipt settlement recovery exceeded ${perReceiptTimeoutMs}ms; `
        + `receiptId=${progress.receiptId}; lastPhase=${progress.phase}. `
        + "The durable receipt remains pending and replayable."
    );
  };

  const recoverSettlements = (budgetMs = totalBudgetMs): Promise<void> => {
    if (activeSettlementSweep) return activeSettlementSweep;
    const sweep = (async () => {
      await recoverPendingSettlementMaterialization({
        settlements: input.settlements,
        outcomes: input.outcomes,
        runtime: input.runtime,
        authoredRoot: input.authoredRoot,
        deadlineAt: Date.now() + Math.max(0, budgetMs),
        perReceiptTimeoutMs,
        onReceiptProgress: reportReceiptProgress,
        recoverCommittedReceipt: input.recoverCommittedReceipt,
        recoverCanonicalPublication: input.recoverCanonicalPublication
      });
      reconcileTerminalSettlements(input.settlements, input.outcomes);
    })();
    activeSettlementSweep = sweep.finally(() => {
      activeSettlementSweep = undefined;
    });
    return activeSettlementSweep;
  };

  const runInitialSweep = async (): Promise<void> => {
    const startedAt = Date.now();
    const deadlineAt = startedAt + totalBudgetMs;
    reporter.mark("initial-sweep", input.repoId, "started", { budgetMs: totalBudgetMs });
    await recoverSettlements(Math.max(0, deadlineAt - Date.now()));

    reporter.mark("historical-recovery-scan", input.repoId, "started");
    const proceedings = input.outcomes.listHistoricalProceedings();
    let attempted = 0;
    let leftByBudget = 0;
    for (const proceeding of proceedings) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        leftByBudget += 1;
        continue;
      }
      const timeoutMs = Math.min(perReceiptTimeoutMs, remainingMs);
      reporter.mark("historical-recovery", proceeding.outerOpId, "started");
      try {
        const recovery = await waitForRecoveryItem(
          input.recoveryGate.recoverHistoricalProceeding(proceeding),
          timeoutMs
        );
        if (recovery.disposition === "permanently-rejected") {
          await input.transport.send({
            protocol: "harness-repo-write-ipc/v1",
            repoId: input.repoId,
            generation: input.generation,
            kind: "recovery-rejected",
            outerOpId: proceeding.outerOpId,
            code: recovery.code,
            diagnostic:
              "Historical recovery evidence permanently conflicts with the canonical publication. "
              + "The outer operation remains outcome-unknown; no authority terminal proof was created.",
            next:
              "Run `ha daemon logs --errors --json`, then escalate this outer op for "
              + "operator-reviewed canonical Git and authority-state repair. "
              + "Do not delete WAL, outcome, or recovery files."
          });
        }
        reporter.mark("historical-recovery", proceeding.outerOpId, "completed");
      } catch (error) {
        const timedOut = error instanceof PostReadyRecoveryTimeoutError;
        const code = timedOut
          ? "AUTHORITY_HISTORICAL_RECOVERY_TIMEOUT"
          : recoveryErrorCode(error);
        const diagnostic = timedOut
          ? `Historical recovery exceeded ${timeoutMs}ms; receiptId=${proceeding.outerOpId}; `
            + "lastPhase=historical-recovery. The durable proceeding remains replayable."
          : boundedRecoveryError(error);
        reporter.mark("historical-recovery", proceeding.outerOpId, "deferred", {
          lastPhase: "historical-recovery"
        });
        sendDeferred(proceeding.outerOpId, code, diagnostic);
      }
      attempted += 1;
    }
    reporter.mark("initial-sweep", input.repoId, "completed", {
      attempted,
      leftByBudget,
      elapsedMs: Date.now() - startedAt
    });
    if (diagnosticDeliveries.size > 0) {
      await Promise.allSettled([...diagnosticDeliveries]);
    }
  };

  return { recoverSettlements, runInitialSweep };
}

interface PostReadyRecoveryReporter {
  readonly mark: (
    phase: string,
    workUnit: string,
    status: string,
    detail?: Readonly<Record<string, string | number>>
  ) => void;
}

function createPostReadyRecoveryReporter(
  repoId: string,
  generation: number
): PostReadyRecoveryReporter {
  let startedAt: number | undefined;
  return {
    mark: (phase, workUnit, status, detail) => {
      try {
        const now = performance.now();
        startedAt ??= now;
        process.stderr.write(`${JSON.stringify({
          schema: "repo-write-child-post-ready-recovery/v1",
          pid: process.pid,
          repoId,
          generation,
          phase,
          workUnit,
          status,
          sinceReadyMs: Math.round(now - startedAt),
          ...(detail ?? {})
        })}\n`);
      } catch {
        // Diagnostics must never alter durable recovery semantics.
      }
    }
  };
}

class PostReadyRecoveryTimeoutError extends Error {
  constructor() {
    super("POST_READY_RECOVERY_TIMEOUT");
    this.name = "PostReadyRecoveryTimeoutError";
  }
}

async function waitForRecoveryItem<T>(recovery: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      recovery,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PostReadyRecoveryTimeoutError()), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function recoveryErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recoveryErrorCode(error: unknown): string {
  if (error instanceof Error && "code" in error
    && typeof error.code === "string" && error.code.trim()) {
    return error.code;
  }
  const match = /^([A-Z][A-Z0-9_]+)(?::|$)/u.exec(recoveryErrorMessage(error));
  return match?.[1] ?? "HISTORICAL_RECOVERY_DEFERRED";
}

export function boundedRecoveryError(error: unknown): string {
  const value = `${error instanceof Error ? `${error.name}: ` : ""}${recoveryErrorMessage(error)}`
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  const bytes = Buffer.from(value || "Historical recovery deferred.", "utf8");
  if (bytes.length <= 2_048) return bytes.toString("utf8");
  return bytes.subarray(0, 2_048).toString("utf8").replace(/\uFFFD$/u, "");
}
