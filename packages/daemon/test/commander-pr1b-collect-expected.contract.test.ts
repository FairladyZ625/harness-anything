// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import {
  compileInboxCompletedEvent,
  compileInboxEnqueuedEvent,
} from "@harness-anything/kernel/internal/domain/agent-runtime-event.ts";
import { canonicalEventWritePlan, makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { steerRuntime } from "../src/daemon-host/runtime-spawn-control.ts";
import type { RuntimeSpawnerContext } from "../src/daemon-host/runtime-spawn-context.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import {
  acceptedWorkDecision,
  openBootstrappedRepoCell as openRepoCell,
  waitForFixturePublication,
} from "./repo-settings.fixture.ts";
import { evidence } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}

function initGitRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Commander PR1B Hardening");
  git(root, "config", "user.email", "commander-pr1b@example.invalid");
  writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "base");
}

function makeAgyDefinition(instanceId: string): AgentDefinitionSnapshot {
  return {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId,
    installationId: "installation-agy",
    kindId: "agy",
    providerId: "google",
    model: "gemini-4-neon",
    reasoningEffort: "high",
    endpointKind: "official",
    baseUrlHash: null,
    authMode: "subscription",
  };
}

async function createTask(
  cell: Awaited<ReturnType<typeof openRepoCell>>,
  owner: ReturnType<typeof withPolicyGroup>,
  input: {
    readonly title: string;
    readonly taskClass?: "work" | "task";
    readonly parentTaskId?: string;
    readonly decisionRef?: string;
  },
): Promise<string> {
  const res = await cell.run(
    {
      kind: "task-create",
      title: input.title,
      ...(input.taskClass ? { taskClass: input.taskClass } : {}),
      ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      ...(input.decisionRef ? { decisionRef: input.decisionRef } : {}),
    },
    owner,
  );
  assert.equal(res.outcome, "applied", JSON.stringify(res));
  await waitForFixturePublication(cell, res.opId, owner);
  const packagePath = String((res as Record<string, unknown>).packagePath);
  await realizeTaskPlanFixture(cell.status().rootDir, packagePath, async (planPath: string) => {
    const submitted = await cell.run({ kind: "doc-submit", paths: [planPath] }, owner);
    if (submitted.outcome === "applied") await waitForFixturePublication(cell, submitted.opId, owner);
    return submitted;
  });
  return String((res as Record<string, unknown>).taskId ?? (evidence(res) as { readonly taskId: string }).taskId);
}

test(
  "F-BD3A8C79: compare-and-steer validates expected on all task-target enqueue branches without local header (0 store/schedule calls on mismatch)",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1b-expected-"));
    const repoId = workspaceId("pr1b-expected");
    const actor = { principal: { personId: "person-owner" }, executor: null } as const;
    try {
      initGitRepo(root);
      let storeAppendCalls = 0;
      let scheduleCalls = 0;
      const makeCtx = (latestDispatch: Record<string, unknown> | null) =>
        ({
          input: {
            repoId,
            rootDir: canonicalRoot(root),
            now: () => "2026-11-27T03:00:00.000Z",
            schedule: () => {
              scheduleCalls += 1;
            },
          },
          processes: new Map(),
          requiredRuntimeStore: () => ({
            readHead: () => ({ revision: 10 }),
            append: () => {
              storeAppendCalls += 1;
              return { revision: 11 };
            },
          }),
          requiredRuntimeProjection: () => ({
            readTaskExists: () => true,
            read: (taskId: string) => ({
              snapshot: {
                task: { taskId, status: "active", iteration: 1, taskClass: "task", metadata: { parentTaskId: null } },
                executions: [{ executionId: "exe_real_1", iteration: 1, state: "active" }],
              },
            }),
            readLatestRuntimeDispatchesByTaskIds: () => (latestDispatch ? [latestDispatch] : []),
            readDispatchLifecycle: () => ({
              status: "ready",
              rows: latestDispatch
                ? [
                    {
                      controlLeafDispatchId: "dispatch_c10000000000000000000001",
                      attempt: { dispatchId: "dispatch_c10000000000000000000001" },
                    },
                  ]
                : [],
            }),
            readInbox: () => ({ status: "ready", items: [], nextCursor: null }),
          }),
          runtimeSpawnError: (code: string, message: string) => Object.assign(new Error(message), { code }),
        }) as unknown as RuntimeSpawnerContext;

      // Branch 1: undispatched task
      const ctxUndispatched = makeCtx(null);
      for (const expected of [
        { dispatchId: "dispatch_wrong" },
        { executionId: "exe_wrong" },
        { taskId: "task_other" },
        { taskless: true },
        { version: 0 },
      ]) {
        await assert.rejects(
          () =>
            steerRuntime(
              ctxUndispatched,
              { taskId: "task_target", mode: "queue", prompt: "must reject", expected },
              { actor, source: "local" },
            ),
          (error: unknown) => (error as { readonly code?: unknown }).code === "runtime_steer_target_changed",
          `undispatched branch must reject ${JSON.stringify(expected)}`,
        );
      }

      const canonicalDispatchId = "dispatch_c10000000000000000000001";
      const ctxCanonicalNoHeader = makeCtx({
        source: "local",
        payload: {
          dispatchId: canonicalDispatchId,
          runtimeSessionId: "runtime_c10000000000000000000001",
          taskId: "task_target",
          executionId: "exe_real_1",
          kindId: "agy",
          instanceId: "agy-main",
          agentId: "neon-worker",
          role: "worker",
          launchedPermissionMode: "bypass",
          definitionSnapshot: makeAgyDefinition("agy-main"),
        },
      });
      for (const expected of [
        { dispatchId: "dispatch_wrong" },
        { executionId: "exe_wrong" },
        { taskId: "task_other" },
        { taskless: true },
        { version: 0 },
      ]) {
        await assert.rejects(
          () =>
            steerRuntime(
              ctxCanonicalNoHeader,
              { taskId: "task_target", mode: "queue", prompt: "must reject", expected },
              { actor, source: "local" },
            ),
          (error: unknown) => (error as { readonly code?: unknown }).code === "runtime_steer_target_changed",
          `canonical-no-header branch must reject ${JSON.stringify(expected)}`,
        );
      }

      assert.equal(storeAppendCalls, 0, "mismatched expected must perform 0 store appends");
      assert.equal(scheduleCalls, 0, "mismatched expected must perform 0 schedule calls");
    } finally {
      removeTempRepository(root);
    }
  },
);

test(
  "F-C8A7209E + F-2E3A91B7: incremental collect paginates >100 inbox items without skips, surfaces older-item updates, and --wait-event wakes on task-start and inbox-enqueue",
  { timeout: 30_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-pr1b-collect-wait-"));
    const repoId = workspaceId("pr1b-collect-wait");
    const actor = { principal: { personId: "person-owner" }, executor: null } as const;
    const owner = withPolicyGroup({ actor, source: "local" as const }, "admin");
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    try {
      initGitRepo(root);
      cell = await openRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "pr1b-collect-wait-owner" });
      const decisionRef = await acceptedWorkDecision(cell, owner, "pr1b-collect-wait");
      const workId = await createTask(cell, owner, { title: "Collect Work", taskClass: "work", decisionRef });
      const parentTaskId = await createTask(cell, owner, { title: "Parent Task", parentTaskId: workId });
      const childTaskId = await createTask(cell, owner, { title: "Child Task", parentTaskId });

      // F-2E3A91B7 (1): register --wait-event FIRST with a 60s timeout (larger than test timeout),
      // then transition child planned -> active via normal task-start; immediate projection wakeup completes the wait.
      const initialCollect = evidence(await cell.run({ kind: "runtime-collect", taskId: parentTaskId }, owner)) as {
        readonly nextSince: number;
      };
      const waitForChildStart = cell.run(
        {
          kind: "runtime-collect",
          taskId: parentTaskId,
          since: initialCollect.nextSince,
          waitEvent: true,
          timeoutMs: 60_000,
        },
        owner,
      );
      const startedChild = await cell.run({ kind: "task-start", taskId: childTaskId }, owner);
      assert.equal(startedChild.outcome, "applied", JSON.stringify(startedChild));
      const wokeOnStart = await waitForChildStart;
      assert.equal(wokeOnStart.outcome, "applied", JSON.stringify(wokeOnStart));
      const startSnap = evidence(wokeOnStart) as {
        readonly nextSince: number;
        readonly children: readonly { readonly taskId: string; readonly status: string }[];
      };
      assert.equal(startSnap.children.find((c) => c.taskId === childTaskId)?.status, "active");

      // F-2E3A91B7 (2): register --wait-event FIRST with a 60s timeout, then enqueue a canonical inbox item
      // via queued steer on parentTaskId (writes inbox_item_enqueued through projection.apply, not runtime-report).
      const waitForInbox = cell.run(
        {
          kind: "runtime-collect",
          taskId: parentTaskId,
          since: startSnap.nextSince,
          waitEvent: true,
          timeoutMs: 60_000,
        },
        owner,
      );
      const enqueuedNormal = await cell.steerRuntime(
        {
          taskId: parentTaskId,
          mode: "queue",
          prompt: "Normal queued steer inbox wake event",
          idempotencyKey: "normal-inbox-wake-1",
        },
        owner,
      );
      assert.equal(enqueuedNormal.outcome, "queued", JSON.stringify(enqueuedNormal));
      const wokeOnInbox = await waitForInbox;
      assert.equal(wokeOnInbox.outcome, "applied", JSON.stringify(wokeOnInbox));
      const inboxSnap = evidence(wokeOnInbox) as {
        readonly inbox: readonly { readonly itemId: string; readonly summary: string }[];
      };
      assert.ok(inboxSnap.inbox.some((item) => item.summary.includes("Normal queued steer inbox wake event")));

      await cell.close();
      cell = undefined;

      // F-C8A7209E: seed 125 inbox items onto parentTaskId, paginate via runtime-collect without skipping #101..#125,
      // then mutate item #0 (old item) and confirm incremental collect surfaces its status update!
      const store = makeTaskEventStore({ repoId, rootDir: canonicalRoot(root) });
      const projection = makeTaskProjection({ rootDir: canonicalRoot(root), eventStore: store });
      let rev = store.readHead()?.revision ?? 0;
      const inboxId = `task:${parentTaskId}`;
      const baseSince = rev;
      for (let i = 0; i < 125; i += 1) {
        rev += 1;
        const ev = compileInboxEnqueuedEvent({
          eventId: `ev-c8-${i}`,
          workspaceRevision: rev,
          opId: `op-c8-${i}`,
          actor,
          source: "local",
          occurredAt: "2026-11-27T04:05:00.000Z",
          payload: {
            inboxId,
            itemId: `c8_item_${String(i).padStart(3, "0")}`,
            source: "runtime_report",
            sourceRef: `task/${childTaskId}/milestone`,
            sourceEpoch: rev,
            dedupeKey: `c8:${i}`,
            admission: "dispatchable",
            consumerKind: "unattended_dispatch",
            taskId: parentTaskId,
            agentId: null,
            lane: "milestone",
            summary: `Notification #${i}`,
            enqueuedAt: "2026-11-27T04:05:00.000Z",
          },
        });
        const plan = canonicalEventWritePlan(ev, "inbox", inboxId);
        store.append({ event: ev, plan, blobs: [] });
        projection.apply(ev, plan);
      }
      projection.close();
      await store.drain();

      cell = await openRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "pr1b-collect-wait-owner-2" });
      const page1 = evidence(
        await cell.run({ kind: "runtime-collect", taskId: parentTaskId, since: baseSince }, owner),
      ) as {
        readonly hasMore: boolean;
        readonly nextSince: number;
        readonly watermark: number;
        readonly inbox: readonly { readonly itemId: string; readonly revision: number; readonly status: string }[];
      };
      assert.equal(page1.inbox.length, 100);
      assert.equal(page1.hasMore, true);
      assert.equal(page1.nextSince, page1.inbox[99]!.revision);
      assert.ok(
        page1.nextSince < page1.watermark,
        "nextSince must stop at last enumerated item, not jump to watermark",
      );

      const page2 = evidence(
        await cell.run({ kind: "runtime-collect", taskId: parentTaskId, since: page1.nextSince }, owner),
      ) as {
        readonly hasMore: boolean;
        readonly nextSince: number;
        readonly watermark: number;
        readonly inbox: readonly { readonly itemId: string; readonly revision: number; readonly status: string }[];
      };
      assert.equal(page2.inbox.length, 25, "items #101..#125 must all be delivered on page 2");
      assert.equal(page2.hasMore, false);
      assert.equal(page2.nextSince, page2.watermark);
      const allIds = [...page1.inbox, ...page2.inbox].map((item) => item.itemId);
      assert.equal(new Set(allIds).size, 125);
      assert.equal(allIds[100], "c8_item_100");
      assert.equal(allIds[124], "c8_item_124");

      // Now update OLD item c8_item_000 (enqueued first!) -> incremental collect --since page2.nextSince MUST return it!
      await cell.close();
      cell = undefined;
      const store2 = makeTaskEventStore({ repoId, rootDir: canonicalRoot(root) });
      const proj2 = makeTaskProjection({ rootDir: canonicalRoot(root), eventStore: store2 });
      const claimedRev = (store2.readHead()?.revision ?? 0) + 1;
      const claimEv = {
        schema: "agent-runtime-event/v1" as const,
        type: "inbox_item_claimed" as const,
        eventId: "ev-c8-claim-0",
        workspaceRevision: claimedRev,
        opId: "op-c8-claim-0",
        actor,
        source: "local" as const,
        occurredAt: "2026-11-27T04:10:00.000Z",
        payload: {
          inboxId,
          itemId: "c8_item_000",
          claimId: "claim_c8_0",
          claimedAt: "2026-11-27T04:10:00.000Z",
          leaseUntil: "2026-11-27T05:10:00.000Z",
        },
      };
      const claimPlan = canonicalEventWritePlan(claimEv, "inbox", inboxId);
      store2.append({ event: claimEv, plan: claimPlan, blobs: [] });
      proj2.apply(claimEv, claimPlan);
      const completeRev = claimedRev + 1;
      const completeEv = compileInboxCompletedEvent({
        eventId: "ev-c8-complete-0",
        workspaceRevision: completeRev,
        opId: "op-c8-complete-0",
        actor,
        source: "local",
        occurredAt: "2026-11-27T04:11:00.000Z",
        payload: {
          inboxId,
          itemId: "c8_item_000",
          claimId: "claim_c8_0",
          dispatchId: "dispatch_c80000000000000000000001",
          completedAt: "2026-11-27T04:11:00.000Z",
        },
      });
      const completePlan = canonicalEventWritePlan(completeEv, "inbox", inboxId);
      store2.append({ event: completeEv, plan: completePlan, blobs: [] });
      proj2.apply(completeEv, completePlan);
      proj2.close();
      await store2.drain();

      cell = await openRepoCell({ repoId, rootDir: canonicalRoot(root), ownerId: "pr1b-collect-wait-owner-3" });
      const page3 = evidence(
        await cell.run({ kind: "runtime-collect", taskId: parentTaskId, since: page2.nextSince }, owner),
      ) as {
        readonly inbox: readonly { readonly itemId: string; readonly status: string; readonly revision: number }[];
      };
      assert.equal(page3.inbox.length, 1);
      assert.equal(page3.inbox[0]?.itemId, "c8_item_000");
      assert.equal(page3.inbox[0]?.status, "completed");
      assert.equal(page3.inbox[0]?.revision, completeRev);
    } finally {
      await cell?.close();
      removeTempRepository(root);
    }
  },
);
