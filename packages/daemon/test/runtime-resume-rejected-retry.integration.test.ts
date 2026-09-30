// harness-test-tier: integration
import assert from "node:assert/strict";
import { withRoleBinding } from "./role-binding.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { openDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";

import { writeOwnerRoster } from "./role-binding.fixtures.ts";

test("a provider-rejected local resume leaves its source available for another admission", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-resume-rejected-retry-"));
  const definition: AgentDefinitionSnapshot = {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: "codex-retry",
    installationId: "installation-codex",
    kindId: "codex",
    providerId: "openai",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    baseUrl: null,
    authMode: "subscription",
  };
  const dispatchId = "dispatch_0123456789abcdef01234567";
  let launches = 0;
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Resume Test"],
      ["config", "user.email", "resume@example.invalid"],
      ["commit", "--allow-empty", "-qm", "base"],
    ])
      execFileSync("git", ["-C", root, ...args]);
    writeOwnerRoster(root, ["fixture"]);
    const writer = openDispatchStream(root, {
      dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-source",
      instanceId: definition.instanceId,
      startedAt: "2026-09-30T00:00:00.000Z",
      cwd: root,
      prompt: "Continue work",
      model: definition.model,
    });
    writer.appendProviderBinding("provider-source", "2026-09-30T00:00:01.000Z");
    const cell = await openBootstrappedRepoCell({
      repoId: workspaceId("resume-rejected-retry"),
      rootDir: canonicalRoot(root),
      ownerId: "fixture",
      runtimeInstances: () => [],
      prepareRuntimeLaunch: (_instanceId, request) => ({
        definition,
        installation: {
          installationId: definition.installationId,
          kindId: definition.kindId,
          executablePath: "/fixture/codex",
          version: "1.0.0",
          observedAt: "2026-09-30T00:00:00.000Z",
        },
        executablePath: "/fixture/codex",
        args: ["exec", "resume", "provider-source"],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => {
        launches++;
        return {
          pid: 0,
          onOutput: () => undefined,
          onErrorOutput: (listener) => listener("provider unavailable before confirming session"),
          onExit: (listener) => listener(1),
          terminate: () => undefined,
        };
      },
    });
    try {
      for (const idempotencyKey of ["rejected-first", "rejected-retry"])
        await assert.rejects(
          cell.spawnRuntime(
            { dispatchId, idempotencyKey, prompt: "Continue work" },
            withRoleBinding(
              { actor: { principal: { personId: "fixture" }, executor: null }, source: "local" },
              "owner",
            ),
          ),
          (error: unknown) =>
            error instanceof Error && (error as Error & { code?: string }).code === "runtime_resume_failed",
          "each rejected attempt must reach provider admission, rather than consume the source",
        );
      assert.equal(launches, 2);
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
