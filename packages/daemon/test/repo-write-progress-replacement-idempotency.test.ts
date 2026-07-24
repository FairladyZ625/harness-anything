// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  taskEntityId,
  type WriteOp
} from "@harness-anything/kernel";
import { testWriteAttribution } from "../../kernel/test/test-attribution.ts";
import {
  guardProgressAppendRecoveryEffect
} from "../src/runtime/repo-write-progress-recovery-guard.ts";

const replacementTest = process.platform === "win32" ? test.skip : test;

replacementTest("replacement child exact recovery does not duplicate a materialized progress delta missing its apply marker", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-progress-replacement-"));
  try {
    const progressPath = path.join(
      root,
      "harness/tasks/task-1/progress.md"
    );
    const authoredRoot = path.join(root, "harness");
    mkdirSync(path.dirname(progressPath), { recursive: true });
    const baseline = "# Progress\n\n## Entries\n\n";
    writeFileSync(progressPath, baseline, "utf8");
    git(authoredRoot, "init", "-q");
    git(authoredRoot, "config", "user.name", "Harness Test");
    git(authoredRoot, "config", "user.email", "harness@example.invalid");
    git(authoredRoot, "add", ".");
    git(authoredRoot, "commit", "-q", "-m", "seed progress");

    const operation = progressAppend("inner-progress-A", "applied once");
    const crashed = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir: root,
      autoMaterialize: false
    });
    Effect.runSync(crashed.enqueue(operation));
    writeFileSync(progressPath, `${baseline}applied once\n`, "utf8");
    assert.doesNotMatch(
      readFileSync(
        path.join(root, ".harness/write-journal/writes.jsonl"),
        "utf8"
      ),
      /apply-marker/u
    );
    assert.equal(
      guardProgressAppendRecoveryEffect({
        rootInput: root,
        opId: operation.opId,
        now: () => new Date("2026-07-24T00:00:00.000Z")
      }),
      "marker-repaired"
    );

    const replacement = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir: root,
      autoMaterialize: false
    });
    const ack = Effect.runSync(replacement.enqueue(operation));
    assert.ok(ack.journalWitness);
    Effect.runSync(
      replacement.flushExactJournalRecord!("recovery", ack.journalWitness)
    );

    assert.equal(
      readFileSync(progressPath, "utf8"),
      `${baseline}applied once\n`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

replacementTest("replacement child exact recovery keeps a materialized new-task package singular without an apply marker", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-new-task-replacement-"));
  try {
    const authoredRoot = path.join(root, "harness");
    mkdirSync(authoredRoot, { recursive: true });
    writeFileSync(path.join(authoredRoot, ".gitkeep"), "", "utf8");
    git(authoredRoot, "init", "-q");
    git(authoredRoot, "config", "user.name", "Harness Test");
    git(authoredRoot, "config", "user.email", "harness@example.invalid");
    git(authoredRoot, "add", ".");
    git(authoredRoot, "commit", "-q", "-m", "seed repository");

    const packagePath = path.join(
      authoredRoot,
      "tasks",
      "task-2-new-task"
    );
    const operation: WriteOp = {
      opId: "inner-new-task-A",
      entityId: taskEntityId("task-2"),
      kind: "package_create",
      payload: {
        writes: [
          {
            taskId: "task-2",
            packageSlug: "new-task",
            path: "INDEX.md",
            body: "# New task\n"
          },
          {
            taskId: "task-2",
            packageSlug: "new-task",
            path: "progress.md",
            body: "# Progress\n\n## Entries\n\n"
          }
        ]
      }
    };
    const crashed = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir: root,
      autoMaterialize: false
    });
    Effect.runSync(crashed.enqueue(operation));
    mkdirSync(packagePath, { recursive: true });
    writeFileSync(path.join(packagePath, "INDEX.md"), "# New task\n", "utf8");
    writeFileSync(
      path.join(packagePath, "progress.md"),
      "# Progress\n\n## Entries\n\n",
      "utf8"
    );
    assert.doesNotMatch(
      readFileSync(
        path.join(root, ".harness/write-journal/writes.jsonl"),
        "utf8"
      ),
      /apply-marker/u
    );

    const replacement = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir: root,
      autoMaterialize: false
    });
    const ack = Effect.runSync(replacement.enqueue(operation));
    assert.ok(ack.journalWitness);
    Effect.runSync(
      replacement.flushExactJournalRecord!("recovery", ack.journalWitness)
    );

    assert.deepEqual(
      readFileSync(path.join(packagePath, "INDEX.md"), "utf8"),
      "# New task\n"
    );
    assert.deepEqual(
      readFileSync(path.join(packagePath, "progress.md"), "utf8"),
      "# Progress\n\n## Entries\n\n"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function progressAppend(opId: string, append: string): WriteOp {
  return {
    opId,
    entityId: taskEntityId("task-1"),
    kind: "progress_append",
    payload: {
      path: "progress.md",
      append
    }
  };
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "pipe"
  });
}
