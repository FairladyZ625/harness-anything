// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSessionResult } from "../src/agent-runtime-contract.ts";
import { makeAgentRuntimeStreamHub } from "../src/agent-runtime-stream.ts";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import { locallyObservedRuntimeSessions } from "../src/runtime-spawn-adoption.ts";
import { readObservedRuntimeSession } from "../src/agent-runtime-read.ts";
import { openDispatchStream, appendRuntimeWorkerRecord } from "../src/dispatch-stream.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import type { AgentDefinitionSnapshot, RuntimeSession } from "@harness-anything/kernel";
import type { RepoCellStatus } from "../src/repo-cell-types.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

for (const fault of ["authorization hold", "HEAD timeout", "HEAD signal"] as const) {
  test(
    `the ledger stays writable through ${fault} and preserves the recovering lease`,
    { skip: process.platform === "win32" && fault !== "authorization hold" },
    async () => {
      const caseId = fault.replaceAll(" ", "-").toLowerCase();
      const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-ready-")),
        statuses: RepoCellStatus[] = [],
        definition: AgentDefinitionSnapshot = {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId: "adoption-ready-codex",
          installationId: "adoption-ready-installation",
          kindId: "codex",
          providerId: "openai",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          baseUrl: "https://api.example.test/",
          authMode: "api-key",
        },
        installation = {
          installationId: definition.installationId,
          kindId: definition.kindId,
          executablePath: "/opt/witnessed/codex",
          version: "1.0.0",
          observedAt: "2026-09-13T00:00:00.000Z",
        };
      const recoveryEntered = Promise.withResolvers<void>(),
        authorization = Promise.withResolvers<void>(),
        outcomes = Promise.withResolvers<void>(),
        failedRecovery = Promise.withResolvers<void>();
      const oldPath = process.env.PATH;
      const realGit =
        fault === "authorization hold" ? null : execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      const observedOutcomes = new Set<string>();
      let holdRecovery = false;
      let opening: ReturnType<typeof openRepoCell> | undefined;
      let launches = 0,
        cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
      try {
        mkdirSync(path.join(rootDir, "harness"));
        writeFileSync(
          path.join(rootDir, "harness/harness.yaml"),
          "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
        );
        for (const args of [
          ["init", "-q"],
          ["config", "user.name", "Adoption Test"],
          ["config", "user.email", "adoption@example.test"],
          ["add", "harness"],
          ["commit", "-qm", "fixture"],
        ])
          execFileSync("git", args, { cwd: rootDir, stdio: "pipe" });
        const binding = withPolicyGroup(
          { actor: { principal: { personId: "adoption-ready-operator" }, executor: null }, source: "local" as const },
          "admin",
        );
        const input = {
          repoId: workspaceId(`adoption-ready-${caseId}`),
          rootDir: canonicalRoot(rootDir),
          ownerId: `adoption-ready-${caseId}`,
          runtimeDaemonRoute: {
            userRoot: path.join(rootDir, ".daemon-user"),
            daemonId: `adoption-ready-${caseId}`,
            endpoint: path.join(rootDir, ".daemon-user/daemon.sock"),
          },
          keycloakSession: async () => {
            if (holdRecovery) {
              recoveryEntered.resolve();
              await authorization.promise;
            }
            return binding.keycloakAuthorization.session;
          },
          onStatus: (status: RepoCellStatus) => statuses.push(status),
          recordLifecycle: (entry: { event: string }) => {
            if (entry.event === "runtime_recovery_failed") failedRecovery.resolve();
          },
          onRuntimeOutcome: (event: { payload: { runtimeSessionId: string } }) => {
            observedOutcomes.add(event.payload.runtimeSessionId);
            if (observedOutcomes.size === (fault === "authorization hold" ? 2 : 1)) outcomes.resolve();
          },
          runtimeInstances: () => [
            {
              schemaVersion: 2 as const,
              instanceId: definition.instanceId,
              name: "Adoption Ready",
              kindId: definition.kindId,
              installationId: definition.installationId,
              providerId: definition.providerId,
              models: [definition.model],
              defaultModel: definition.model,
              enabled: true,
              permissionMode: "workspace-write" as const,
              codex: {},
              authMode: definition.authMode,
              authState: "configured" as const,
              authReadiness: { status: "ready" as const, code: null, hint: null },
              isolationState: "enforced" as const,
            },
          ],
          prepareRuntimeLaunch: async (_instanceId: string, request: { cwd: string; prompt: string }) => ({
            definition,
            installation,
            executablePath: installation.executablePath,
            args: ["exec", "--json", "-"],
            env: process.env,
            cwd: request.cwd,
            prompt: request.prompt,
          }),
          // No process record: reopening must settle the durable sessions as missing, through the real queue.
          runtimeLaunch: () => {
            launches += 1;
            return {
              pid: process.pid,
              onOutput: () => undefined,
              onErrorOutput: () => undefined,
              onExit: () => undefined,
              terminate: () => undefined,
            };
          },
        };
        mkdirSync(path.join(rootDir, "runtime-head"));
        cell = await openRepoCell(input);
        const taskId = `task-recovering-${caseId}`;
        const created = await cell.run({ kind: "task-create", taskId, title: "Recovery lease owner" }, binding);
        assert.equal(created.outcome, "applied");
        await waitForFixturePublication(cell, created.opId, binding);
        await realizeTaskPlanFixture(
          rootDir,
          String((created as Record<string, unknown>).packagePath),
          (planPath) => cell!.run({ kind: "doc-submit", paths: [planPath] }, binding),
          "Recovery lease owner",
        );
        const sessions: string[] = [];
        for (const dispatchKey of ["first", "second"]) {
          const receipt = await cell.spawnRuntime(
            {
              runtimeInstanceId: definition.instanceId,
              cwd: { scope: "repo-relative", path: "runtime-head" },
              prompt: "adoption ready",
              ...(dispatchKey === "first" ? { taskId } : {}),
              dispatchKey,
            },
            binding,
          );
          sessions.push(String(receipt.runtimeSessionId));
        }
        await cell.close();
        cell = undefined;
        statuses.length = 0;
        holdRecovery = true;
        if (realGit) {
          const shim = path.join(rootDir, "git-shim");
          mkdirSync(shim);
          writeFileSync(
            path.join(shim, "git"),
            `#!${process.execPath}
const {spawnSync}=require("node:child_process");
const args=process.argv.slice(2);
if(args[0]==="-C" && args[1]===${JSON.stringify(path.join(rootDir, "runtime-head"))} && args[2]==="rev-parse" && args[3]==="HEAD") {
  ${fault === "HEAD timeout" ? "setTimeout(()=>{},60000);" : 'process.kill(process.pid,"SIGTERM");'}
} else { const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"}); if(result.signal) process.kill(process.pid,result.signal); else process.exit(result.status??1); }
`,
            { mode: 0o755 },
          );
          process.env.PATH = `${shim}${path.delimiter}${oldPath ?? ""}`;
        }
        opening = openRepoCell(input);
        const first = await Promise.race([
          opening.then((opened) => {
            cell = opened;
            return "ledger-ready";
          }),
          recoveryEntered.promise.then(() => "runtime-blocked"),
        ]);
        assert.equal(first, "ledger-ready", "runtime authorization cannot be a repository readiness prerequisite");
        cell = await opening;
        opening = undefined;
        await recoveryEntered.promise;
        assert.equal((await cell.run({ kind: "task-list" }, binding)).outcome, "applied");
        assert.equal(
          (
            await cell.run(
              { kind: "task-create", taskId: "task_during_recovery", title: "Writable during recovery" },
              binding,
            )
          ).outcome,
          "applied",
        );
        if (fault === "authorization hold")
          await assert.rejects(
            cell.spawnRuntime(
              {
                runtimeInstanceId: definition.instanceId,
                cwd: { scope: "repo-root" },
                prompt: "must reserve old capacity",
                dispatchKey: "while-recovering",
              },
              binding,
            ),
            { code: "runtime_recovery_pending" },
          );
        const before = await cell.run({ kind: "task-show", taskId }, binding);
        assert.match(String((before as Record<string, unknown>).summary), /lease: [^\n]*phase=held/u);
        const other = withPolicyGroup(
          { actor: { principal: { personId: "recovery-other-owner" }, executor: null }, source: "local" as const },
          "admin",
        );
        await assert.rejects(
          cell.spawnRuntime(
            {
              runtimeInstanceId: definition.instanceId,
              cwd: { scope: "repo-root" },
              prompt: "Cannot take a recovering owner's task",
              taskId,
              dispatchKey: "steal-recovering-lease",
            },
            other,
          ),
          /active execution lease|lease.*held|lease.*owner/iu,
        );
        const after = await cell.run({ kind: "task-show", taskId }, binding);
        assert.equal((after as Record<string, unknown>).summary, (before as Record<string, unknown>).summary);
        authorization.resolve();
        await outcomes.promise;
        if (fault !== "authorization hold") await failedRecovery.promise;
        assert.equal(
          (
            await cell.run(
              { kind: "task-create", taskId: "task_after_recovery_fault", title: "After recovery" },
              binding,
            )
          ).outcome,
          "applied",
        );
        assert.equal(cell.status().state, "attached");
        assert.equal(cell.status().attach, undefined);
        assert.equal(launches, 2);
        for (const runtimeSessionId of sessions) {
          const session = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
          // dec_614F7BBB18C8687E7EFC72173D/CH3: a missing process record has no exit evidence.
          assert.equal(
            (session as AgentRuntimeSessionResult).session.activity.outcome,
            fault !== "authorization hold" && runtimeSessionId === sessions[0] ? null : "unknown",
          );
        }
        await cell.close();
        cell = undefined;
        if (fault !== "authorization hold") return;
        statuses.length = 0;
        cell = await openRepoCell(input);
        assert.equal(
          statuses.some((status) => status.attach?.phase === "restoring-runtimes"),
          false,
          "terminal sessions do not settle twice",
        );
        assert.equal(launches, 2);
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        authorization.resolve();
        if (opening) cell = await opening;
        await cell?.close();
        rmSync(rootDir, { recursive: true, force: true });
      }
    },
  );
}

test("owner adoption checks dead PID before publishing live and preserves live control when publication is offline", async () => {
  for (const alive of [false, true]) {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-owner-evidence-")),
      dispatchId = "dispatch_0123456789abcdef01234567",
      runtimeSessionId = "runtime-owner-evidence",
      pid = alive ? process.pid : 2_147_483_647,
      accepted = {
        runtimeSessionId,
        instanceId: "owner-instance",
        providerSessionId: null,
        outcome: null,
        liveness: "unknown",
        attachable: true,
        taskBindings: [],
        lastObservedAt: "2026-10-07T00:00:00Z",
      } as unknown as RuntimeSession,
      projection = {
        readRuntimeSession: () => accepted,
        readRuntimeDispatch: () => ({ payload: { dispatchId } }),
      } as never,
      hub = makeAgentRuntimeStreamHub({
        readSession: () => readObservedRuntimeSession(projection, rootDir, runtimeSessionId),
        canAttach: (session) => session.attachable && session.liveness === "live",
      }),
      published: string[] = [];
    openDispatchStream(rootDir, {
      dispatchId,
      runtimeSessionId,
      taskId: null,
      executionId: null,
      instanceId: accepted.instanceId,
      startedAt: accepted.lastObservedAt,
      dispatchOpId: "owner-dispatch",
      kindId: "codex",
      permissionMode: "read-only",
      binding: {
        actor: { principal: { personId: "owner" }, executor: null },
        source: { kind: "node", nodeId: "owner" },
      },
      cwd: rootDir,
      prompt: "Owner recovery",
      model: "test",
      reasoningEffort: null,
    });
    appendRuntimeWorkerRecord(rootDir, dispatchId, { kind: "process_started", pid });
    const runtime = makeRuntimeSpawner({
      repoId: "owner-evidence",
      rootDir,
      daemonGeneration: 2,
      runtimeNode: { nodeId: "owner" },
      now: () => accepted.lastObservedAt,
      stream: hub,
      prepareLaunch: async () => {
        throw new Error("adoption must not relaunch");
      },
      schedule: async (work) => {
        await work();
      },
      remote: {
        readRuntimeSessions: async () => [accepted],
        readRuntimeDispatchId: async () => dispatchId,
        publish: async (draft) => {
          published.push(`${draft.type}:${String(draft.payload.liveness ?? "")}`);
          throw new Error("center unavailable");
        },
      } as never,
    });
    try {
      const recovery = await runtime.adopt();
      assert.equal(recovery[0]?.outcome, "failed");
      assert.match(String(recovery[0]?.error), /center unavailable/u);
      assert.equal(
        published.some((value) => value === "runtime_session_liveness_changed:live"),
        alive,
      );
      assert.equal(hub.attach(runtimeSessionId, "stream:0").initial.ok, alive);
      const selected = locallyObservedRuntimeSessions(
        [{ ...accepted, liveness: "live" }],
        new Map([[runtimeSessionId, { process: { pid } as RuntimeProcess }]]),
      );
      assert.equal(selected[0]!.liveness, alive ? "live" : "unknown");
      assert.equal(accepted.liveness, "unknown", "local evidence cannot mutate the canonical observation");
    } finally {
      runtime.close();
      hub.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});
