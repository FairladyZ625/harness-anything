// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
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
