// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { definition, initHarnessRepo, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";

const binding = withPolicyGroup(
  {
    actor: { principal: { personId: "selection-operator" }, executor: null },
    source: "local" as const,
  },
  "admin",
);

for (const route of ["agent", "schedule"] as const) {
  for (const state of ["first-ready", "first-unavailable", "all-unavailable"] as const) {
    test(`${route} prepares candidates before any launch: ${state}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-prelaunch-selection-")),
        first = { ...definition, instanceId: "codex-first" },
        second = { ...definition, instanceId: "claude-second", kindId: "claude" as const, model: "GLM-5.3" },
        attempted: string[] = [],
        launched: string[] = [];
      initHarnessRepo(root, "prelaunch-selection");
      const ports = scheduleRuntimePorts(),
        cell = await openRepoCell({
          repoId: workspaceId("prelaunch-selection"),
          rootDir: canonicalRoot(root),
          ownerId: "selection-test",
          runtimeDaemonRoute: {
            userRoot: path.join(root, ".daemon"),
            daemonId: "selection-test",
            endpoint: path.join(root, ".daemon", "daemon.sock"),
          },
          runtimeInstances: () =>
            [first, second].map((selected) => ({
              ...ports.runtimeInstances()[0],
              instanceId: selected.instanceId,
              kindId: selected.kindId,
              models: [selected.model],
              defaultModel: selected.model,
            })),
          prepareRuntimeLaunch: async (instanceId, request) => {
            assert.equal(launched.length, 0, "no worker starts while candidates are being prepared");
            attempted.push(instanceId);
            if (state === "all-unavailable" || (state === "first-unavailable" && instanceId === first.instanceId))
              throw Object.assign(new Error(`Sign in ${instanceId}`), { code: "runtime_subscription_required" });
            const selected = instanceId === first.instanceId ? first : second;
            return {
              ...(await ports.prepareRuntimeLaunch(instanceId, request)),
              definition: selected,
              installation: {
                installationId: selected.installationId,
                kindId: selected.kindId,
                executablePath: "/opt/test/codex",
                version: "1.0.0",
                observedAt: "2026-10-09T00:00:00.000Z",
              },
            };
          },
          runtimeLaunch: (launch) => {
            launched.push(launch.prompt);
            return {
              pid: 4242,
              onOutput: () => undefined,
              onErrorOutput: () => undefined,
              onExit: () => undefined,
              terminate: () => undefined,
            };
          },
        });
      try {
        await cell.run(
          {
            kind: "agent-install",
            declaration: {
              schema: "agent-declaration/v1",
              id: "ordered-agent",
              name: "Ordered Agent",
              instructions: "Inspect.",
              runtimes: [
                { type: first.kindId, model: first.model },
                { type: second.kindId, model: second.model },
              ],
            },
          },
          binding,
        );
        if (route === "schedule") {
          const created = await cell.run(
            {
              kind: "schedule-create",
              scheduleId: "ordered-probe",
              name: "Ordered probe",
              mode: "detect",
              everyMs: 60_000,
              agentId: "ordered-agent",
              mission: "Inspect.",
              idempotencyKey: "create",
            },
            binding,
          );
          assert.equal(created.outcome, "applied");
          const target = (created as unknown as { schedule: { spec: { target: object } } }).schedule.spec.target;
          assert.equal(Object.hasOwn(target, "runtimeInstanceId"), false);
          assert.equal(Object.hasOwn(target, "model"), false);
        }
        const run = () =>
          route === "agent"
            ? cell.spawnRuntime(
                { agentId: "ordered-agent", prompt: "Inspect.", cwd: { scope: "repo-root" }, idempotencyKey: "run" },
                binding,
              )
            : cell.run({ kind: "schedule-run-now", scheduleId: "ordered-probe", idempotencyKey: "run" }, binding);
        if (state === "all-unavailable") {
          if (route === "agent")
            await assert.rejects(
              run(),
              /codex-first: runtime_subscription_required.*claude-second: runtime_subscription_required/u,
            );
          else {
            const result = await run();
            const schedule = (
              result as unknown as { schedule: { status: { lastRun: { outcome: string; detail: string } } } }
            ).schedule;
            assert.equal(schedule.status.lastRun.outcome, "failed");
            assert.match(
              schedule.status.lastRun.detail,
              /codex-first: runtime_subscription_required.*claude-second: runtime_subscription_required/u,
            );
          }
          assert.equal(launched.length, 0);
        } else {
          const receipt = await run();
          assert.equal(receipt.outcome, "applied");
          assert.equal(launched.length, 1);
          const runtimeSessionId =
            route === "agent"
              ? String(receipt.runtimeSessionId)
              : (receipt as unknown as { schedule: { status: { activeRun: { runtimeSessionId: string } } } }).schedule
                  .status.activeRun.runtimeSessionId;
          const { session } = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
          const selected = state === "first-ready" ? first : second;
          assert.equal(session.instanceId, selected.instanceId);
          assert.equal(session.kindId, selected.kindId);
          assert.equal(session.definitionSnapshot?.model, selected.model);
        }
        assert.deepEqual(
          attempted,
          state === "first-ready" ? [first.instanceId] : [first.instanceId, second.instanceId],
        );
      } finally {
        await cell.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
