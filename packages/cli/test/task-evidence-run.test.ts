// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseTaskEvidenceInvocation, runTaskEvidence } from "../src/cli-task-evidence-run.ts";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("progress append remains text-only and cannot execute or freeze a command", () => {
  const progress = parseThinCommand(["task", "progress", "append", "task-proof", "--text", "zero hits"]);
  assert.equal(progress.ok, true);
  if (progress.ok)
    assert.deepEqual(progress.command.action, {
      kind: "task-progress-append",
      taskId: "task-proof",
      text: "zero hits",
      evidence: [],
    });
});

test("task evidence run publishes the same-run command transcript and preserves child exit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-task-evidence-")),
    invocation = parseTaskEvidenceInvocation(
      [
        "--root",
        root,
        "task",
        "evidence",
        "run",
        "task-proof",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('zero hits\\n'); process.stderr.write('detail\\n'); process.exit(7)",
      ],
      root,
    );
  assert.ok(invocation);
  let transcript: Record<string, unknown> | undefined;
  const receipt = await runTaskEvidence(invocation, undefined, async (command) => {
    transcript = JSON.parse(String(command.action.content));
    assert.equal(command.action.source, undefined);
    return {
      ok: true,
      outcome: "applied",
      destination: command.action.destination,
    };
  });
  assert.equal(receipt.exitCode, 7);
  assert.equal(receipt.childExitCode, 7);
  assert.deepEqual(transcript?.command, invocation.command);
  assert.equal(transcript?.cwd, process.cwd());
  assert.equal(transcript?.stdout, "zero hits\n");
  assert.equal(transcript?.stderr, "detail\n");
  assert.equal(transcript?.exitCode, 7);
  assert.match(String(receipt.evidencePath), /^artifacts\/evidence\/command-.*\.json$/u);
});

test("task evidence run requires the separator and a command", () => {
  assert.equal(parseTaskEvidenceInvocation(["task", "evidence", "run", "task-proof"]), null);
  assert.equal(parseTaskEvidenceInvocation(["task", "evidence", "run", "task-proof", "--"]), null);
});
