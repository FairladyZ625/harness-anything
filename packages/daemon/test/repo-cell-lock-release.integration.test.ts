// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const auth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: {
    ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary",
  },
} as unknown as DaemonAuthenticationContext;

test("a post-initialize open failure releases the workspace lock for the next attach", async () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-open-lock-release-"))),
    lockPath = `${rootDir}.harness-anything-writer.lock`;
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    const bootstrap = resolveRepoBootstrap(
      { rootDir, repoId: "lock-release", personId: "owner", displayName: "Owner" },
      auth,
    );
    await assert.rejects(
      openRepoCell({
        rootDir: canonicalRoot(rootDir),
        repoId: workspaceId("lock-release"),
        ownerId: "lock-release-failure",
        bootstrap,
        killpoint: (point) => {
          if (point === "before_event_write") throw new Error("post-initialize failure");
        },
      }),
      /post-initialize failure/u,
    );
    assert.equal(existsSync(lockPath), false);
    const reopened = await openRepoCell({
      rootDir: canonicalRoot(rootDir),
      repoId: workspaceId("lock-release"),
      ownerId: "lock-release-successor",
    });
    await reopened.close();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("repeated bare init reuses the registered repo id while its RepoCell is open", async () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-repeated-init-"))),
    rootDir = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    request = { rootDir, repoId: "registered-id", personId: "owner", displayName: "Owner" };
  let host = await openDaemonHost({ daemonId: "repeated-init-first", userRoot });
  try {
    execFileSync("git", ["init", "-q", rootDir]);
    const initialized = await host.bootstrap(request, auth);
    assert.equal(initialized.outcome, "applied");
    await host.close();
    host = await openDaemonHost({ daemonId: "repeated-init-second", userRoot });
    await host.attachmentsSettled();

    const repeated = await host.bootstrap({ rootDir, personId: "owner", displayName: "Owner" }, auth);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.repoId, "registered-id");
    assert.equal(repeated.summary, "This repository is already registered as registered-id and is initialized.");

    await assert.rejects(
      host.bootstrap({ ...request, repoId: "conflicting-id" }, auth),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "repository_already_registered" &&
        error.message ===
          "This repository is already registered as registered-id; " +
            "rerun without --repo-id or with --repo-id registered-id.",
    );
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
