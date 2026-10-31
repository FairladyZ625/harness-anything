// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection, type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { openDispatchStream, readDispatchStream } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import { grantTestPolicyGroups } from "./keycloak-policy.fixtures.ts";

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
    grantTestPolicyGroups(["fixture"], "admin");
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
      runtimeInstances: () =>
        [
          {
            instanceId: definition.instanceId,
            enabled: true,
            kindId: definition.kindId,
            models: [definition.model],
            defaultModel: definition.model,
          },
        ] as never,
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
      for (const dispatchKey of ["rejected-first", "rejected-retry"])
        await assert.rejects(
          cell.spawnRuntime(
            { dispatchId, dispatchKey, prompt: "Continue work" },
            withPolicyGroup(
              { actor: { principal: { personId: "fixture" }, executor: null }, source: "local" },
              "admin",
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

test("a rejected task resume keeps its primary error when lease stop proof is unresolved", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-resume-rejected-stop-proof-")),
    repoId = workspaceId("resume-rejected-stop-proof"),
    taskId = "task-resume-rejected-stop-proof",
    executionId = "execution-resume-rejected-stop-proof",
    sourceDispatchId = "dispatch_abcdefabcdefabcdefabcdef",
    sourceRuntimeSessionId = "runtime-source-stop-proof",
    definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "codex-stop-proof",
      installationId: "installation-codex-stop-proof",
      kindId: "codex",
      providerId: "openai",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      baseUrl: null,
      authMode: "subscription",
    };
  try {
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Resume Stop Proof Test"],
      ["config", "user.email", "resume-stop-proof@example.invalid"],
      ["commit", "--allow-empty", "-qm", "base"],
    ])
      execFileSync("git", ["-C", root, ...args]);
    grantTestPolicyGroups(["fixture"], "admin");
    const writer = openDispatchStream(root, {
      dispatchId: sourceDispatchId,
      taskId,
      executionId,
      runtimeSessionId: sourceRuntimeSessionId,
      instanceId: definition.instanceId,
      kindId: definition.kindId,
      startedAt: "2026-09-30T00:00:00.000Z",
      cwd: root,
      prompt: "Continue task work",
      model: definition.model,
    });
    writer.appendProviderBinding("provider-source-stop-proof", "2026-09-30T00:00:01.000Z");
    let launches = 0;
    const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "fixture",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "resume-stop-proof",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () =>
        [
          {
            instanceId: definition.instanceId,
            enabled: true,
            kindId: definition.kindId,
            models: [definition.model],
            defaultModel: definition.model,
          },
        ] as never,
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
        args: ["exec", "resume", "provider-source-stop-proof"],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: () => {
        launches += 1;
        return {
          // The fixture deliberately has no independent process group and never proves this
          // synthetic host stopped. A real provider rejection is delivered immediately below.
          pid: process.pid,
          onOutput: () => undefined,
          onErrorOutput: (listener) => listener("provider rejected before confirming session"),
          onExit: (listener) => listener(1),
          terminate: () => undefined,
        };
      },
    });
    try {
      const binding = withPolicyGroup(
        { actor: { principal: { personId: "fixture" }, executor: null }, source: "local" },
        "admin",
      );
      const created = await cell.run(
        { kind: "task-create", taskId, title: "Resume stop proof", presetId: "docs-task" },
        binding,
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String((created as Record<string, unknown>).packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Resume stop proof",
      );
      const started = await cell.run({ kind: "task-start", taskId, executionId }, binding);
      assert.equal(started.outcome, "applied", JSON.stringify(started));
      let failure: unknown;
      try {
        await cell.spawnRuntime(
          { dispatchId: sourceDispatchId, dispatchKey: "rejected-task-stop-proof", prompt: "Continue task work" },
          binding,
        );
      } catch (error) {
        failure = error;
      }
      assert.equal(
        (failure as { readonly code?: string } | undefined)?.code,
        "runtime_resume_failed",
        failure instanceof Error ? failure.message : String(failure),
      );
      assert.equal(launches, 1);
      const hash = createHash("sha256").update(`${repoId}\0rejected-task-stop-proof`).digest("hex");
      const rejectedDispatchId = `dispatch_${hash.slice(0, 24)}`;
      assert.ok(
        readDispatchStream(root, rejectedDispatchId),
        "unresolved cleanup keeps the rejection stream for proof",
      );
      const projection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventReader({ repoId, rootDir: root }),
      });
      try {
        assert.equal(
          projection.read(taskId).snapshot.lease?.actor.executor?.id,
          `runtime-session:runtime_${hash.slice(24, 48)}`,
          "A6 must keep the lease held when the process group is not proven stopped",
        );
      } finally {
        projection.close();
      }
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
