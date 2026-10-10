// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScheduleV1 } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { builtinCiObserveScheduleId, seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";

const binding = withPolicyGroup(
  { actor: { principal: { personId: "pull-receipt-owner" }, executor: null }, source: "local" as const },
  "admin",
);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

/**
 * A task with a submitted delivery (coverage: exact), a scripted gh provider that can serve or
 * block the witness walk and the diagnostic scan independently, and a call log every gh
 * invocation appends to. Gates: witnessHold blocks runs?head_sha until released; scanHold
 * blocks the workflow-runs page until released.
 */
async function submittedTaskFixture(
  work: (input: {
    readonly cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>>;
    readonly rootDir: string;
    readonly taskId: string;
    readonly delivery: string;
    readonly calls: () => string[];
    readonly releaseWitness: () => void;
    readonly releaseScan: () => void;
    readonly show: () => Promise<ScheduleV1>;
  }) => Promise<void>,
): Promise<void> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-ci-pull-receipt-")),
    rootDir = path.join(parent, "repo"),
    bin = path.join(parent, "bin"),
    callsLog = path.join(parent, "calls.log"),
    deliveryFile = path.join(parent, "delivery"),
    witnessHold = path.join(parent, "witness-released"),
    scanHold = path.join(parent, "scan-released"),
    originalPath = process.env.PATH;
  mkdirSync(rootDir);
  mkdirSync(bin);
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Pull Receipt Fixture");
  git(rootDir, "config", "user.email", "pull-receipt@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "fixture base");
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    "settings:\n  ci:\n    workflows: [rewrite-ci]\n  gates:\n    ci:\n      appliesTo: code\n      adapter: github-actions\n      branch: main\n      event: push\n      coverage: exact\n      selection: newest\n",
  );
  writeFileSync(callsLog, "");
  // The writer thread copies the environment when the cell opens, before the delivery commit
  // exists — the stub reads the delivery sha from this file instead of process.env.
  writeFileSync(deliveryFile, "");
  const gh = `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsLog)}, args.join(' ') + '\\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (file) => { while (!fs.existsSync(file)) await sleep(10); };
(async () => {
const api = args.find(a => a.startsWith('repos/')) ?? '';
const delivery = fs.readFileSync(${JSON.stringify(deliveryFile)}, 'utf8').trim();
const metadata = (runId) => ({name:'rewrite-ci',workflowName:'rewrite-ci',head_sha:delivery,headSha:delivery,head_branch:'main',headBranch:'main',status:'completed',conclusion:'success',run_attempt:1,attempt:1,event:'push',path:'.github/workflows/rewrite-ci.yml',workflow_id:1,repository:{full_name:'fixture/pull-receipt'},id:runId});
if (api.includes('/workflows/')) { await waitFor(${JSON.stringify(scanHold)}); process.stdout.write(JSON.stringify({workflow_runs: []})); }
else if (api.includes('head_sha=')) { await waitFor(${JSON.stringify(witnessHold)}); process.stdout.write(JSON.stringify([{databaseId:7, path:'.github/workflows/rewrite-ci.yml', headBranch:'main', event:'push', status:'completed', conclusion:'success'}])); }
else if (api.includes('/jobs')) process.stdout.write(JSON.stringify([{jobs:[]}]));
else if (api.includes('/artifacts')) process.stdout.write(JSON.stringify([{artifacts:[]}]));
else if (api.includes('/attempts/')) process.stdout.write(JSON.stringify(metadata(7)));
else if (args[1] === 'view') process.stdout.write(JSON.stringify(metadata(Number(args[2]))));
else if (args[1] === 'list') process.stdout.write('[]');
else throw new Error('unexpected provider call ' + args.join(' '));
})().catch(e => { process.stderr.write(e.stack); process.exitCode=1; });
`;
  writeFileSync(path.join(bin, "gh"), gh, { mode: 0o755 });
  const taskId = "task-pull-receipt";
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const cell = await openBootstrappedRepoCell({
    repoId: workspaceId("ci-pull-receipt"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "pull-receipt",
  });
  try {
    await seedBuiltinSchedules({ cell, binding });
    const created = await cell.run({ kind: "task-create", taskId, title: "Pull receipt witness" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const packagePath = String((created as unknown as { packagePath: string }).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath: string) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId, executionId: "pull-receipt-execution" }, binding)).outcome,
      "applied",
    );
    await cell.settlePendingMaterialization("fixture delivery");
    const deliveryRoot = path.join(rootDir, ".worktrees", taskId);
    writeFileSync(path.join(deliveryRoot, "README.md"), "# Pull receipt\n");
    git(deliveryRoot, "add", "README.md");
    git(deliveryRoot, "commit", "-qm", "test: delivery");
    const delivery = git(deliveryRoot, "rev-parse", "HEAD");
    writeFileSync(deliveryFile, delivery);
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      `# Closeout\n\n## Summary\n\nDelivery ${delivery}.\n\n## Verification\n\nFixture verified.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNone.\n`,
    );
    const submitted = await cell.run({ kind: "task-submit", taskId }, binding);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await work({
      cell,
      rootDir,
      taskId,
      delivery,
      calls: () => readFileSync(callsLog, "utf8").split("\n").filter(Boolean),
      releaseWitness: () => writeFileSync(witnessHold, "released"),
      releaseScan: () => writeFileSync(scanHold, "released"),
      show: async () =>
        (
          (await cell.run({ kind: "schedule-show", scheduleId: builtinCiObserveScheduleId }, binding)) as unknown as {
            schedule: ScheduleV1;
          }
        ).schedule,
    });
  } finally {
    process.env.PATH = originalPath;
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

async function settlesWithin<T>(work: Promise<T>, limitMs = 1_000, label = "receipt"): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`${label} did not settle within ${limitMs}ms`)), limitMs);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

async function waitForIdleSchedule(show: () => Promise<ScheduleV1>): Promise<ScheduleV1> {
  const end = Date.now() + 15_000;
  for (;;) {
    const schedule = await show();
    if (!schedule.status.activeRun || Date.now() > end) return schedule;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a pull for a task whose witness is already recorded answers from the ledger without an occurrence", async () => {
  await submittedTaskFixture(async ({ cell, taskId, calls, show, releaseWitness, releaseScan }) => {
    releaseWitness();
    releaseScan();
    // One explicit occurrence records the witness through the re-derivation pass.
    const occurring = cell.run(
      {
        kind: "schedule-run-now",
        scheduleId: builtinCiObserveScheduleId,
        idempotencyKey: "record-witness-once",
      },
      binding,
    );
    assert.equal((await occurring).outcome, "applied");
    const afterOccurrence = await show();
    assert.equal(
      afterOccurrence.status.lastRun?.outcome,
      "succeeded",
      `occurrence detail: ${afterOccurrence.status.lastRun?.detail}; ciObserve error: ${JSON.stringify(afterOccurrence.status.ciObserve?.error)}`,
    );
    const callsAfterOccurrence = calls();
    assert.ok(
      callsAfterOccurrence.some((line) => line.includes("head_sha=")),
      "the occurrence walked the witness",
    );
    // The pull returns immediately, cites the recorded run, and touches neither the provider
    // nor the schedule: no new gh call, no claimed occurrence.
    const receipt = await settlesWithin(cell.run({ kind: "ci-observe-pull", taskId }, binding));
    assert.ok(["applied", "no_changes"].includes(receipt.outcome), JSON.stringify(receipt));
    assert.match(String(receipt.evidence ?? receipt.summary ?? ""), /already recorded/u);
    assert.deepEqual(calls(), callsAfterOccurrence);
    assert.equal((await show()).status.activeRun, null);
  });
});

test("the pull that starts an occurrence returns when its witness is accepted, before the scan settles", async () => {
  await submittedTaskFixture(async ({ cell, taskId, releaseWitness, releaseScan, show, calls }) => {
    releaseWitness();
    // Hold only the diagnostic scan: the witness walk completes, the drain accepts it, and the
    // occurrence keeps running behind the blocked page listing.
    const pull = cell.run({ kind: "ci-observe-pull", taskId }, binding);
    const receipt = await settlesWithin(pull, 5_000, "triggering pull");
    assert.ok(["applied", "no_changes"].includes(receipt.outcome), JSON.stringify(receipt));
    assert.match(String(receipt.summary ?? receipt.evidence ?? ""), /CI witness/u);
    assert.ok((await show()).status.activeRun, "the occurrence is still running the scan");
    releaseScan();
    const settled = await waitForIdleSchedule(show);
    assert.equal(settled.status.lastRun?.outcome, "succeeded");
    assert.equal(calls().filter((line) => line.includes("head_sha=")).length, 1, "one witness walk total");
  });
});

test("a late --task pull waits out the active occurrence, then answers from the ledger without provider IO", async () => {
  await submittedTaskFixture(async ({ cell, taskId, calls, show, releaseWitness, releaseScan }) => {
    // Block the witness walk so the first pull's occurrence stays in its drain while the
    // late pull arrives behind it.
    const pull = cell.run({ kind: "ci-observe-pull", taskId }, binding);
    const late = cell.run({ kind: "ci-observe-pull", taskId }, binding);
    releaseWitness();
    assert.ok(["applied", "no_changes"].includes((await pull).outcome), "triggering pull settles at accept");
    releaseScan();
    // The late pull re-enters once the occurrence settles; the recorded witness answers it
    // without starting another occurrence.
    const lateReceipt = await settlesWithin(late, 15_000, "late pull");
    assert.ok(["applied", "no_changes"].includes(lateReceipt.outcome), JSON.stringify(lateReceipt));
    assert.match(String(lateReceipt.evidence ?? lateReceipt.summary ?? ""), /already recorded/u);
    assert.equal((await waitForIdleSchedule(show)).status.lastRun?.outcome, "succeeded");
    const walks = calls().filter((line) => line.includes("head_sha=")).length;
    assert.equal(walks, 1, "one witness walk total");
    // The queued copy the late pull left behind is dropped at the next drain: no re-walk.
    const second = await cell.run(
      {
        kind: "schedule-run-now",
        scheduleId: builtinCiObserveScheduleId,
        idempotencyKey: "drain-stale-request",
      },
      binding,
    );
    assert.ok(["applied", "no_changes"].includes(second.outcome), JSON.stringify(second));
    assert.equal(
      calls().filter((line) => line.includes("head_sha=")).length,
      walks,
      "the dropped request caused no provider call",
    );
  });
});
