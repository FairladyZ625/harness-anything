// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { createRuntimeInstanceDispatchState } from "../src/runtime-instance-selection.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { fixtureRuntimeProcess } from "./fixtures/runtime-process.ts";

for (const selectionStrategy of ["sticky", "lru"] as const) {
  test(`F1: ${selectionStrategy} counts this node's running instances across repositories and releases settled attempts`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-node-load-")),
      state = createRuntimeInstanceDispatchState(),
      cells: Awaited<ReturnType<typeof openBootstrappedRepoCell>>[] = [],
      instances: RuntimeInstanceSummary[] = ["pro-a", "pro-b"].map((instanceId) => ({
        schemaVersion: 2,
        instanceId,
        name: instanceId,
        kindId: "codex",
        installationId: "pool-installation",
        providerId: "openai",
        models: ["pool-model"],
        defaultModel: "pool-model",
        enabled: true,
        tier: 1,
        credentialSource: "instance",
        permissionMode: "bypass",
        authMode: "subscription",
        authState: "authenticated",
        authReadiness: { status: "ready", code: null, hint: null },
        isolationState: "enforced",
        configuration: {},
      })),
      binding = withPolicyGroup(
        { actor: { principal: { personId: "person-node-load" }, executor: null }, source: "local" },
        "admin",
      );
    try {
      for (const name of ["x", "y"]) {
        const repo = path.join(root, name);
        mkdirSync(path.join(repo, "harness"), { recursive: true });
        execFileSync("git", ["init", "-q", repo]);
        execFileSync("git", ["-C", repo, "config", "user.name", "Node Load Test"]);
        execFileSync("git", ["-C", repo, "config", "user.email", "node-load@example.invalid"]);
        execFileSync("git", ["-C", repo, "commit", "--allow-empty", "-qm", "base"]);
        writeFileSync(
          path.join(repo, "harness/harness.yaml"),
          `schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  runtime:\n    selectionStrategy: ${selectionStrategy}\n`,
        );
        cells.push(
          await openBootstrappedRepoCell({
            repoId: workspaceId(`node-load-${selectionStrategy}-${name}`),
            rootDir: canonicalRoot(repo),
            ownerId: "node-load-test",
            runtimeInstanceDispatchState: state,
            runtimeInstances: () => instances,
            prepareRuntimeLaunch: (instanceId, request) => ({
              definition: {
                schema: "agent-definition-snapshot/v1",
                configVersion: 1,
                instanceId,
                installationId: "pool-installation",
                kindId: "codex",
                providerId: "openai",
                model: "pool-model",
                reasoningEffort: null,
                baseUrl: null,
                authMode: "subscription",
              } satisfies AgentDefinitionSnapshot,
              installation: {
                installationId: "pool-installation",
                kindId: "codex",
                executablePath: "/fixture/codex",
                version: "0.147.0",
                observedAt: "2026-11-14T00:00:00.000Z",
              },
              executablePath: "/fixture/codex",
              args: [],
              env: {},
              cwd: request.cwd,
              prompt: request.prompt,
            }),
            runtimeLaunch: () => ({
              ...fixtureRuntimeProcess(t),
              onOutput: () => undefined,
              onErrorOutput: () => undefined,
              onExit: () => undefined,
            }),
          }),
        );
      }
      const [repoX, repoY] = cells;
      let sequence = 0;
      const spawn = async (cell: NonNullable<typeof repoX>, instanceId?: string) => {
        const receipt = await cell.spawnRuntime(
          {
            ...(instanceId === undefined ? {} : { runtimeInstanceId: instanceId }),
            cwd: { scope: "repo-root" },
            prompt: "Keep this instance busy",
            taskId: null,
            dispatchKey: `node-load-${++sequence}`,
          },
          binding,
        );
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        return {
          instanceId: (receipt.runtimeSelection as { readonly instanceId: string }).instanceId,
          runtimeSessionId: String(receipt.runtimeSessionId),
        };
      };
      const running = [await spawn(repoX!, "pro-a")];
      if (selectionStrategy === "lru") {
        running.push(await spawn(repoX!, "pro-a"));
        running.push(await spawn(repoX!, "pro-b"));
      }
      const firstY = await spawn(repoY!);
      assert.equal(firstY.instanceId, "pro-b", "repo Y must see repo X's node-local active load");
      for (const { runtimeSessionId } of running) {
        await repoX!.cancelRuntime({ runtimeSessionId }, binding);
        await repoX!.awaitRuntimeOutcome(runtimeSessionId);
      }
      const secondY = await spawn(repoY!);
      assert.equal(secondY.instanceId, "pro-a", "settled repo X attempts must not leave phantom load");
      for (const { runtimeSessionId } of [firstY, secondY]) {
        await repoY!.cancelRuntime({ runtimeSessionId }, binding);
        await repoY!.awaitRuntimeOutcome(runtimeSessionId);
      }
      assert.equal(state.readActiveLoads().size, 0, "all settled attempts release the shared host load");
      const idleX = await spawn(repoX!);
      await repoX!.cancelRuntime({ runtimeSessionId: idleX.runtimeSessionId }, binding);
      await repoX!.awaitRuntimeOutcome(idleX.runtimeSessionId);
      const idleY = await spawn(repoY!);
      assert.equal(
        idleY.instanceId === idleX.instanceId,
        selectionStrategy === "sticky",
        "separate writer threads must share recency after the pool becomes idle",
      );
    } finally {
      for (const cell of cells) await cell.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
