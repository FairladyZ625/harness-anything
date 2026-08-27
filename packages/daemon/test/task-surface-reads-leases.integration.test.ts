// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventStore,
  makeTaskProjection,
  readTaskProjection,
  rebuildTaskProjection,
} from "../../kernel/src/index.ts";
import {
  canonicalRoot,
  workspaceId,
} from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";
test("task read surfaces, dry-runs, idempotency, structured input, and supersede facade stay closed", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-read-surface-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-read-surface"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-read-surface",
      now: () => "2026-08-15T03:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    await cell.run(
      {
        kind: "task-create",
        taskId: "task_target",
        title: "Target",
        moduleKey: "kernel",
      },
      binding,
    );
    writeFileSync(
      path.join(rootDir, "task-input.json"),
      JSON.stringify({
        title: "Searchable Surface",
        workKind: "fix",
        riskTier: "high",
        urgency: "medium",
        moduleKey: "daemon",
        surfaces: ["ha task list"],
      }),
    );
    const created = (await cell.run(
      {
        kind: "task-create",
        taskId: "task_source",
        idempotencyKey: "stable-create",
        fromFile: "task-input.json",
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(created.outcome, "applied");
    mkdirSync(path.join(rootDir, "harness/legacy/source"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "harness/legacy/source/old.md"),
      "# Legacy\n",
    );
    writeFileSync(
      path.join(rootDir, "harness/legacy/index.json"),
      JSON.stringify({
        entries: [
          {
            id: "legacy-1",
            title: "Legacy Rebuilt",
            storedPath: "harness/legacy/source/old.md",
          },
        ],
      }),
    );
    const legacy = (await cell.run(
      { kind: "task-create", fromLegacyId: "legacy-1" },
      binding,
    )) as Record<string, unknown>;
    assert.equal(legacy.outcome, "applied", JSON.stringify(legacy));
    const eventCount = makeTaskEventStore({
      repoId: "task-read-surface",
      rootDir,
    }).read().events.length;
    const reused = (await cell.run(
      {
        kind: "task-create",
        title: "Different retry title",
        idempotencyKey: "stable-create",
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(reused.taskId, "task_source");
    assert.match(String(reused.evidence), /"reused":true/u);
    const startPreview = await cell.run(
        {
          kind: "task-start",
          taskId: "task_source",
          ttlMs: 60_000,
          dryRun: true,
        },
        binding,
      ),
      relationPreview = await cell.run(
        {
          kind: "task-relate",
          taskId: "task_source",
          target: "task/task_target",
          relationType: "depends-on",
          rationale: "Preview only",
          dryRun: true,
        },
        binding,
      );
    assert.equal(startPreview.outcome, "pending");
    assert.equal(startPreview.proof?.canonicalVisible, false);
    assert.equal(relationPreview.outcome, "pending");
    assert.equal(relationPreview.proof?.canonicalVisible, false);
    assert.equal(
      makeTaskEventStore({ repoId: "task-read-surface", rootDir }).read().events
        .length,
      eventCount,
    );
    await cell.run(
      {
        kind: "task-relate",
        taskId: "task_source",
        target: "task/task_target",
        relationType: "depends-on",
        rationale: "Required target",
      },
      binding,
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-relate",
            taskId: "task_target",
            target: "task/task_source",
            relationType: "depends-on",
            rationale: "Would cycle",
          },
          binding,
        )
      ).outcome,
      "op_rejected",
    );
    const listed = evidence(
        await cell.run(
          {
            kind: "task-list",
            status: "planned",
            module: "daemon",
            search: "searchable",
          },
          binding,
        ),
      ),
      relations = evidence(
        await cell.run(
          {
            kind: "relation-list",
            entity: "task/task_source",
            relationType: "depends-on",
            state: "active",
          },
          binding,
        ),
      ),
      review = evidence(
        await cell.run(
          {
            kind: "task-review",
            taskId: "task_source",
            reviewerId: "reviewer",
          },
          binding,
        ),
      ),
      migration = evidence(
        await cell.run(
          {
            kind: "task-contract-migrate",
            mode: "dry-run",
            taskId: "task_source",
          },
          binding,
        ),
      );
    assert.deepEqual(
      (listed.rows as { taskId: string }[]).map((row) => row.taskId),
      ["task_source"],
    );
    assert.equal((relations.rows as unknown[]).length, 1);
    // #1542: event-backed truth already answers this read; an unmaterialized generated-cache
    // must not stand as a permanent hard-fail warning on an otherwise healthy workspace.
    assert.deepEqual(relations.warnings, []);
    assert.equal(review.completionAuthority, false);
    assert.match(JSON.stringify(migration), /"status":"current"/u);
    const superseded = (await cell.run(
      {
        kind: "task-supersede",
        oldTaskId: "task_source",
        title: "Replacement Surface",
        slug: "replacement-surface",
        reason: "Reframed scope",
      },
      binding,
    )) as Record<string, unknown>;
    assert.equal(superseded.outcome, "applied", JSON.stringify(superseded));
    assert.equal(typeof superseded.replacementTaskId, "string");
    rebuildTaskProjection({ rootDir });
    assert.equal(
      readTaskProjection({ rootDir }).rows.find(
        (row) => row.taskId === "task_source",
      )?.packageDisposition,
      "archived",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a lapsed lease stays readable through task show and releasable through task release", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-lease-exit-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  let clock = "2026-08-15T02:00:00.000Z";
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-lease-exit"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-lease-exit",
      now: () => clock,
    });
    const holder = {
      actor: {
        principal: { personId: "person-surface" },
        executor: { kind: "agent" as const, id: "executor-departed" },
      },
      source: "local" as const,
    };
    const reclaimer = {
      actor: {
        principal: { personId: "person-surface" },
        executor: { kind: "agent" as const, id: "executor-reclaimer" },
      },
      source: "local" as const,
    };
    assert.equal(
      (
        await cell.run(
          { kind: "task-create", taskId: "task_lease", title: "Lease exit" },
          holder,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-start",
            taskId: "task_lease",
            executionId: "exe_lapse",
            ttlMs: 60_000,
          },
          holder,
        )
      ).outcome,
      "applied",
    );
    const held = String(
      (
        (await cell.run(
          { kind: "task-show", taskId: "task_lease" },
          reclaimer,
        )) as Record<string, unknown>
      ).summary,
    );
    assert.match(held, /\nlease: [^\n]*phase=held/u, held);
    assert.match(
      held,
      /\nlease: [^\n]*expiresAt=2026-08-15T02:01:00\.000Z/u,
      held,
    );
    const earlyReclaim = await cell.run(
      {
        kind: "task-release",
        taskId: "task_lease",
        reason: "Holder is still active",
      },
      reclaimer,
    );
    assert.equal(
      earlyReclaim.outcome,
      "op_rejected",
      JSON.stringify(earlyReclaim),
    );
    assert.equal(
      (earlyReclaim as Record<string, unknown>).code,
      "lease_conflict",
      JSON.stringify(earlyReclaim),
    );
    clock = "2026-08-15T03:00:00.000Z";
    const summary = String(
      (
        (await cell.run(
          { kind: "task-show", taskId: "task_lease" },
          reclaimer,
        )) as Record<string, unknown>
      ).summary,
    );
    assert.match(
      summary,
      /\nlease: [^\n]*executionId=exe_lapse[^\n]*phase=orphaned/u,
      summary,
    );
    assert.match(
      summary,
      /\nlease: [^\n]*expiresAt=2026-08-15T02:01:00\.000Z/u,
      summary,
    );
    assert.match(summary, /\ntask: [^\n]*status=active[^\n]*/u, summary);
    assert.match(summary, /executions:\n[^\n]*\texe_lapse\t/u, summary);
    // The reporter's bite: the failed append must say when the lease lapsed and name the round to re-enter.
    const bite = (await cell.run(
      {
        kind: "task-progress-append",
        taskId: "task_lease",
        text: "Append after the lease lapsed",
        evidence: [],
      },
      reclaimer,
    )) as Record<string, unknown>;
    assert.equal(bite.outcome, "op_rejected", JSON.stringify(bite));
    assert.equal(bite.code, "progress_lease_required", JSON.stringify(bite));
    assert.match(
      String(bite.nextAction),
      /lapsed at 2026-08-15T02:01:00\.000Z/u,
      JSON.stringify(bite),
    );
    assert.match(
      String(bite.nextAction),
      /ha task release task_lease, then re-enter the round with ha task start task_lease --execution-id exe_lapse/u,
      JSON.stringify(bite),
    );
    const outsider = {
      actor: {
        principal: { personId: "person-outsider" },
        executor: { kind: "agent" as const, id: "executor-outsider" },
      },
      source: "local" as const,
    };
    const crossPrincipal = await cell.run(
      {
        kind: "task-release",
        taskId: "task_lease",
        reason: "Different principal",
      },
      outsider,
    );
    assert.equal(
      crossPrincipal.outcome,
      "op_rejected",
      JSON.stringify(crossPrincipal),
    );
    assert.equal(
      (crossPrincipal as Record<string, unknown>).code,
      "lease_conflict",
      JSON.stringify(crossPrincipal),
    );
    const released = await cell.run(
      {
        kind: "task-release",
        taskId: "task_lease",
        reason: "The holder never came back",
      },
      reclaimer,
    );
    assert.equal(released.outcome, "applied", JSON.stringify(released));
    assert.equal(
      evidence(
        await cell.run({ kind: "task-show", taskId: "task_lease" }, reclaimer),
      ).lease,
      null,
    );
    // The recovery the error prescribes must actually work: same execution re-leases the round, then the append lands.
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-start",
            taskId: "task_lease",
            executionId: "exe_lapse",
            ttlMs: 60_000,
          },
          reclaimer,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-progress-append",
            taskId: "task_lease",
            text: "Re-entered after the lapse",
            evidence: [],
          },
          reclaimer,
        )
      ).outcome,
      "applied",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a released round is re-enterable by its own execution and still refuses a second one", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-round-reenter-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-round-reenter"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-round-reenter",
      now: () => "2026-08-15T02:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-create",
            taskId: "task_round",
            title: "Round re-entry",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-start",
            taskId: "task_round",
            executionId: "exe_round",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-release",
            taskId: "task_round",
            reason: "Holder handed the round back",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    // Release ends the lease but not the round: the execution is still active, so a *second* execution stays refused.
    const second = await cell.run(
      { kind: "task-start", taskId: "task_round", executionId: "exe_second" },
      binding,
    );
    assert.equal(second.outcome, "op_rejected", JSON.stringify(second));
    assert.equal(second.code, "invalid_transition");
    // The adjudicated exit: the same execution re-leases the round it never finished.
    const rejoined = await cell.run(
      { kind: "task-start", taskId: "task_round", executionId: "exe_round" },
      binding,
    );
    assert.equal(rejoined.outcome, "applied", JSON.stringify(rejoined));
    const shown = evidence(
      await cell.run({ kind: "task-show", taskId: "task_round" }, binding),
    );
    assert.deepEqual(
      (
        shown.executions as readonly {
          readonly executionId: string;
          readonly state: string;
        }[]
      ).map((row) => `${row.executionId}/${row.state}`),
      ["exe_round/active"],
    );
    assert.equal(
      (shown.lease as { readonly executionId: string } | null)?.executionId,
      "exe_round",
    );
    // Re-entry must not require the caller to remember the id. Omitting it used to derive a fresh one,
    // which the round then refused — the reported dead end, reachable with no execution id at all.
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-release",
            taskId: "task_round",
            reason: "Handed back again",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const blind = await cell.run(
      { kind: "task-start", taskId: "task_round" },
      binding,
    );
    assert.equal(blind.outcome, "applied", JSON.stringify(blind));
    assert.equal(
      (
        evidence(
          await cell.run({ kind: "task-show", taskId: "task_round" }, binding),
        ).lease as { readonly executionId: string } | null
      )?.executionId,
      "exe_round",
    );
    // Replay is the real contract: a cold rebuild from the event log must not grow a duplicate execution.
    await cell.close();
    cell = undefined;
    const store = makeTaskEventStore({ repoId: "task-round-reenter", rootDir }),
      replay = makeTaskProjection({ rootDir, eventStore: store });
    replay.close();
    rmSync(replay.path, { force: true });
    replay.rebuild();
    assert.deepEqual(
      replay
        .read("task_round")
        .snapshot.executions.map((row) => `${row.executionId}/${row.state}`),
      ["exe_round/active"],
    );
    replay.close();
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("read commands report projection readiness instead of asserting canonical visibility", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-readiness-"));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId("task-readiness"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "task-readiness",
      now: () => "2026-08-15T02:00:00.000Z",
    });
    const binding = { actor, source: "local" as const };
    assert.equal(
      (
        await cell.run(
          { kind: "task-create", taskId: "task_ready", title: "Readiness" },
          binding,
        )
      ).outcome,
      "applied",
    );
    const listed = await cell.run({ kind: "task-list" }, binding),
      payload = evidence(listed);
    assert.equal(listed.outcome, "applied");
    // A caught-up read now says so in its own payload, so "count=0" can never again be mistaken for an empty ledger.
    assert.equal(payload.status, "ready");
    assert.equal(payload.watermark, payload.sourceRevision);
    assert.equal(listed.proof?.canonicalVisible, true);
    assert.equal(listed.proof?.appliedCut, payload.watermark);
    assert.match(
      String((listed as Record<string, unknown>).summary),
      /status=ready/u,
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
