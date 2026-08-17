// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { resolveHarnessLayout } from "../../kernel/src/index.ts";
import { createPresetProcessService } from "../../preset/src/index.ts";
import { resolveLocalDaemonTarget } from "../src/client/local-daemon-target.ts";
import { daemonRequestLogPath } from "../src/request-log.ts";

test("local daemon target resolves a registered workspace from its subdirectory", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace"), nestedRoot = path.join(workspaceRoot, "harness", "tasks"), userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(nestedRoot, { recursive: true }); mkdirSync(userRoot, { recursive: true });
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [repo("workspace", canonicalWorkspaceRoot)] }, null, 2)}\n`);

    const target = resolveLocalDaemonTarget({ rootDir: nestedRoot, userRoot, env: {} });

    assert.equal(target.repoId, "workspace");
    assert.equal(target.canonicalRoot, canonicalWorkspaceRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target chooses the deepest nested registered workspace", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const outerRoot = path.join(fixtureRoot, "outer"), innerRoot = path.join(outerRoot, "packages", "inner"), nestedRoot = path.join(innerRoot, "harness"), userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(nestedRoot, { recursive: true }); mkdirSync(userRoot, { recursive: true });
    const canonicalOuterRoot = realpathSync.native(outerRoot), canonicalInnerRoot = realpathSync.native(innerRoot);
    writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [repo("outer", canonicalOuterRoot), repo("inner", canonicalInnerRoot)] }, null, 2)}\n`);

    const target = resolveLocalDaemonTarget({ rootDir: nestedRoot, userRoot, env: {} });

    assert.equal(target.repoId, "inner");
    assert.equal(target.canonicalRoot, canonicalInnerRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target rejects a disabled nested workspace instead of falling back to its enabled parent", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const outerRoot = path.join(fixtureRoot, "outer"), innerRoot = path.join(outerRoot, "packages", "inner"), nestedRoot = path.join(innerRoot, "harness"), userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(nestedRoot, { recursive: true }); mkdirSync(userRoot, { recursive: true });
    const canonicalOuterRoot = realpathSync.native(outerRoot), canonicalInnerRoot = realpathSync.native(innerRoot);
    writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [repo("outer", canonicalOuterRoot), repo("inner", canonicalInnerRoot, "disabled")] }, null, 2)}\n`);

    assert.throws(() => resolveLocalDaemonTarget({ rootDir: nestedRoot, userRoot, env: {} }), /workspace is not registered/u);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target honors an explicit root instead of the process working directory", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const outerRoot = path.join(fixtureRoot, "outer"), innerRoot = path.join(outerRoot, "packages", "inner"), userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(innerRoot, { recursive: true }); mkdirSync(userRoot, { recursive: true });
    const canonicalOuterRoot = realpathSync.native(outerRoot), canonicalInnerRoot = realpathSync.native(innerRoot);
    writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [repo("outer", canonicalOuterRoot), repo("inner", canonicalInnerRoot)] }, null, 2)}\n`);
    const parsed = parseThinCommand(["--root", outerRoot, "task", "list"], innerRoot);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    if (!parsed.ok) return;

    const target = resolveLocalDaemonTarget({ rootDir: parsed.command.rootDir, userRoot, env: {} });

    assert.equal(target.repoId, "outer");
    assert.equal(target.canonicalRoot, canonicalOuterRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target keeps the environment repo id override authoritative", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const firstRoot = path.join(fixtureRoot, "first"), secondRoot = path.join(fixtureRoot, "second"), userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(firstRoot, { recursive: true }); mkdirSync(secondRoot); mkdirSync(userRoot);
    const canonicalFirstRoot = realpathSync.native(firstRoot), canonicalSecondRoot = realpathSync.native(secondRoot);
    writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [repo("first", canonicalFirstRoot), repo("second", canonicalSecondRoot)] }, null, 2)}\n`);

    const target = resolveLocalDaemonTarget({ rootDir: firstRoot, userRoot, env: { HARNESS_DAEMON_REPO_ID: "second" } });

    assert.equal(target.repoId, "second");
    assert.equal(target.canonicalRoot, canonicalSecondRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target rejects a path outside every registered workspace", () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace"), unrelatedRoot = path.join(fixtureRoot, "unrelated"), userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(workspaceRoot); mkdirSync(unrelatedRoot); mkdirSync(userRoot);
    writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [repo("workspace", realpathSync.native(workspaceRoot))] }, null, 2)}\n`);

    assert.throws(() => resolveLocalDaemonTarget({ rootDir: unrelatedRoot, userRoot, env: {} }), /workspace is not registered/u);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("local daemon target routes a repository worktree to the canonical workspace local layer", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "ha-local-daemon-target-"));
  const workspaceRoot = path.join(fixtureRoot, "workspace"), worktreeRoot = path.join(workspaceRoot, ".worktrees", "feature"), userRoot = path.join(fixtureRoot, "user");
  try {
    mkdirSync(path.join(workspaceRoot, "harness"), { recursive: true }); mkdirSync(path.join(worktreeRoot, "harness"), { recursive: true }); mkdirSync(userRoot);
    writeFileSync(path.join(workspaceRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
    writeFileSync(path.join(worktreeRoot, "harness", "harness.yaml"), "schema: harness-anything/v1\n");
    const canonicalWorkspaceRoot = realpathSync.native(workspaceRoot);
    writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify({ schema: "harness-daemon-registry/v1", repos: [repo("workspace", canonicalWorkspaceRoot)] }, null, 2)}\n`);

    const target = resolveLocalDaemonTarget({ rootDir: worktreeRoot, userRoot, env: {} });
    const layout = resolveHarnessLayout(target.canonicalRoot);
    const presetProcess = createPresetProcessService({ rootDir: target.canonicalRoot, userRoot: path.join(layout.localRoot, "presets") });
    await presetProcess.close();

    assert.equal(target.canonicalRoot, canonicalWorkspaceRoot);
    assert.equal(layout.localRoot, path.join(canonicalWorkspaceRoot, ".harness"));
    assert.equal(layout.cacheRoot, path.join(canonicalWorkspaceRoot, ".harness", "cache"));
    assert.equal(daemonRequestLogPath(target.canonicalRoot), path.join(canonicalWorkspaceRoot, ".harness", "requests", "requests.jsonl"));
    assert.equal(existsSync(path.join(canonicalWorkspaceRoot, ".harness", "preset-runs")), true);
    assert.equal(`${target.canonicalRoot}.harness-anything-writer.lock`, `${canonicalWorkspaceRoot}.harness-anything-writer.lock`);
    assert.notEqual(layout.localRoot, path.join(realpathSync.native(worktreeRoot), ".harness"));
    assert.equal(existsSync(path.join(worktreeRoot, ".harness")), false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function repo(repoId: string, canonicalRoot: string, state = "enabled") {
  return { repoId, canonicalRoot, displayName: repoId, authoredBranch: "main", state, registeredAt: "2026-08-17T00:00:00.000Z" };
}
