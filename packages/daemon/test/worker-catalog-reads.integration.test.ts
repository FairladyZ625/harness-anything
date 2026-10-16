// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  makeTaskEventReader,
  makeTaskProjection,
} from "@harness-anything/kernel";
import { openRepoCell } from "../src/repo-cell-open.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { startDaemon } from "../src/runtime.ts";
import { requestDaemonJsonRpcAt } from "../src/client/local-json-rpc-client.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { createRealizedTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { initIngressRepo, eventuallyValue, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { commandDescriptorForAction } from "../src/protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

// The dispatched implementer's catalog reads (dec_9DFDC635180975FDFC0CDB33D7): the real daemon,
// Keycloak fixture, spawned runtime credential, and CLI binary drive preset list/inspect,
// vertical validate, and own-package doc show while writes and outside paths stay rejected.
test(
  "dispatched implementers read the preset catalog and their own package documents",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-worker-reads-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      repoId = "worker-reads",
      daemonId = "worker-reads-test",
      realm = await serveKeycloak();
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      rmSync(parent, { recursive: true, force: true });
    });
    initIngressRepo(root, process.getuid?.() ?? 0);
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
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
    const id = process.env.HARNESS_ACTOR.split(":").at(-1), dir = ${JSON.stringify(parent)};
    console.log(JSON.stringify({ type: "thread.started", thread_id: id }));
    const keys = ["HARNESS_EXECUTION_CREDENTIAL", "HARNESS_EXECUTION_EXPIRES_AT", "HARNESS_ACTOR", "HARNESS_DAEMON_USER_ROOT", "HARNESS_DAEMON_ID", "HARNESS_DAEMON_ENDPOINT", "HARNESS_DAEMON_REPO_ID", "HARNESS_CANONICAL_ROOT", "HARNESS_TASK_BOUND", "HARNESS_DAEMON_RELAY"];
    const envPath = path.join(dir, id + ".json");
    fs.writeFileSync(envPath + ".tmp", JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k]]))), { mode: 0o600 });
    fs.renameSync(envPath + ".tmp", envPath);
    const finish = () => { if (!fs.existsSync(path.join(dir, id + ".finish"))) return;
      watcher.close(); console.log(JSON.stringify({ type: "item.completed", item: { id: "final", type: "agent_message", text: "Reads exercised." } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })); };
    const watcher = fs.watch(dir, finish); finish();
  `,
    );
    const opened = Promise.withResolvers<Awaited<ReturnType<typeof openRepoCell>>>();
    const daemon = await startDaemon({
      daemonId,
      userRoot,
      buildSupersessionEnabled: false,
      openCell: (input) => {
        const opening = openRepoCell(input);
        opened.resolve(opening);
        return opening;
      },
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
    await opened.promise;
    const instance = await rpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId: "codex-worker",
        name: "Catalog reader",
        kindId: "codex",
        installationId: "codex-fixture",
        providerId: "openai",
        models: ["fixture"],
        permissionMode: "workspace-write",
        authMode: "subscription",
      },
    });
    assert.equal(instance.ok, true, JSON.stringify(instance));
    const settings = await run({ kind: "settings-read" });
    assert.equal(settings.outcome, "applied", JSON.stringify(settings));
    const projectUse = await run({
      kind: "settings-update",
      runtimeAllowedInstances: [
        ...((settings.settings as { runtime?: { allowedInstances?: string[] } }).runtime?.allowedInstances ?? []),
        "codex-worker",
      ],
      expectedVersion: settings.entityRevision,
    });
    assert.equal(projectUse.outcome, "applied", JSON.stringify(projectUse));
    const taskId = "task-reads";
    await createRealizedTaskPlanFixture(
      root,
      async () => {
        const created = await run({
          kind: "task-create",
          taskId,
          title: "Worker catalog reads",
          presetId: "docs-task",
        });
        await run({
          kind: "receipt-show",
          opId: created.opId,
          waitFor: ["git_verified", "worktree_visible"],
          timeoutMs: 5000,
        });
        return created;
      },
      (planPath: string) => run({ kind: "doc-submit", paths: [planPath] }),
      "Worker catalog reads",
    );
    const started = await run({ kind: "task-start", taskId, executionId: "execution-reads" });
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    const read = makeTaskProjection({ rootDir: root, eventStore: makeTaskEventReader({ rootDir: root, repoId }) }),
      packagePath = read.read(taskId).packagePath!;
    read.close();
    const spawned = await rpc("repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-worker",
        cwd: { scope: "repo-root" },
        taskId,
        prompt: "Exercise catalog reads.",
        dispatchKey: "worker-reads",
      },
    });
    assert.equal(spawned.outcome, "applied", JSON.stringify(spawned));
    const runtime = String(spawned.runtimeSessionId),
      env = await eventuallyValue(async () =>
        existsSync(path.join(parent, `${runtime}.json`))
          ? (JSON.parse(readFileSync(path.join(parent, `${runtime}.json`), "utf8")) as NodeJS.ProcessEnv)
          : null,
      );
    assert.ok(env.HARNESS_EXECUTION_CREDENTIAL);
    const cli = async (args: string[]) => {
      const response = await spawnCli(["--root", root, "--json", ...args], { ...process.env, ...env });
      assert.ok(response.stdout.trim(), response.stderr);
      return { receipt: JSON.parse(response.stdout) as JsonObject, status: response.status };
    };

    const catalog = await cli(["preset", "list"]);
    assert.equal(catalog.receipt.outcome, "applied", JSON.stringify(catalog.receipt));
    const inspected = await cli(["preset", "inspect", "docs-task"]);
    assert.equal(inspected.receipt.outcome, "applied", JSON.stringify(inspected.receipt));
    // An in-repository source runs the validator itself (its report owns availability).
    const validated = await cli(["vertical", "validate", "--source", "verticals/none"]);
    assert.equal(validated.receipt.outcome, "applied", JSON.stringify(validated.receipt));
    const plan = await cli(["doc", "show", "--path", `${packagePath}/task_plan.md`]);
    assert.equal(plan.receipt.outcome, "applied", JSON.stringify(plan.receipt));
    assert.ok(String(plan.receipt.evidence).includes("Worker catalog reads"));

    // dec_CF96A3C910B31D2D7498F32DDD/CH2: foreign reads reach document lookup; foreign writes stay denied.
    const otherPlan = await cli(["doc", "show", "--path", "tasks/task-other/task_plan.md"]);
    assert.equal(otherPlan.receipt.code, "document_not_found", JSON.stringify(otherPlan.receipt));

    for (const [args, label] of [
      [["preset", "install", "--source", "."], "catalog writes"],
      [["task", "progress", "append", "task-other", "--text", "foreign write"], "other task writes"],
      [["vertical", "validate", "--source", "/etc"], "sources outside the repository"],
      [["script", "run", "vertical:none:none"], "script execution"],
    ] as const) {
      const denied = await cli(args as unknown as string[]);
      assert.equal(denied.receipt.code, "execution_credential_rejected", `${label}: ${JSON.stringify(denied.receipt)}`);
      assert.notEqual(denied.status, 0, `${label} must exit non-zero on an error receipt`);
    }
    // The per-dispatch relay socket lives only while the provider runs, so the worker completes
    // on this marker after the CLI reads; the early cleanup hook then stops the fixture daemon.
    writeFileSync(path.join(parent, `${runtime}.finish`), "finish");
  },
);
