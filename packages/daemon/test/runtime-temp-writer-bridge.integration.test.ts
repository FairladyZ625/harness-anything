// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { launchNative } from "../src/runtime-spawn-process.ts";
import { readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test(
  "writer bridge reclaims a terminal run while a parallel run stays live and reclaims failed launches",
  { timeout: 30000 },
  async () => {
    const sweeps: (readonly string[])[] = [],
      reclaimed: string[] = [];
    const root = mkdtempSync(path.join(tmpdir(), "ha-proxy-exit-")),
      executablePath = writeProviderExecutable(
        path.join(root, "provider.mjs"),
        `
      import fs from "node:fs";
      fs.readFileSync(0, "utf8");
      console.log(JSON.stringify({ type: "thread.started", thread_id: "proxy-provider" }));
      fs.writeFileSync(process.env.TMPDIR + "/ready", "ready");
      const timer = setInterval(() => {
        if (!fs.existsSync(process.env.TMPDIR + "/release")) return;
        clearInterval(timer);
        console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
        console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
      }, 10);
    `,
      ),
      definition = {
        schema: "agent-definition-snapshot/v1" as const,
        configVersion: 1,
        instanceId: "codex-proxy",
        installationId: "installation-codex",
        kindId: "codex" as const,
        providerId: "openai",
        model: "codex-model",
        reasoningEffort: null,
        baseUrl: null,
        authMode: "subscription" as const,
      },
      installation = {
        installationId: definition.installationId,
        kindId: definition.kindId,
        executablePath,
        version: "1.0.0",
        observedAt: new Date().toISOString(),
      };
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Test"],
      ["config", "user.email", "test@example.invalid"],
      ["commit", "--allow-empty", "-qm", "fixture"],
    ])
      execFileSync("git", ["-C", root, ...args]);
    const cellInput: Parameters<typeof openRepoCell>[0] = {
      repoId: workspaceId("proxy-exit"),
      rootDir: canonicalRoot(root),
      ownerId: "proxy-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, "user"),
        daemonId: "proxy-test",
        endpoint: path.join(root, "test.sock"),
      },
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Attached Tail",
          kindId: definition.kindId,
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "workspace-write",
          codex: {},
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      reclaimSettledRuntimeTempDirectories: (ids) => {
        sweeps.push(ids);
        return [];
      },
      reclaimRuntimeTempDirectory: (_instanceId, id) => {
        reclaimed.push(id);
        rmSync(path.join(root, "temp", id), { recursive: true, force: true });
        return reclaimed.length === 2
          ? Object.assign(new Error("EBUSY: bridge reclaim refusal"), { code: "EBUSY" })
          : null;
      },
      runtimeLaunch: (input, persistence) => {
        if (input.env.FAIL_LAUNCH)
          throw Object.assign(new Error("fixture launch refused"), { code: "fixture_refused" });
        return launchNative(input, persistence);
      },
      prepareRuntimeLaunch: async (_instanceId, request) => {
        const temp = path.join(root, "temp", request.runtimeSessionId!);
        mkdirSync(temp, { recursive: true });
        return {
          definition,
          installation,
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: {
            ...process.env,
            TMPDIR: path.join(root, "temp", request.runtimeSessionId!),
            ...(request.prompt.includes("fail launch") ? { FAIL_LAUNCH: "1" } : {}),
          },
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
    };
    let cell = await openRepoCell(cellInput);
    try {
      const binding = withPolicyGroup(
          { actor: { principal: { personId: "proxy-owner" }, executor: null }, source: "local" as const },
          "admin",
        ),
        taskId = "task-proxy-exit";
      for (const id of [taskId, "task-parallel-temp", "task-failed-temp"]) {
        const created = await cell.run({ kind: "task-create", taskId: id, title: id, presetId: "docs-task" }, binding);
        assert.equal(created.outcome, "applied", JSON.stringify(created));
        await waitForFixturePublication(cell, created.opId, binding);
        await realizeTaskPlanFixture(
          root,
          String(created.packagePath),
          (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
          id,
        );
        assert.equal((await cell.run({ kind: "task-start", taskId: id }, binding)).outcome, "applied");
      }
      const receipt = await cell.spawnRuntime(
          {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Wait for release",
            taskId,
            idempotencyKey: "proxy-exit",
          },
          binding,
        ),
        runtimeSessionId = String(receipt.runtimeSessionId);
      const temp = path.join(root, "temp", runtimeSessionId);
      await until(() => existsSync(path.join(temp, "ready")));
      assert.equal(sweeps.length, 1, "open-time sweep crosses the actual writer bridge");
      assert.deepEqual(sweeps[0], [], "an empty repo authorizes no global directories");
      const second = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Keep running",
          taskId: "task-parallel-temp",
          idempotencyKey: "parallel-temp",
          permissionMode: "read-only",
        },
        binding,
      );
      const secondId = String(second.runtimeSessionId),
        secondTemp = path.join(root, "temp", secondId);
      await until(() => existsSync(path.join(secondTemp, "ready")));
      writeFileSync(path.join(temp, "release"), "exit");
      await cell.awaitRuntimeOutcome(runtimeSessionId);
      assert.equal(existsSync(temp), false, "terminated run's temporary contents disappear");
      assert.equal(existsSync(secondTemp), true, "parallel live run retains its TMPDIR");
      assert.ok(reclaimed.includes(runtimeSessionId));
      assert.equal(reclaimed.includes(secondId), false);
      await cell.cancelRuntime({ runtimeSessionId: secondId }, binding);
      await cell.awaitRuntimeOutcome(secondId);
      assert.equal(existsSync(secondTemp), false);
      const terminal = readDispatchStreamSummary(root, String(second.dispatchId))!.terminalOutcome!;
      assert.equal(terminal.payload.outcome, "cancelled");
      assert.match(terminal.body, /EBUSY: bridge reclaim refusal/);
      await assert.rejects(
        cell.spawnRuntime(
          {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "fail launch",
            taskId: "task-failed-temp",
            idempotencyKey: "failed-temp",
            permissionMode: "read-only",
          },
          binding,
        ),
        { code: "fixture_refused", message: "fixture launch refused" },
      );
      assert.equal(reclaimed.length, 3, "failed provider launch also crosses the reclaim bridge");
      assert.equal(existsSync(path.join(root, "temp", reclaimed[2]!)), false);
      await cell.close();
      cell = await openRepoCell(cellInput);
      assert.equal(sweeps.length, 2);
      assert.deepEqual(
        [...sweeps[1]!].sort(),
        [runtimeSessionId, secondId].sort(),
        "startup bridge carries the repository's terminal IDs even after streams are archived",
      );
    } finally {
      await cell.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 12000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "expected runtime observation did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
