// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { registerDaemonRepo } from "../../kernel/src/index.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { auth, rosterRepo } from "./daemon-host-recovery.fixture.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

test("daemon status omits projection cuts while a repository close is still settling", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-host-closing-status-")),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  rosterRepo(rootDir, "host-closing-status");
  registerDaemonRepo({
    canonicalRoot: rootDir,
    repoId: "host-closing-status",
    userRoot,
    createConvenienceLinks: false,
  });
  let closeSettled!: () => void, releaseClose!: () => void;
  const closeReached = new Promise<void>((resolve) => {
      closeSettled = resolve;
    }),
    closeRelease = new Promise<void>((resolve) => {
      releaseClose = resolve;
    }),
    host = await openDaemonHost({
      daemonId: "host-closing-status",
      userRoot,
      openCell: async (input) => {
        const cell = await openRepoCell(input);
        return {
          ...cell,
          close: async () => {
            await cell.close();
            closeSettled();
            await closeRelease;
          },
        };
      },
    });
  await host.attachmentsSettled();
  try {
    const attached = host.status().repos.find((repo) => repo.repoId === "host-closing-status")!;
    assert.equal(attached.state, "attached");
    assert.equal(typeof attached.projectionWatermark, "number");
    assert.equal(typeof attached.ledgerRevision, "number");

    const unregistering = host.admin({ kind: "unbind", repoId: "host-closing-status" }, auth);
    await closeReached;
    const closing = host.status().repos.find((repo) => repo.repoId === "host-closing-status")!;
    assert.equal(closing.state, "closed");
    assert.equal(closing.projectionWatermark, undefined);
    assert.equal(closing.ledgerRevision, undefined);
    releaseClose();
    await unregistering;
  } finally {
    releaseClose();
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
