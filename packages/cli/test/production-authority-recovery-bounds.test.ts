// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { makeLocalAuthorityAttributionEventV2Log } from "../../kernel/src/index.ts";
import {
  createGitCanonicalPublicationInspector,
  recoverPendingProductionEvents
} from "@harness-anything/daemon";

test("one repo permits only one first-parent recovery scan in flight", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authority-recovery-single-flight-"));
  const watermarkPath = path.join(root, "recovery-watermark.json");
  let scanCalls = 0;
  let activeScans = 0;
  let maxActiveScans = 0;
  let releaseScan!: () => void;
  const scanGate = new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  try {
    const input = {
      workspaceId: "workspace-production",
      operationRegistry: {
        get: async () => undefined,
        list: async () => [],
        put: async () => undefined
      },
      replicaChangeLog: {} as import("../../application/src/index.ts").ReplicaChangeLog,
      eventLog: {} as ReturnType<typeof makeLocalAuthorityAttributionEventV2Log>,
      publicationInspector: {
        scanFirstParentOperationAnchors: async () => {
          scanCalls += 1;
          activeScans += 1;
          maxActiveScans = Math.max(maxActiveScans, activeScans);
          await scanGate;
          activeScans -= 1;
          return { headCommit: "b".repeat(40), scannedCommitCount: 400, anchors: [] };
        }
      } as ReturnType<typeof createGitCanonicalPublicationInspector>,
      recover: async () => { throw new Error("no pending operation should recover"); },
      watermarkPath
    };

    const first = recoverPendingProductionEvents(input);
    const second = recoverPendingProductionEvents(input);
    await delay(10);
    releaseScan();
    await Promise.all([first, second]);
    assert.equal(scanCalls, 1);
    assert.equal(maxActiveScans, 1);
  } finally {
    releaseScan();
    rmSync(root, { recursive: true, force: true });
  }
});

test("first-parent recovery scan honors its absolute deadline", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-authority-recovery-deadline-"));
  const git = (...args: ReadonlyArray<string>) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness@example.test"
    }
  }).trim();
  try {
    git("init", "-q");
    writeFileSync(path.join(root, "seed.txt"), "seed\n");
    git("add", ".");
    git("commit", "-q", "-m", "seed");
    const inspector = createGitCanonicalPublicationInspector(root);

    await assert.rejects(
      inspector.scanFirstParentOperationAnchors({
        interestedOpIds: new Set(),
        deadlineAt: Date.now() - 1
      }),
      /AUTHORITY_RECOVERY_SCAN_DEADLINE_EXCEEDED/u
    );
    await inspector.shutdown();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
