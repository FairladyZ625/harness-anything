// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { recordE2EProbeFailure, runCliJsonForTest } from "./e2e-probe.mjs";

test("a rejected artifact attach fails the probe closure with its original error", async (context) => {
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
  const rejection = Object.assign(new Error("content_not_ready · exit 1"), { code: "probe_closure_rejected" }),
    calls = [];
  const runCli = async (_workspaceRoot, _rootDir, args) => {
    calls.push(args.slice(0, 3).join(" "));
    if (args[0] === "task" && args[1] === "list") return { ok: true, outcome: "applied", evidence: '{"rows":[]}' };
    if (args[0] === "task" && args[1] === "create")
      return { ok: true, outcome: "applied", taskId: "task-e2eclosurefake" };
    if (args[0] === "task" && args[1] === "artifact" && args[2] === "add") {
      throw rejection;
    }
    if (args[0] === "fact" && args[1] === "record") return { ok: true, outcome: "applied" };
    throw new Error(`unexpected CLI invocation: ${args.join(" ")}`);
  };

  await assert.rejects(recordE2EProbeFailure({ bundlePath, runCli }), (error) => {
    assert.equal(error, rejection, "the attachment error must propagate unchanged");
    assert.equal(error.code, "probe_closure_rejected");
    assert.equal(error.message, "content_not_ready · exit 1", "the original error text must remain visible");
    return true;
  });
  assert.deepEqual(calls, ["task list --search", "task create --title", "task artifact add"]);

  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { recordE2EProbeFailure } from ${JSON.stringify(new URL("./e2e-probe.mjs", import.meta.url).href)};
       import { withStdoutReservedForJson } from ${JSON.stringify(new URL("./gui-e2e/emit-json.mjs", import.meta.url).href)};
       const rejection = Object.assign(new Error("content_not_ready · exit 1"), { code: "probe_closure_rejected" });
       const calls = [], runCli = ${runCli.toString()};
       await withStdoutReservedForJson(
         () => recordE2EProbeFailure({ bundlePath: ${JSON.stringify(bundlePath)}, runCli }),
         (error) => ({ outcome: "failed", message: error.message }),
       );`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 1, `the probe JSON entry must exit with failure: ${child.stderr}`);
  assert.deepEqual(JSON.parse(child.stdout), { outcome: "failed", message: rejection.message });
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
