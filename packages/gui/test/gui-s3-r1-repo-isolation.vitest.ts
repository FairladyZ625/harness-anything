// harness-test-tier: fast
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});
import { catalogQueryKeys } from "../src/renderer/catalog-data.ts";
import { controlSucceeded, selectActiveRepoId, settleDaemonControl, systemQueryKeys } from "../src/renderer/system-data.ts";
import type { DaemonControlReceipt, SystemRepoRow } from "../src/renderer/api-client.ts";
import { invalidateLedgerDependents, LEDGER_REFRESH_INTERVAL_MS, taskDocumentQuery, taskListQuery, taskQueryKeys } from "../src/renderer/task-data.ts";
import { triadicQueryKeys } from "../src/renderer/triadic-data.ts";
import { favoritesStorageKey } from "../src/renderer/model/favorites.ts";

describe("GUI S3 R1 repository isolation", () => {
  it("namespaces every repository projection by repo id", () => {
    expect(taskQueryKeys.list("repo-a")).toEqual(["tasks", "repo-a", "list"]);
    expect(taskQueryKeys.document("repo-b", "task-1", "INDEX.md")).toEqual([
      "tasks", "repo-b", "task-1", "document", "INDEX.md",
    ]);
    expect(triadicQueryKeys.graph("repo-a")).toEqual(["triadic", "repo-a", "relation-graph"]);
    expect(triadicQueryKeys.decisions("repo-b")).toEqual(["triadic", "repo-b", "decisions"]);
    expect(catalogQueryKeys.snapshot("repo-a")).toEqual(["catalog", "repo-a", "snapshot"]);
    expect(catalogQueryKeys.preset("repo-b", "preset-a", "zh-TW")).toEqual([
      "catalog", "repo-b", "preset", "preset-a", "zh-TW",
    ]);
    expect(favoritesStorageKey("repo-a")).not.toBe(favoritesStorageKey("repo-b"));
  });

  it("keeps daemon-global status outside repository namespaces", () => {
    expect(systemQueryKeys.status()).toEqual(["system", "global", "status"]);
  });

  it("observes a newer ledger revision while the task view stays mounted", async () => {
    vi.useFakeTimers();
    let revision = 41;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      ...taskListQuery("repo-a"),
      queryFn: async () => ({ ok: true as const, status: "ready" as const, rows: [], watermark: revision, sourceRevision: revision, warnings: [] }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(41);
      revision = 42;
      await vi.advanceTimersByTimeAsync(LEDGER_REFRESH_INTERVAL_MS + 1);
      expect(observer.getCurrentResult().data?.sourceRevision).toBe(42);
    } finally {
      unsubscribe();
      client.clear();
      vi.useRealTimers();
    }
  });

  it("refreshes an open task document when the ledger cut advances", async () => {
    let body = "before";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observer = new QueryObserver(client, {
      ...taskDocumentQuery("repo-a", "task-1", "progress.md"),
      queryFn: async () => ({ ok: true as const, status: "ready" as const, taskId: "task-1", path: "progress.md", body, blobSha256: "sha", watermark: body === "before" ? 41 : 42, sourceRevision: body === "before" ? 41 : 42 }),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await observer.refetch();
      expect(observer.getCurrentResult().data?.body).toBe("before");
      body = "after";
      await invalidateLedgerDependents(client, "repo-a");
      expect(observer.getCurrentResult().data?.body).toBe("after");
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("selects only enabled repos and retains an enabled unavailable repo", () => {
    const repos = [repo("disabled", "disabled", "not_loaded"), repo("unavailable", "enabled", "unavailable"), repo("attached", "enabled", "attached")];
    expect(selectActiveRepoId(repos, null)).toBe("attached");
    expect(selectActiveRepoId(repos, "unavailable")).toBe("unavailable");
    expect(selectActiveRepoId(repos, "disabled")).toBe("attached");
  });

  it("polls a control receipt without replaying the request and requires a new pid for restart", async () => {
    const pending = receipt("queued"), settled = receipt("settled", 10, 11), read = vi.fn(async () => settled);
    await expect(settleDaemonControl(pending, read, async () => undefined)).resolves.toBe(settled);
    expect(read).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledWith(pending.operationId);
    expect(controlSucceeded(settled)).toBe(true); expect(controlSucceeded(receipt("settled", 10, 10))).toBe(false);
  });
});

function repo(repoId: string, registrationState: SystemRepoRow["registrationState"], cellState: SystemRepoRow["cellState"]): SystemRepoRow { return { repoId, displayName: repoId, canonicalRoot: `/tmp/${repoId}`, authoredBranch: "main", registrationState, cellState, generation: null, queueDepth: null, lockState: registrationState === "disabled" ? "not_applicable" : "unknown", recoveryMs: null, lastError: null, unavailableReason: cellState === "unavailable" ? "fixture unavailable" : null }; }
function receipt(phase: DaemonControlReceipt["phase"], beforePid: number | null = null, afterPid: number | null = null): DaemonControlReceipt { const point = (pid: number) => ({ daemonId: "daemon", pid, startedAt: `generation-${pid}` }); return { schema: "daemon-control-receipt/v1", ok: phase !== "failed", outcome: phase === "failed" ? "rejected" : "pending", kind: "restart", operationId: "operation-r1", phase, requestedAt: "2026-08-14T00:00:00.000Z", completedAt: phase === "settled" ? "2026-08-14T00:00:01.000Z" : null, before: beforePid === null ? null : point(beforePid), after: afterPid === null ? null : point(afterPid), error: null, nextAction: phase === "settled" ? null : "poll" }; }
