// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, type ScheduleV1 } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup, revokeTestPolicyActions } from "./keycloak-policy.fixtures.ts";
import { initRepo } from "./task-surface.fixtures.ts";
import { builtinCiObserveScheduleId, seedBuiltinSchedules } from "../src/schedule-builtin-executor.ts";
import { makeScheduleScheduler } from "../src/schedule-scheduler.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";

const binding = withPolicyGroup(
  { actor: { principal: { personId: "ci-center-owner" }, executor: null }, source: "local" as const },
  "contributor",
);
const posix = process.platform === "win32" ? "requires POSIX executable scripts resolved through PATH" : false;
async function waitForFile(file: string) {
  const end = Date.now() + 15_000;
  while (!existsSync(file)) {
    assert.ok(Date.now() < end, `provider did not reach ${path.basename(file)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function fixture(
  work: (input: {
    cell: Awaited<ReturnType<typeof openRepoCell>>;
    rootDir: string;
    release: () => void;
    started: string;
    show: () => Promise<ScheduleV1>;
    events: () => Promise<readonly { readonly schema: string; readonly type: string }[]>;
    stateRoot: string;
  }) => Promise<void>,
) {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-ci-fence-")),
    rootDir = path.join(parent, "repo"),
    bin = path.join(parent, "bin"),
    started = path.join(parent, "started"),
    released = path.join(parent, "released"),
    stateRoot = path.join(parent, "epochs"),
    originalPath = process.env.PATH;
  mkdirSync(rootDir);
  mkdirSync(bin);
  initRepo(rootDir);
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  ci:\n    workflows: [rewrite-ci]\n");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs'); const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(started)}, 'started');
(async () => {
while (!fs.existsSync(${JSON.stringify(released)})) await new Promise(r => setTimeout(r, 10));
const endpoint = args.find(a => a.startsWith('repos/')) || '';
const metadata = {name:'rewrite-ci',workflowName:'rewrite-ci',head_sha:'${"a".repeat(40)}',headSha:'${"a".repeat(40)}',head_branch:'main',headBranch:'main',status:'completed',conclusion:'success',run_attempt:1,attempt:1,event:'push',path:'.github/workflows/rewrite-ci.yml',workflow_id:1,repository:{full_name:'fixture/repository'}};
if (endpoint.includes('/workflows/')) process.stdout.write(JSON.stringify({workflow_runs: endpoint.endsWith('page=1') ? [{id:1,run_attempt:1,head_branch:'main',status:'completed'}] : []}));
else if (endpoint.includes('/jobs?')) process.stdout.write(JSON.stringify([{jobs:[]}]));
else if (endpoint.includes('/artifacts')) process.stdout.write(JSON.stringify([{artifacts:[]}]));
else if (endpoint.includes('/attempts/') || args[1] === 'view') process.stdout.write(JSON.stringify(metadata));
else if (args[1] === 'download') { process.stderr.write('no artifacts match'); process.exitCode=1; }
else if (args[1] === 'list') process.stdout.write('[]');
else throw new Error('unexpected provider call ' + args.join(' '));
})().catch(e => { process.stderr.write(e.stack); process.exitCode=1; });
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
  const authority = openPersistentWriterEpoch({ stateRoot, holderId: "ci-fence-owner" }),
    lease = authority.acquire("ci-fence");
  authority.close();
  const cell = await openRepoCell({
    repoId: workspaceId("ci-fence"),
    rootDir: canonicalRoot(rootDir),
    ownerId: "ci-fence-owner",
    defaultWriterEpochFence: {
      schema: "harness-writer-epoch-fence/v1",
      stateRoot,
      repoId: "ci-fence",
      holderId: lease.holderId,
      epoch: lease.epoch,
    },
    now: () => "2026-10-08T10:00:00.000Z",
  });
  const release = () => writeFileSync(released, "released");
  try {
    await seedBuiltinSchedules({ cell, binding });
    await work({
      cell,
      rootDir,
      release,
      started,
      stateRoot,
      show: async () =>
        (
          (await cell.run({ kind: "schedule-show", scheduleId: builtinCiObserveScheduleId }, binding)) as unknown as {
            schedule: ScheduleV1;
          }
        ).schedule,
      events: async () => {
        const reader = makeTaskEventReader({ rootDir, repoId: "ci-fence" });
        try {
          return reader.read().events;
        } finally {
          await reader.drain();
        }
      },
    });
  } finally {
    release();
    process.env.PATH = originalPath;
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

const claim = { kind: "schedule-run-now", scheduleId: builtinCiObserveScheduleId, idempotencyKey: "ci-occurrence-one" };

test(
  "eight forwarded edge refreshes share the center occurrence; provider IO leaves other writes runnable",
  { skip: posix },
  async () => {
    await fixture(async ({ cell, rootDir, release, started, show, events }) => {
      const collecting = cell.run(claim, binding);
      await waitForFile(started);
      const active = (await show()).status.activeRun!;
      assert.equal(
        await cell.hasBuiltinExecutor(active.claimFence),
        true,
        "the proxy queries the live writer executor",
      );
      const edgeRequests = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          cell.run(
            { kind: "ci-observe-pull", runs: [1] },
            { ...binding, source: { kind: "node", nodeId: `edge-${i}` } },
          ),
        ),
      );
      for (const request of edgeRequests) assert.equal(request.outcome, "pending", JSON.stringify(request));
      const other = await cell.run(
        { kind: "task-create", taskId: "other-write", title: "Queue stays available" },
        binding,
      );
      assert.equal(other.outcome, "applied", JSON.stringify(other));
      assert.equal((await show()).status.activeRun!.claimFence, active.claimFence);
      release();
      const collected = await collecting;
      assert.equal(collected.code, undefined, JSON.stringify(collected));
      assert.equal(collected.outcome, "applied");
      assert.equal((await events()).filter((e) => e.schema === "ci-run-observation/v4").length, 2);
      const refresh = await cell.run({ kind: "ci-observe-pull", runs: [1] }, binding);
      assert.equal(refresh.outcome, "applied", JSON.stringify(refresh));
      assert.equal((await events()).filter((e) => e.schema === "ci-run-observation/v4").length, 2);
      assert.equal((await show()).status.activeRun, null);
      assert.equal((await show()).status.ciObserve!.error, null);
      const progress = (await show()).status.ciObserve;
      const orphan = await cell.run(
        {
          kind: "schedule-claim",
          scheduleId: builtinCiObserveScheduleId,
          idempotencyKey: "interrupted-before-executor",
        },
        binding,
      );
      assert.equal(orphan.outcome, "applied", JSON.stringify(orphan));
      const fence = (await show()).status.activeRun!.claimFence;
      assert.equal(await cell.hasBuiltinExecutor(fence), false);
      await cell.close();
      const reopened = await openRepoCell({
        repoId: workspaceId("ci-fence"),
        rootDir: canonicalRoot(rootDir),
        ownerId: "ci-fence-reopened",
        now: () => "2026-10-08T10:00:00.000Z",
      });
      const scheduler = makeScheduleScheduler({
        cells: new Map([["ci-fence", reopened]]),
        localBinding: () => binding,
        now: () => "2026-10-08T10:00:00.000Z",
      });
      try {
        await scheduler.start();
        const recovered = (await reopened.run(
          { kind: "schedule-show", scheduleId: builtinCiObserveScheduleId },
          binding,
        )) as unknown as { schedule: ScheduleV1 };
        assert.equal(recovered.schedule.status.activeRun, null);
        assert.equal(recovered.schedule.status.lastRun!.outcome, "unknown");
        assert.deepEqual(recovered.schedule.status.ciObserve, progress);
        const resumed = await reopened.run({ ...claim, idempotencyKey: "resume-after-center-restart" }, binding);
        assert.equal(resumed.code, undefined, JSON.stringify(resumed));
        assert.equal((await events()).filter((e) => e.schema === "ci-run-observation/v4").length, 2);
      } finally {
        scheduler.close();
        await reopened.close();
      }
    });
  },
);

test("an occurrence whose fence expired during download cannot append", { skip: posix }, async () => {
  await fixture(async ({ cell, release, started, show, events }) => {
    const collecting = cell.run(claim, binding);
    await waitForFile(started);
    const active = (await show()).status.activeRun!;
    assert.equal(
      (
        await cell.run(
          {
            kind: "schedule-settle",
            scheduleId: builtinCiObserveScheduleId,
            claimFence: active.claimFence,
            outcome: "cancelled",
            endedAt: "2026-10-08T10:01:00.000Z",
            idempotencyKey: "expire-ci",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    release();
    const receipt = await collecting;
    assert.ok(receipt.code, JSON.stringify(receipt));
    assert.equal((await events()).filter((e) => e.schema === "ci-run-observation/v4").length, 0);
  });
});

test("an old center writer epoch cannot append after provider IO completes", { skip: posix }, async () => {
  await fixture(async ({ cell, release, started, stateRoot, events }) => {
    const collecting = cell.run(claim, binding);
    await waitForFile(started);
    const next = openPersistentWriterEpoch({ stateRoot, holderId: "ci-fence-successor" });
    next.acquire("ci-fence");
    next.close();
    release();
    const receipt = await collecting;
    assert.ok(receipt.code, JSON.stringify(receipt));
    assert.equal((await events()).filter((e) => e.schema === "ci-run-observation/v4").length, 0);
  });
});

test("CI acceptance reauthorizes after provider IO before appending", { skip: posix }, async () => {
  await fixture(async ({ cell, release, started, show, events }) => {
    const collecting = cell.run(claim, binding);
    await waitForFile(started);
    revokeTestPolicyActions("ci-center-owner", "ci-fence", ["ci-observe-pull"]);
    release();
    const receipt = await collecting;
    assert.equal(receipt.code, "schedule_builtin_failed", JSON.stringify(receipt));
    assert.match((await show()).status.ciObserve!.error!, /authorization_denied/);
    assert.equal((await events()).filter((e) => e.schema === "ci-run-observation/v4").length, 0);
  });
});
