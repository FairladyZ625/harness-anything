// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { makeTaskEventReader } from "../../kernel/src/index.ts";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { canonicalRoot, workspaceId, type DaemonAgendaResult } from "../src/protocol/daemon-protocol.contract.ts";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-submit-ci-bin-"));
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

const actor = { principal: { personId: "person-agenda" }, executor: { kind: "agent", id: "codex-sol" } } as const;
const binding = { actor, source: "local" as const };

function writeReviewReport(rootDir: string, packagePath: string, reviewId: string): void {
  const stem = reviewId.startsWith("review-") ? reviewId.slice("review-".length) : reviewId,
    report = path.join(rootDir, "harness", packagePath, "artifacts", "reports", `${stem}.md`);
  mkdirSync(path.dirname(report), { recursive: true });
  writeFileSync(report, `# Review ${reviewId}\n\nPhysical review findings.\n`);
}

test("agenda projects an empty ledger without synthetic state", async () => {
  await withCell("agenda-empty", async (cell) => {
    const agenda = await cell.read("repo.agenda.read");
    assert.deepEqual(
      {
        inFlight: agenda.inFlight,
        awaitingDecision: agenda.awaitingDecision,
        waitingOnOthers: agenda.waitingOnOthers,
        dispatchable: agenda.dispatchable,
      },
      { inFlight: [], awaitingDecision: [], waitingOnOthers: [], dispatchable: [] },
    );
    assert.match(agenda.summary, /在飞线 \(0\)[\s\S]*待裁 \(0\)[\s\S]*球在别人手里 \(0\)[\s\S]*可派队列 \(0\)/u);
  });
});

test("agenda and task list keep a pinned submitted task visible for owner adjudication", async () => {
  await withCell("agenda-submitted", async (cell, rootDir) => {
    const taskId = "task_submitted_pinned",
      executionId = "exe_submitted_pinned",
      created = await cell.run({ kind: "task-create", taskId, title: "Submitted pinned" }, binding);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "entity-pin", entityRef: `task/${taskId}` }, binding)).outcome, "applied");
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      `# Closeout\n\n## Summary\n\nSubmitted agenda fixture ${git(rootDir, "rev-parse", "fixture-delivery")} is ready.\n\n## Verification\n\nIntegration assertions cover submitted visibility.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nTask list and agenda share the lifecycle projection.\n`,
    );
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");

    const agenda = await cell.read("repo.agenda.read", { limit: 50 }),
      submitted = await cell.read("repo.tasks.list", { status: "submitted" });
    assert.equal(
      agenda.pinnedEntities.some(({ ref }) => ref === `task/${taskId}`),
      true,
    );
    assert.equal(
      agenda.awaitingDecision.some(
        (row) => row.kind === "execution" && row.taskId === taskId && row.executionId === executionId && row.pinned,
      ),
      true,
    );
    assert.deepEqual(
      submitted.rows.map((row) => row.taskId),
      [taskId],
    );
  });
});

test("agenda derives all four groups, pins first, and rejects a missing task pin", async () => {
  await withCell("agenda-four-groups", async (cell, rootDir) => {
    const createdTasks = new Map<string, string>();
    for (const [taskId, title] of [
      ["task_active", "Active pinned"],
      ["task_dispatch", "Dispatch"],
      ["task_dispatch_pinned", "Dispatch pinned"],
      ["task_blocked", "Explicitly blocked"],
      ["task_wait", "Waits on dependency"],
      ["task_dependency", "Dependency"],
      ["task_review", "Review pending"],
    ] as const) {
      const created = await cell.run({ kind: "task-create", taskId, title }, binding);
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(cell, created.opId, binding);
      createdTasks.set(taskId, String((created as Record<string, unknown>).packagePath));
    }
    for (const taskId of ["task_active", "task_review"])
      await realizeTaskPlanFixture(rootDir, createdTasks.get(taskId)!, (planPath) =>
        cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_active", executionId: "exe_active" }, binding)).outcome,
      "applied",
    );
    const activePin = await cell.run({ kind: "entity-pin", entityRef: "task/task_active" }, binding);
    assert.equal(activePin.outcome, "applied", JSON.stringify(activePin));
    assert.equal(
      (await cell.run({ kind: "entity-pin", entityRef: "task/task_dispatch_pinned" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          { kind: "task-transition", taskId: "task_blocked", status: "blocked", reason: "Waiting on another team" },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "relation-relate",
            sourceRef: "task/task_wait",
            targetRef: "task/task_dependency",
            relationType: "depends-on",
            rationale: "Dependency must finish first",
            expectedVersion: 0,
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_review", executionId: "exe_review" }, binding)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "harness", createdTasks.get("task_review")!, "closeout.md"),
      `# Closeout\n\n## Summary\n\nAgenda fixture delivery ${git(rootDir, "rev-parse", "fixture-delivery")} is ready.\n\n## Verification\n\nIntegration assertions exercise agenda grouping and review visibility.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nTask lifecycle projections share the review cut.\n`,
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-submit",
            taskId: "task_review",
            executionId: "exe_review",
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
            kind: "task-adjudicate",
            taskId: "task_review",
            executionId: "exe_review",
            forward: true,
            reason: "Forward agenda review cut.",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const proposed = await cell.run(decisionProposal(), binding);
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));

    const missing = await cell.run({ kind: "entity-pin", entityRef: "task/task_missing" }, binding);
    assert.deepEqual(
      { outcome: missing.outcome, code: missing.code },
      { outcome: "op_rejected", code: "entity_not_found" },
    );

    const agenda = await cell.read("repo.agenda.read", { limit: 50 });
    assert.deepEqual(
      agenda.inFlight.map(({ taskId }) => taskId),
      ["task_active"],
    );
    assert.equal(agenda.inFlight[0]?.pinned, true);
    assert.equal(agenda.inFlight[0]?.leaseExecutionId, "exe_active");
    assert.equal(
      agenda.awaitingDecision.some((row) => row.kind === "execution" && row.executionId === "exe_review"),
      true,
    );
    assert.equal(
      agenda.awaitingDecision.some((row) => row.kind === "decision"),
      true,
    );
    assert.equal(
      agenda.waitingOnOthers.some(({ taskId }) => taskId === "task_blocked"),
      true,
    );
    assert.deepEqual(
      agenda.waitingOnOthers
        .find(({ taskId }) => taskId === "task_wait")
        ?.blockingAssessment.blockers.map(({ targetTaskId }) => targetTaskId),
      ["task_dependency"],
    );
    assert.equal(agenda.dispatchable[0]?.taskId, "task_dispatch_pinned");
    assert.equal(agenda.dispatchable[0]?.pinned, true);
    assert.equal(
      agenda.dispatchable.some(({ taskId }) => taskId === "task_wait"),
      false,
    );
    assert.match(agenda.summary, /📌 task_active[\s\S]*待裁[\s\S]*球在别人手里[\s\S]*📌 task_dispatch_pinned/u);
    const reviewerBinding = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-agenda-reviewer" },
          executor: { kind: "agent" as const, id: "agenda-reviewer" },
        },
        source: "local" as const,
      },
      "arbiter",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "dismissed", reason: "Superseded opinion.", evidenceChecked: ["agenda"] }),
    );
    writeReviewReport(rootDir, createdTasks.get("task_review")!, "review-dismissed");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId: "task_review",
            executionId: "exe_review",
            reviewId: "review-dismissed",
            fromFile: "review.json",
          },
          reviewerBinding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.read("repo.agenda.read", { limit: 50 })).awaitingDecision.some(
        (row) => row.kind === "execution" && row.executionId === "exe_review",
      ),
      true,
      "dismissed history must not remove the execution from review work",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "approved", reason: "Current opinion.", evidenceChecked: ["agenda"] }),
    );
    writeReviewReport(rootDir, createdTasks.get("task_review")!, "review-approved");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId: "task_review",
            executionId: "exe_review",
            reviewId: "review-approved",
            fromFile: "review.json",
          },
          reviewerBinding,
        )
      ).outcome,
      "applied",
    );
    assert.equal(
      (await cell.read("repo.agenda.read", { limit: 50 })).awaitingDecision.some(
        (row) => row.kind === "execution" && row.executionId === "exe_review",
      ),
      false,
      "an approved current-cut Review resolves review work even when dismissed history remains",
    );
    const contract = JSON.parse(
      readFileSync(path.join(rootDir, "harness/tasks/task_active-active-pinned/task-contract.json"), "utf8"),
    ) as { pinned?: boolean };
    assert.equal(contract.pinned, undefined, "Entity Pin does not rewrite the Task authored document");

    let page: DaemonAgendaResult = await cell.read("repo.agenda.read", { limit: 1 });
    const dispatchable = [...page.dispatchable];
    assert.equal(
      page.dispatchable[0]?.taskId,
      "task_dispatch_pinned",
      "a pinned task must lead the first planned source page",
    );
    while (page.page.nextCursor) {
      page = await cell.read("repo.agenda.read", { limit: 1, cursor: page.page.nextCursor });
      dispatchable.push(...page.dispatchable);
    }
    assert.equal(
      new Set(dispatchable.map(({ taskId }) => taskId)).has("task_dispatch"),
      true,
      "the composite cursor must eventually expose unpinned dispatchable tasks",
    );
  });
});

test("agenda surfaces a changes_requested task in the rework group and nowhere else", async () => {
  await withCell("agenda-rework", async (cell, rootDir) => {
    const created = await cell.run(
      { kind: "task-create", taskId: "task_rework", title: "Returned for rework" },
      binding,
    );
    assert.equal(created.outcome, "applied");
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_rework", executionId: "exe_rework" }, binding)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      `# Closeout\n\n## Summary\n\nRework fixture delivery ${git(rootDir, "rev-parse", "fixture-delivery")} is ready.\n\n## Verification\n\nIntegration assertions exercise agenda rework grouping.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nTask lifecycle projections share the review cut.\n`,
    );
    assert.equal(
      (await cell.run({ kind: "task-submit", taskId: "task_rework", executionId: "exe_rework" }, binding)).outcome,
      "applied",
    );
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-adjudicate",
            taskId: "task_rework",
            executionId: "exe_rework",
            forward: true,
            reason: "Forward agenda rework cut.",
          },
          binding,
        )
      ).outcome,
      "applied",
    );
    const reviewerBinding = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-agenda-reviewer" },
          executor: { kind: "agent" as const, id: "agenda-reviewer" },
        },
        source: "local" as const,
      },
      "arbiter",
    );
    writeFileSync(
      path.join(rootDir, "review.json"),
      JSON.stringify({ verdict: "changes_requested", reason: "Needs another pass.", evidenceChecked: ["agenda"] }),
    );
    writeReviewReport(rootDir, packagePath, "review-rework");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-review-execution",
            taskId: "task_rework",
            executionId: "exe_rework",
            reviewId: "review-rework",
            fromFile: "review.json",
          },
          reviewerBinding,
        )
      ).outcome,
      "applied",
    );
    const returned = await cell.run(
      {
        kind: "task-adjudicate",
        taskId: "task_rework",
        executionId: "exe_rework",
        return: true,
        reviewId: "review-rework",
        reason: "Return agenda cut for rework.",
      },
      binding,
    );
    assert.equal(returned.outcome, "applied");
    await waitForFixturePublication(cell, returned.opId, binding);
    const returnedSnapshot = JSON.parse(
      String((await cell.run({ kind: "task-show", taskId: "task_rework" }, binding)).evidence),
    ) as {
      readonly task: { readonly status: string };
      readonly executions: readonly { readonly state: string }[];
    };
    assert.equal(returnedSnapshot.task.status, "active");
    assert.equal(returnedSnapshot.executions.at(-1)?.state, "changes_requested");

    const agenda = await cell.read("repo.agenda.read", { limit: 50 });
    // The returned task sits in exactly one group — the one this change adds.
    assert.deepEqual(
      (agenda.awaitingRework ?? []).map(({ taskId }) => taskId),
      ["task_rework"],
    );
    for (const group of [agenda.inFlight, agenda.waitingOnOthers, agenda.dispatchable])
      assert.equal(
        group.some(({ taskId }) => taskId === "task_rework"),
        false,
      );
    assert.equal(
      agenda.awaitingDecision.some((row) => row.kind === "execution" && row.taskId === "task_rework"),
      false,
    );
    assert.match(agenda.summary, /等我修 \(1\) — status=active 且最新 execution=changes_requested[\s\S]*task_rework/u);

    // Starting a fresh execution moves it back to the in-flight line.
    assert.equal(
      (await cell.run({ kind: "task-start", taskId: "task_rework", executionId: "exe_rework_2" }, binding)).outcome,
      "applied",
    );
    const restarted = await cell.read("repo.agenda.read", { limit: 50 });
    assert.equal(
      (restarted.awaitingRework ?? []).some(({ taskId }) => taskId === "task_rework"),
      false,
    );
    assert.equal(
      restarted.inFlight.some(({ taskId }) => taskId === "task_rework"),
      true,
    );
  });
});

test("agenda excludes archived rework tasks without consuming a page", async () => {
  await withCell("agenda-archived-rework", async (cell, rootDir) => {
    const reviewerBinding = withRoleBinding(
      {
        actor: {
          principal: { personId: "person-agenda-reviewer" },
          executor: { kind: "agent" as const, id: "agenda-reviewer" },
        },
        source: "local" as const,
      },
      "arbiter",
    );
    const createChangesRequestedTask = async (taskId: string) => {
      const created = await cell.run({ kind: "task-create", taskId, title: taskId }, binding);
      assert.equal(created.outcome, "applied");
      await waitForFixturePublication(cell, created.opId, binding);
      const packagePath = String((created as Record<string, unknown>).packagePath);
      await realizeTaskPlanFixture(rootDir, packagePath, (planPath) =>
        cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      assert.equal(
        (await cell.run({ kind: "task-start", taskId, executionId: `exe_${taskId}` }, binding)).outcome,
        "applied",
      );
      writeFileSync(
        path.join(rootDir, "harness", packagePath, "closeout.md"),
        `# Closeout\n\n## Summary\n\nAgenda fixture delivery ${git(rootDir, "rev-parse", "fixture-delivery")} is ready.\n\n## Verification\n\nIntegration assertions exercise agenda grouping.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nTask lifecycle projections share the review cut.\n`,
      );
      assert.equal(
        (await cell.run({ kind: "task-submit", taskId, executionId: `exe_${taskId}` }, binding)).outcome,
        "applied",
      );
      assert.equal(
        (
          await cell.run(
            {
              kind: "task-adjudicate",
              taskId,
              executionId: `exe_${taskId}`,
              forward: true,
              reason: "Forward archived agenda cut.",
            },
            binding,
          )
        ).outcome,
        "applied",
      );
      writeFileSync(
        path.join(rootDir, "review.json"),
        JSON.stringify({ verdict: "changes_requested", reason: "Needs another pass.", evidenceChecked: ["agenda"] }),
      );
      writeReviewReport(rootDir, packagePath, `review_${taskId}`);
      assert.equal(
        (
          await cell.run(
            {
              kind: "task-review-execution",
              taskId,
              executionId: `exe_${taskId}`,
              reviewId: `review_${taskId}`,
              fromFile: "review.json",
            },
            reviewerBinding,
          )
        ).outcome,
        "applied",
      );
      const returned = await cell.run(
        {
          kind: "task-adjudicate",
          taskId,
          executionId: `exe_${taskId}`,
          return: true,
          reviewId: `review_${taskId}`,
          reason: "Return archived agenda cut for rework.",
        },
        binding,
      );
      assert.equal(returned.outcome, "applied");
      await waitForFixturePublication(cell, returned.opId, binding);
    };

    await createChangesRequestedTask("task_000_archived_rework");
    await createChangesRequestedTask("task_zzz_active_rework");
    assert.equal(
      (
        await cell.run(
          {
            kind: "task-archive",
            taskId: "task_000_archived_rework",
            reason: "Replacement task owns the remaining work.",
          },
          binding,
        )
      ).outcome,
      "applied",
    );

    const agenda = await cell.read("repo.agenda.read", { limit: 1 });
    assert.deepEqual(
      (agenda.awaitingRework ?? []).map(({ taskId }) => taskId),
      ["task_zzz_active_rework"],
      "an archived row must not consume the source page before active rework",
    );
    for (const group of [agenda.inFlight, agenda.waitingOnOthers, agenda.dispatchable])
      assert.equal(
        group.some(({ taskId }) => taskId === "task_000_archived_rework"),
        false,
      );
    assert.equal(
      agenda.awaitingDecision.some((row) => row.kind === "execution" && row.taskId === "task_000_archived_rework"),
      false,
    );
    assert.match(agenda.summary, /等我修 \(1\)[\s\S]*task_zzz_active_rework/u);
    assert.doesNotMatch(agenda.summary, /task_000_archived_rework/u);
  });
});

test("agenda projects an all-blocked ledger only into the waiting group", async () => {
  await withCell("agenda-all-blocked", async (cell) => {
    for (const taskId of ["task_blocked_a", "task_blocked_b"] as const) {
      await cell.run({ kind: "task-create", taskId, title: taskId }, binding);
      await cell.run({ kind: "task-transition", taskId, status: "blocked", reason: "External wait" }, binding);
    }
    const agenda = await cell.read("repo.agenda.read");
    assert.deepEqual(
      agenda.waitingOnOthers.map(({ taskId }) => taskId),
      ["task_blocked_a", "task_blocked_b"],
    );
    assert.deepEqual(
      { inFlight: agenda.inFlight, awaitingDecision: agenda.awaitingDecision, dispatchable: agenda.dispatchable },
      { inFlight: [], awaitingDecision: [], dispatchable: [] },
    );
  });
});

test("task pin and unpin route through entity pin events and update agenda order", async () => {
  await withCell("agenda-pin-command", async (cell, rootDir) => {
    for (const taskId of ["task_a", "task_z"] as const)
      assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
    const runCli = (argv: readonly string[]) => {
      const parsed = parseThinCommand(argv);
      assert.equal(parsed.ok, true, argv.join(" "));
      if (!parsed.ok) throw new Error(parsed.nextAction);
      return cell.run(parsed.command.action as Parameters<typeof cell.run>[0], binding);
    };
    const eventFor = async (opId: string) => {
        await cell.settlePendingMaterialization("agenda event assertion");
        return makeTaskEventReader({ repoId: "agenda-pin-command", rootDir }).readEvent(opId);
      },
      pin = await runCli(["task", "pin", "task_z"]);
    assert.equal(pin.outcome, "applied", JSON.stringify(pin));
    const pinEvent = await eventFor(pin.opId);
    assert.equal(pinEvent?.schema, "entity-pin-event/v1");
    assert.equal(pinEvent?.type, "entity_pinned");
    assert.deepEqual(
      (await cell.read("repo.agenda.read")).dispatchable.map(({ taskId }) => taskId),
      ["task_z", "task_a"],
    );

    const unpin = await runCli(["task", "unpin", "task_z"]);
    assert.equal(unpin.outcome, "applied", JSON.stringify(unpin));
    assert.equal((await eventFor(unpin.opId))?.type, "entity_unpinned");
    const shown = await runCli(["task", "show", "task_z"]);
    assert.match(String(shown.evidence), /"pinned":false/u);
    assert.deepEqual(
      (await cell.read("repo.agenda.read")).dispatchable.map(({ taskId }) => taskId),
      ["task_a", "task_z"],
    );

    const amend = await runCli(["task", "amend", "task_z", "--set", "pinned:true"]);
    assert.equal(amend.outcome, "op_rejected", JSON.stringify(amend));
    assert.equal((await runCli(["task", "pin", "task_z"])).outcome, "applied");
    assert.equal((await cell.run({ kind: "projection-rebuild" }, binding)).outcome, "applied");
    assert.equal(
      (await cell.read("repo.agenda.read")).pinnedEntities.some(({ ref }) => ref === "task/task_z"),
      true,
    );
  });
});

test("entity pins cover task, decision, and schedule with bounded rendering and ordered idempotency", async () => {
  await withCell(
    "agenda-entity-pins",
    async (cell) => {
      const task = await cell.run({ kind: "task-create", taskId: "task_pin", title: "Pinned task" }, binding);
      assert.equal(task.outcome, "applied");
      assert.deepEqual(
        task.guidance?.find(({ kind }) => kind === "pin-agenda"),
        {
          kind: "pin-agenda",
          args: { entityKind: "task", entityId: "task_pin" },
          when: { dryRun: false },
        },
      );
      assert.equal(
        (await cell.run({ kind: "task-create", taskId: "task_capacity", title: "Capacity task" }, binding)).outcome,
        "applied",
      );
      const decision = (await cell.run(decisionProposal(), binding)) as Record<string, unknown>;
      assert.equal(decision.outcome, "applied", JSON.stringify(decision));
      const decisionId = String((JSON.parse(String(decision.evidence)) as { decisionId: string }).decisionId);
      assert.deepEqual(
        (decision.guidance as { kind: string; args: unknown }[]).find(({ kind }) => kind === "pin-agenda"),
        { kind: "pin-agenda", args: { entityKind: "decision", entityId: decisionId } },
      );
      assert.equal(
        (
          await cell.run(
            {
              kind: "schedule-create",
              scheduleId: "nightly-reckoning",
              name: "Nightly reckoning",
              mode: "detect",
              everyMs: 300_000,
              agentId: "probe-agent",
              runtimeInstanceId: "runtime-local",
              mission: "Run nightly reckoning.",
              idempotencyKey: "agenda-pin:schedule",
            },
            binding,
          )
        ).outcome,
        "applied",
      );
      let capacityGuidance: unknown;
      for (const entityRef of ["task/task_pin", `decision/${decisionId}`, "schedule/nightly-reckoning"]) {
        const receipt = await cell.run({ kind: "entity-pin", entityRef }, binding);
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        capacityGuidance = receipt.guidance;
      }
      assert.deepEqual(capacityGuidance, [{ kind: "pin-agenda", args: { used: 3, limit: 3 } }]);
      const atCapacity = await cell.run({ kind: "entity-pin", entityRef: "task/task_capacity" }, binding);
      assert.deepEqual(
        { outcome: atCapacity.outcome, code: atCapacity.code },
        { outcome: "op_rejected", code: "pin_capacity_exceeded" },
      );
      assert.match(String(atCapacity.rejectionExplanation), /3\/3.*unpin/u);
      assert.equal((await cell.run({ kind: "entity-pin", entityRef: "task/task_pin" }, binding)).outcome, "no_changes");
      const agenda = await cell.read("repo.agenda.read");
      assert.deepEqual(
        new Set(agenda.pinnedEntities.map(({ ref }) => ref)),
        new Set(["task/task_pin", `decision/${decisionId}`, "schedule/nightly-reckoning"]),
      );
      for (const label of ["Task", "Decision", "Schedule"])
        assert.match(agenda.summary, new RegExp(`📌 \\[${label}\\]`, "u"));
      const rejected = await cell.run(
        { kind: "decision-reject", decisionId, reason: "The proposed outcome is no longer needed." },
        withRoleBinding(
          { actor: { principal: { personId: "person-independent" }, executor: null }, source: "local" },
          "arbiter",
        ),
      );
      assert.equal(rejected.outcome, "applied", JSON.stringify(rejected));
      assert.equal(
        (await cell.read("repo.agenda.read")).pinnedEntities.some(({ ref }) => ref === `decision/${decisionId}`),
        false,
      );
      assert.equal(
        (await cell.run({ kind: "entity-pin", entityRef: "task/task_capacity" }, binding)).outcome,
        "applied",
      );
      const deleted = await cell.run(
        {
          kind: "schedule-delete",
          scheduleId: "nightly-reckoning",
          reason: "The replacement schedule owns this work.",
          idempotencyKey: "agenda-pin:schedule-delete",
        },
        binding,
      );
      assert.equal(deleted.outcome, "applied", JSON.stringify(deleted));
      assert.equal(
        (await cell.read("repo.agenda.read")).pinnedEntities.some(({ ref }) => ref === "schedule/nightly-reckoning"),
        false,
      );
    },
    (rootDir) => {
      const settingsPath = path.join(rootDir, "harness/harness.yaml");
      mkdirSync(path.dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n" +
          "settings:\n  agenda:\n    pinLimit: 3\n",
      );
    },
  );
});

test("agenda pin listing follows the requested limit", async () => {
  await withCell("agenda-pin-list-limit", async (cell) => {
    for (let index = 0; index < 12; index += 1) {
      const taskId = `task_pin_${String(index).padStart(2, "0")}`;
      assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
      assert.equal((await cell.run({ kind: "entity-pin", entityRef: `task/${taskId}` }, binding)).outcome, "applied");
    }
    const complete = await cell.read("repo.agenda.read", { limit: 12 });
    assert.equal(complete.pinnedEntities.length, 12);
    assert.equal(complete.pinnedEntityOverflow, 0);
    const bounded = await cell.read("repo.agenda.read", { limit: 10 });
    assert.equal(bounded.pinnedEntities.length, 10);
    assert.equal(bounded.pinnedEntityOverflow, 2);
  });
});

test("terminal task transitions clear pins without changing unpinned task outcomes", async () => {
  await withCell("agenda-terminal-pin", async (cell) => {
    for (const taskId of ["task_pinned", "task_plain"] as const)
      assert.equal((await cell.run({ kind: "task-create", taskId, title: taskId }, binding)).outcome, "applied");
    assert.equal((await cell.run({ kind: "entity-pin", entityRef: "task/task_pinned" }, binding)).outcome, "applied");

    const cancel = (taskId: "task_pinned" | "task_plain") =>
      cell.run(
        { kind: "task-transition", taskId, status: "cancelled", reason: "Terminal pin fixture", force: true },
        binding,
      );
    const pinned = await cancel("task_pinned"),
      plain = await cancel("task_plain");
    assert.equal(pinned.outcome, "applied", JSON.stringify(pinned));
    assert.equal(plain.outcome, "applied", JSON.stringify(plain));
    assert.deepEqual(
      (await cell.read("repo.tasks.list")).rows
        .map(({ taskId, snapshot }) => ({ taskId, status: snapshot.task?.status, pinned: snapshot.task?.pinned }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId)),
      [
        { taskId: "task_pinned", status: "cancelled", pinned: false },
        { taskId: "task_plain", status: "cancelled", pinned: false },
      ],
    );
  });
});

async function withCell(
  name: string,
  run: (cell: Awaited<ReturnType<typeof openRepoCell>>, rootDir: string) => Promise<void>,
  prepare?: (rootDir: string) => void,
): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), `${name}-`));
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(rootDir);
    prepare?.(rootDir);
    cell = await openRepoCell({
      repoId: workspaceId(name),
      rootDir: canonicalRoot(rootDir),
      ownerId: name,
      now: () => "2026-08-21T12:00:00.000Z",
    });
    await run(cell, rootDir);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}
function decisionProposal() {
  return {
    kind: "decision-propose",
    jsonInput: JSON.stringify({
      title: "Choose agenda behavior",
      question: "Should this proposal appear in the agenda?",
      riskTier: "medium",
      urgency: "high",
      vertical: "default",
      preset: "default",
      decisionClass: "ordinary",
      appliesTo: { modules: ["daemon"], productLines: [] },
      chosen: [{ id: "CH1", text: "Project it" }],
      rejected: [{ id: "RJ1", text: "Hide it", whyNot: "It needs review" }],
      claims: [],
      fulfillments: [],
    }),
  } as const;
}
function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Agenda Test");
  git(rootDir, "config", "user.email", "agenda@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
  writeFileSync(path.join(rootDir, "README.md"), "# Agenda fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-qm", "fixture delivery");
  git(rootDir, "tag", "fixture-delivery");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
