// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDaemonServiceHost } from "@harness-anything/daemon";
import { cliDaemonServiceHostServices } from "../src/composition/daemon-service-host-services.ts";

const batch4Golden = JSON.parse(readFileSync(new URL("../../daemon/test/fixtures/batch4-equivalence-golden.json", import.meta.url), "utf8")) as Record<string, string>;

test("daemon control reports a stuck drain and does not run transport shutdown", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-daemon-drain-timeout-"));
  const serviceRoot = path.join(root, "service");
  const repoRoot = path.join(root, "repo");
  mkdirSync(serviceRoot, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
  const events: string[] = [];
  const repo = { repoId: "alpha", canonicalRoot: repoRoot };
  const repoRuntime = runtimeStatus(repo);
  const runtime = {
    start: async () => managerStatus(repo),
    stop: async () => {
      events.push("runtime:stop-stuck");
      await new Promise<void>(() => undefined);
    },
    status: () => managerStatus(repo),
    attachRepo: async () => { throw new Error("fixture attach not used"); },
    detachRepo: async () => { throw new Error("fixture detach not used"); },
    retryUnavailableRepos: async () => [],
    getRepoRuntime: () => repoRuntime,
    enqueueInteractiveWrite: async () => { throw new Error("fixture enqueue not used"); },
    enqueueBackgroundBatch: async () => { throw new Error("fixture background not used"); },
    enqueueMaterializerBatch: async () => { throw new Error("fixture materializer not used"); }
  };

  try {
    const entrypoint = path.resolve("packages/cli/src/index.ts");
    const host = await createDaemonServiceHost(
      runtime as Parameters<typeof createDaemonServiceHost>[0],
      [repo],
      repo.repoId,
      undefined,
      0,
      path.join(serviceRoot, "daemon.sock"),
      { active: 1, total: 1 },
      serviceRoot,
      {
        entrypoint,
        loadedIdentity: `sha256:${"0".repeat(64)}`,
        startedAt: "2026-07-20T00:00:00.000Z",
        launchConfiguration: {
          execPath: process.execPath,
          execArgv: [],
          entrypoint,
          args: ["--root", repoRoot, "daemon", "serve"]
        },
        preflightReplacement: async () => undefined
      },
      cliDaemonServiceHostServices
    );
    host.onStop(async () => {
      events.push("transport:stopped");
    });
    const control = await host.requestControl("restart", {
      reason: "fault-injected stuck runtime",
      drainTimeoutMs: 100
    });
    assert.equal(control.ok, true);
    if (!control.ok) assert.fail(control.error.hint);
    control.afterResponse();

    const stopRequest = await host.waitForStopRequest();
    assert.equal(stopRequest.reason, "control");
    let stopSettled = false;
    void host.stop().then(() => { stopSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const activeControl = host.status().service.activeControl;
    assert.equal(activeControl?.phase, "failed");
    assert.equal(activeControl?.failure?.code, "daemon_queue_drain_timeout");
    assert.match(activeControl?.failure?.hint ?? "", /in-flight operations failed to settle in time/u);
    assert.equal(JSON.stringify({ phase: activeControl?.phase, failure: activeControl?.failure }), batch4Golden.ownerExitReceipt);
    assert.deepEqual(events, ["runtime:stop-stuck"]);
    assert.equal(stopSettled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function managerStatus(repo: { readonly repoId: string; readonly canonicalRoot: string }) {
  return {
    started: true,
    repoCount: 1,
    attachedCount: 1,
    unavailableCount: 0,
    repos: [runtimeStatus(repo).status()]
  };
}

function runtimeStatus(repo: { readonly repoId: string; readonly canonicalRoot: string }) {
  return {
    start: async () => ({}),
    stop: async () => undefined,
    status: () => ({
      started: true,
      repoId: repo.repoId,
      rootDir: repo.canonicalRoot,
      canonicalRoot: repo.canonicalRoot,
      state: "attached" as const,
      queue: {
        depth: 0,
        active: false,
        interactiveDepth: 0,
        backgroundDepth: 0,
        activePriority: null,
        maxInteractiveOpsPerCommit: 32
      },
      projectionGeneration: {
        state: "unknown" as const,
        validationRuns: 0,
        invalidations: 0,
        hintedInvalidations: 0,
        fenceRuns: 0,
        reconciliationRuns: 0,
        activeCanonicalWrites: 0,
        pendingTouchedPaths: 0
      }
    }),
    enqueueInteractiveWrite: async () => { throw new Error("fixture enqueue not used"); },
    enqueueBackgroundBatch: async () => { throw new Error("fixture background not used"); },
    enqueueMaterializerBatch: async () => { throw new Error("fixture materializer not used"); },
    queryExecutionEvidencePage: async () => ({ groups: [], nextCursor: null })
  };
}
