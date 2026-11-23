// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindWriterGenerationToken, readSettingsFacet } from "@harness-anything/kernel";
import { resolveRepoBootstrapDefaults } from "@harness-anything/preset";
import { bootstrapRepo, resolveRepoBootstrap } from "../src/daemon-host/repo-bootstrap.ts";
import type { DaemonAuthenticationContext } from "../src/daemon-host/transport/auth-context.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
      removeTempRepository(rootDir);
    }
  }
});

test("init selects the vertical's default artifact preset without creating project Git", () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-init-artifact-shape-"))),
    rootDir = path.join(parent, "research"),
    defaults = resolveRepoBootstrapDefaults({ rootDir, verticalId: "office/collab" });
  mkdirSync(rootDir);
  try {
    const input = resolveRepoBootstrap(
        {
          rootDir,
          repoId,
          personId: "researcher",
          displayName: "Researcher",
          vertical: "office/collab",
        },
        auth,
      ),
      receipt = bootstrapRepo(input, writer, bindWriterGenerationToken(writer)),
      settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8"));

    assert.equal(settings.defaultVertical, "office/collab");
    assert.equal(settings.defaultPreset, defaults.presetId);
    assert.equal(settings.defaultProfile, defaults.profileId);
    assert.equal(existsSync(path.join(rootDir, ".git")), false);
    assert.equal(input.outputShape, "task-package-artifact");
    assert.equal(existsSync(path.join(rootDir, "harness", ".git")), true);
    assert.equal(receipt.publication.ok, true);
  } finally {
    removeTempRepository(parent);
  }
});

test("init keeps the repository-diff Git default when no vertical is selected", () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-init-code-shape-")));
  try {
    const input = resolveRepoBootstrap({ rootDir, repoId, personId: "owner", displayName: "Owner" }, auth),
      receipt = bootstrapRepo(input, writer, bindWriterGenerationToken(writer)),
      settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8"));

    assert.equal(settings.defaultVertical, "software/coding");
    assert.equal(settings.defaultPreset, "standard-task");
    assert.equal(input.outputShape, "repository-diff");
    assert.equal(existsSync(path.join(rootDir, ".git")), true);
    assert.equal(receipt.publication.ok, true);
  } finally {
    removeTempRepository(rootDir);
  }
});

test("artifact init continues protecting the ledger inside an existing Git repository", () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-init-artifact-existing-git-")));
  try {
    execFileSync("git", ["-C", rootDir, "init", "-q"]);
    execFileSync("git", ["-C", rootDir, "config", "user.name", "Researcher"]);
    const receipt = bootstrapRepo(
        resolveRepoBootstrap(
          {
            rootDir,
            repoId,
            personId: "researcher",
            displayName: "Researcher",
            vertical: "office/collab",
          },
          auth,
        ),
        writer,
        bindWriterGenerationToken(writer),
      ),
      ignored = readFileSync(path.join(rootDir, ".gitignore"), "utf8");

    assert.match(ignored, /^\/harness\/$/mu);
    assert.equal(existsSync(path.join(rootDir, ".git")), true);
    assert.equal(receipt.publication.ok, true);
  } finally {
    removeTempRepository(rootDir);
  }
});
