// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertFleetEdgeRepositoryGit,
  readFleetCenterGitMetadata,
  FleetEdgeGitPreflightError,
} from "../src/fleet-edge-git-preflight.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function commit(rootDir: string, message: string): void {
  git(
    rootDir,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    message,
  );
}

test("edge Git preflight verifies center history instead of requiring matching remote URLs", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-git-preflight-")),
    center = path.join(root, "center"),
    edge = path.join(root, "edge"),
    origin = path.join(root, "origin.git"),
    wrong = path.join(root, "wrong.git"),
    wrongSource = path.join(root, "wrong-source"),
    alternateOrigin = path.join(root, "origin-alias.git");
  try {
    git(root, "init", "--bare", "-q", origin);
    git(root, "init", "-b", "main", "-q", wrongSource);
    commit(wrongSource, "unrelated repository");
    git(root, "clone", "--bare", "-q", wrongSource, wrong);
    git(wrong, "symbolic-ref", "HEAD", "refs/heads/main");
    symlinkSync(origin, alternateOrigin, "dir");
    git(root, "init", "-b", "main", "-q", center);
    git(center, "remote", "add", "origin", origin);
    commit(center, "initial");
    git(center, "push", "-q", "-u", "origin", "main");
    git(center, "fetch", "-q", "origin");
    git(center, "remote", "set-head", "origin", "main");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
    git(root, "clone", "-q", origin, edge);
    const centerGit = await readFleetCenterGitMetadata(center);
    assert.equal(centerGit.defaultBranch, "main");
    assert.ok(centerGit.defaultBranchCommit);
    assert.deepEqual(centerGit.originPushUrls, [centerGit.originUrl]);

    git(edge, "remote", "set-url", "--push", "origin", wrong);
    await assert.rejects(
      assertFleetEdgeRepositoryGit({ rootDir: edge, center: centerGit, operation: "runtime dispatch" }),
      { code: "edge_push_url_mismatch" },
    );
    git(edge, "remote", "set-url", "--push", "origin", origin);
    await assertFleetEdgeRepositoryGit({ rootDir: edge, center: centerGit, operation: "runtime dispatch" });

    git(edge, "remote", "set-url", "--push", "origin", "ext::sh -c id");
    await assert.rejects(
      assertFleetEdgeRepositoryGit({ rootDir: edge, center: centerGit, operation: "runtime dispatch" }),
      { code: "edge_push_url_mismatch" },
    );
    git(edge, "remote", "set-url", "--push", "origin", origin);

    git(edge, "remote", "set-url", "origin", alternateOrigin);
    git(edge, "remote", "set-url", "--push", "origin", alternateOrigin);
    await assertFleetEdgeRepositoryGit({
      rootDir: edge,
      center: centerGit,
      operation: "runtime dispatch",
    });

    git(edge, "remote", "set-url", "origin", wrong);
    await assert.rejects(
      assertFleetEdgeRepositoryGit({ rootDir: edge, center: centerGit, operation: "runtime dispatch" }),
      (error: unknown) => {
        assert.equal((error as FleetEdgeGitPreflightError).code, "edge_origin_mismatch");
        assert.match(String(error), /default branch history/u);
        return true;
      },
    );
    assert.equal(git(edge, "remote", "get-url", "origin"), wrong, "preflight never rewrites an existing origin");
    git(edge, "remote", "remove", "origin");
    await assert.rejects(assertFleetEdgeRepositoryGit({ rootDir: edge, center: centerGit, operation: "edge sync" }), {
      code: "edge_origin_missing",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("center Git metadata exposes a copyable origin without URL credentials", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-git-origin-display-")),
    center = path.join(root, "center");
  try {
    git(root, "init", "-q", "-b", "main", center);
    commit(center, "initial");
    git(center, "remote", "add", "origin", "https://build-user:fake-token@example.invalid/team/repo.git");
    const metadata = await readFleetCenterGitMetadata(center);
    assert.equal(metadata.originAddress, "https://example.invalid/team/repo.git");
    assert.equal(JSON.stringify(metadata).includes("fake-token"), false);
    assert.equal(metadata.originUrl, "git-remote://example.invalid/team/repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("center local-only Git mode is explicit and unreadable center facts fail closed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-git-center-facts-")),
    center = path.join(root, "center"),
    edge = path.join(root, "edge"),
    origin = path.join(root, "origin.git");
  try {
    git(root, "init", "-b", "main", "-q", center);
    commit(center, "local center");
    const localOnly = await readFleetCenterGitMetadata(center);
    assert.deepEqual(localOnly, {
      originUrl: null,
      originPushUrls: [],
      defaultBranch: null,
      defaultBranchCommit: null,
    });
    await assert.rejects(
      assertFleetEdgeRepositoryGit({ rootDir: edge, center: { originUrl: null }, operation: "runtime dispatch" }),
      { code: "center_git_metadata_unavailable" },
    );
    await assert.rejects(
      assertFleetEdgeRepositoryGit({
        rootDir: edge,
        center: { originUrl: origin, originPushUrls: [origin] },
        operation: "runtime dispatch",
      }),
      { code: "center_git_metadata_unavailable" },
    );
    git(root, "init", "--bare", "-q", origin);
    git(center, "remote", "add", "backup", origin);
    await assert.rejects(readFleetCenterGitMetadata(center), { code: "center_git_metadata_unavailable" });
    await assert.rejects(readFleetCenterGitMetadata(path.join(root, "unreadable")), {
      code: "center_git_metadata_unavailable",
    });

    git(root, "init", "-b", "main", "-q", edge);
    commit(edge, "edge");
    git(edge, "remote", "add", "origin", origin);
    await assertFleetEdgeRepositoryGit({ rootDir: edge, center: localOnly, operation: "runtime dispatch" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("edge Git preflight rejects a default branch behind the center head", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-edge-git-behind-")),
    center = path.join(root, "center"),
    edge = path.join(root, "edge"),
    origin = path.join(root, "origin.git");
  try {
    git(root, "init", "--bare", "-q", origin);
    git(root, "init", "-b", "main", "-q", center);
    git(center, "remote", "add", "origin", origin);
    commit(center, "initial");
    git(center, "push", "-q", "-u", "origin", "main");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
    git(root, "clone", "-q", origin, edge);
    commit(center, "center advances");
    git(center, "push", "-q", "origin", "main");
    git(center, "fetch", "-q", "origin");
    const centerGit = await readFleetCenterGitMetadata(center);
    await assert.rejects(
      assertFleetEdgeRepositoryGit({ rootDir: edge, center: centerGit, operation: "runtime dispatch" }),
      (error: unknown) => {
        assert.equal((error as FleetEdgeGitPreflightError).code, "edge_default_branch_behind");
        assert.match(String(error), /fetch origin main/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
