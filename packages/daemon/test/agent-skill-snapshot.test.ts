// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { computeSkillSnapshotDigest, isSha256Digest, sha256Bytes } from "@harness-anything/kernel";
import {
  listLocalSkillSnapshotSessionIds,
  materializeDispatchSkillSnapshot,
  prepareDispatchSkillSnapshot,
  reclaimSessionSkillSnapshot,
} from "../src/daemon-host/agent-skill-snapshot.ts";

function scaffoldRepo(root: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: snapshot-unit\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
}

test("prepareDispatchSkillSnapshot reads only referenced skills and ignores unreferenced poison directories", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-skill-snapshot-unit-")),
    root = path.join(parent, "repo"),
    selectedDir = path.join(root, "harness", "skills", "selected"),
    unreferencedDir = path.join(parent, "external-home-skills", "broken-external");
  try {
    scaffoldRepo(root);
    mkdirSync(path.join(selectedDir, "scripts"), { recursive: true });
    writeFileSync(path.join(selectedDir, "SKILL.md"), "# Selected Skill\n");
    writeFileSync(path.join(selectedDir, "scripts", "helper.mjs"), "export const ok = true;\n");

    // An unreferenced directory with a broken symlink must never be scanned.
    mkdirSync(unreferencedDir, { recursive: true });
    symlinkSync(path.join(unreferencedDir, "does-not-exist"), path.join(unreferencedDir, "SKILL.md"));

    const prepared = prepareDispatchSkillSnapshot({
      rootDir: root,
      cwd: root,
      runtimeSessionId: "runtime_unit_1",
      skills: [{ id: "selected", sourceDir: selectedDir, skillFile: path.join(selectedDir, "SKILL.md") }],
    });
    assert.ok(isSha256Digest(prepared.skillSnapshotDigest));
    assert.equal(existsSync(prepared.snapshotRoot), false, "prepare step must not write to disk before fence check");

    materializeDispatchSkillSnapshot(prepared);
    assert.equal(existsSync(prepared.skills[0]!.skillFile), true);
    assert.equal(readFileSync(prepared.skills[0]!.skillFile, "utf8"), "# Selected Skill\n");
    assert.equal(
      readFileSync(path.join(prepared.skills[0]!.sourceDir, "scripts", "helper.mjs"), "utf8"),
      "export const ok = true;\n",
    );
    const manifest = JSON.parse(readFileSync(path.join(prepared.snapshotRoot, "manifest.json"), "utf8"));
    assert.equal(manifest.skillSnapshotDigest, prepared.skillSnapshotDigest);
    assert.equal(computeSkillSnapshotDigest(manifest.skills), manifest.skillSnapshotDigest);
    assert.deepEqual(manifest.skills[0].files[0], {
      relativePath: "SKILL.md",
      sha256: sha256Bytes(readFileSync(prepared.skills[0]!.skillFile)),
      byteLength: Buffer.byteLength("# Selected Skill\n"),
    });
    assert.deepEqual(listLocalSkillSnapshotSessionIds(root), ["runtime_unit_1"]);

    reclaimSessionSkillSnapshot(root, "runtime_unit_1", root);
    assert.equal(existsSync(prepared.snapshotRoot), false);
    assert.deepEqual(listLocalSkillSnapshotSessionIds(root), []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("prepareDispatchSkillSnapshot fails closed on broken symlinks and directory symlink cycles", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-skill-snapshot-cycles-")),
    brokenDir = path.join(root, "harness", "skills", "broken"),
    cycleDir = path.join(root, "harness", "skills", "cycle");
  try {
    scaffoldRepo(root);
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(path.join(brokenDir, "SKILL.md"), "# Broken\n");
    symlinkSync("./missing-target.txt", path.join(brokenDir, "dangling.txt"));

    assert.throws(
      () =>
        prepareDispatchSkillSnapshot({
          rootDir: root,
          cwd: root,
          runtimeSessionId: "runtime_broken",
          skills: [{ id: "broken", sourceDir: brokenDir, skillFile: path.join(brokenDir, "SKILL.md") }],
        }),
      (error: unknown) => (error as { code?: string }).code === "agent_skill_snapshot_invalid",
    );

    mkdirSync(path.join(cycleDir, "nested"), { recursive: true });
    writeFileSync(path.join(cycleDir, "SKILL.md"), "# Cycle\n");
    symlinkSync("..", path.join(cycleDir, "nested", "loop"));

    assert.throws(
      () =>
        prepareDispatchSkillSnapshot({
          rootDir: root,
          cwd: root,
          runtimeSessionId: "runtime_cycle",
          skills: [{ id: "cycle", sourceDir: cycleDir, skillFile: path.join(cycleDir, "SKILL.md") }],
        }),
      (error: unknown) =>
        (error as { code?: string }).code === "agent_skill_snapshot_invalid" &&
        /cycle/iu.test((error as Error).message),
    );
    assert.deepEqual(listLocalSkillSnapshotSessionIds(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareDispatchSkillSnapshot limits links to the selected skill directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-skill-snapshot-contained-")),
    skillDir = path.join(root, "harness", "skills", "selected");
  try {
    scaffoldRepo(root);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# Selected Skill\n");
    writeFileSync(path.join(skillDir, "..", "reference.txt"), "fixture reference\n");
    symlinkSync("../reference.txt", path.join(skillDir, "reference.txt"));

    assert.throws(
      () =>
        prepareDispatchSkillSnapshot({
          rootDir: root,
          cwd: root,
          runtimeSessionId: "runtime_contained",
          skills: [{ id: "selected", sourceDir: skillDir, skillFile: path.join(skillDir, "SKILL.md") }],
        }),
      { code: "agent_skill_snapshot_invalid", message: /outside its directory/u },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked worktree snapshots materialize inside worktree localRoot and prune empty runtime dirs on reclaim", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-skill-snapshot-wt-")),
    worktree = path.join(root, ".worktrees", "task_1"),
    skillDir = path.join(root, "harness", "skills", "wt-skill");
  try {
    scaffoldRepo(root);
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, ".git"), "gitdir: ../../.git/worktrees/task_1\n");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# Worktree Skill\n");

    const prepared = prepareDispatchSkillSnapshot({
      rootDir: root,
      cwd: worktree,
      runtimeSessionId: "runtime_wt_1",
      skills: [{ id: "wt-skill", sourceDir: skillDir, skillFile: path.join(skillDir, "SKILL.md") }],
    });
    assert.equal(
      prepared.skills[0]!.skillFile,
      path.join(worktree, ".harness", "runtime", "sealed-skills", "runtime_wt_1", "wt-skill", "SKILL.md"),
    );
    materializeDispatchSkillSnapshot(prepared);
    assert.equal(existsSync(prepared.skills[0]!.skillFile), true);

    reclaimSessionSkillSnapshot(root, "runtime_wt_1", worktree);
    assert.equal(existsSync(path.join(worktree, ".harness", "runtime")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
