// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup, revokeTestPolicyActions } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { initIngressRepo } from "./fixtures/runtime-ingress.ts";

test("first dispatch mints one project snapshot without settings authority and preserves another project's empty list", async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-allowlist-")),
    binding = withPolicyGroup(
      { actor: { principal: { personId: "runtime-operator" }, executor: null }, source: "local" as const },
      "contributor",
    ),
    installation = {
      installationId: "installation-codex",
      kindId: "codex" as const,
      executablePath: process.execPath,
      version: "fixture",
      observedAt: "2026-10-11T00:00:00.000Z",
    },
    base: RuntimeInstanceSummary = {
      schemaVersion: 2,
      instanceId: "codex-api",
      name: "Codex",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["test-model"],
      defaultModel: "test-model",
      enabled: true,
      permissionMode: "read-only",
      isolationState: "enforced",
      codex: {},
      authMode: "subscription",
      authState: "configured",
      authReadiness: { status: "ready", code: null, hint: null },
    };
  let instances = [base];
  const cells: Awaited<ReturnType<typeof openBootstrappedRepoCell>>[] = [];
  try {
    for (const repoId of ["project-a", "project-b"]) {
      const root = path.join(parent, repoId);
      initIngressRepo(root, process.getuid?.() ?? 0);
      if (repoId === "project-b")
        appendFileSync(path.join(root, "harness/harness.yaml"), "  runtime:\n    allowedInstances: []\n");
      cells.push(
        await openBootstrappedRepoCell({
          repoId: workspaceId(repoId),
          rootDir: canonicalRoot(root),
          ownerId: "allowlist-test",
          runtimeInstances: () => instances,
          prepareRuntimeLaunch: async (instanceId, request) => ({
            definition: {
              schema: "agent-definition-snapshot/v1",
              configVersion: 1,
              instanceId,
              installationId: installation.installationId,
              kindId: "codex",
              providerId: "openai",
              model: "test-model",
              reasoningEffort: null,
              baseUrl: null,
              authMode: "subscription",
            },
            installation,
            executablePath: installation.executablePath,
            args: [],
            env: {},
            cwd: request.cwd,
            prompt: request.prompt,
          }),
          runtimeLaunch: () => ({
            pid: 4343,
            onOutput: () => undefined,
            onErrorOutput: () => undefined,
            onExit: () => undefined,
            terminate: () => undefined,
          }),
        }),
      );
    }
    const [a, b] = cells;
    revokeTestPolicyActions("runtime-operator", "project-a", ["settings-update"]);
    const denied = await a.run({ kind: "settings-update", runtimeAllowedInstances: [] }, binding);
    assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
    const spawn = (cell: typeof a, instanceId: string, key: string) =>
      cell.spawnRuntime(
        {
          runtimeInstanceId: instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Inspect project",
          taskId: null,
          idempotencyKey: key,
        },
        binding,
      );
    const first = await spawn(a, "codex-api", "first-a");
    assert.equal(first.outcome, "applied", JSON.stringify(first));
    assert.equal((await spawn(a, "codex-api", "second-a")).outcome, "applied");
    await assert.rejects(spawn(b, "codex-api", "blocked-b"), (error: Error & { code?: string }) => {
      assert.equal(error.code, "runtime_instance_not_allowed");
      assert.equal(
        error.message,
        "Runtime instance codex-api is not allowed for this repository. Allowed instances: none. Enable it with ha settings update --runtime-allowed-instance codex-api.",
      );
      t.diagnostic(`project B rejection: ${JSON.stringify({ code: error.code, message: error.message })}`);
      return true;
    });
    instances = [...instances, { ...base, instanceId: "later-codex" }];
    await assert.rejects(spawn(a, "later-codex", "later-a"), { code: "runtime_instance_not_allowed" });
    const events = makeTaskEventReader({ repoId: "project-a", rootDir: path.join(parent, "project-a") }).read().events;
    assert.equal(events.filter((event) => event.opId === "runtime-allowlist-auto-init-project-a").length, 1);
    assert.deepEqual((await a.read("repo.settings.read")).settings.runtime?.allowedInstances, ["codex-api"]);
    assert.deepEqual((await b.read("repo.settings.read")).settings.runtime?.allowedInstances, []);
  } finally {
    for (const cell of cells) await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
