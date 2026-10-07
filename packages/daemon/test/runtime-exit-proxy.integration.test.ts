// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { withPolicyGroup, revokeTestPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { readDispatchStreamSummary } from "../src/dispatch-stream.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

test(
  "default host proxy ends an already parked wait and refuses attach after archive authorization is revoked",
  { timeout: 30000 },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-proxy-exit-")),
      release = path.join(root, "release"),
      ready = path.join(root, "ready"),
      executablePath = writeProviderExecutable(
        path.join(root, "provider.mjs"),
        `
      import fs from "node:fs";
      fs.readFileSync(0, "utf8");
      console.log(JSON.stringify({ type: "thread.started", thread_id: "proxy-provider" }));
      fs.writeFileSync(${JSON.stringify(ready)}, "ready");
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(release)})) return;
        clearInterval(timer);
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
    const cell = await openRepoCell({
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
      prepareRuntimeLaunch: async (_instanceId, request) => {
        return {
          definition,
          installation,
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: process.env,
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
    });
    try {
      const binding = withPolicyGroup(
          { actor: { principal: { personId: "proxy-owner" }, executor: null }, source: "local" as const },
          "admin",
        ),
        taskId = "task-proxy-exit",
        created = await cell.run(
          { kind: "task-create", taskId, title: "Proxy archive", presetId: "docs-task" },
          binding,
        );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
      await realizeTaskPlanFixture(
        root,
        String(created.packagePath),
        (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
        "Proxy archive",
      );
      assert.equal((await cell.run({ kind: "task-start", taskId }, binding)).outcome, "applied");
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
        runtimeSessionId = String(receipt.runtimeSessionId),
        dispatchId = String(receipt.dispatchId);
      await until(() => existsSync(ready));
      const live = await cell.attach(runtimeSessionId, "stream:0");
      assert.equal(live.initial.ok, true);
      live.detach();
      let returned = false;
      const wait = cell.awaitRuntimeOutcome(runtimeSessionId).then(() => {
        returned = true;
      });
      assert.equal(returned, false);
      revokeTestPolicyGroup("proxy-owner", "admin");
      writeFileSync(release, "exit");
      await until(() => Boolean(readDispatchStreamSummary(root, dispatchId)?.terminalOutcome));
      const stream = readDispatchStreamSummary(root, dispatchId)!;
      assert.equal(stream.process?.exited, true);
      assert.equal(stream.process?.exitCode, 0);
      assert.equal(stream.terminalOutcome?.payload.outcome, "failed");
      assert.match(stream.terminalOutcome!.body, /Runtime archive publication failed:/);
      const stopped = await cell.attach(runtimeSessionId, "stream:0");
      stopped.detach();
      assert.equal(stopped.initial.ok, false);
      await until(() => returned);
      await wait;
      const projection = makeTaskProjection({
        rootDir: root,
        eventStore: makeTaskEventReader({ repoId: "proxy-exit", rootDir: root }),
      });
      try {
        assert.equal(
          projection.readRuntimeSession(runtimeSessionId)?.outcome,
          null,
          "denied publication must not become canonical success",
        );
      } finally {
        projection.close();
      }
      const observed = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
      assert.equal(observed.session.liveness, "live", "public query retains the last center-accepted observation");
      assert.equal(observed.settlement, null, "denied publication cannot become a canonical settlement");
      assert.equal(observed.result, null);
      assert.equal(stream.terminalOutcome?.payload.outcome, "failed");
      assert.equal(stream.terminalOutcome?.payload.reasonCode, "authorization_denied");
      const terminal = stream.terminalOutcome!,
        canonicalAction = {
          kind: "event" as const,
          type: "runtime_session_outcome_observed" as const,
          opId: "proxy-canonical-outcome",
          payload: { ...terminal.payload, outcome: "cancelled" as const },
          resultBody: terminal.body,
        };
      await assert.rejects(cell.runtimeIngress(canonicalAction, binding), { code: "authorization_denied" });
      const restored = withPolicyGroup(binding, "admin");
      const published = await cell.runtimeIngress(canonicalAction, restored);
      assert.equal(published.outcome, "applied", JSON.stringify(published));
      const canonical = await cell.read("repo.agentRuntime.sessions.read", { runtimeSessionId });
      assert.equal(
        canonical.session.activity.outcome,
        "cancelled",
        "canonical outcome must beat the local failed stream",
      );
      assert.equal(readDispatchStreamSummary(root, dispatchId)?.terminalOutcome?.payload.outcome, "failed");
      await cell.awaitRuntimeOutcome(runtimeSessionId);
    } finally {
      writeFileSync(release, "exit");
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
