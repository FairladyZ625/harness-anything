// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recordE2EProbeFailure, runCliJsonForTest } from "./e2e-probe.mjs";

test("a rejected artifact attach keeps the closure's taskId and still records the first-triage fact", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-probe-closure-")),
    bundlePath = path.join(root, "failure.json");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(
    bundlePath,
    `${JSON.stringify({
      schema: "e2e-probe-journey/v1",
      outcome: "failed",
      runId: "probe-test-run",
      startedAt: "2026-10-10T00:00:00.000Z",
      failedStep: "board",
      message: "injected invalid result",
      failureSignature: "0123456789abcdef0123",
    })}\n`,
  );
  const rejections = [];
  const runCli = async (_workspaceRoot, _rootDir, args) => {
    if (args[0] === "task" && args[1] === "list") return { ok: true, outcome: "applied", evidence: '{"rows":[]}' };
    if (args[0] === "task" && args[1] === "create")
      return { ok: true, outcome: "applied", taskId: "task-e2eclosurefake" };
    if (args[0] === "task" && args[1] === "artifact" && args[2] === "add") {
      const rejection = Object.assign(new Error("content_not_ready · exit 1"), { code: "probe_closure_rejected" });
      rejections.push(rejection);
      throw rejection;
    }
    if (args[0] === "fact" && args[1] === "record") return { ok: true, outcome: "applied" };
    throw new Error(`unexpected CLI invocation: ${args.join(" ")}`);
  };

  const closure = await recordE2EProbeFailure({ bundlePath, runCli });

  assert.equal(rejections.length, 1, "the artifact attach must have been attempted exactly once");
  assert.equal(closure.taskId, "task-e2eclosurefake", "a rejected artifact attach must not mask the taskId");
  assert.equal(closure.deduplicated, false);
  assert.equal(closure.artifactAttached, false);
  assert.equal(closure.artifactError, rejections[0].message);
  assert.equal(closure.factRecorded, true, "the first-triage fact must still be recorded after a rejected attach");
  assert.equal(closure.factError, null);
});

test("a rejected CLI receipt surfaces a non-empty message carrying its code and exit status", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, ".."),
    root = mkdtempSync(path.join(tmpdir(), "e2e-probe-cli-"));
  try {
    await assert.rejects(
      runCliJsonForTest(repositoryRoot, root, ["task", "not-a-real-subcommand"], process.env),
      (error) => {
        assert.match(error.code, /^probe_closure_(rejected|invalid_receipt)$/u);
        assert.notEqual(error.message, "", "the message must not collapse to the empty stderr string");
        assert.match(error.message, /exit \d+/u, `the message must carry the exit status: ${error.message}`);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
