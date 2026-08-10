// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator, sha256Text, type WriteCoordinator, type WriteOp } from "../../kernel/src/index.ts";
import { createCanonicalScriptStage, remapScope, ScriptStageScopeError, scriptIngestOp } from "../src/commands/extensions/script-staging.ts";
import { listGeneratedFiles } from "../src/commands/extensions/script-scope.ts";
import { initializeNestedHarnessRepo } from "./helpers/git-fixtures.ts";

const commitAuthor = { name: "Harness Test", email: "harness@example.test" };

test("script ingest rejects a canonical file created after staging instead of overwriting it", () => {
  withFixture(({ rootDir, outputRoot, targetPath }) => {
    const stage = createCanonicalScriptStage(rootDir, path.join(rootDir, ".harness/runs/create-race"), outputRoot);
    const stagedTarget = path.join(stage.outputRoot, "snapshot.json");
    write(stagedTarget, "script result\n");

    write(targetPath, "concurrent creator\n");
    commitHarness(rootDir, "concurrent create");

    const op = requiredIngestOp(stage, "create-race");
    assert.equal(firstWrite(op).baseBlobSha256, null);

    assertCoordinatorRejects(rootDir, op, "snapshot.json");
    assert.equal(readFileSync(targetPath, "utf8"), "concurrent creator\n");
  });
});

test("script ingest rejects a canonical file modified after staging instead of overwriting it", () => {
  withFixture(({ rootDir, outputRoot, targetPath }) => {
    write(targetPath, "staged base\n");
    commitHarness(rootDir, "seed canonical base");

    const stage = createCanonicalScriptStage(rootDir, path.join(rootDir, ".harness/runs/modify-race"), outputRoot);
    write(path.join(stage.outputRoot, "snapshot.json"), "script result\n");

    write(targetPath, "concurrent modifier\n");
    commitHarness(rootDir, "concurrent modify");

    const op = requiredIngestOp(stage, "modify-race");
    assert.equal(firstWrite(op).baseBlobSha256, sha256Text("staged base\n"));

    assertCoordinatorRejects(rootDir, op, "snapshot.json");
    assert.equal(readFileSync(targetPath, "utf8"), "concurrent modifier\n");
  });
});

test("canonical stage materializes only declared write roots and keeps read-only roots canonical", () => {
  withFixture(({ rootDir, outputRoot }) => {
    const unrelatedRoot = path.join(rootDir, "harness/context/unrelated-payload");
    const unrelatedFile = path.join(unrelatedRoot, "large.bin");
    const baseFile = path.join(outputRoot, "snapshot.json");
    write(unrelatedFile, "unrelated\n".repeat(1_024));
    write(baseFile, "staged base\n");
    const writeScope = {
      roots: [outputRoot],
      permissions: [outputRoot, `${outputRoot}/**`]
    };
    const stage = createCanonicalScriptStage(
      rootDir,
      path.join(rootDir, ".harness/runs/sparse"),
      outputRoot,
      { protectedScopes: [{ mode: "write", scope: writeScope }] }
    );

    assert.equal(existsSync(path.join(stage.outputRoot, "snapshot.json")), true);
    assert.equal(existsSync(path.join(stage.layout.authoredRoot, "context/unrelated-payload/large.bin")), false);
    assert.deepEqual([...stage.baseline.keys()], [path.join(stage.outputRoot, "snapshot.json")]);

    const remappedRead = remapScope(stage, {
      roots: [unrelatedRoot],
      permissions: [unrelatedRoot, `${unrelatedRoot}/**`]
    });
    assert.deepEqual(remappedRead.roots, [unrelatedRoot]);
    assert.equal(remappedRead.permissions.includes(unrelatedRoot), true);
    assert.equal(remappedRead.permissions.includes(path.join(stage.layout.authoredRoot, "context/unrelated-payload")), true);
  });
});

test("script ingest compiles staged task prose and rejects machine-written section tampering", () => {
  withFixture(({ rootDir }) => {
    const taskId = "task_01KX3W4V1EDPHPTGWYYBQQ2J75";
    const taskRoot = path.join(rootDir, "harness", "tasks", taskId);
    write(path.join(taskRoot, "INDEX.md"), scriptTaskIndex(taskId));
    write(path.join(taskRoot, "task_plan.md"), scriptPlanBody("Original goal."));
    write(path.join(taskRoot, "progress.md"), scriptProgressBody("Original log."));
    commitHarness(rootDir, "seed managed task documents");

    const stage = createCanonicalScriptStage(rootDir, path.join(rootDir, ".harness/runs/managed"), taskRoot);
    write(path.join(stage.outputRoot, "task_plan.md"), scriptPlanBody("Staged goal."));
    const op = requiredIngestOp(stage, "managed-prose");
    const payload = op.payload as {
      readonly semanticMutationPlan: { readonly mutations: ReadonlyArray<{ readonly entityKind: string; readonly action: string; readonly identity: unknown }> };
    };
    assert.deepEqual(payload.semanticMutationPlan.mutations.map((mutation) => [
      mutation.entityKind, mutation.action, mutation.identity
    ]), [["task", "document", { taskId }]]);

    write(path.join(stage.outputRoot, "progress.md"), scriptProgressBody("Tampered prose."));
    assert.throws(() => scriptIngestOp(stage, [stage.outputRoot], "managed-machine-tamper"),
      /SEMANTIC_DIFF_REQUIRED:machine-written section requires typed command/u);
  });
});

test("canonical stage construction rejects a protected recursive scope containing a symlink", {
  skip: process.platform === "win32"
}, () => {
  withFixture(({ rootDir, outputRoot }) => {
    const externalRoot = path.join(rootDir, "external-stage-target");
    mkdirSync(outputRoot, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });
    symlinkSync(externalRoot, path.join(outputRoot, "escape"));

    assert.throws(() => createCanonicalScriptStage(
      rootDir,
      path.join(rootDir, ".harness/runs/symlink-stage"),
      outputRoot,
      {
        protectedScopes: [{
          mode: "write",
          scope: {
            roots: [outputRoot],
            permissions: [outputRoot, `${outputRoot}/**`]
          }
        }]
      }
    ), (error: unknown) => (
      error instanceof ScriptStageScopeError &&
      error.code === "script_stage_scope_symlink"
    ));
  });
});

test("canonical stage construction rejects a protected non-recursive file swapped to a symlink", {
  skip: process.platform === "win32"
}, () => {
  withFixture(({ rootDir, outputRoot }) => {
    const externalFile = path.join(rootDir, "external-stage-file.txt");
    const declaredFile = path.join(outputRoot, "receipt.json");
    write(externalFile, "outside\n");
    mkdirSync(outputRoot, { recursive: true });
    symlinkSync(externalFile, declaredFile);

    assert.throws(() => createCanonicalScriptStage(
      rootDir,
      path.join(rootDir, ".harness/runs/exact-symlink-stage"),
      outputRoot,
      {
        protectedScopes: [{
          mode: "write",
          scope: { roots: [declaredFile], permissions: [declaredFile] }
        }]
      }
    ), (error: unknown) => error instanceof ScriptStageScopeError);
  });
});

test("generated-file discovery never follows a symlinked root", {
  skip: process.platform === "win32"
}, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-script-list-symlink-"));
  try {
    const externalRoot = path.join(rootDir, "external");
    const linkedRoot = path.join(rootDir, "linked");
    mkdirSync(externalRoot, { recursive: true });
    write(path.join(externalRoot, "artifact.txt"), "must not be discovered\n");
    symlinkSync(externalRoot, linkedRoot);

    assert.deepEqual(listGeneratedFiles(linkedRoot), []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("stage scope remapping preserves a non-recursive permission boundary", () => {
  withFixture(({ rootDir, outputRoot }) => {
    mkdirSync(outputRoot, { recursive: true });
    const declaredFile = path.join(outputRoot, "receipt.json");
    write(declaredFile, "base\n");
    const stage = createCanonicalScriptStage(
      rootDir,
      path.join(rootDir, ".harness/runs/non-recursive-scope"),
      outputRoot
    );

    const remapped = remapScope(stage, {
      roots: [declaredFile],
      permissions: [declaredFile]
    }, { retainOriginalPermissions: false });

    assert.equal(remapped.permissions.includes(path.join(stage.outputRoot, "receipt.json")), true);
    assert.equal(remapped.permissions.some((permission) => permission.endsWith("/**")), false);
  });
});

function withFixture(run: (fixture: {
  readonly rootDir: string;
  readonly outputRoot: string;
  readonly targetPath: string;
}) => void): void {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-script-staging-cas-"));
  try {
    initializeNestedHarnessRepo(rootDir);
    const outputRoot = path.join(rootDir, "harness/tasks/task-cas/artifacts/architecture");
    run({ rootDir, outputRoot, targetPath: path.join(outputRoot, "snapshot.json") });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function requiredIngestOp(
  stage: ReturnType<typeof createCanonicalScriptStage>,
  operationId: string
): WriteOp {
  const op = scriptIngestOp(stage, [stage.outputRoot], operationId);
  assert.ok(op, "staged script write must produce an ingest op");
  return op;
}

function firstWrite(op: WriteOp): { readonly baseBlobSha256: string | null } {
  const payload = op.payload as { readonly writes?: ReadonlyArray<{ readonly baseBlobSha256: string | null }> };
  assert.equal(payload.writes?.length, 1);
  const write = payload.writes?.[0];
  assert.ok(write);
  return write;
}

function assertCoordinatorRejects(rootDir: string, op: WriteOp, expectedPath: string): void {
  const result = Effect.runSync(Effect.either(attributedCoordinator(rootDir).enqueue(op)));
  assert.equal(result._tag, "Left");
  if (result._tag === "Left") {
    assert.equal(result.left._tag, "WriteRejected");
    assert.match(String(result.left.reason), new RegExp(`canonical authored base changed before script_ingest: .*${expectedPath}`));
  }
}

function attributedCoordinator(rootDir: string): WriteCoordinator {
  return makeJournaledWriteCoordinator({
    rootDir,
    attribution: {
      actor: {
        principal: { kind: "person", personId: "person_test" },
        executor: { kind: "agent", id: "codex-test" }
      },
      principalSource: {
        kind: "local-configured",
        authority: "harness.yaml",
        authoritySha256: `sha256:${"0".repeat(64)}`
      },
      executorSource: "client-asserted"
    },
    commitAuthor
  });
}

function write(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function commitHarness(rootDir: string, message: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  execFileSync("git", ["-C", harnessRoot, "add", "."]);
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", message], { stdio: "ignore" });
}

function scriptTaskIndex(taskId: string): string {
  return [
    "---", "schema: task-package/v2", `task_id: ${taskId}`, "status: active", "urgency: medium",
    "vertical: software/coding", "preset: standard-task", "---", "# Task", ""
  ].join("\n");
}

function scriptPlanBody(goal: string): string {
  return [
    "# Plan", "", "## Goal", goal, "## Context", "Context.", "## Constraints", "Constraints.",
    "## Checkpoint", "Checkpoint.", "## CI/Gate Authority Stop Condition", "Stop.",
    "## Implementation Plan", "Plan.", "## Verification", "Verify.", ""
  ].join("\n");
}

function scriptProgressBody(log: string): string {
  return ["# Progress", "", "## Log", "", log, "", "## Evidence", "", "None.", ""].join("\n");
}
