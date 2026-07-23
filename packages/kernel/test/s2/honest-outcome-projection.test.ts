// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import {
  makeJournaledWriteCoordinator,
  runLedgerMaterializer
} from "../../src/index.ts";
import { projectKernelHonestOutcome } from "../../src/write-coordination/journal/honest-outcome.ts";
import { reconcileDurableFlush } from "../../src/write-coordination/journal/receipt.ts";
import { docWrite, withTempStore } from "../store/helpers.ts";

const kernelRegistry = {
  apply_conflict: {
    family: "apply",
    recovery: {
      action: "resolve_conflict_then_reapply_committed_operation",
      automation: "operator_required",
      operationId: "reuse_same",
      effectSafety: "committed_do_not_resubmit"
    }
  },
  visibility_pending: {
    family: "visibility",
    recovery: {
      action: "run_materializer_then_recheck_visibility",
      automation: "allowed",
      operationId: "reuse_same",
      effectSafety: "committed_do_not_resubmit"
    }
  },
  outcome_unknown: {
    family: "commit",
    recovery: {
      action: "query_operation_outcome",
      automation: "forbidden",
      operationId: "not_applicable",
      effectSafety: "outcome_must_be_queried"
    }
  }
} as const;

test("foreign-committer durable reconciliation stays committed and forbids duplicate replay", () => {
  withTempStore((rootDir) => {
    const journalPath = path.join(rootDir, ".harness/write-journal/writes.jsonl");
    const watermarkPath = path.join(rootDir, ".harness/write-journal/watermark.json");
    mkdirSync(path.dirname(watermarkPath), { recursive: true });
    writeFileSync(watermarkPath, JSON.stringify({
      schema: "write-watermark/v1",
      lastCommittedOpIds: ["op-foreign"],
      lastCommitSha: "commit-foreign",
      projectionHash: "projection-foreign",
      updatedAt: "2026-07-23T00:00:00.000Z"
    }), "utf8");
    const pending = [docWrite("op-foreign", "task-foreign", "note.md", "once\n")];

    const reconciled = reconcileDurableFlush(
      "explicit",
      ["op-foreign"],
      pending,
      journalPath,
      watermarkPath,
      rootDir
    );
    assert.ok(reconciled);
    const outcome = projectKernelHonestOutcome({
      operation: { id: "op-foreign" },
      flushReport: reconciled
    }, kernelRegistry);

    assert.equal(outcome.moments.committed.status, "confirmed");
    assert.equal(outcome.moments.applied.status, "unknown");
    assert.equal(outcome.moments.visible.status, "unknown");
    assert.equal(outcome.moments.acked.status, "unknown");
    assert.deepEqual(outcome.failures, []);
    assert.equal(pending.length, 0, "reconciled op must leave the retry queue");
  });
});

test("session commit plus materializer conflict reports canonical-missing without resubmit", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const relativeTarget = "tasks/task-s2-e/note.md";
    const target = path.join(rootDir, "harness", relativeTarget);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "base\n", "utf8");
    git(rootDir, "add", "--", relativeTarget);
    git(rootDir, "commit", "-m", "seed E target");

    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir,
      sessionId: "s2-e-conflict",
      autoMaterialize: false
    });
    Effect.runSync(coordinator.enqueue(
      docWrite("op-s2-e", "task-s2-e", "note.md", "session mutation\n")
    ));
    const flushReport = Effect.runSync(coordinator.flush("explicit"));

    rmSync(target);
    git(rootDir, "add", "--", relativeTarget);
    git(rootDir, "commit", "-m", "remove E target on canonical trunk");
    const materializer = runLedgerMaterializer(rootDir, {
      sessionId: "s2-e-conflict"
    });
    assert.equal(
      materializer.branches.find((branch) => branch.branch === "sessions/s2-e-conflict")?.status,
      "conflict"
    );
    assert.equal(existsSync(target), false);

    const outcome = projectKernelHonestOutcome({
      operation: { id: "op-s2-e" },
      flushReport,
      materializer: {
        report: materializer,
        branch: "sessions/s2-e-conflict"
      }
    }, kernelRegistry);
    assert.equal(outcome.moments.committed.status, "confirmed");
    assert.equal(outcome.moments.applied.status, "not_reached");
    assert.equal(outcome.moments.visible.status, "not_reached");
    assert.equal(outcome.failures[0]?.reason, "apply_conflict");
    assert.equal(
      outcome.failures[0]?.recovery.effectSafety,
      "committed_do_not_resubmit"
    );
  });
});

test("malformed watermark remains outcome-unknown with automatic effect replay forbidden", () => {
  withTempStore((rootDir) => {
    const journalPath = path.join(rootDir, ".harness/write-journal/writes.jsonl");
    const watermarkPath = path.join(rootDir, ".harness/write-journal/watermark.json");
    mkdirSync(path.dirname(watermarkPath), { recursive: true });
    writeFileSync(watermarkPath, JSON.stringify({
      schema: "wrong-watermark/v1",
      lastCommittedOpIds: ["op-malformed"]
    }), "utf8");
    const pending = [docWrite(
      "op-malformed",
      "task-malformed",
      "note.md",
      "must not replay automatically\n"
    )];

    const reconciled = reconcileDurableFlush(
      "explicit",
      ["op-malformed"],
      pending,
      journalPath,
      watermarkPath,
      rootDir
    );
    assert.equal(reconciled, undefined);
    const outcome = projectKernelHonestOutcome({
      operation: { id: "op-malformed" },
      durable: {
        status: "malformed",
        detail: "watermark schema mismatch"
      }
    }, kernelRegistry);

    assert.deepEqual(outcome.moments.committed, {
      status: "unknown",
      reason: "outcome_indeterminate",
      detail: "watermark schema mismatch"
    });
    assert.equal(outcome.failures[0]?.reason, "outcome_unknown");
    assert.equal(outcome.failures[0]?.recovery.automation, "forbidden");
    assert.equal(
      outcome.failures[0]?.recovery.effectSafety,
      "outcome_must_be_queried"
    );
    assert.equal(pending.length, 1, "unreadable durability must not claim reconciliation");
  });
});

test("materializer merge confirms applied while visibility waits for independent read evidence", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir,
      sessionId: "s2-visible",
      autoMaterialize: false
    });
    Effect.runSync(coordinator.enqueue(
      docWrite("op-s2-visible", "task-s2-visible", "note.md", "visible\n")
    ));
    const flushReport = Effect.runSync(coordinator.flush("explicit"));
    const materializer = runLedgerMaterializer(rootDir, {
      sessionId: "s2-visible"
    });

    const withoutRead = projectKernelHonestOutcome({
      operation: { id: "op-s2-visible" },
      flushReport,
      materializer: {
        report: materializer,
        branch: "sessions/s2-visible"
      }
    }, kernelRegistry);
    assert.equal(withoutRead.moments.applied.status, "confirmed");
    assert.deepEqual(withoutRead.moments.visible, {
      status: "unknown",
      reason: "scope_not_proven"
    });

    const withRead = projectKernelHonestOutcome({
      operation: { id: "op-s2-visible" },
      flushReport,
      materializer: {
        report: materializer,
        branch: "sessions/s2-visible"
      },
      projectionRead: {
        status: "visible",
        ref: "sqlite/task-s2-visible/op-s2-visible",
        scopeId: "task-projection"
      }
    }, kernelRegistry);
    assert.equal(withRead.moments.applied.status, "confirmed");
    assert.equal(withRead.moments.visible.status, "confirmed");
    assert.equal(withRead.moments.acked.status, "unknown");
  });
});

function initAuthoredGit(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", "master"], {
    stdio: "ignore"
  });
  // Persist a local committer identity so the production write-coordination
  // commit path (which reads ambient git config, not the test's per-invocation
  // -c flags) succeeds under hermetic CI where no global/implicit identity
  // exists. Mirrors what a real `ha init` seeds into a harness root.
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], {
    stdio: "ignore"
  });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], {
    stdio: "ignore"
  });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "", "utf8");
  git(rootDir, "add", "--", ".gitkeep");
  git(rootDir, "commit", "-m", "seed");
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-C",
    path.join(rootDir, "harness"),
    "-c",
    "user.name=Harness Test",
    "-c",
    "user.email=harness@example.test",
    ...args
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
