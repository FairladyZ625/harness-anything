// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  INITIAL_SETTINGS_V1,
  submissionDigest,
  type AgentRuntimeEventV1,
  type ExecutionV1,
} from "@harness-anything/kernel";
import { readDispatchStream } from "../src/daemon-host/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { makeRuntimeSpawner } from "../src/daemon-host/runtime-spawner.ts";
import { RuntimeProcessStartRejected } from "../src/daemon-host/runtime-spawn-process.ts";
import { waitForDurableCondition } from "../../../tools/fixtures/event-arrival.ts";
import { fixtureRuntimeProcess } from "./fixtures/runtime-process.ts";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";

test(
  "doc-only task review fallback on a symlinked authoredRoot preserves task-package cwd and completes review registration",
  { timeout: 60_000, skip: process.platform === "win32" ? "requires POSIX symlink semantics" : false },
  async () => {
    const externalParent = mkdtempSync(path.join(tmpdir(), "ha-doc-task-symlink-ledger-")),
      externalHarness = path.join(externalParent, "private-harness");
    const f = await fixture(1, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      create: { presetId: "docs-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 0,
    });
    try {
      await f.install(null);
      const docPackagePath = f.packagePath,
        artifactRelative = `${docPackagePath}/artifacts/spec.md`;
      mkdirSync(path.dirname(path.join(f.root, "harness", artifactRelative)), { recursive: true });
      writeFileSync(path.join(f.root, "harness", artifactRelative), "# Doc-only deliverable\n");
      writeFileSync(
        path.join(f.root, "harness", docPackagePath, "closeout.md"),
        "# Closeout\n\n## Summary\n\nDoc-only deliverable.\n\n## Verification\n\nVerified.\n\n" +
          "## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nNone.\n",
      );
      assert.equal((await f.run({ kind: "doc-submit", taskId })).outcome, "applied");
      await f.cell().settlePendingMaterialization("doc-only prepare before symlink");

      // Relocate authoredRoot outside the repository as its own git ledger and mount it via symlink.
      renameSync(path.join(f.root, "harness"), externalHarness);
      execFileSync("git", ["-C", externalHarness, "init", "-q", "-b", "main"]);
      execFileSync("git", ["-C", externalHarness, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", externalHarness, "config", "user.email", "test@example.com"]);
      execFileSync("git", ["-C", externalHarness, "add", "."]);
      execFileSync("git", ["-C", externalHarness, "commit", "--allow-empty", "-qm", "init private ledger"]);
      symlinkSync(externalHarness, path.join(f.root, "harness"), "dir");
      await f.reopen();

      assert.equal((await f.run({ kind: "task-submit", taskId, executionId })).outcome, "applied");

      await f.waitForLaunches(2);
      const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
      assert.equal(attempts.length, 2, JSON.stringify(attempts));
      const expectedPackageCwd = realpathSync.native(path.join(externalHarness, docPackagePath));
      assert.equal(f.launches[0]?.instanceId, "review-first");
      assert.equal(f.launches[1]?.instanceId, "review-second");
      assert.equal(f.launches[0]?.cwd, expectedPackageCwd);
      assert.equal(
        f.launches[1]?.cwd,
        expectedPackageCwd,
        "backup reviewer for a doc-only task on a symlinked authoredRoot must inherit the task-package boundary",
      );
      const firstStream = readDispatchStream(f.root, attempts[0]!.payload.dispatchId),
        secondStream = readDispatchStream(f.root, attempts[1]!.payload.dispatchId);
      assert.equal(firstStream?.header.trustedManagedCwd, "task-package");
      assert.equal(secondStream?.header.trustedManagedCwd, "task-package");

      const successor = attempts[1]!.payload,
        packetPath = `${docPackagePath}/artifacts/reports/${successor.dispatchId}.json`,
        reportPath = `${docPackagePath}/artifacts/reports/${successor.dispatchId}.md`;
      mkdirSync(path.dirname(path.join(f.root, "harness", packetPath)), { recursive: true });
      writeFileSync(path.join(f.root, "harness", reportPath), "# Independent Doc Review\n\nApproved.\n");
      writeFileSync(
        path.join(f.root, "harness", packetPath),
        JSON.stringify({
          verdict: "approved",
          reason: "Backup reviewer verified doc-only deliverable.",
          evidenceChecked: ["Verified spec.md in symlinked task package."],
          findings: [],
          resolutions: [],
        }),
      );
      const reviewed = await f.cell().run(
        {
          kind: "task-review-execution",
          taskId,
          executionId,
          reviewId: `review-${successor.dispatchId}`,
          fromFile: `harness/${packetPath}`,
        },
        {
          ...owner,
          actor: {
            principal: owner.actor.principal,
            executor: { kind: "agent", id: `runtime-session:${successor.runtimeSessionId}` },
          },
        },
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      assert.equal(
        await f.settleReview(String(successor.dispatchId), String(successor.runtimeSessionId), "Doc review complete."),
        "succeeded",
      );
    } finally {
      await f.close();
      rmSync(externalParent, { recursive: true, force: true });
    }
  },
);

test(
  "task-bound dispatch with caller-selected cwd never acquires .worktrees realpath exemption on initial launch or fallback",
  { timeout: 60_000, skip: process.platform === "win32" ? "requires POSIX symlink semantics" : false },
  async () => {
    const outsideParent = mkdtempSync(path.join(tmpdir(), "ha-task-bound-worktrees-escape-")),
      externalWorktrees = path.join(outsideParent, "external-worktrees"),
      externalSneakyTarget = path.join(externalWorktrees, "sneaky-caller-target");
    let nowMs = Date.now() + 60_000;
    const f = await fixture(1, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 60,
      now: () => new Date(nowMs).toISOString(),
    });
    try {
      await f.install(null);
      await f.cell().settlePendingMaterialization("task-bound worktrees symlink setup");
      // Relocate .worktrees outside the repository and symlink it back so any spurious .worktrees
      // managed-root grant would admit targets inside externalWorktrees.
      renameSync(path.join(f.root, ".worktrees"), externalWorktrees);
      mkdirSync(externalSneakyTarget, { recursive: true });
      symlinkSync(externalWorktrees, path.join(f.root, ".worktrees"), "dir");
      await f.reopen();

      // 1. Direct caller-selected escaping symlink on a Task-bound dispatch is rejected immediately.
      symlinkSync(externalSneakyTarget, path.join(f.root, "task-escape-link"), "dir");
      await assert.rejects(
        f.cell().spawnRuntime(
          {
            agentId: "closeout-reviewer",
            taskId,
            cwd: { scope: "repo-relative", path: "task-escape-link" },
            prompt: "Caller-selected escaping symlink on task-bound dispatch",
            dispatchKey: "task-bound-direct-escape",
          },
          owner,
        ),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "invalid_runtime_cwd" &&
          /Runtime cwd must stay inside the repository/u.test(error.message),
      );

      // 2. Caller-selected in-repo cwd on a Task-bound dispatch records no trustedManagedCwd and
      //    cannot acquire .worktrees exemption when swapped to a symlink inside externalWorktrees during backoff.
      const callerDir = path.join(f.root, "caller-selected-dir");
      mkdirSync(callerDir, { recursive: true });
      const spawned = await f.cell().spawnRuntime(
        {
          agentId: "closeout-reviewer",
          taskId,
          cwd: { scope: "repo-relative", path: "caller-selected-dir" },
          prompt: "Caller-selected in-repo cwd on task-bound dispatch",
          dispatchKey: "task-bound-caller-fallback-escape",
        },
        owner,
      );
      await f.waitForLaunches(1);
      const firstStream = readDispatchStream(f.root, String(spawned.dispatchId));
      assert.equal(firstStream?.header.trustedManagedCwd, undefined);
      await f.awaitOutcome(String(spawned.runtimeSessionId));

      rmSync(callerDir, { recursive: true, force: true });
      symlinkSync(externalSneakyTarget, callerDir, "dir");
      nowMs += 65_000;
      await f.reopen();

      await waitForDurableCondition(async () => {
        const read = await f
          .cell()
          .readDispatchLifecycle({ by: "dispatch", dispatchIds: [String(spawned.dispatchId)] });
        return read.status === "ready" && read.rows[0]?.policy.groupSettled === true;
      });
      assert.equal(
        f.launches.length,
        1,
        "caller-selected Task-bound fallback must not launch inside external .worktrees",
      );
      const outcomes = f
        .events()
        .filter(
          (event) =>
            event.type === "runtime_session_outcome_observed" &&
            event.payload.dispatchId === String(spawned.dispatchId),
        );
      assert.match(outcomes.at(-1)?.payload.attempt?.reason ?? "", /Runtime cwd must stay inside the repository/u);
    } finally {
      await f.close();
      rmSync(outsideParent, { recursive: true, force: true });
    }
  },
);

test(
  "start-rejected review preserves local dispatch stream when center lifecycle is pending, then recovers backup review once ready",
  { timeout: 60_000 },
  async () => {
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 0,
    });
    const repoId = workspaceId("completion-review"),
      runtimeStops: Array<() => unknown> = [];
    let spawner1: ReturnType<typeof makeRuntimeSpawner> | undefined,
      spawner2: ReturnType<typeof makeRuntimeSpawner> | undefined;
    try {
      await f.install(null);
      f.disableInstances();
      assert.equal((await f.submit()).outcome, "applied");
      f.enableInstances();
      const shown = await f.run({ kind: "task-show", taskId }),
        snapshot = JSON.parse(String(shown.evidence)) as { readonly executions: readonly ExecutionV1[] },
        submittedExecution = snapshot.executions.find((entry) => entry.executionId === executionId)!;
      assert.ok(submittedExecution?.submission?.commitSha);
      const reviewDigest = submissionDigest(submittedExecution.submission);

      let lifecyclePending = false;
      const backupLaunches: Array<{ readonly dispatchId: string; readonly instanceId: string; readonly cwd: string }> =
          [],
        pendingExits: Array<(code: number | null) => void> = [],
        pendingOutputs: Array<(chunk: string) => void> = [];

      const createSpawner = (rejectPrimary: boolean) => {
        let queue: Promise<unknown> = Promise.resolve();
        return makeRuntimeSpawner({
          repoId,
          rootDir: canonicalRoot(f.root),
          daemonGeneration: 1,
          now: () => new Date().toISOString(),
          readSettings: () => ({
            ...INITIAL_SETTINGS_V1,
            runtime: {
              ...INITIAL_SETTINGS_V1.runtime,
              allowedInstances: ["review-first", "review-second"],
              providerMaxRetries: 0,
              providerRoundBackoffBaseSeconds: 0,
            },
          }),
          schedule: (work) => {
            queue = queue.then(
              () => work(),
              () => work(),
            );
          },
          stream: { publish: () => undefined },
          runtimeDaemonRoute: {
            userRoot: path.join(f.root, "user"),
            daemonId: "fixture-pending-recovery",
            endpoint: path.join(f.root, "user.sock"),
          },
          runtimeInstances: () =>
            ["review-first", "review-second"].map((instanceId) => ({
              schemaVersion: 2 as const,
              instanceId,
              name: instanceId,
              kindId: "codex" as const,
              installationId: "installation-review",
              providerId: "openai",
              models: ["review-model"],
              defaultModel: "review-model",
              enabled: true,
              permissionMode: "read-only" as const,
              codex: {
                reasoningEffort: null,
                fast: false,
                baseUrl: null,
                baseUrlConfigured: false,
                wire_api: null,
                requires_openai_auth: null,
                http_headers: null,
              },
              authMode: "subscription" as const,
              authState: "configured" as const,
              authReadiness: { status: "ready" as const, code: null, hint: null },
              isolationState: "enforced" as const,
            })),
          resolveAgent: (agentId) =>
            agentId === "closeout-reviewer"
              ? {
                  schema: "agent-declaration/v1" as const,
                  id: "closeout-reviewer",
                  name: "Independent reviewer",
                  instructions: "Review submitted delivery.",
                  runtimes: [{ type: "codex" as const, model: "review-model" }],
                  role: "worker" as const,
                }
              : null,
          prepareLaunch: (instanceId, request) => ({
            definition: {
              schema: "agent-definition-snapshot/v1",
              configVersion: 1,
              instanceId,
              installationId: "installation-review",
              kindId: "codex",
              providerId: "openai",
              model: request.model ?? "review-model",
              reasoningEffort: null,
              fast: false,
              endpointKind: "official",
              baseUrlHash: null,
              authMode: "subscription",
            },
            installation: {
              installationId: "installation-review",
              kindId: "codex",
              executablePath: "/fixture/reviewer",
              version: "1.0.0",
              observedAt: "2026-11-21T00:00:00.000Z",
            },
            executablePath: "/fixture/reviewer",
            args: ["exec", "--json", "-"],
            env: {},
            cwd: request.cwd,
            prompt: request.prompt,
          }),
          launch: (prepared, persistence) => {
            if (rejectPrimary && prepared.definition.instanceId === "review-first") {
              // Simulate transient center projection lag immediately after admission and start rejection.
              lifecyclePending = true;
              throw new RuntimeProcessStartRejected(
                Object.assign(new Error("spawn ENOENT on review-first"), { code: "ENOENT" }),
              );
            }
            backupLaunches.push({
              dispatchId: persistence.dispatchId,
              instanceId: prepared.definition.instanceId,
              cwd: prepared.cwd,
            });
            const proc = fixtureRuntimeProcess({
              after: (stop) => {
                runtimeStops.push(stop);
              },
            });
            return {
              pid: proc.pid,
              onOutput: (listener) => {
                pendingOutputs.push(listener);
              },
              onErrorOutput: () => undefined,
              terminate: proc.terminate,
              terminateTree: proc.terminateTree,
              onExit: (listener) => {
                pendingExits.push(listener);
              },
            };
          },
          remote: {
            executionCredential: () => undefined,
            taskContext: async () => ({
              taskId,
              executionId,
              packagePath: f.packagePath,
              packageRoot: path.join(f.root, "harness", f.packagePath),
              mission: () => "Review submitted cut.",
              planBody: null,
              riskTier: "medium" as const,
              riskTierFlowVersion: 1,
              profileId: "baseline",
              taskClass: "standard" as const,
              causalContext: null,
              ownerReturnBody: null,
              continuationContext: null,
              reviewerNote: null,
              worktree: {
                taskId,
                branch: taskId,
                path: `.worktrees/${taskId}`,
              },
              reviewerSubmission: submittedExecution.submission!,
            }),
            readRuntimeSession: async (runtimeSessionId) => {
              const requested = f
                .events()
                .find(
                  (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
                    event.type === "runtime_dispatch_requested" && event.payload.runtimeSessionId === runtimeSessionId,
                );
              if (!requested) return null;
              return {
                runtimeSessionId,
                instanceId: requested.payload.instanceId,
                outcome: null,
                exitCode: null,
                resultRef: null,
                reasonCode: null,
              };
            },
            readRuntimeSessions: async () => [],
            readRuntimeDispatch: async (runtimeSessionId) => {
              const requested = f
                .events()
                .find(
                  (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
                    event.type === "runtime_dispatch_requested" && event.payload.runtimeSessionId === runtimeSessionId,
                );
              return requested ? { event: requested, actor: requested.actor, source: requested.source } : null;
            },
            readDispatchLifecycle: async (query) => {
              if (lifecyclePending) return { status: "pending", watermark: 0, sourceRevision: 1 };
              return f.cell().readDispatchLifecycle(query);
            },
            publish: async (draft) => {
              const receipt = await f.cell().runtimeIngress({ kind: "event", ...draft }, owner);
              return { event: (receipt.event as unknown as AgentRuntimeEventV1) ?? null, receipt };
            },
            archive: async () => ({ outcome: "applied" }),
          },
        });
      };

      spawner1 = createSpawner(true);
      const receipt = await spawner1.spawn(
        {
          agentId: "closeout-reviewer",
          role: "reviewer",
          taskId,
          executionId,
          reviewTarget: { kind: "task", taskId, executionId, digest: reviewDigest },
          dispatchKey: `task-review:${taskId}:${executionId}:0:${reviewDigest}:reviewer:closeout-reviewer`,
          prompt: "Inspect submitted cut and record verdict.",
        },
        { ...owner, authorizationDecision: { outcome: "allowed", nextActions: [] } as never },
      );
      const firstDispatchId = String(receipt.dispatchId),
        preservedStream = readDispatchStream(f.root, firstDispatchId);
      assert.ok(preservedStream, "node-local dispatch stream must be preserved when lifecycle read is pending");
      assert.ok(preservedStream.header.fallbackAttempt, "fallbackAttempt header must remain intact for recovery");
      assert.ok(preservedStream.attemptOutcome, "attemptOutcome must remain intact for recovery");
      assert.ok(preservedStream.terminalOutcome, "terminalOutcome must remain intact for recovery");
      assert.ok(
        preservedStream.header.cwd && existsSync(preservedStream.header.cwd),
        "review worktree must remain intact while center lifecycle is pending",
      );

      // Simulate restart adoption once center projection catches up.
      spawner1.close();
      lifecyclePending = false;
      spawner2 = createSpawner(false);
      await spawner2.adopt();
      await waitForDurableCondition(async () => backupLaunches.length >= 1);
      assert.equal(backupLaunches[0]?.instanceId, "review-second");
      assert.equal(backupLaunches[0]?.cwd, preservedStream.header.cwd);

      const backupDispatch = f
        .events()
        .find(
          (event): event is Extract<AgentRuntimeEventV1, { readonly type: "runtime_dispatch_requested" }> =>
            event.type === "runtime_dispatch_requested" && event.payload.dispatchId === backupLaunches[0]!.dispatchId,
        );
      assert.ok(backupDispatch, "backup dispatch must be admitted by the center");
      await waitForDurableCondition(async () =>
        f
          .events()
          .some(
            (event) =>
              event.type === "runtime_session_liveness_changed" &&
              event.payload.runtimeSessionId === backupDispatch.payload.runtimeSessionId,
          ),
      );
      const reviewed = await f.reviewDispatchedArtifacts(
        backupDispatch.payload.runtimeSessionId,
        backupDispatch.payload.dispatchId,
      );
      assert.equal(reviewed.outcome, "applied", JSON.stringify(reviewed));
      pendingOutputs[0]?.(`${JSON.stringify({ type: "thread.started", thread_id: "recovered-backup-thread" })}\n`);
      pendingOutputs[0]?.(
        `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Backup approved." } })}\n`,
      );
      pendingOutputs[0]?.(`${JSON.stringify({ type: "turn.completed", usage: {} })}\n`);
      pendingExits[0]?.(0);
      await f.awaitOutcome(backupDispatch.payload.runtimeSessionId);
    } finally {
      spawner1?.close();
      spawner2?.close();
      for (const stop of runtimeStops) await stop();
      await f.close();
    }
  },
);

test(
  "active review cancellation is never misreported as a provider failure and does not shadow an earlier failed review group",
  { timeout: 60_000 },
  async () => {
    let rejectAll = false;
    const f = await fixture(false, true, false, false, false, {
      autoSubmit: false,
      closeoutProfile: "standard",
      submitCommit: true,
      guiDelivery: true,
      create: { presetId: "standard-task" },
      keycloakSession: async () => owner.keycloakAuthorization.session,
      providerMaxRetries: 0,
      providerRoundBackoffBaseSeconds: 0,
      rejectLaunch: (instanceId) =>
        rejectAll ? Object.assign(new Error(`real provider outage on ${instanceId}`), { code: "ENOENT" }) : null,
    });
    try {
      await f.install(null);
      assert.equal((await f.submit()).outcome, "applied");
      await f.waitForLaunches(1);
      const firstDispatch = f.events().find((event) => event.type === "runtime_dispatch_requested");
      assert.ok(firstDispatch?.type === "runtime_dispatch_requested");

      // 1. Cancel the only review dispatch -> task show & agenda must NOT report cancellation as a provider failure.
      await f.cancel(String(firstDispatch.payload.runtimeSessionId));
      assert.equal(await f.awaitOutcome(String(firstDispatch.payload.runtimeSessionId)), "cancelled");
      await f.cell().settlePendingMaterialization("cancelled-only review");

      const shownCancelledOnly = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        readonly completionBlocker: { readonly code: string; readonly gate: string } | null;
        readonly completionNext: { readonly action: string; readonly reason: string } | null;
      };
      assert.deepEqual(shownCancelledOnly.completionBlocker, { code: "review_pending", gate: "review" });
      assert.equal(shownCancelledOnly.completionNext?.action, `ha task dispatch-review ${taskId}`);
      assert.equal(
        (shownCancelledOnly.completionNext?.reason ?? "").includes("Latest review dispatch"),
        false,
        `cancelled review must not be reported as a failure: ${shownCancelledOnly.completionNext?.reason}`,
      );
      const agendaCancelledOnly = await f.cell().read("repo.agenda.read", {}, owner);
      assert.match(agendaCancelledOnly.summary, /required review has no active dispatch/u);
      assert.equal(agendaCancelledOnly.summary.includes("review dispatch failed"), false, agendaCancelledOnly.summary);

      // 2. Dispatch a second group that fails/exhausts across all providers.
      rejectAll = true;
      await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      await waitForDurableCondition(async () => {
        const attempts = f.events().filter((event) => event.type === "runtime_dispatch_requested");
        if (attempts.length < 3) return false;
        const read = await f
          .cell()
          .readDispatchLifecycle({ by: "dispatch", dispatchIds: [attempts.at(-1)!.payload.dispatchId] });
        return read.status === "ready" && read.rows[0]?.policy.groupSettled === true;
      });

      // 3. Dispatch a third group and actively cancel it -> must NOT shadow the earlier real failure from step 2.
      rejectAll = false;
      const third = await f.run({ kind: "task-dispatch-review", taskIds: [taskId] });
      assert.equal(third.outcome, "applied", JSON.stringify(third));
      await f.waitForLaunches(2);
      const allDispatches = f.events().filter((event) => event.type === "runtime_dispatch_requested"),
        thirdDispatch = allDispatches.at(-1)!;
      await f.cancel(String(thirdDispatch.payload.runtimeSessionId));
      assert.equal(await f.awaitOutcome(String(thirdDispatch.payload.runtimeSessionId)), "cancelled");
      await f.cell().settlePendingMaterialization("failed then cancelled review");

      const shownAfterCancel = JSON.parse(String((await f.run({ kind: "task-show", taskId })).evidence)) as {
        readonly completionBlocker: { readonly code: string; readonly gate: string } | null;
        readonly completionNext: { readonly action: string; readonly reason: string } | null;
      };
      assert.deepEqual(shownAfterCancel.completionBlocker, { code: "review_pending", gate: "review" });
      assert.equal(shownAfterCancel.completionNext?.action, `ha task dispatch-review ${taskId}`);
      assert.match(shownAfterCancel.completionNext?.reason ?? "", /real provider outage on review-second/u);
      assert.equal(
        (shownAfterCancel.completionNext?.reason ?? "").includes(thirdDispatch.payload.dispatchId),
        false,
        "later cancelled dispatch must not overwrite the earlier real failure",
      );

      const agendaAfterCancel = await f.cell().read("repo.agenda.read", {}, owner);
      assert.match(agendaAfterCancel.summary, /real provider outage on review-second/u);
      assert.match(agendaAfterCancel.summary, new RegExp(`ha task dispatch-review ${taskId}`, "u"));
    } finally {
      await f.close();
    }
  },
);
