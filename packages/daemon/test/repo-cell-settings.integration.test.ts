// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const actor = { principal: { personId: "settings-owner" }, executor: { kind: "agent", id: "settings-test" } } as const;

test("settings writes reject catalog-inconsistent vertical, preset, and profile selections", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-settings-catalog-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("settings-catalog"),
      rootDir: canonicalRoot(root),
      ownerId: "settings-catalog-test",
    });
    const binding = { actor, source: "local" as const },
      configPath = path.join(root, "harness/harness.yaml"),
      before = readFileSync(configPath, "utf8");
    for (const selection of [
      { defaultVertical: "software/coding", defaultPreset: "standard-task", defaultProfile: "prose" },
      { defaultVertical: "other/vertical", defaultPreset: "standard-task", defaultProfile: "baseline" },
    ]) {
      const rejected = await cell.run(
        { kind: "settings-update", ...selection, idempotencyKey: `reject-${selection.defaultVertical}` },
        binding,
      );
      assert.equal(rejected.outcome, "op_rejected");
      assert.equal(rejected.code, "invalid_settings_catalog_selection");
      assert.equal(readFileSync(configPath, "utf8"), before);
    }

    const applied = await cell.run(
      {
        kind: "settings-update",
        defaultVertical: "software/coding",
        defaultPreset: "docs-task",
        defaultProfile: "baseline",
        idempotencyKey: "valid-settings-selection",
      },
      binding,
    );
    assert.equal(applied.outcome, "applied", JSON.stringify(applied));
    assert.match(readFileSync(configPath, "utf8"), /defaultPreset: docs-task[\s\S]*defaultProfile: baseline/u);
  } finally {
    await cell?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function initRepo(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    [
      "schema: harness-anything/v1",
      "name: settings-catalog-test",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "settings:",
      "  defaultVertical: software/coding",
      "  defaultPreset: standard-task",
      "  defaultProfile: baseline",
      "  locale: en-US",
      "  scaffolds:",
      "    task: governance/task-scaffold.json",
      "    repository: governance/repository-scaffold.json",
      "",
    ].join("\n"),
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Settings Test");
  git(root, "config", "user.email", "settings@example.invalid");
  git(root, "add", "harness/harness.yaml");
  git(root, "commit", "--quiet", "-m", "fixture");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
}
