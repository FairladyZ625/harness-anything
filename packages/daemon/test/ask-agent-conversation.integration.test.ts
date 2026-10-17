// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader, makeTaskProjection, type AgentDefinitionSnapshot } from "@harness-anything/kernel";
import { readDispatchStream } from "../src/dispatch-stream.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";

import { grantTestPolicyGroups, withPolicyGroup } from "./keycloak-policy.fixtures.ts";

// The ask-agent conversation slice: an unbound read-only agent dispatch carries an allowlist
// execution credential, later rounds resume the same provider session, and the caller keeps
// naming the first dispatch while the daemon follows the resume chain to the current leaf.
test(
  "ask conversation keeps one provider session across chain-following resume rounds",
  { timeout: 60_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ask-conversation-")),
      root = path.join(parent, "repo"),
      providerSession = "provider-ask-session",
      repoId = workspaceId("ask-agent-conversation"),
      definition: AgentDefinitionSnapshot = {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "codex-ask",
        installationId: "installation-codex",
        kindId: "codex",
        providerId: "openai",
        model: "deepseek-flash",
        reasoningEffort: null,
        baseUrl: null,
        authMode: "subscription",
      };
    const launchRequests: { readonly prompt: string; readonly providerSessionId: string | undefined }[] = [],
      launchCredentials: readonly (string | undefined)[] = [];
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    mkdirSync(root, { recursive: true });
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Ask Conversation Test"],
      ["config", "user.email", "ask@example.invalid"],
      ["commit", "--allow-empty", "-qm", "base"],
    ])
      execFileSync("git", ["-C", root, ...args]);
    grantTestPolicyGroups(["fixture"], "admin");
    const binding = withPolicyGroup(
      { actor: { principal: { personId: "fixture" }, executor: null }, source: "local" },
      "admin",
    );
    const cell = await openBootstrappedRepoCell({
      repoId,
      rootDir: canonicalRoot(root),
      ownerId: "fixture",
      runtimeDaemonRoute: {
        userRoot: path.join(parent, "user"),
        daemonId: "ask-agent-conversation",
        endpoint: path.join(parent, "user", "ask-agent-conversation.sock"),
      },
      runtimeInstances: () =>
        [
          {
            schemaVersion: 2,
            instanceId: definition.instanceId,
            name: definition.instanceId,
            kindId: definition.kindId,
            installationId: definition.installationId,
            providerId: definition.providerId,
            models: [definition.model],
            defaultModel: definition.model,
            enabled: true,
            permissionMode: "bypass",
            codex: {
              reasoningEffort: null,
              baseUrl: null,
              baseUrlConfigured: false,
              wire_api: null,
              requires_openai_auth: null,
              http_headers: null,
            },
            authMode: "subscription",
            authState: "configured",
            authReadiness: { status: "ready", code: null, hint: null },
            isolationState: "enforced",
          },
        ] as never,
      prepareRuntimeLaunch: async (_instanceId, request) => {
        launchRequests.push({ prompt: request.prompt, providerSessionId: request.providerSessionId });
        return {
          definition,
          installation: {
            installationId: definition.installationId,
            kindId: definition.kindId,
            executablePath: "/fixture/codex",
            version: "1.0.0",
            observedAt: "2026-10-17T00:00:00.000Z",
          },
          executablePath: "/fixture/codex",
          args: [
            "exec",
            "--json",
            "--sandbox",
            "read-only",
            "--model",
            definition.model,
            ...(request.providerSessionId ? ["resume", request.providerSessionId] : []),
            "-",
          ],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: (prepared) => {
        launchCredentials.push(prepared.env.HARNESS_EXECUTION_CREDENTIAL);
        return askFakeProcess(
          prepared.prompt.includes("第一问")
            ? "第一轮答案：重构组有 3 项在进行。"
            : "第二轮：继续第一轮的结论，引用 provider-ask-session。",
        );
      },
    });
    try {
      const projection = () =>
        makeTaskProjection({ rootDir: root, eventStore: makeTaskEventReader({ rootDir: root, repoId }) });
      const awaitSettled = async (runtimeSessionId: string): Promise<void> => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const read = projection(),
            session = read.readRuntimeSessions().find((row) => row.runtimeSessionId === runtimeSessionId);
          read.close();
          if (session && session.liveness === "exited" && session.outcome !== null) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(`runtime ${runtimeSessionId} did not settle`);
      };

      // Round one: the ordinary runtime spawn; the ask agent resolves from the bundled layer.
      const first = (await cell.spawnRuntime(
        {
          agentId: "ask-agent",
          cwd: { scope: "repo-root" },
          prompt: "第一问：重构组怎么样了？",
          dispatchKey: "ask-round-1",
        },
        binding,
      )) as { readonly dispatchId: string; readonly runtimeSessionId: string };
      const firstId = String(first.dispatchId);
      await awaitSettled(String(first.runtimeSessionId));
      const firstStream = readDispatchStream(root, firstId);
      assert.ok(firstStream, "round-one dispatch stream exists");
      assert.equal(firstStream.providerSessionId, providerSession);
      assert.equal(firstStream.header.agentId, "ask-agent");
      assert.equal(firstStream.header.permissionMode, "read-only");

      // Round two: resuming the conversation continues the same provider session and links to
      // the round it continues; the launch carries a fresh allowlist credential.
      const second = (await cell.spawnRuntime(
        { dispatchId: firstId, prompt: "第二问：引用第一轮的结论", dispatchKey: "ask-round-2" },
        binding,
      )) as { readonly dispatchId: string; readonly runtimeSessionId: string };
      const secondId = String(second.dispatchId);
      await awaitSettled(String(second.runtimeSessionId));
      const secondStream = readDispatchStream(root, secondId);
      assert.ok(secondStream, "round-two dispatch stream exists");
      assert.equal(secondStream.providerSessionId, providerSession);
      assert.equal(secondStream.header.resumedFromDispatchId, firstId);
      assert.equal(secondStream.header.permissionMode, "read-only");

      // Round three names the first dispatch again — the daemon follows the chain to the leaf
      // so the new round continues the second, not the exhausted first.
      const third = (await cell.spawnRuntime(
        { dispatchId: firstId, prompt: "第三问：还在吗", dispatchKey: "ask-round-3" },
        binding,
      )) as { readonly dispatchId: string; readonly runtimeSessionId: string };
      await awaitSettled(String(third.runtimeSessionId));
      const thirdStream = readDispatchStream(root, String(third.dispatchId));
      assert.ok(thirdStream, "round-three dispatch stream exists");
      assert.equal(thirdStream.providerSessionId, providerSession);
      assert.equal(thirdStream.header.resumedFromDispatchId, secondId);

      // Every round launched against the same provider session, and each carried the
      // read-only execution credential minted for its own dispatch.
      assert.deepEqual(
        launchRequests.map((request) => request.providerSessionId ?? null),
        [null, providerSession, providerSession],
      );
      assert.equal(launchCredentials.length, 3);
      for (const [index, credential] of launchCredentials.entries())
        assert.match(
          String(credential),
          new RegExp(`^harness-execution-${String([first, second, third][index]!.dispatchId)}:`),
          `round ${index + 1} credential is scoped to its own dispatch`,
        );

      // The built-in agent's lifecycle stays closed even while the conversation used it.
      const retired = (await cell.run(
        { kind: "agent-retire", agentId: "ask-agent", reason: "replace" } as never,
        binding,
      )) as { readonly outcome: string; readonly code?: string };
      assert.equal(retired.outcome, "op_rejected");
      assert.equal(retired.code, "agent_system_builtin");
      const deleted = (await cell.run(
        { kind: "agent-delete", agentId: "ask-agent", reason: "replace", expectedVersion: 1 } as never,
        binding,
      )) as { readonly outcome: string; readonly code?: string };
      assert.equal(deleted.outcome, "op_rejected");
      assert.equal(deleted.code, "agent_system_builtin");
    } finally {
      await cell.close();
    }
  },
);

/** A Codex-shaped fake that always binds the one conversation provider session and succeeds. */
function askFakeProcess(answer: string): RuntimeProcess {
  let output: ((chunk: string) => void) | null = null,
    exit: ((code: number | null) => void) | null = null;
  return {
    pid: Math.floor(Math.random() * 100_000) + 1,
    onOutput: (listener) => {
      output = listener;
    },
    onErrorOutput: () => undefined,
    onExit: (listener) => {
      exit = listener;
      setImmediate(() => {
        const frames = [
          { type: "thread.started", thread_id: "provider-ask-session" },
          { type: "item.completed", item: { id: "message", type: "agent_message", text: answer } },
          { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
        ];
        output?.(`${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`);
        exit?.(0);
      });
    },
    terminate: () => undefined,
  };
}
