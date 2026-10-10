// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseTaskArtifactRunInvocation, runTaskArtifactCommand } from "../src/cli-task-artifact-run.ts";
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

test("task artifact add --run publishes the same-run transcript and preserves child exit", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-task-evidence-")),
    invocation = parseTaskArtifactRunInvocation(
      [
        "--root",
        root,
        "task",
        "artifact",
        "add",
        "task-proof",
        "--run",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('zero hits\\n'); process.stderr.write('detail\\n'); process.exit(7)",
      ],
      root,
    );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.ok(invocation);
  let transcript: Record<string, unknown> | undefined;
  const receipt = await runTaskArtifactCommand(invocation, undefined, async (command) => {
    transcript = JSON.parse(String(command.action.content));
    assert.equal(command.action.source, undefined);
    return { ok: true, outcome: "applied", destination: command.action.destination };
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

test("task artifact add selects exactly one input source", () => {
  assert.equal(parseTaskArtifactRunInvocation(["task", "artifact", "add", "task-proof", "--run"]), null);
  assert.equal(parseTaskArtifactRunInvocation(["task", "artifact", "add", "task-proof", "--run", "--"]), null);
  assert.equal(
    parseTaskArtifactRunInvocation([
      "task",
      "artifact",
      "add",
      "task-proof",
      "--source",
      "proof.txt",
      "--run",
      "--",
      "true",
    ]),
    null,
  );
  assert.equal(parseThinCommand(["task", "artifact", "add", "task-proof", "--run"]).ok, false);
  assert.equal(parseThinCommand(["task", "artifact", "add", "task-proof", "--source", "proof.txt"]).ok, false);
  assert.equal(
    parseThinCommand(["task", "artifact", "add", "task-proof", "--source", "proof.txt", "--destination", "proof.txt"])
      .ok,
    true,
  );
  assert.equal(
    parseTaskArtifactRunInvocation([
      "task",
      "artifact",
      "add",
      "task-proof",
      "--run",
      "--destination=evidence/proof.json",
      "--",
      "true",
    ])?.destination,
    "evidence/proof.json",
  );
});
