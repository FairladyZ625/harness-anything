// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeSessionResult } from "../src/agent-runtime-contract.ts";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { RepoCellStatus } from "../src/repo-cell-types.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

test("the real writer relays completed runtime restorations before ready without relaunching models", async () => {
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
    const input = {
      repoId: workspaceId("adoption-ready"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "adoption-ready-test",
      onStatus: (status: RepoCellStatus) => statuses.push(status),
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
    cell = await openRepoCell(input);
    const binding = withPolicyGroup(
        { actor: { principal: { personId: "adoption-ready-operator" }, executor: null }, source: "local" as const },
        "admin",
      ),
      sessions: string[] = [];
    for (const idempotencyKey of ["first", "second"]) {
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          prompt: "adoption ready",
          idempotencyKey,
        },
        binding,
      );
      sessions.push(String(receipt.runtimeSessionId));
    }
    await cell.close();
    cell = undefined;
    statuses.length = 0;
    cell = await openRepoCell(input);
    assert.deepEqual(
      [
        ...new Set(
          statuses
            .filter((status) => status.attach?.phase === "restoring-runtimes")
            .map((status) => status.attach?.applied),
        ),
      ],
      [1, 2],
    );
    assert.equal(cell.status().state, "attached");
    assert.equal(cell.status().attach, undefined);
    assert.equal(launches, 2);
    for (const runtimeSessionId of sessions) {
      const session = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
      assert.equal((session as AgentRuntimeSessionResult).session.activity.outcome, "failed");
    }
    await cell.close();
    cell = undefined;
    statuses.length = 0;
    cell = await openRepoCell(input);
    assert.equal(
      statuses.some((status) => status.attach?.phase === "restoring-runtimes"),
      false,
      "terminal sessions do not settle twice",
    );
    assert.equal(launches, 2);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
