// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { readBundledAgentDeclaration } from "@harness-anything/preset";
import { makeTaskEventReader } from "@harness-anything/storage";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { startDaemon } from "../src/runtime.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { initIngressRepo, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test(
  "fresh repository installs portable identities and dispatches worker through the CLI",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-generic-agents-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      home = path.join(parent, "home"),
      repoId = "generic-agents",
      daemonId = "generic-agents",
      instanceId = "portable-provider",
      realm = await serveKeycloak(),
      promptFile = path.join(parent, "launched-prompt.txt");
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      rmSync(parent, { recursive: true, force: true });
    });
    mkdirSync(home);
    initIngressRepo(root, process.getuid?.() ?? 0);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    realm.bind(userRoot);
    realm.keycloak.account("owner");
    realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "owner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });
    // A real child process speaks the provider protocol without using host credentials or an API.
    const executablePath = writeProviderExecutable(
        path.join(parent, "provider.mjs"),
        `import fs from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(promptFile)}, prompt);
for (const frame of [
  { type: "thread.started", thread_id: "portable-worker-session" },
  { type: "item.completed", item: { id: "result", type: "agent_message", text: "portable worker completed" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
]) console.log(JSON.stringify(frame));
`,
      ),
      daemon = await startDaemon({
        daemonId,
        userRoot,
        buildSupersessionEnabled: false,
        runtimeDiscover: () => [
          {
            installationId: "portable-installation",
            kindId: "codex",
            executablePath,
            version: "1.0.0",
            observedAt: new Date().toISOString(),
          },
        ],
      });
    assert.ok("stop" in daemon);
    stop = daemon.stop;
    const rpc = (method: string, params: JsonObject) =>
        requestDaemonJsonRpcAt(daemon.endpoint, method, params, 1000, 30_000),
      run = (action: JsonObject) => rpc("repo.task.run", { repo: { repoId }, payload: { action } }),
      cli = async (expectedExit: number, ...args: string[]): Promise<JsonObject> => {
        const result = await spawnCli(["--root", root, "--json", ...args], {
          HOME: home,
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
          HARNESS_DAEMON_USER_ROOT: userRoot,
          HARNESS_DAEMON_ID: daemonId,
          HARNESS_DAEMON_ENDPOINT: daemon.endpoint,
          HARNESS_DAEMON_REPO_ID: repoId,
        });
        assert.equal(result.status, expectedExit, `${result.stderr}\n${result.stdout}`);
        return JSON.parse(result.stdout) as JsonObject;
      };
    const configured = await rpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId,
        name: "Portable provider",
        kindId: "codex",
        installationId: "portable-installation",
        providerId: "openai",
        models: ["portable-model"],
        permissionMode: "workspace-write",
        authMode: "subscription",
      },
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    assert.equal((await run({ kind: "settings-update", runtimeAllowedInstances: [instanceId] })).outcome, "applied");
    const roles = { defaultWorker: "worker", defaultReviewer: "reviewer", defaultCommander: "commander" };
    assert.equal((await cli(0, "settings", "update", "--roles", JSON.stringify(roles))).outcome, "applied");
    const created = await cli(0, "task", "create", "--title", "Portable worker dispatch", "--risk-tier", "low");
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const taskId = String(created.taskId);
    await realizeTaskPlanFixture(root, String(created.packagePath), (planPath: string) =>
      run({ kind: "doc-submit", paths: [planPath] }),
    );
    assert.equal(existsSync(path.join(root, "harness", "skills")), false);

    // Fresh repositories can use the shipped identities before installing any override.
    for (const role of ["worker", "reviewer", "commander"] as const) {
      const preview = await cli(
        0,
        "agent",
        "run",
        role,
        "--task",
        taskId,
        "--instance",
        instanceId,
        "--prompt",
        "Inspect the task.",
        "--dry-run",
      );
      assert.notEqual(preview.ok, false, JSON.stringify(preview));
      assert.equal(existsSync(promptFile), false, "dry-run must not launch the provider");
      const declaration = readBundledAgentDeclaration(role);
      assert.ok(declaration);
      const source = path.join(parent, `${role}.json`);
      writeFileSync(source, JSON.stringify(declaration));
      const installed = await cli(0, "agent", "install", "--source", source, "--expected-version", "0");
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
      const published = await cli(
        0,
        "receipt",
        "show",
        String(installed.opId),
        "--wait",
        "git_verified,worktree_visible",
      );
      assert.equal((published.wait as JsonObject).state, "satisfied", JSON.stringify(published));
      const materialized = JSON.parse(readFileSync(path.join(root, "harness", "agents", `${role}.json`), "utf8"));
      assert.deepEqual(materialized, declaration);
      assert.deepEqual(materialized.skills, []);
      t.diagnostic(`install ${role}: ${JSON.stringify(installed)}`);
    }
    assert.equal((await cli(0, "task", "start", taskId)).outcome, "applied");
    const receipt = await cli(0, "agent", "run", "worker", "--task", taskId, "--instance", instanceId);
    assert.equal(receipt.ok, true, JSON.stringify(receipt));
    assert.equal(receipt.outcome, "running", JSON.stringify(receipt));
    assert.equal(typeof receipt.dispatchId, "string", JSON.stringify(receipt));
    assert.equal(typeof receipt.runtimeSessionId, "string", JSON.stringify(receipt));
    const settled = await cli(1, "runtime", "status", String(receipt.runtimeSessionId), "--wait", "--no-stream");
    assert.equal(settled.ok, true, JSON.stringify(settled));
    // A dispatch-only provider submits no delivery: the task protocol must report that stop.
    assert.equal(settled.outcome, "stopped", JSON.stringify(settled));
    assert.equal(settled.code, "provider_exit");
    assert.equal(((settled.session as JsonObject).activity as JsonObject).exitCode, 0);
    assert.match(String((settled.result as JsonObject).text), /portable worker completed/u);
    assert.match(String(settled.reason), /worker exited without a submitted delivery/u);
    assert.match(readFileSync(promptFile, "utf8"), /# Agent Identity: worker \(worker\)/u);
    assert.match(readFileSync(promptFile, "utf8"), /# Worker Role/u);
    assert.match(readFileSync(promptFile, "utf8"), /Portable worker dispatch/u);
    assert.doesNotMatch(readFileSync(promptFile, "utf8"), /# Required Skills/u);
    const reader = makeTaskEventReader({ repoId, rootDir: root });
    try {
      const dispatched = reader
        .read()
        .events.find(
          (event) => event.type === "runtime_dispatch_requested" && event.payload.dispatchId === receipt.dispatchId,
        );
      assert.ok(dispatched?.type === "runtime_dispatch_requested");
      assert.equal(dispatched.payload.agentId, "worker");
      assert.equal(dispatched.payload.taskId, taskId);
      assert.equal(dispatched.payload.instanceId, instanceId);
      assert.equal(dispatched.payload.definitionSnapshot?.model, "portable-model");
      assert.equal(typeof dispatched.payload.executionId, "string");
    } finally {
      await reader.drain();
    }
    t.diagnostic(`worker dispatch: ${JSON.stringify(receipt)}`);
    t.diagnostic(`worker settlement: ${JSON.stringify(settled)}`);
  },
);
