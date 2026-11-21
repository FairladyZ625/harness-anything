// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveBasePolicyGroups, effectivePolicyGroupScopes } from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import type { JsonObject } from "../src/daemon-host/protocol/json-rpc-types.ts";
import { registerBootstrappedDaemonRepo } from "./repo-settings.fixture.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { initIngressRepo, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

test(
  "CLI vertical list enumerates builtin verticals, links to preset list, and office/collab dispatches bundled roles through production daemon and GUI catalog",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-office-collab-prod-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      home = path.join(parent, "home"),
      repoId = "office-collab-prod",
      daemonId = "office-collab-prod",
      instanceId = "office-provider",
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

    const executablePath = writeProviderExecutable(
        path.join(parent, "provider.mjs"),
        `import fs from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(promptFile)}, prompt);
for (const frame of [
  { type: "thread.started", thread_id: "office-contributor-session" },
  { type: "item.completed", item: { id: "result", type: "agent_message", text: "office contributor completed" } },
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
            installationId: "office-installation",
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
      cliEnv = {
        HOME: home,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_ID: daemonId,
        HARNESS_DAEMON_ENDPOINT: daemon.endpoint,
        HARNESS_DAEMON_REPO_ID: repoId,
      },
      cliJson = async (expectedExit: number, ...args: string[]): Promise<JsonObject> => {
        const result = await spawnCli(["--root", root, "--json", ...args], cliEnv);
        assert.equal(result.status, expectedExit, `${result.stderr}\n${result.stdout}`);
        return JSON.parse(result.stdout) as JsonObject;
      };

    // HA09-4: Real CLI `ha vertical list` enumerates both builtin verticals and chains into `ha preset list --vertical office/collab`
    const verticalListRaw = await spawnCli(["--root", root, "vertical", "list"], cliEnv);
    assert.equal(verticalListRaw.status, 0, `${verticalListRaw.stderr}\n${verticalListRaw.stdout}`);
    assert.match(verticalListRaw.stdout, /office\/collab — Office Collaboration/u);
    assert.match(verticalListRaw.stdout, /software\/coding — Software Coding/u);
    assert.match(verticalListRaw.stdout, /ha preset list --vertical office\/collab/u);

    const verticalListReceipt = await cliJson(0, "vertical", "list");
    const verticals = JSON.parse(String(verticalListReceipt.evidence)) as Array<{
      id: string;
      layer: string;
      valid: boolean;
      default: boolean;
    }>;
    assert.deepEqual(
      verticals.map(({ id, layer, valid, default: isDefault }) => ({ id, layer, valid, default: isDefault })),
      [
        { id: "office/collab", layer: "builtin", valid: true, default: false },
        { id: "software/coding", layer: "builtin", valid: true, default: true },
      ],
    );

    const officePresetsReceipt = await cliJson(0, "preset", "list", "--vertical", "office/collab");
    const officePresets = JSON.parse(String(officePresetsReceipt.evidence)) as Array<{
      id: string;
      validity: string;
    }>;
    assert.deepEqual(
      officePresets.map(({ id, validity }) => ({ id, validity })),
      [
        { id: "deliverable-task", validity: "valid" },
        { id: "handoff-task", validity: "valid" },
        { id: "minutes-task", validity: "valid" },
      ],
    );

    // HA09-5: GUI catalog and production dispatch resolve bundled office/collab roles when defaultVertical=office/collab
    const codingCatalog = (await rpc("repo.gui.catalog.snapshot", { repo: { repoId } })) as {
      bundledAgents: string[];
    };
    assert.ok(codingCatalog.bundledAgents.includes("worker"));
    assert.ok(codingCatalog.bundledAgents.includes("closeout-reviewer"));

    const configured = await rpc("daemon.runtimeInstance.create", {
      payload: {
        instanceId,
        name: "Office provider",
        kindId: "codex",
        installationId: "office-installation",
        providerId: "openai",
        models: ["office-model"],
        permissionMode: "workspace-write",
        authMode: "subscription",
      },
    });
    assert.equal(configured.ok, true, JSON.stringify(configured));
    assert.equal(
      (
        await run({
          kind: "settings-update",
          defaultVertical: "office/collab",
          defaultPreset: "deliverable-task",
          defaultProfile: "baseline",
          runtimeAllowedInstances: [instanceId],
          roles: { defaultWorker: "contributor", defaultReviewer: "reviewer", defaultCommander: "coordinator" },
        })
      ).outcome,
      "applied",
    );

    const officeCatalog = (await rpc("repo.gui.catalog.snapshot", { repo: { repoId } })) as {
      bundledAgents: string[];
    };
    assert.deepEqual(officeCatalog.bundledAgents, ["closeout-reviewer", "contributor", "coordinator", "reviewer"]);

    const created = await cliJson(0, "task", "create", "--title", "Quarterly briefing", "--risk-tier", "low");
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const taskId = String(created.taskId);
    await realizeTaskPlanFixture(root, String(created.workspacePackagePath), (planPath: string) =>
      run({ kind: "doc-submit", paths: [planPath] }),
    );

    for (const role of ["coordinator", "contributor", "reviewer", "closeout-reviewer"] as const) {
      const preview = await cliJson(
        0,
        "agent",
        "run",
        role,
        "--task",
        taskId,
        "--instance",
        instanceId,
        "--prompt",
        "Inspect office task.",
        "--dry-run",
      );
      assert.notEqual(preview.ok, false, `${role}: ${JSON.stringify(preview)}`);
      assert.equal(existsSync(promptFile), false, "dry-run must not launch provider");
    }

    assert.equal((await cliJson(0, "task", "start", taskId)).outcome, "applied");
    const dispatched = await cliJson(0, "agent", "run", "contributor", "--task", taskId, "--instance", instanceId);
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    const settled = await cliJson(1, "runtime", "status", String(dispatched.runtimeSessionId), "--wait", "--no-stream");
    assert.equal(settled.outcome, "stopped", JSON.stringify(settled));
    const launchedPrompt = readFileSync(promptFile, "utf8");
    assert.match(launchedPrompt, /# Agent Identity: contributor \(contributor\)/u);
    assert.match(launchedPrompt, /Produce the assigned deliverable, handoff package, or meeting minutes/u);
  },
);
