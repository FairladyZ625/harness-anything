import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { hashTaskProjectionRows, rebuildTaskProjection } from "../../src/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/store/index.ts";
import { resolveCommitPlan } from "../../src/store/write-journal-git.ts";
import { moduleEntityId, taskEntityId } from "../../src/domain/index.ts";
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

test("WriteCoordinator journals actor person and uses explicit git authors", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    const alice = makeJournaledWriteCoordinator({
      rootDir,
      actor: { kind: "human", id: "person_alice" },
      commitAuthor: { name: "Alice Admin", email: "alice@example.com" }
    });
    const bob = makeJournaledWriteCoordinator({
      rootDir,
      actor: { kind: "human", id: "person_bob" },
      commitAuthor: { name: "Bob Builder", email: "bob@example.com" }
    });

    Effect.runSync(alice.enqueue(docWrite("op-alice", "task-1", "alice.md", "alice")));
    const journalBody = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8");
    assert.match(journalBody, /"actor":\{"kind":"human","id":"person_alice"\}/u);
    Effect.runSync(alice.flush("explicit"));

    Effect.runSync(bob.enqueue(docWrite("op-bob", "task-1", "bob.md", "bob")));
    const bobJournalBody = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8");
    assert.match(bobJournalBody, /"actor":\{"kind":"human","id":"person_bob"\}/u);
    Effect.runSync(bob.flush("explicit"));

    assert.deepEqual(
      runGit(rootDir, "log", "-2", "--format=%an <%ae>").split(/\r?\n/u),
      ["Bob Builder <bob@example.com>", "Alice Admin <alice@example.com>"]
    );
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

    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      commitAuthor: testCommitAuthor
    });
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

test("WriteCoordinator rejects hard delete for task packages with anchored facts", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    const taskDir = path.join(rootDir, "harness/tasks/task-anchored");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(path.join(taskDir, "INDEX.md"), indexBody("task-anchored", "Task Anchored", "planned"), "utf8");
    writeFileSync(path.join(taskDir, "facts.md"), [
      "# Facts",
      "",
      "- {fact_id: F-DEADBEEF, statement: \"Anchored fact blocks hard delete.\", source: \"test\", observedAt: \"2026-07-04T00:00:00.000Z\", confidence: high, memoryClass: episodic, memoryTags: [], provenance: [{runtime: \"human\", sessionId: \"human-cli-1783036800000\", boundAt: \"2026-07-04T00:00:00.000Z\"}]}",
      ""
    ].join("\n"), "utf8");
    runGit(rootDir, "add", ".");
    runGit(rootDir, "commit", "-m", "seed anchored task");

    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      commitAuthor: testCommitAuthor
    });

    assert.throws(
      () => Effect.runSync(coordinator.enqueue({
        opId: "op-hard-delete-anchored",
        entityId: taskEntityId("task-anchored"),
        kind: "package_delete_hard",
        payload: {
          reason: "mistaken anchored package"
        }
      })),
      /1 anchored fact\(s\), 0 active incoming relation\(s\), and 0 child task\(s\).*ha task archive/u
    );
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
    assert.equal(existsSync(taskDir), true);
  });
});

test("WriteCoordinator rejects ignored authored paths instead of reporting success", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, ".gitignore"), "artifacts/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore artifacts");
    const beforeHead = runGit(rootDir, "rev-parse", "HEAD");

    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      commitAuthor: testCommitAuthor
    });
    assert.throws(
      () => Effect.runSync(coordinator.enqueue(docWrite("op-ignored-artifact", "task-1", "artifacts/.gitkeep", ""))),
      /gitignored authored path requires explicit forceAddPaths: harness\/tasks\/task-1\/artifacts\/\.gitkeep/u
    );

    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/artifacts/.gitkeep")), false);
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
    assert.equal(runGit(rootDir, "rev-parse", "HEAD"), beforeHead);
  });
});

test("WriteCoordinator rejects tracked files that are now matched by gitignore", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness/tasks/task-1/artifacts"), { recursive: true });
    writeFileSync(path.join(rootDir, ".gitignore"), "artifacts/\n", "utf8");
    writeFileSync(path.join(rootDir, "harness/tasks/task-1/artifacts/tracked.md"), "before\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "add", "-f", "harness/tasks/task-1/artifacts/tracked.md");
    runGit(rootDir, "commit", "-m", "seed tracked ignored authored path");
    const beforeHead = runGit(rootDir, "rev-parse", "HEAD");

    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      commitAuthor: testCommitAuthor
    });

    assert.throws(
      () => Effect.runSync(coordinator.enqueue(docWrite("op-tracked-ignored-artifact", "task-1", "artifacts/tracked.md", "after\n"))),
      /gitignored authored path requires explicit forceAddPaths: harness\/tasks\/task-1\/artifacts\/tracked\.md/u
    );
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/artifacts/tracked.md"), "utf8"), "before\n");
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
    assert.equal(runGit(rootDir, "rev-parse", "HEAD"), beforeHead);
  });
});

test("WriteCoordinator excludes localRoot machine artifacts from every git repo", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");
    const outerHead = runGit(rootDir, "rev-parse", "HEAD");

    const harnessRoot = path.join(rootDir, "harness");
    mkdirSync(harnessRoot, { recursive: true });
    initializeGitRepo(harnessRoot);
    writeFileSync(path.join(harnessRoot, "harness.yaml"), [
      "schema: harness-anything/v1",
      "name: self-host-fixture",
      "layout:",
      "  authoredRoot: harness",
      "  localRoot: .harness",
      ""
    ].join("\n"), "utf8");
    runGit(harnessRoot, "add", "harness.yaml");
    runGit(harnessRoot, "commit", "-m", "seed nested harness");
    const innerHead = runGit(harnessRoot, "rev-parse", "HEAD");

    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      sessionId: "codex-distill-leak",
      autoMaterialize: false,
      commitAuthor: testCommitAuthor
    });
    Effect.runSync(coordinator.enqueue({
      opId: "op-distill-candidate",
      entityId: moduleEntityId("distill-candidate"),
      kind: "machine_artifact_write",
      payload: {
        boundary: "distill-candidate",
        path: ".harness/generated/distill/task-1/distill_fixture.json",
        body: "{\"schema\":\"distill-candidate/v1\"}\n"
      }
    }));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-distill-candidate");
    assert.equal(readFileSync(path.join(rootDir, ".harness/generated/distill/task-1/distill_fixture.json"), "utf8"), "{\"schema\":\"distill-candidate/v1\"}\n");
    assert.equal(runGit(rootDir, "rev-parse", "HEAD"), outerHead);
    assert.equal(runGit(rootDir, "branch", "--list", "sessions/*"), "");
    assert.equal(runGit(rootDir, "ls-files", "--", "harness", ".harness"), "");
    assert.equal(runGit(harnessRoot, "rev-parse", "HEAD"), innerHead);
    assert.equal(runGit(harnessRoot, "branch", "--list", "sessions/*"), "");
  });
});

test("WriteCoordinator creates missing unignored authored root in root repo", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "seed outer repo");
    const beforeHead = runGit(rootDir, "rev-parse", "HEAD");

    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      commitAuthor: testCommitAuthor
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-create-authored-root", "task-1", "notes.md", "first write")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-create-authored-root");
    assert.notEqual(runGit(rootDir, "rev-parse", "HEAD"), beforeHead);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "first write");
    assert.equal(runGit(rootDir, "ls-files", "--", "harness/tasks/task-1/notes.md"), "harness/tasks/task-1/notes.md");
    assert.equal(runGit(rootDir, "branch", "--list", "sessions/*"), "");
  });
});

test("resolveCommitPlan fails closed when missing authored root is ignored by root repo", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "commit", "-m", "ignore private harness");
    const beforeHead = runGit(rootDir, "rev-parse", "HEAD");

    assert.throws(
      () => resolveCommitPlan(rootDir, [path.join(rootDir, "harness/tasks/task-1/notes.md")], rootDir),
      /authored root is ignored by Git but is not a nested Git repository/u
    );
    assert.equal(runGit(rootDir, "rev-parse", "HEAD"), beforeHead);
    assert.equal(runGit(rootDir, "branch", "--list", "sessions/*"), "");
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

    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      commitAuthor: testCommitAuthor
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-nested", "task-1", "notes.md", "nested")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.watermark, "op-nested");
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-1/notes.md"), "utf8"), "nested");
    assert.match(runGit(path.join(rootDir, "harness"), "log", "--oneline", "-1"), /task\(doc\): task-1 notes\.md \[op-nested\]/);
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
    assert.match(runGit(path.join(rootDir, "harness"), "log", "--oneline", "-1"), /task\(doc\): task-1 notes\.md \[op-mixed-case\]/);
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

test("WriteCoordinator still fails closed when ignored authored root was force-tracked", () => {
  withTempStore((rootDir) => {
    initializeGitRepo(rootDir);
    writeFileSync(path.join(rootDir, ".gitignore"), "/harness/\n/.harness/\n", "utf8");
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/tracked.md"), "tracked despite ignore\n", "utf8");
    runGit(rootDir, "add", ".gitignore");
    runGit(rootDir, "add", "-f", "harness/tracked.md");
    runGit(rootDir, "commit", "-m", "seed force tracked harness");

    const coordinator = makeJournaledWriteCoordinator({ rootDir });

    assert.throws(
      () => Effect.runSync(coordinator.enqueue(docWrite("op-force-tracked-ignored", "task-1", "notes.md", "ignored"))),
      /authored root is ignored by Git but is not a nested Git repository/
    );
    assert.equal(existsSync(path.join(rootDir, ".harness/write-journal/writes.jsonl")), false);
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

const testCommitAuthor = {
  name: "Harness Test",
  email: "harness@example.test"
};

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
