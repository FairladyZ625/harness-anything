// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { safePath } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { runCommandThroughDaemon } from "../src/daemon/client.ts";
import { run, runMaybe } from "./runtime-cli.commands.fixture.ts";
import { createRuntimeFixture, seedTask } from "./runtime-cli.setup.fixture.ts";

test("Read-only dispatch contracts and closed batch and wire payloads are enforced", async (context) => {
  const fixture = createRuntimeFixture(context);
  const { root, env } = fixture;
  const { taskId, executionId } = seedTask(root, env, "validation");
  run(root, env, ["task", "start", taskId, "--execution-id", executionId]);
  const readOnly = runMaybe(root, env, [
    "runtime",
    "run",
    "cli-worker",
    "--permission-mode",
    "read-only",
    "--prompt",
    "read-only",
    "--no-stream",
  ]);
  assert.equal(readOnly.status, 0, `${readOnly.stderr}\n${JSON.stringify(readOnly.receipt)}`);
  assert.equal(readOnly.receipt.outcome, "succeeded");
  const readOnlySpawn = readOnly.receipt.spawn as Record<string, unknown>;
  assert.deepEqual(
    { ledgerAccess: readOnlySpawn.ledgerAccess, reportDelivery: readOnlySpawn.reportDelivery },
    { ledgerAccess: "unavailable", reportDelivery: "stdout" },
  );
  assert.match(
    String((readOnly.receipt.result as Record<string, unknown>).text),
    /Read-only Dispatch Contract[\s\S]*daemon-ledger commands are unavailable[\s\S]*final stdout/u,
  );
  const noAction = runMaybe(root, env, ["runtime", "run", "cli-worker", "--prompt", "no-action", "--no-stream"]);
  assert.equal(noAction.status, 0, `${noAction.stderr}\n${JSON.stringify(noAction.receipt)}`);
  assert.equal(noAction.receipt.outcome, "succeeded");
  writeFileSync(
    path.join(root, "batch-unknown-declaration.json"),
    JSON.stringify({
      schema: "runtime-batch/v1",
      maxConcurrency: 1,
      dispatches: [{ instance: "cli-worker", prompt: "unused" }],
      permissionMode: "read-only",
    }),
  );
  const unknownDeclaration = runMaybe(root, env, ["runtime", "batch", "batch-unknown-declaration.json"]);
  assert.equal(unknownDeclaration.status, 1);
  assert.equal(unknownDeclaration.receipt.code, "batch_file_invalid");
  assert.equal((unknownDeclaration.receipt.diagnostic as Record<string, unknown>).kind, "validation");
  writeFileSync(
    path.join(root, "batch-unknown-dispatch.json"),
    JSON.stringify({
      schema: "runtime-batch/v1",
      maxConcurrency: 1,
      dispatches: [{ instance: "cli-worker", prompt: "unused", permissionMode: "read-only" }],
    }),
  );
  const unknownDispatch = runMaybe(root, env, ["runtime", "batch", "batch-unknown-dispatch.json"]);
  assert.equal(unknownDispatch.status, 1);
  assert.equal(unknownDispatch.receipt.code, "batch_file_invalid");
  assert.equal((unknownDispatch.receipt.diagnostic as Record<string, unknown>).kind, "validation");
  const unknownSpawn = await runCommandThroughDaemon(
    {
      rootDir: safePath(root),
      repoId: "runtime-cli",
      json: true,
      method: "repo.agentRuntime.spawn",
      action: {
        kind: "runtime-run",
        runtimeInstanceId: "cli-worker",
        cwd: { scope: "repo-root" },
        prompt: "unused",
        taskId: null,
        idempotencyKey: "unknown-wire-field",
        permission_mode: "read-only",
      } as never,
    },
    undefined,
    { env },
  );
  assert.equal(unknownSpawn.code, "unknown_field");
  const unknownSpawnDiagnostic = unknownSpawn.diagnostic as Record<string, unknown>;
  assert.deepEqual(
    {
      kind: unknownSpawnDiagnostic.kind,
      entity: unknownSpawnDiagnostic.entity,
      field: unknownSpawnDiagnostic.field,
      actual: unknownSpawnDiagnostic.actual,
    },
    {
      kind: "validation",
      entity: "repo.agentRuntime.spawn",
      field: "permission_mode",
      actual: "unknown",
    },
  );
  assert.match(String(unknownSpawnDiagnostic.expectation), /Allowed fields:.*agentId.*permissionMode/u);
  const unknownCancel = await runCommandThroughDaemon(
    {
      rootDir: safePath(root),
      repoId: "runtime-cli",
      json: true,
      method: "repo.agentRuntime.cancel",
      action: { kind: "runtime-cancel", runtimeSessionId: "missing", force: true } as never,
    },
    undefined,
    { env },
  );
  assert.equal(unknownCancel.code, "unknown_field");
  assert.deepEqual(
    {
      kind: (unknownCancel.diagnostic as Record<string, unknown>).kind,
      field: (unknownCancel.diagnostic as Record<string, unknown>).field,
    },
    { kind: "validation", field: "force" },
  );
  const unknownFact = await runCommandThroughDaemon(
    {
      rootDir: safePath(root),
      repoId: "runtime-cli",
      json: true,
      method: "repo.task.read",
      action: { kind: "fact-search", taskId, permissionMode: "read-only" } as never,
    },
    undefined,
    { env: { ...env, HARNESS_ACTOR: "" } },
  );
  assert.equal(unknownFact.code, "invalid_command");
});
