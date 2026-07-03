import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { hashTaskProjectionRows, rebuildTaskProjection } from "../../src/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { taskEntityId } from "../../src/domain/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator flushes same-task writes in FIFO order", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "notes.md", "first")));
    Effect.runSync(coordinator.enqueue(docWrite("op-2", "task-1", "notes.md", "second")));

    const report = Effect.runSync(coordinator.flush("explicit"));
    assert.equal(report.watermark, "op-2");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "second");
  });
});

test("WriteCoordinator preserves same-task FIFO across two coordinators", () => {
  withTempStore((rootDir) => {
    const firstCoordinator = makeJournaledWriteCoordinator({ rootDir });
    const secondCoordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(firstCoordinator.enqueue(docWrite("op-1", "task-1", "notes.md", "first")));
    Effect.runSync(secondCoordinator.enqueue(docWrite("op-2", "task-1", "notes.md", "second")));

    const secondReport = Effect.runSync(secondCoordinator.flush("explicit"));
    assert.equal(secondReport.opCount, 2);
    assert.equal(secondReport.watermark, "op-2");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "second");

    const firstReport = Effect.runSync(firstCoordinator.flush("explicit"));
    assert.equal(firstReport.opCount, 0);
    assert.equal(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8").includes("\"op-1\",\"op-2\""), true);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "second");
  });
});

test("WriteCoordinator records real projection hash and compacts watermark-covered journal entries", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    Effect.runSync(coordinator.enqueue(docWrite("op-1", "task-1", "INDEX.md", indexBody("task-1", "Task One", "planned"))));
    const report = Effect.runSync(coordinator.flush("explicit"));
    const watermark = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8")) as {
      readonly projectionHash: string;
    };
    const expectedHash = hashTaskProjectionRows(rebuildTaskProjection({ rootDir }).rows);

    assert.equal(report.watermark, "op-1");
    assert.equal(watermark.projectionHash, expectedHash);
    assert.equal(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), "");

    const recovered = Effect.runSync(makeJournaledWriteCoordinator({ rootDir }).recover);
    assert.equal(recovered.replayedOps, 0);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), "utf8"), indexBody("task-1", "Task One", "planned"));
  });
});

test("WriteCoordinator stages hard-deleted task packages and clears replay journal", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness/tasks/task-1"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md"), indexBody("task-1", "Task One", "planned"), "utf8");
    runGit(rootDir, "add", ".");
    runGit(rootDir, "commit", "-m", "seed task");

    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue({
      opId: "op-hard-delete",
      entityId: taskEntityId("task-1"),
      kind: "package_delete_hard",
      payload: {
        reason: "mistaken local package"
      }
    }));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-hard-delete");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1")), false);
    const journalBody = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8");
    assert.doesNotMatch(journalBody, /"schema":"write-journal\/v1"/);
    assert.match(journalBody, /"schema":"delete-audit\/v1"/);
    assert.match(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8"), /op-hard-delete/);
    assert.match(runGit(rootDir, "show", "--name-status", "--format=", "HEAD"), /D\s+harness\/tasks\/task-1\/INDEX.md/);

    const recovered = Effect.runSync(makeJournaledWriteCoordinator({ rootDir }).recover);
    assert.equal(recovered.replayedOps, 0);
  });
});

test("WriteCoordinator force-adds explicit harness paths ignored by target repo patterns", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "artifacts/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore artifacts");

    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-ignored-artifact", "task-1", "artifacts/.gitkeep", "")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-ignored-artifact");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/artifacts/.gitkeep")), true);
    assert.match(runGit(rootDir, "show", "--name-only", "--format=", "HEAD"), /harness\/tasks\/task-1\/artifacts\/\.gitkeep/);
  });
});

test("WriteCoordinator bounds committed op ids in watermark after successful compaction", () => {
  withTempStore((rootDir) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    for (let index = 0; index < 140; index += 1) {
      Effect.runSync(coordinator.enqueue(docWrite(`op-${index}`, "task-1", "notes.md", `write ${index}`)));
    }

    const report = Effect.runSync(coordinator.flush("explicit"));
    const watermark = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8")) as {
      readonly lastCommittedOpIds: ReadonlyArray<string>;
    };

    assert.equal(report.watermark, "op-139");
    assert.equal(watermark.lastCommittedOpIds.length, 128);
    assert.equal(watermark.lastCommittedOpIds[0], "op-12");
    assert.equal(watermark.lastCommittedOpIds.at(-1), "op-139");
    assert.equal(readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8"), "");

    const duplicateRecent = Effect.runSync(coordinator.enqueue(docWrite("op-139", "task-1", "notes.md", "duplicate")));
    assert.equal(duplicateRecent.accepted, true);
    assert.equal(Effect.runSync(coordinator.flush("explicit")).opCount, 0);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "write 139");
  });
});

test("WriteCoordinator commits self-host authored writes inside ignored nested harness repo", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");

    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    initializeGitRepo(path.join(rootDir, "harness"));
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "name: self-host-fixture",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "tasks:",
      "  root: harness/tasks",
      ""
    ].join("\n"), "utf8");
    mkdirSync(path.join(rootDir, "harness/notes"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/notes/unrelated.md"), "before\n", "utf8");
    runGit(path.join(rootDir, "harness"), "add", ".");
    runGit(path.join(rootDir, "harness"), "commit", "-m", "seed nested harness");
    writeFileSync(path.join(rootDir, "harness/notes/unrelated.md"), "after\n", "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-nested", "task-1", "notes.md", "nested")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-nested");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "nested");
    assert.match(runGit(path.join(rootDir, "harness"), "log", "--oneline", "-1"), /harness write op-nested/);
    assert.equal(runGit(path.join(rootDir, "harness"), "show", "--name-only", "--format=", "HEAD"), "tasks/task-1/notes.md");
    assert.equal(runGit(path.join(rootDir, "harness"), "status", "--short"), "M notes/unrelated.md");
    assert.equal(runGit(rootDir, "status", "--short"), "");
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), true);
  });
});

test("WriteCoordinator accepts non-native case root paths on case-insensitive filesystems", (t) => {
  withTempStore((rootDir) => {
    const variantRoot = caseVariantPath(rootDir);
    if (!variantRoot || !existsSync(variantRoot)) {
      t.skip("filesystem does not resolve mixed-case path aliases");
      return;
    }
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");

    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    initializeGitRepo(path.join(rootDir, "harness"));
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
      "schema: harness-anything/v1",
      "name: self-host-fixture",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "tasks:",
      "  root: harness/tasks",
      ""
    ].join("\n"), "utf8");

    const coordinator = makeJournaledWriteCoordinator({ rootDir: variantRoot });
    Effect.runSync(coordinator.enqueue(docWrite("op-mixed-case", "task-1", "notes.md", "mixed")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-mixed-case");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "mixed");
    assert.match(runGit(path.join(rootDir, "harness"), "log", "--oneline", "-1"), /harness write op-mixed-case/);
  });
});

test("WriteCoordinator records nested harness HEAD when self-host flush has no staged diff", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");
    const parentHead = runGit(rootDir, "rev-parse", "HEAD");

    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(path.join(harnessRoot, "tasks/task-1"), { recursive: true });
    initializeGitRepo(harnessRoot);
    writeFileSync(path.join(harnessRoot, "harness.yaml"), [
      "schema: harness-anything/v1",
      "name: self-host-fixture",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      "tasks:",
      "  root: harness/tasks",
      ""
    ].join("\n"), "utf8");
    writeFileSync(path.join(harnessRoot, "tasks/task-1/notes.md"), "already committed", "utf8");
    runGit(harnessRoot, "add", ".");
    runGit(harnessRoot, "commit", "-m", "seed harness");
    const nestedHead = runGit(harnessRoot, "rev-parse", "HEAD");
    assert.notEqual(nestedHead, parentHead);

    const coordinator = makeJournaledWriteCoordinator({ rootDir });
    Effect.runSync(coordinator.enqueue(docWrite("op-noop-nested", "task-1", "notes.md", "already committed")));
    Effect.runSync(coordinator.flush("explicit"));
    const watermark = JSON.parse(readFileSync(path.join(rootDir, ".harness/write-journal/watermark.json"), "utf8")) as {
      readonly lastCommitSha: string;
    };

    assert.equal(watermark.lastCommitSha, nestedHead);
  });
});

test("WriteCoordinator fails closed when ignored authored root has no nested Git repo", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });

    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    assert.throws(
      () => Effect.runSync(coordinator.enqueue(docWrite("op-ignored", "task-1", "notes.md", "ignored"))),
      /authored root is ignored by Git but is not a nested Git repository/
    );
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/watermark.json")), false);
  });
});

function indexBody(taskId: string, title: string, status: string): string {
  return [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    "",
    `# ${title}`,
    ""
  ].join("\n");
}

function initializeGitRepo(repoRoot: string): void {
  runGit(repoRoot, "init");
}

function caseVariantPath(inputPath: string): string | null {
  const basename = path.basename(inputPath);
  const toggled = basename.replace(/[A-Za-z]/u, (char) => char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase());
  if (toggled === basename) return null;
  return path.join(path.dirname(inputPath), toggled);
}

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Harness Test",
      GIT_AUTHOR_EMAIL: "harness-test@example.invalid",
      GIT_COMMITTER_NAME: "Harness Test",
      GIT_COMMITTER_EMAIL: "harness-test@example.invalid"
    }
  }).trim();
}
