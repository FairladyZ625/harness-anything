// harness-test-tier: fast
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProbeFailureBundle, recordE2EProbeFailure, runCliJsonForTest } from "./e2e-probe.mjs";

test("probe failure bundle preserves scenario and screenshot details from the GUI result", () => {
  const bundle = buildProbeFailureBundle(
    { runId: "gui-e2e-test-run", failureSignature: "0123456789abcdef0123" },
    {
      id: "edge-invite",
      lane: "isolated",
      durationMs: 250,
      failedStep: "edge-invite",
      message: "Expected values to be strictly equal: 2 !== 1",
      screenshotPath: "/tmp/occ-manual-123/shots/edge-invite-failure.png",
    },
    Date.parse("2026-10-21T00:00:00.000Z"),
  );

  assert.deepEqual(bundle, {
    schema: "e2e-probe-journey/v1",
    outcome: "failed",
    runId: "gui-e2e-test-run",
    startedAt: "2026-10-20T23:59:59.750Z",
    scenarioId: "edge-invite",
    lane: "isolated",
    failedStep: "edge-invite",
    message: "Expected values to be strictly equal: 2 !== 1",
    screenshotPath: "/tmp/occ-manual-123/shots/edge-invite-failure.png",
    failureSignature: "0123456789abcdef0123",
  });
});

function writeFailureBundle(root, { screenshotPath = null } = {}) {
  const bundlePath = path.join(root, ".harness", "e2e-probe", "probe-failure.json");
  mkdirSync(path.dirname(bundlePath), { recursive: true });
  writeFileSync(
    bundlePath,
    `${JSON.stringify({
      schema: "e2e-probe-journey/v1",
      outcome: "failed",
      runId: "gui-e2e-test-run",
      startedAt: "2026-10-10T00:00:00.000Z",
      scenarioId: "edge-invite",
      failedStep: "edge-invite",
      message: "Invitation link version changed unexpectedly.",
      failureSignature: "0123456789abcdef0123",
      screenshotPath,
    })}\n`,
  );
  return bundlePath;
}

function closureCli({ root, existingRows = [], onCreate } = {}) {
  const calls = [];
  const runCli = async (_workspaceRoot, _rootDir, args) => {
    calls.push(args);
    if (args[0] === "task" && args[1] === "list")
      return { ok: true, outcome: "applied", evidence: JSON.stringify({ rows: existingRows }) };
    if (args[0] === "task" && args[1] === "create") {
      onCreate?.(args, root);
      return { ok: true, outcome: "applied", taskId: "task-e2eclosurefake" };
    }
    if (args[0] === "task" && args[1] === "artifact" && args[2] === "add") return { ok: true, outcome: "applied" };
    if (args[0] === "fact" && args[1] === "record") return { ok: true, outcome: "applied" };
    throw new Error(`unexpected CLI invocation: ${args.join(" ")}`);
  };
  return { calls, runCli };
}

test("probe closure archives the failing scenario screenshot in the task package", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-probe-screenshot-")),
    screenshotPath = path.join(root, ".harness", "e2e-probe", "edge-invite-failure.png"),
    bundlePath = writeFailureBundle(root, { screenshotPath });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { calls, runCli } = closureCli({ root });

  await recordE2EProbeFailure({ rootDir: root, workspaceRoot: root, bundlePath, runCli });

  const screenshotAttach = calls.find(
    (args) => args[0] === "task" && args[1] === "artifact" && args[2] === "add" && args.includes(screenshotPath),
  );
  assert.ok(screenshotAttach, "the screenshot source must be attached before closure returns");
  assert.ok(
    screenshotAttach.includes("artifacts/e2e-probe/gui-e2e-test-run-edge-invite-failure.png"),
    "the screenshot must have a run-specific task artifact path",
  );
});

test("probe closure archives a new screenshot when it reuses an existing failure task", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-probe-deduplicated-screenshot-")),
    screenshotPath = path.join(root, ".harness", "e2e-probe", "edge-invite-failure.png"),
    bundlePath = writeFailureBundle(root, { screenshotPath });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { calls, runCli } = closureCli({ root, existingRows: [{ taskId: "task-existing-probe" }] });

  const result = await recordE2EProbeFailure({ rootDir: root, workspaceRoot: root, bundlePath, runCli });

  assert.equal(result.taskId, "task-existing-probe");
  assert.equal(result.deduplicated, true);
  assert.equal(
    calls.some((args) => args[0] === "task" && args[1] === "create"),
    false,
  );
  assert.ok(
    calls.some(
      (args) =>
        args[0] === "task" &&
        args[1] === "artifact" &&
        args[2] === "add" &&
        args.includes(screenshotPath) &&
        args.includes("artifacts/e2e-probe/gui-e2e-test-run-edge-invite-failure.png"),
    ),
    "deduplication must not discard evidence from this occurrence",
  );
});

test("probe-created task has a dispatchable Brief with scenario, failure, run, and screenshot path", async (context) => {
  const root = mkdtempSync(path.join(tmpdir(), "e2e-probe-plan-")),
    screenshotPath = path.join(root, ".harness", "e2e-probe", "edge-invite-failure.png"),
    bundlePath = writeFailureBundle(root, { screenshotPath });
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  let authoredPlan = "";
  const { runCli } = closureCli({
    root,
    onCreate(args, workspaceRoot) {
      const planFileIndex = args.indexOf("--plan-file");
      assert.notEqual(planFileIndex, -1, "task create must receive an authored plan file");
      authoredPlan = readFileSync(path.join(workspaceRoot, args[planFileIndex + 1]), "utf8");
    },
  });

  await recordE2EProbeFailure({ rootDir: root, workspaceRoot: root, bundlePath, runCli });

  const brief = authoredPlan.split(/^## Brief\s*$/mu)[1]?.split(/^## /mu)[0] ?? "";
  assert.match(brief, /edge-invite/u);
  assert.match(brief, /Invitation link version changed unexpectedly\./u);
  assert.match(brief, /gui-e2e-test-run/u);
  assert.match(brief, /artifacts\/e2e-probe\/gui-e2e-test-run-edge-invite-failure\.png/u);
  for (const heading of [
    "Goal",
    "Context",
    "Required Reading",
    "Entry Conditions",
    "Dependencies",
    "Execution Surface",
    "Constraints",
    "Checkpoint",
    "Implementation Plan",
    "Deliverable Contract",
    "Evidence Protocol",
    "Verification",
  ])
    assert.match(authoredPlan, new RegExp(`^## ${heading}$`, "mu"));
});

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
