// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ScheduleV1, TaskLifecycleSnapshot } from "@harness-anything/kernel";
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
    readonly disableBranchRuns: () => void;
    readonly enableBranchRuns: () => void;
    readonly breakProvider: () => void;
    readonly show: () => Promise<ScheduleV1>;
    readonly advance: () => void;
  }) => Promise<void>,
  mode: "local" | "remote-center" = "local",
): Promise<void> {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-ci-pull-receipt-")),
    rootDir = path.join(parent, "repo"),
    bin = path.join(parent, "bin"),
    callsLog = path.join(parent, "calls.log"),
    deliveryFile = path.join(parent, "delivery"),
    witnessHold = path.join(parent, "witness-released"),
    scanHold = path.join(parent, "scan-released"),
    branchRunsDisabled = path.join(parent, "branch-runs-disabled"),
    originalPath = process.env.PATH;
  mkdirSync(rootDir);
  mkdirSync(bin);
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Pull Receipt Fixture");
  git(rootDir, "config", "user.email", "pull-receipt@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "fixture base");
  git(rootDir, "remote", "add", "origin", "https://github.com/fixture/pull-receipt.git");
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
const waitFor = async (file) => {
  if (fs.existsSync(file)) return;
  await new Promise((resolve, reject) => {
    const path = require('node:path');
    const watcher = fs.watch(path.dirname(file), (_event, name) => {
      if (name && name.toString() !== path.basename(file)) return;
      if (fs.existsSync(file)) finish();
    });
    const finish = () => { watcher.close(); resolve(); };
    watcher.on('error', reject);
    if (fs.existsSync(file)) finish();
  });
};
(async () => {
const api = args.find(a => a.startsWith('repos/')) ?? '';
const delivery = fs.readFileSync(${JSON.stringify(deliveryFile)}, 'utf8').trim();
const metadata = (runId) => ({name:'rewrite-ci',workflowName:'rewrite-ci',head_sha:delivery,headSha:delivery,head_branch:runId===9?'task-pull-receipt':'main',headBranch:runId===9?'task-pull-receipt':'main',status:'completed',conclusion:'success',run_attempt:1,attempt:1,event:'push',path:'.github/workflows/rewrite-ci.yml',workflow_id:1,repository:{full_name:'fixture/pull-receipt'},id:runId});
if (api.includes('/workflows/')) { await waitFor(${JSON.stringify(scanHold)}); process.stdout.write(JSON.stringify({workflow_runs: []})); }
else if (api.includes('?branch=')) process.stdout.write(JSON.stringify([{workflow_runs:fs.existsSync(${JSON.stringify(branchRunsDisabled)})?[]:[{id:9,path:'.github/workflows/rewrite-ci.yml',head_branch:'task-pull-receipt',head_sha:delivery,event:'push',status:'completed',conclusion:'success'}]}]));
else if (api.includes('head_sha=')) { await waitFor(${JSON.stringify(witnessHold)}); process.stdout.write(JSON.stringify([{databaseId:7, path:'.github/workflows/rewrite-ci.yml', headBranch:'main', event:'push', status:'completed', conclusion:'success'}])); }
else if (api.includes('/jobs')) process.stdout.write(JSON.stringify([{jobs:[]}]));
else if (api.includes('/artifacts')) process.stdout.write(JSON.stringify([{artifacts:[]}]));
else if (api.includes('/attempts/')) process.stdout.write(JSON.stringify(metadata(Number(/runs\\/([0-9]+)\\/attempts/u.exec(api)?.[1] ?? 7))));
else if (args[1] === 'view') process.stdout.write(JSON.stringify(metadata(Number(args[2]))));
else if (args[1] === 'list') process.stdout.write('[]');
else throw new Error('unexpected provider call ' + args.join(' '));
})().catch(e => { process.stderr.write(e.stack); process.exitCode=1; });
`;
  writeFileSync(path.join(bin, "gh"), gh, { mode: 0o755 });
  const taskId = "task-pull-receipt";
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  let now = "2026-10-11T00:00:00.000Z";
  const cell = await openBootstrappedRepoCell({
    now: () => now,
    repoId: workspaceId("ci-pull-receipt"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "pull-receipt",
    mode,
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
      advance: () => {
        now = "2026-10-11T02:00:00.000Z";
      },
      calls: () => readFileSync(callsLog, "utf8").split("\n").filter(Boolean),
      releaseWitness: () => writeFileSync(witnessHold, "released"),
      releaseScan: () => writeFileSync(scanHold, "released"),
      disableBranchRuns: () => writeFileSync(branchRunsDisabled, "disabled"),
      enableBranchRuns: () => rmSync(branchRunsDisabled, { force: true }),
      breakProvider: () =>
        writeFileSync(
          path.join(bin, "gh"),
          `#!/usr/bin/env node\nprocess.stderr.write('provider offline'); process.exit(1);\n`,
          { mode: 0o755 },
        ),
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
  // This is only a failure bound; test progress is driven by observable state below.
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
  for (;;) {
    const schedule = await show();
    if (!schedule.status.activeRun) return schedule;
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    const settled = await settlesWithin(waitForIdleSchedule(show), 15_000, "schedule idle");
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
    assert.equal(
      (await settlesWithin(waitForIdleSchedule(show), 15_000, "schedule idle")).status.lastRun?.outcome,
      "succeeded",
    );
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

for (const trigger of ["ci-observe-pull", "schedule-run-now", "task-complete"] as const) {
  test(`${trigger} replaces an expired CI claim and publishes one bound witness`, async () => {
    await submittedTaskFixture(async ({ cell, taskId, advance, releaseWitness, releaseScan, show }) => {
      const snapshot = async () =>
        JSON.parse(String((await cell.run({ kind: "task-show", taskId }, binding)).evidence)) as TaskLifecycleSnapshot;
      const before = await snapshot();
      const old = before.executions[0]!.gateRuns[0]!;
      assert.equal(old.state, "running");
      assert.equal(before.gateWitnesses.length, 0);
      advance();
      releaseWitness();
      releaseScan();
      if (trigger === "task-complete") {
        const results = await Promise.all(
          [0, 1].map((i) =>
            cell.run({ kind: trigger, taskId }, { ...binding, source: { kind: "node", nodeId: `edge-${i}` } }),
          ),
        );
        assert.ok(
          results.every((receipt) => receipt.code === "ci_missing"),
          JSON.stringify(results),
        );
        const renewed = await snapshot();
        assert.equal(renewed.executions[0]!.gateRuns.length, 2, "two edge requests share one new claim");
        assert.equal(renewed.executions[0]!.gateRuns[0]!.state, "cancelled");
      }
      const receipt =
        trigger === "schedule-run-now"
          ? await cell.run(
              { kind: trigger, scheduleId: builtinCiObserveScheduleId, idempotencyKey: "expired-import" },
              binding,
            )
          : await cell.run({ kind: "ci-observe-pull", taskId }, binding);
      assert.ok(["applied", "no_changes"].includes(receipt.outcome), JSON.stringify(receipt));
      await settlesWithin(waitForIdleSchedule(show), 15_000, "schedule idle");
      const after = await snapshot();
      const runs = after.executions[0]!.gateRuns;
      assert.equal(runs.length, 2);
      assert.equal(runs[0]!.state, "cancelled");
      assert.equal(runs[1]!.state, "completed");
      assert.equal(runs[1]!.result, "pass");
      assert.equal(runs[1]!.supersedesRunId, old.runId);
      assert.ok(runs[1]!.claimFence > old.claimFence);
      assert.equal(after.gateWitnesses.length, 1);
      assert.equal(after.gateWitnesses[0]!.provenance!.runId, runs[1]!.runId);
      assert.equal(after.gateWitnesses[0]!.provenance!.claimFence, runs[1]!.claimFence);
      const completed = await cell.run({ kind: "task-complete", taskId }, binding);
      assert.notEqual(completed.code, "ci_missing", JSON.stringify(completed));
      // This fixture has no human review; CI must cease blocking without inventing consent.
      assert.equal((await snapshot()).gateWitnesses.length, 1);
    });
  });
}

const forward = {
  kind: "task-adjudicate",
  executionId: "pull-receipt-execution",
  forward: true,
  reason: "Forward for review.",
} as const;

test("forwarding a landed cut imports its CI witness; the reviewer reads green without a manual pull", async () => {
  await submittedTaskFixture(async ({ cell, rootDir, taskId, delivery, calls, releaseWitness, releaseScan }) => {
    releaseWitness();
    releaseScan();
    git(rootDir, "update-ref", "refs/remotes/origin/main", delivery);
    const receipt = (await cell.run({ ...forward, taskId }, binding)) as unknown as {
      outcome: string;
      steps?: readonly { readonly outcome?: string; readonly code?: string }[];
    };
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.ok(
      (receipt.steps ?? []).some((step) => ["applied", "no_changes"].includes(String(step.outcome)) && !step.code),
      `the forward receipt records the import step: ${JSON.stringify(receipt.steps ?? [])}`,
    );
    assert.ok(
      calls().some((line) => line.includes("head_sha=")),
      "the forward itself walked the witness",
    );
    const snapshot = JSON.parse(String((await cell.run({ kind: "task-show", taskId }, binding)).evidence));
    assert.equal(snapshot.executions[0].gateRuns.at(-1).state, "completed");
    assert.equal(snapshot.executions[0].gateRuns.at(-1).result, "pass");
    const ci = (await cell.run({ kind: "task-ci", taskId }, binding)) as unknown as {
      ci: { conclusion: string };
    };
    assert.equal(ci.ci.conclusion, "success", JSON.stringify(ci.ci));
  });
});

test("forwarding a review cut on the remote center imports branch CI for the owner CLI reviewer", async () => {
  await submittedTaskFixture(async ({ cell, taskId, calls, releaseWitness, releaseScan }) => {
    releaseWitness();
    releaseScan();
    const receipt = (await cell.run({ ...forward, taskId }, binding)) as unknown as {
      outcome: string;
      steps?: readonly { readonly outcome?: string; readonly code?: string }[];
    };
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.ok(
      (receipt.steps ?? []).some((step) => ["applied", "no_changes"].includes(String(step.outcome)) && !step.code),
      `the forward receipt records the branch import step: ${JSON.stringify(receipt.steps ?? [])}`,
    );
    const walked = calls(),
      branchPull = walked.findIndex((line) => line.includes("branch=task-pull-receipt")),
      witnessWalk = walked.findIndex((line) => line.includes("head_sha="));
    assert.ok(branchPull >= 0, "the forward imported the task branch's runs");
    assert.ok(
      witnessWalk < 0 || branchPull < witnessWalk,
      "the forward's queued request is the branch pull; only the occurrence's re-derivation may walk the witness afterwards",
    );
    const ci = (await cell.run({ kind: "task-ci", taskId }, binding)) as unknown as {
      ci: { conclusion: string; runs: readonly { id: number }[] };
    };
    assert.equal(ci.ci.conclusion, "success", JSON.stringify(ci.ci));
    assert.ok(
      ci.ci.runs.some((run) => run.id === 9),
      JSON.stringify(ci.ci.runs),
    );
  }, "remote-center");
});

test("owner forward imports branch CI through the command runner after a frozen pass", async () => {
  await submittedTaskFixture(
    async ({ cell, taskId, calls, releaseWitness, releaseScan, disableBranchRuns, enableBranchRuns }) => {
      disableBranchRuns();
      releaseWitness();
      releaseScan();
      const occurrence = await cell.run(
        {
          kind: "schedule-run-now",
          scheduleId: builtinCiObserveScheduleId,
          idempotencyKey: "record-main-witness-before-forward",
        },
        binding,
      );
      assert.equal(occurrence.outcome, "applied", JSON.stringify(occurrence));
      const beforeForward = JSON.parse(
        String((await cell.run({ kind: "task-show", taskId }, binding)).evidence),
      ) as TaskLifecycleSnapshot;
      assert.equal(beforeForward.executions[0]!.gateRuns.at(-1)!.state, "completed");
      assert.equal(beforeForward.executions[0]!.gateRuns.at(-1)!.result, "pass");
      const ciBeforeForward = (await cell.run({ kind: "task-ci", taskId }, binding)) as unknown as {
        ci: { runs: readonly { id: number }[] };
      };
      assert.equal(
        ciBeforeForward.ci.runs.some((run) => run.id === 9),
        false,
      );
      enableBranchRuns();
      const shown = await cell.run({ kind: "task-show", taskId }, binding);
      assert.equal(shown.outcome, "applied", JSON.stringify(shown));
      const task = JSON.parse(String(shown.evidence)) as TaskLifecycleSnapshot;
      const executionId = task.executions.at(-1)?.executionId;
      assert.ok(executionId, JSON.stringify(task));
      const forwarded = await cell.run(
        { kind: "task-adjudicate", taskId, executionId, forward: true, reason: "Forward for CI regression." },
        binding,
      );
      assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
      assert.ok(
        calls().some((line) => line.includes("branch=task-pull-receipt")),
        "forward must import task branch runs despite the passing gate",
      );
      const ci = (await cell.run({ kind: "task-ci", taskId }, binding)) as unknown as {
        ci: { conclusion: string; runs: readonly { id: number }[] };
      };
      assert.equal(ci.ci.conclusion, "success", JSON.stringify(ci.ci));
      assert.ok(
        ci.ci.runs.some((run) => run.id === 9),
        JSON.stringify(ci.ci.runs),
      );
      assert.ok(
        ci.ci.runs.some((run) => run.id === 9),
        JSON.stringify(ci.ci.runs),
      );
    },
    "remote-center",
  );
});

test("a failed import lands as a warning on the standing forward; the cut reads pending, never not_started", async () => {
  await submittedTaskFixture(async ({ cell, taskId, breakProvider }) => {
    breakProvider();
    const receipt = (await cell.run({ ...forward, taskId }, binding)) as unknown as {
      outcome: string;
      warnings?: readonly string[];
    };
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.ok((receipt.warnings ?? []).length > 0, `the import failure surfaces: ${JSON.stringify(receipt)}`);
    const ci = (await cell.run({ kind: "task-ci", taskId }, binding)) as unknown as {
      ci: { conclusion: string; notStarted?: unknown };
    };
    assert.equal(ci.ci.conclusion, "pending", JSON.stringify(ci.ci));
    assert.equal(ci.ci.notStarted, undefined);
  });
});
