// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { makeTaskEventReader } from "@harness-anything/storage";
import { startDaemon, readDaemonPid } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { createRuntimeCallbackRelay } from "../src/runtime-callback-relay.ts";
import { authenticateRuntimeExecutionCredential } from "../src/runtime-execution-credential.ts";
import { dispatchStreamPath } from "../src/dispatch-stream.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { initIngressRepo, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";
import type { PreparedRuntimeLaunch } from "../src/agent-runtime-instances.ts";
import type { RuntimeCallbackRelay } from "../src/runtime-spawn-types.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

test(
  "unbound runtime CLI uses the spawning daemon and person without a task lease",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-unbound-cli-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = "unbound-repo",
      daemonId = "unbound-test",
      realm = await serveKeycloak(),
      launches: { prepared: PreparedRuntimeLaunch; relay?: RuntimeCallbackRelay }[] = [],
      relays: ReturnType<typeof createRuntimeCallbackRelay>[] = [];
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      for (const relay of relays) await relay.stop();
      await stop();
      await realm.close();
      rmSync(parent, { recursive: true, force: true });
    });
    initIngressRepo(root, process.getuid?.() ?? 0);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    realm.bind(userRoot);
    realm.keycloak.account("spawner");
    realm.keycloak.permit("spawner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "spawner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
    const executablePath = writeProviderExecutable(path.join(parent, "codex.mjs"), "process.exit(0);\n"),
      daemon = await startDaemon({
        daemonId,
        userRoot,
        buildSupersessionEnabled: false,
        runtimeDiscover: () => [
          {
            installationId: "fixture",
            kindId: "codex",
            executablePath,
            version: "1.0",
            observedAt: new Date().toISOString(),
          },
        ],
        runtimeLaunch: (prepared, persistence) => {
          launches.push({ prepared, relay: persistence?.callbackRelay });
          return { pid: 4310, onOutput: () => {}, onErrorOutput: () => {}, onExit: () => {}, terminate: () => {} };
        },
      });
    assert.ok("stop" in daemon);
    stop = daemon.stop;
    const rpc = (method: string, params: JsonObject) =>
        requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000),
      run = (action: JsonObject) => rpc("repo.task.run", { repo: { repoId }, payload: { action } });
    assert.equal(
      (
        await rpc("daemon.runtimeInstance.create", {
          payload: {
            instanceId: "codex-session",
            name: "Session",
            kindId: "codex",
            installationId: "fixture",
            providerId: "openai",
            models: ["fixture"],
            permissionMode: "workspace-write",
            authMode: "subscription",
          },
        })
      ).ok,
      true,
    );
    assert.equal(
      (await run({ kind: "settings-update", runtimeAllowedInstances: ["codex-session"] })).outcome,
      "applied",
    );
    assert.equal(
      (
        await run({
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id: "session-child",
            name: "Session child",
            role: "worker",
            instructions: "Inspect the repository.",
            runtimes: [{ type: "codex" }],
            instance: "codex-session",
          },
        })
      ).outcome,
      "applied",
    );
    const spawnParams = {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-session",
        taskId: null,
        cwd: { scope: "repo-root" },
        prompt: "Coordinate repository work.",
        dispatchKey: "unbound-session",
      },
    };
    await rpc("daemon.rbac.manage", { operation: "logout", rootDir: root });
    assert.equal((await rpc("repo.agentRuntime.spawn", spawnParams)).code, "authentication_required");
    assert.equal(launches.length, 0, "an unauthenticated spawn must not launch a process");
    signInAt(userRoot, "spawner");
    const spawned = await rpc("repo.agentRuntime.spawn", spawnParams);
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const launch = launches[0]!,
      env = launch.prepared.env;
    assert.equal(env.HARNESS_DAEMON_USER_ROOT, userRoot);
    assert.equal(env.HARNESS_DAEMON_ID, daemonId);
    assert.equal(env.HARNESS_DAEMON_REPO_ID, repoId);
    assert.equal(env.HARNESS_ACTOR, `agent:runtime-session:${spawned.runtimeSessionId}`);
    assert.equal(env.HARNESS_TASK_BOUND, undefined);
    assert.ok(env.HARNESS_EXECUTION_CREDENTIAL);
    assert.ok(Date.parse(env.HARNESS_EXECUTION_EXPIRES_AT!) > Date.now());
    assert.notEqual(env.HOME, process.env.HOME);
    if (launch.relay) {
      // The production worker host opens this exact relay using only the in-memory manifest.
      assert.equal(env.HARNESS_DAEMON_ENDPOINT, launch.relay.path);
      const relay = createRuntimeCallbackRelay({
        dispatchId: String(spawned.dispatchId),
        route: { userRoot, daemonId, endpoint: daemon.endpoint },
        relayPath: launch.relay.path,
        executionCredential: env.HARNESS_EXECUTION_CREDENTIAL,
      });
      relays.push(relay);
      await relay.start();
    } else assert.equal(env.HARNESS_DAEMON_ENDPOINT, daemon.endpoint);
    // Strip host identity/configuration; the child CLI receives only its prepared runtime route,
    // credential and isolated HOME. No fixture writes the execution secret to a file.
    const childEnv: NodeJS.ProcessEnv = {
      HOME: env.HOME,
      PATH: env.PATH,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      ...Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("HARNESS_"))),
    };
    const cli = async (args: string[], overrides: NodeJS.ProcessEnv = {}) => {
      const result = await spawnCli(["--root", root, "--json", ...args], { ...childEnv, ...overrides });
      assert.ok(result.stdout.trim(), result.stderr);
      return JSON.parse(result.stdout) as JsonObject;
    };
    writeFileSync(path.join(root, "session-plan.md"), realizedTaskPlan("Session task"));
    const created = await cli([
      "task",
      "create",
      "--title",
      "Session task",
      "--preset",
      "docs-task",
      "--risk-tier",
      "low",
      "--plan-file",
      "session-plan.md",
    ]);
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const event = makeTaskEventReader({ repoId, rootDir: root })
      .read()
      .events.find((entry) => entry.type === "task_bootstrapped" && entry.opId === created.opId);
    assert.equal(event?.actor.principal.personId, "spawner");
    assert.equal(event?.actor.executor?.id, `runtime-session:${spawned.runtimeSessionId}`);
    const taskId = String(created.taskId);
    assert.equal((await cli(["task", "start", taskId])).outcome, "applied");
    const nested = await cli([
      "agent",
      "run",
      "session-child",
      "--task",
      taskId,
      "--detach",
      "--prompt",
      "Inspect the newly created task.",
    ]);
    assert.equal(nested.outcome, "running", JSON.stringify(nested));
    assert.equal(launches.length, 2, "the same daemon must receive the detached child dispatch");
    const child = await authenticateRuntimeExecutionCredential(
      {
        url: realm.url,
        realm: "harness",
        clientId: "harness-center",
        accessToken: "center-token",
      },
      launches[1]!.prepared.env.HARNESS_EXECUTION_CREDENTIAL!,
    );
    assert.equal(child.personId, "spawner");
    assert.equal(child.repoId, repoId);
    assert.equal(child.role, "implementation");
    assert.equal(child.taskId, taskId);
    const reviewer = await rpc("repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        ...spawnParams.payload,
        role: "reviewer",
        dispatchKey: "decision-reviewer",
        reviewTarget: { kind: "decision", decisionId: "dec-review-target", digest: "review-cut" },
      },
    });
    assert.equal(reviewer.outcome, "applied", JSON.stringify(reviewer));
    assert.equal(
      launches[2]!.prepared.env.HARNESS_EXECUTION_CREDENTIAL,
      undefined,
      "a Decision-bound reviewer must not be reclassified as a general session",
    );
    const direct = { HARNESS_DAEMON_ENDPOINT: daemon.endpoint, HARNESS_DAEMON_RELAY: "" };
    assert.equal(
      (await cli(["task", "list"], { ...direct, HARNESS_EXECUTION_CREDENTIAL: "invalid" })).code,
      "execution_credential_rejected",
    );
    realm.keycloak.revoke("spawner", repoId, ["task-create"]);
    assert.equal((await cli(["task", "create", "--title", "Denied"])).code, "authorization_denied");
    realm.keycloak.account("other");
    realm.keycloak.permit("other", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "other");
    assert.equal(
      (await cli(["task", "list"])).code,
      "execution_credential_rejected",
      "changing the device person cannot change the dispatch principal",
    );
    signInAt(userRoot, "spawner");
    const clients = (await (
      await fetch(`${realm.url}/admin/realms/harness/clients?clientId=harness-execution-${spawned.dispatchId}`)
    ).json()) as { id: string; attributes: { harness_execution: string } }[];
    await fetch(`${realm.url}/admin/realms/harness/clients/${clients[0]!.id}`, {
      method: "PUT",
      body: JSON.stringify({
        attributes: {
          harness_execution: JSON.stringify({
            ...JSON.parse(clients[0]!.attributes.harness_execution),
            expiresAt: new Date(Date.now() - 1).toISOString(),
          }),
        },
      }),
    });
    assert.equal((await cli(["task", "list"])).code, "execution_credential_rejected");
    assert.ok(
      !readFileSync(dispatchStreamPath(root, String(spawned.dispatchId)), "utf8").includes(
        env.HARNESS_EXECUTION_CREDENTIAL!,
      ),
    );
    await stop();
    stop = async () => {};
    const unavailable = await cli(["task", "list"], direct);
    assert.equal((unavailable.error as JsonObject).code, "daemon_start_runtime_forbidden");
    assert.equal(readDaemonPid(userRoot, daemonId), null, "an unbound runtime cannot create a replacement daemon");
  },
);
