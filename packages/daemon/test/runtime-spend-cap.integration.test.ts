// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { appendRuntimeWorkerRecord, readDispatchStreamHeaders } from "../src/dispatch-stream.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { grantTestPolicyGroups, withPolicyGroup } from "./keycloak-policy.fixtures.ts";

const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-spend-cap",
  installationId: "installation-codex-spend-cap",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: "https://api.example.test/",
  authMode: "api-key",
};
const installation: RuntimeInstallationWitness = {
  installationId: definition.installationId,
  kindId: definition.kindId,
  executablePath: "/opt/witnessed/codex-spend-cap",
  version: "1.0.0",
  observedAt: "2026-10-24T00:00:00.000Z",
};

test("a dispatch over its declared token limit is terminated and settled with the cap reason", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spend-cap-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Spend Cap Test");
    git(root, "config", "user.email", "spend-cap@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    mkdirSync(path.join(root, "harness"), { recursive: true });
    writeFileSync(path.join(root, "harness", "harness.yaml"), "settings:\n  runtime:\n    dispatchTokenLimit: 100\n");
    grantTestPolicyGroups(["person-spend-cap"], "admin");
    let output: ((chunk: string) => void) | null = null,
      terminateCalls = 0;
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-spend-cap"),
      rootDir: canonicalRoot(root),
      ownerId: "spend-cap-test",
      runtimeInstances: () => [
        {
          schemaVersion: 2,
          instanceId: definition.instanceId,
          name: "Codex Spend Cap",
          kindId: "codex",
          installationId: definition.installationId,
          providerId: definition.providerId,
          models: [definition.model],
          defaultModel: definition.model,
          enabled: true,
          permissionMode: "bypass",
          codex: {
            reasoningEffort: definition.reasoningEffort,
            baseUrl: definition.baseUrl,
            baseUrlConfigured: true,
            wire_api: null,
            requires_openai_auth: null,
            http_headers: null,
          },
          authMode: definition.authMode,
          authState: "configured",
          authReadiness: { status: "ready", code: null, hint: null },
          isolationState: "enforced",
        },
      ],
      prepareRuntimeLaunch: (instanceId, request) => ({
        definition,
        installation,
        executablePath: installation.executablePath,
        args: ["exec", "--json", "-"],
        env: { HOME: "/isolated/codex-spend-cap/home", OPENAI_API_KEY: "resolved-only-in-daemon" },
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: (_input, persistence) => {
        appendRuntimeWorkerRecord(root, persistence.dispatchId, {
          kind: "process_started",
          occurredAt: "2026-10-24T00:00:01.000Z",
          pid: 4321,
        });
        return {
          pid: 4321,
          onOutput: (listener) => {
            output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => {
            terminateCalls += 1;
          },
        };
      },
    });
    try {
      const binding = withPolicyGroup(
          {
            actor: { principal: { personId: "person-spend-cap" }, executor: null },
            source: "local" as const,
          },
          "admin",
        ),
        receipt = await cell.spawnRuntime(
          {
            runtimeInstanceId: definition.instanceId,
            cwd: { scope: "repo-root" },
            prompt: "Consume past the declared limit.",
            taskId: null,
            dispatchKey: "spend-cap-over-limit",
          },
          binding,
        );
      assert.equal(receipt.outcome, "applied");
      assert.equal(
        readDispatchStreamHeaders(root).find((header) => header.dispatchId === receipt.dispatchId)?.tokenLimit,
        100,
      );
      output?.(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 80, output_tokens: 30 } }) + "\n");
      const settled = await eventuallyValue(async () => {
          const read = await cell.read("repo.agentRuntime.sessions.read", {
            runtimeSessionId: String(receipt.runtimeSessionId),
          });
          return read.session.activity.outcome === "failed" ? read : null;
        }),
        row = await cell.read("repo.agentRuntime.sessions.read", {
          runtimeSessionId: String(receipt.runtimeSessionId),
        });
      assert.equal(terminateCalls, 1);
      assert.equal(settled.session.activity.reasonCode, "runtime_spend_cap_exceeded");
      assert.equal(settled.settlement?.outcome, "failed");
      assert.match(settled.settlement?.reason ?? "", /110 tokens consumed \(limit 100\)/u);
      assert.equal(row.session.activity.outcome, "failed");
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function eventuallyValue<T>(read: () => T | null | Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runtime spend cap did not settle");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
