// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBootstrappedRepoCell, seedSettingsEvent } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRuntimeResourceHost } from "../src/runtime-resource-host.ts";
import { defaultRuntimeResourceLimits } from "../src/runtime-resource-admission.ts";
import { validateAgentRuntimeSession } from "../src/agent-runtime-contract.ts";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";

test(
  "real RepoCell queues before launch preparation, reads queued canonically, then starts without redispatch",
  { timeout: 20_000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-resource-spawn-"));
    let cpu = 0.2,
      prepared = 0,
      launched = 0,
      terminations = 0;
    let exit: ((code: number | null) => void) | undefined;
    const host = openRuntimeResourceHost("fixture-node", {
      sample: async () => ({ cores: 4, cpu, cpuMetric: "idle-fraction", availableMemoryFraction: 0.5 }),
      limits: defaultRuntimeResourceLimits(4),
      notify: async () => undefined,
    });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "-q");
    git("config", "user.name", "Harness Test");
    git("config", "user.email", "harness@example.test");
    git("commit", "--allow-empty", "-qm", "base");
    seedSettingsEvent({
      repoId: workspaceId("resource-spawn"),
      rootDir: canonicalRoot(root),
      runtimeInstances: [{ instanceId: "claude-review", enabled: true }],
    });
    const definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "claude-review",
      installationId: "installation-claude",
      kindId: "claude",
      providerId: "anthropic",
      model: "claude-fable-5",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    };
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cell = await openBootstrappedRepoCell({
      repoId: workspaceId("resource-spawn"),
      rootDir: canonicalRoot(root),
      ownerId: "resource-test",
      resourceAdmission: host,
      runtimeInstances: () => [{ instanceId: "claude-review", enabled: true } as never],
      prepareRuntimeLaunch: async (_id, request) => {
        prepared++;
        return {
          definition,
          installation: {
            installationId: definition.installationId,
            kindId: "claude",
            executablePath: "/fixture/claude",
            version: "1",
            observedAt: new Date().toISOString(),
          },
          executablePath: "/fixture/claude",
          args: [],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => {
        launched++;
        started();
        return {
          pid: 123456789,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: (callback) => {
            exit = callback;
          },
          terminate: () => {
            terminations++;
            exit?.(null);
          },
        };
      },
    });
    try {
      const binding = withPolicyGroup(
        { actor: { principal: { personId: "person-owner" }, executor: null }, source: "local" as const },
        "admin",
      );
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: "claude-review",
          cwd: { scope: "repo-root" },
          prompt: "inspect",
          idempotencyKey: "resource-request",
        },
        binding,
      );
      assert.equal(receipt.dispatchStatus, "queued");
      await host.check();
      assert.equal(prepared, 0);
      assert.equal(launched, 0);
      const waiting = await cell.read("repo.agentRuntime.sessions.read", {
        runtimeSessionId: receipt.runtimeSessionId,
      });
      assert.deepEqual(validateAgentRuntimeSession(waiting), []);
      assert.equal(waiting.session, null);
      console.log(JSON.stringify({ receipt, waiting }));
      cpu = 0.8;
      await host.check();
      await start;
      assert.equal(prepared, 1);
      assert.equal(launched, 1);
      // A subsequent read is behind the scheduled writer turn, so it sees the launch publication.
      await cell.read("repo.agentRuntime.overview");
      console.log("resource-test: launched publication visible");
      assert.equal(host.snapshot().active, 1);
      cpu = 0.8;
      await host.check();
      assert.equal(terminations, 0, "pressure must not terminate the running provider");
      const cancelled = await cell.spawnRuntime(
        {
          runtimeInstanceId: "claude-review",
          cwd: { scope: "repo-root" },
          prompt: "cancel before prepare",
          idempotencyKey: "cancel-before-prepare",
        },
        binding,
      );
      console.log("resource-test: second queued");
      const cancellation = await cell.cancelRuntime(
        { runtimeSessionId: cancelled.runtimeSessionId, idempotencyKey: "cancel-queued" },
        binding,
      );
      console.log("resource-test: cancellation", JSON.stringify(cancellation));
      assert.equal(cancellation.dispatchStatus, "cancelled");
      await cell.awaitRuntimeOutcome(String(cancelled.runtimeSessionId));
      assert.equal(prepared, 1);
      console.log("resource-test: queued waiter settled");
      exit!(0);
      await cell.awaitRuntimeOutcome(String(receipt.runtimeSessionId));
      console.log("resource-test: provider settled");
      assert.equal(host.snapshot().active, 0, "real runtime settlement releases admission");
    } finally {
      await cell.close();
      host.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
