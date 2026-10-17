// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { startDaemon } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { initIngressRepo, eventuallyValue, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

// The ask-agent tool boundary end to end: the dispatched agent's environment carries the
// read-only execution credential, and the real CLI inside it finds allowlisted queries answered
// while everything outside the allowlist — reads and writes — is rejected by the daemon.
test(
  "the dispatched ask agent reaches only its allowlisted ledger queries through the real CLI",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-ask-allowlist-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = "ask-allowlist",
      daemonId = "ask-allowlist-test",
      envPath = path.join(parent, "ask-env.json"),
      realm = await serveKeycloak();
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      rmSync(parent, { recursive: true, force: true });
    });
    initIngressRepo(root, process.getuid?.() ?? 0);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    realm.bind(userRoot);
    realm.keycloak.account("owner");
    realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "owner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
    const executablePath = writeProviderExecutable(
      path.join(parent, "codex.mjs"),
      `
    import fs from "node:fs";
    import path from "node:path";
    if (process.argv[2] === "login" && process.argv[3] === "status") process.exit(0);
    fs.readFileSync(0, "utf8");
    const emit = (value) => console.log(JSON.stringify(value));
    emit({ type: "thread.started", thread_id: "provider-ask-session" });
    const keys = ["HARNESS_EXECUTION_CREDENTIAL", "HARNESS_EXECUTION_EXPIRES_AT", "HARNESS_TASK_BOUND", "HARNESS_DAEMON_ENDPOINT", "HARNESS_DAEMON_USER_ROOT", "HARNESS_DAEMON_ID", "HARNESS_DAEMON_REPO_ID", "HARNESS_DAEMON_RELAY"];
    const envPath = ${JSON.stringify(envPath)};
    fs.writeFileSync(envPath + ".tmp", JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k]]))));
    fs.renameSync(envPath + ".tmp", envPath);
    // The runtime's relay socket lives only while this worker host process does: stay alive
    // until the test releases the turn, so the real CLI inside the sandbox can reach the daemon.
    const finishPath = ${JSON.stringify(path.join(parent, "ask-finish"))};
    const finish = () => { if (!fs.existsSync(finishPath)) return;
      watcher.close();
      emit({ type: "item.completed", item: { id: "message", type: "agent_message", text: "问一句就答。" } });
      emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const watcher = fs.watch(${JSON.stringify(parent)}, finish);
    finish();
  `,
    );
    const daemon = await startDaemon({
      daemonId,
      userRoot,
      buildSupersessionEnabled: false,
      runtimeDiscover: () => [
        {
          installationId: "codex-fixture",
          kindId: "codex",
          executablePath,
          version: "1.0",
          observedAt: new Date().toISOString(),
        },
      ],
    });
    assert.ok("stop" in daemon);
    stop = daemon.stop;
    const rpc = (method: string, params: JsonObject) =>
        requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000),
      run = (action: JsonObject) => {
        const method = commandDescriptorForAction(String(action.kind)).method;
        const { kind: _kind, ...payload } = action;
        return rpc(method, {
          repo: { repoId },
          payload: method === "repo.task.run" || method === "repo.task.read" ? { action } : payload,
        });
      };
    const instance = await rpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "codex-ask",
        name: "Ask fixture",
        kindId: "codex",
        installationId: "codex-fixture",
        providerId: "openai",
        models: ["deepseek-flash"],
        permissionMode: "bypass",
        authMode: "subscription",
      },
    });
    assert.equal(instance.ok, true, JSON.stringify(instance));
    const settings = (await run({ kind: "settings-read" })) as {
      readonly outcome: string;
      readonly entityRevision: number;
      readonly settings: { readonly runtime?: { readonly allowedInstances?: readonly string[] } };
    };
    assert.equal(settings.outcome, "applied", JSON.stringify(settings));
    const allowed = await run({
      kind: "settings-update",
      runtimeAllowedInstances: [...(settings.settings.runtime?.allowedInstances ?? []), "codex-ask"],
      expectedVersion: settings.entityRevision,
    });
    assert.equal(allowed.outcome, "applied", JSON.stringify(allowed));

    const spawned = (await rpc("repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-ask",
        agentId: "ask-agent",
        taskId: null,
        cwd: { scope: "repo-root" },
        prompt: "重构组怎么样了？",
        dispatchKey: "ask-allowlist",
      },
    })) as { readonly outcome: string; readonly runtimeSessionId?: string };
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));

    const env = await eventuallyValue(() =>
      existsSync(envPath) ? (JSON.parse(readFileSync(envPath, "utf8")) as Record<string, string | undefined>) : null,
    );
    assert.match(String(env.HARNESS_EXECUTION_CREDENTIAL), /^harness-execution-dispatch_[a-z0-9]+:/u);
    assert.equal(env.HARNESS_TASK_BOUND, undefined);

    // The allowlisted queries answer through the real CLI; everything else — other reads and
    // every write — is refused by the daemon with the allowlist rejection, not by the prompt.
    const cli = async (args: readonly string[]) => {
      const response = await spawnCli(["--root", root, "--json", ...args], { ...process.env, ...env });
      return response;
    };
    const agenda = await cli(["agenda"]);
    assert.equal(agenda.status, 0, `allowlisted agenda read failed: ${agenda.stderr}${agenda.stdout}`);
    const workList = await cli(["work", "list"]);
    assert.equal(workList.status, 0, `allowlisted work list failed: ${workList.stderr}${workList.stdout}`);
    for (const [label, response] of [
      ["outside allowlist read", await cli(["agent", "list"])],
      ["outside allowlist write", await cli(["agent", "install", "--source", path.join(parent, "nope")])],
      ["ledger write", await cli(["settings-update", "--runtime-allowed-instance", "codex-other"])],
    ]) {
      assert.notEqual(response.status, 0, `${label} unexpectedly succeeded`);
      assert.match(
        `${response.stdout}${response.stderr}`,
        /execution_credential_rejected/u,
        `${label} must be refused by the daemon`,
      );
      assert.match(`${response.stdout}${response.stderr}`, /allowlisted ledger queries/u);
    }
    // Release the provider turn so the runtime settles and the test daemon can stop cleanly.
    writeFileSync(path.join(parent, "ask-finish"), "");
  },
);
