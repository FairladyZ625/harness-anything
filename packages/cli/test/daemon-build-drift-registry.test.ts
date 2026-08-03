// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import {
  calculateDaemonArtifactIdentity,
  createDaemonServiceHost,
  daemonBuildProvenanceFilename
} from "@harness-anything/daemon";
import { cliDaemonServiceHostServices } from "../src/composition/daemon-service-host-services.ts";

test("artifact drift blocks registry attach recovery and logs the diagnosis only once", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-build-drift-registry-"));
  const serviceRoot = path.join(root, "service");
  const alphaRoot = path.join(root, "alpha");
  const betaRoot = path.join(root, "beta");
  const artifactRoot = path.join(root, "artifact", "dist");
  const entrypoint = path.join(artifactRoot, "index.js");
  for (const directory of [serviceRoot, alphaRoot, betaRoot, artifactRoot]) {
    mkdirSync(directory, { recursive: true });
  }
  initializeHarness(betaRoot);
  writeFileSync(entrypoint, "export const version = 'loaded';\n", "utf8");
  const loadedIdentity = calculateDaemonArtifactIdentity(entrypoint).identity;
  writeProvenance(artifactRoot, loadedIdentity);
  let assertBuildCurrent = () => undefined;
  let recoveryRuns = 0;
  const repo = { repoId: "alpha", canonicalRoot: alphaRoot };
  const repoRuntime = runtimeFixture(repo);
  const runtime = {
    start: async () => managerStatus(repo),
    stop: async () => undefined,
    status: () => managerStatus(repo),
    installWriteGuard: (guard: () => void) => {
      assertBuildCurrent = guard;
    },
    attachRepo: async () => {
      assertBuildCurrent();
      recoveryRuns += 1;
      throw new Error("recovery must not run during artifact drift");
    },
    detachRepo: async () => { throw new Error("detach not used"); },
    retryUnavailableRepos: async () => [],
    getRepoRuntime: (repoId: string) => repoId === repo.repoId ? repoRuntime : undefined,
    enqueueInteractiveWrite: async () => { throw new Error("manager write not used"); },
    enqueueBackgroundBatch: async () => { throw new Error("manager background not used"); },
    enqueueMaterializerBatch: async () => { throw new Error("manager materializer not used"); }
  };
  const logMessages: string[] = [];
  const daemonLogService = {
    append: async (input: { readonly message: string }) => {
      logMessages.push(input.message);
      return {} as never;
    },
    list: async () => ({}) as never
  };

  try {
    const host = await createDaemonServiceHost(
      runtime as Parameters<typeof createDaemonServiceHost>[0],
      [repo],
      repo.repoId,
      undefined,
      0,
      path.join(serviceRoot, "daemon.sock"),
      { active: 0, total: 0 },
      serviceRoot,
      {
        entrypoint,
        loadedIdentity,
        startedAt: "2026-07-31T00:00:00.000Z",
        launchConfiguration: {
          execPath: process.execPath,
          execArgv: [],
          entrypoint,
          args: ["--root", alphaRoot, "daemon", "serve"]
        },
        preflightReplacement: async () => undefined
      },
      cliDaemonServiceHostServices,
      undefined,
      daemonLogService as Parameters<typeof createDaemonServiceHost>[11]
    );
    registerDaemonRepo({
      userRoot: serviceRoot,
      repoId: "beta",
      canonicalRoot: betaRoot,
      createConvenienceLinks: false
    });
    writeFileSync(entrypoint, "export const version = 'rebuilt';\n", "utf8");
    writeProvenance(artifactRoot, calculateDaemonArtifactIdentity(entrypoint).identity);

    await host.reconcileNow(serviceRoot);
    await host.reconcileNow(serviceRoot);

    assert.equal(recoveryRuns, 0);
    assert.match(host.status().service.lastReconcileError?.message ?? "", /DAEMON_BUILD_STALE/u);
    assert.equal(logMessages.length, 1);
    assert.match(logMessages[0] ?? "", /ha daemon restart/u);
    await host.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function initializeHarness(rootDir: string): void {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n",
    "utf8"
  );
}

function writeProvenance(artifactRoot: string, contentFingerprint: string): void {
  writeFileSync(
    path.join(artifactRoot, daemonBuildProvenanceFilename),
    `${JSON.stringify({ schema: "daemon-build-provenance/v1", contentFingerprint })}\n`,
    "utf8"
  );
}

function managerStatus(repo: { readonly repoId: string; readonly canonicalRoot: string }) {
  return {
    started: true,
    repoCount: 1,
    attachedCount: 1,
    unavailableCount: 0,
    repos: [runtimeFixture(repo).status()]
  };
}

function runtimeFixture(repo: { readonly repoId: string; readonly canonicalRoot: string }) {
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
    enqueueInteractiveWrite: async () => { throw new Error("repo write not used"); },
    enqueueBackgroundBatch: async () => { throw new Error("repo background not used"); },
    enqueueMaterializerBatch: async () => { throw new Error("repo materializer not used"); },
    queryExecutionEvidencePage: async () => ({ groups: [], nextCursor: null }),
    createAttributedCoordinator: () => { throw new Error("coordinator not used"); },
    assertWriteFenceHeld: async () => undefined,
    admissionBudget: {
      limits: {
        maxOperations: 1,
        maxBytes: 1,
        reservedOperationsPerPlane: 0,
        reservedBytesPerPlane: 0
      }
    },
    subscribeProjectionChanges: () => () => undefined
  };
}
