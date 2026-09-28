// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindWriterGenerationToken, readSettingsFacet } from "@harness-anything/kernel";
import { bootstrapRepo, resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const repoId = "worktree-setup-init";
const auth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" },
} as unknown as DaemonAuthenticationContext;
const writer = { workspaceId: repoId, ownerId: "worktree-setup-init-test", generation: 0 };

// dec_8B3FCCD256CAC5B0BF3CCEDE58: init detects the ecosystem once and writes the answer as a visible setting.
test("init writes the node-modules setup for an npm workspaces repository and says how to change it", () => {
  for (const [manifest, expected] of [
    [{ private: true, workspaces: ["packages/*"] }, ["node-modules"]],
    [{ name: "single-package" }, []],
    [null, []],
  ] as const) {
    const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-init-worktree-setup-")));
    try {
      execFileSync("git", ["-C", rootDir, "init", "-q"]);
      if (manifest) writeFileSync(path.join(rootDir, "package.json"), JSON.stringify(manifest));
      const receipt = bootstrapRepo(
        resolveRepoBootstrap({ rootDir, repoId, personId: "owner", displayName: "Owner" }, auth),
        writer,
        bindWriterGenerationToken(writer),
      );
      const settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8"));
      assert.deepEqual(settings.worktree.setup, expected, JSON.stringify(manifest));
      if (expected.length)
        assert.match(
          receipt.summary,
          /worktree setup: node-modules \(npm workspaces detected\)\..*ha settings update --worktree-setup <step>.*--worktree-setup none/u,
        );
      else assert.doesNotMatch(receipt.summary, /worktree setup/u);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});
