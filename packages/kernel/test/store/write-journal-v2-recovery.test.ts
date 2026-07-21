// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { sha256Text, stablePayloadHash, taskEntityId } from "../../src/index.ts";
import { makeJournaledWriteCoordinator } from "../../src/index.ts";
import { recoverJournaledWrites } from "../../src/write-coordination/journal/coordinator.ts";
import { testWriteAttribution } from "../test-attribution.ts";
import { withTempStore } from "./helpers.ts";

const originalAttribution = testWriteAttribution({ kind: "agent", id: "codex-original" });
const recoveryActor = { scope: "operational", kind: "system", id: "daemon-recovery" } as const;
const commitAuthor = { name: "Harness Test", email: "harness@example.test" };

test("crash-before-apply recovery copies the original v2 actor axes into delete audit", () => {
  withDeleteFixture("before-apply", ({ rootDir }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: originalAttribution, commitAuthor });
    Effect.runSync(coordinator.enqueue(hardDelete("op-before-apply")));

    const report = Effect.runSync(recoverJournaledWrites({ rootDir, operationalActor: recoveryActor, commitAuthor }));

    assert.equal(report.replayedOps, 1);
    assertDeleteAuditActor(rootDir, "op-before-apply");
  });
});

test("crash-after-apply recovery preserves the original v2 actor instead of the recovery daemon", () => {
  withDeleteFixture("after-apply", ({ rootDir, harnessRoot }) => {
    const hook = path.join(harnessRoot, ".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", "utf8");
    chmodSync(hook, 0o755);
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: originalAttribution, commitAuthor });
    Effect.runSync(coordinator.enqueue(hardDelete("op-after-apply")));

    const failed = Effect.runSync(Effect.either(coordinator.flush("explicit")));
    assert.equal(failed._tag, "Left");
    rmSync(hook);
    const report = Effect.runSync(recoverJournaledWrites({ rootDir, operationalActor: recoveryActor, commitAuthor }));

    assert.equal(report.replayedOps, 1);
    assertDeleteAuditActor(rootDir, "op-after-apply");
  });
});

test("crash-after-commit recovery is a no-op and retained audit keeps the original v2 actor", () => {
  withDeleteFixture("after-commit", ({ rootDir }) => {
    const coordinator = makeJournaledWriteCoordinator({ rootDir, attribution: originalAttribution, commitAuthor });
    Effect.runSync(coordinator.enqueue(hardDelete("op-after-commit")));
    Effect.runSync(coordinator.flush("explicit"));

    const report = Effect.runSync(recoverJournaledWrites({ rootDir, operationalActor: recoveryActor, commitAuthor }));

    assert.equal(report.replayedOps, 0);
    assertDeleteAuditActor(rootDir, "op-after-commit");
  });
});

test("mixed legacy v1 WAL recovers without inventing a principal", () => {
  withTempStore((rootDir) => {
    const journalDir = path.join(rootDir, ".harness/write-journal");
    const payload = { path: "legacy.md", body: "legacy recovered\n" };
    const payloadBody = JSON.stringify(payload);
    const payloadPath = ".harness/write-journal/payloads/legacy-recovery.json";
    mkdirSync(path.join(journalDir, "payloads"), { recursive: true });
    writeFileSync(path.join(rootDir, payloadPath), payloadBody, "utf8");
    writeFileSync(path.join(journalDir, "writes.jsonl"), `${JSON.stringify({
      schema: "write-journal/v1",
      opId: "legacy-recovery",
      entityId: "task/task-legacy",
      kind: "doc_write",
      actor: { kind: "agent", id: "legacy-agent" },
      at: "2026-07-12T00:00:00.000Z",
      payloadRef: { path: payloadPath, sha256: sha256Text(payloadBody) },
      payload: { payloadHash: stablePayloadHash(payload) }
    })}\n`, "utf8");

    const report = Effect.runSync(recoverJournaledWrites({ rootDir, operationalActor: recoveryActor }));

    assert.equal(report.replayedOps, 1);
    assert.equal(readFileSync(path.join(rootDir, "harness/tasks/task-legacy/legacy.md"), "utf8"), "legacy recovered\n");
  });
});

function hardDelete(opId: string) {
  return {
    opId,
    entityId: taskEntityId("task-delete"),
    kind: "package_delete_hard" as const,
    payload: { reason: "recovery actor preservation fixture" }
  };
}

function assertDeleteAuditActor(rootDir: string, opId: string): void {
  const lines = readFileSync(path.join(rootDir, ".harness/write-journal/writes.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const audit = lines.find((line) => line.opId === `${opId}:applied`);
  assert.deepEqual(audit?.actor, originalAttribution.actor);
  assert.notDeepEqual(audit?.actor, recoveryActor);
}

function withDeleteFixture(
  name: string,
  run: (input: { readonly rootDir: string; readonly harnessRoot: string }) => void
): void {
  withTempStore((rootDir) => {
    const harnessRoot = path.join(rootDir, "harness");
    const taskRoot = path.join(harnessRoot, "tasks/task-delete");
    mkdirSync(taskRoot, { recursive: true });
    git(harnessRoot, "init");
    writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(name), "utf8");
    git(harnessRoot, "add", ".");
    git(harnessRoot, "commit", "-m", "seed recovery fixture");
    run({ rootDir, harnessRoot });
  });
}

function taskIndex(name: string): string {
  return [
    "---", "schema: task-package/v2", "task_id: task-delete", `title: Recovery ${name}`,
    "lifecycle:", "  bindingSchema: lifecycle-binding/v1", "  engine: local", "  status: planned",
    "  ref: ", `  titleSnapshot: Recovery ${name}`, "  url: ",
    "  bindingCreatedAt: 2026-07-12T00:00:00.000Z", "  bindingFingerprint: sha256:fixture",
    "packageDisposition: active", "vertical: default", "preset: default", "---", "", `# Recovery ${name}`, ""
  ].join("\n");
}

function git(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, "-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }
  }).trim();
}
