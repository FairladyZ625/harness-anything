// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  deriveBasePolicyGroups,
  effectivePolicyGroupScopes,
  type AgentDefinitionSnapshot,
} from "@harness-anything/kernel";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import type { RuntimeInstallationWitness } from "../src/daemon-host/agent-runtime-instances.ts";
import { writeFleetEdgeConfig } from "../src/daemon-host/client/fleet-edge-config.ts";
import { requestDaemonJsonRpcAt } from "../src/daemon-host/client/local-json-rpc-client.ts";
import { openDaemonHost } from "../src/daemon-host/daemon-host.ts";
import { applyFleetMirrorCut } from "../src/daemon-host/fleet-edge-mirror.ts";
import { startDaemon } from "../src/daemon-host/runtime.ts";
import type { JsonObject } from "../src/daemon-host/protocol/json-rpc-types.ts";
import { fleetFixture, git, initRepo, localAuthFixture } from "./fleet-runtime-recovery.fixtures.ts";
import { waitForFleetPublication } from "./fleet-store.fixture.ts";
import { runtimeProcessFixture } from "./fixtures/runtime-process.ts";
import { initIngressRepo, spawnCli } from "./fixtures/runtime-ingress.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { serveKeycloak, signInAt } from "./keycloak.fixtures.ts";
import { catchUpReplica } from "./replica-catch-up.fixture.ts";
import { registerBootstrappedDaemonRepo, registerFixtureRuntimeInstance } from "./repo-settings.fixture.ts";

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

test(
  "HA09-5: Fleet Edge dispatch preserves remote task verticalId for office-only contributor and same-name reviewer when repository defaultVertical is software/coding",
  { timeout: 120_000 },
  async (t) => {
    const replicaQuota = 64 * 1024 * 1024,
      fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"], [], "local", undefined, undefined, false);
    t.after(() => fixture.close());

    // Repository stays on defaultVertical=software/coding; create a second task frozen to office/collab.
    const officeTaskId = "task-office-edge",
      createdOffice = await fixture.host.run(
        fixture.subject.repoId,
        {
          kind: "task-create",
          taskId: officeTaskId,
          title: "Office Edge Briefing",
          verticalId: "office/collab",
          presetId: "deliverable-task",
          profileId: "baseline",
          riskTier: "low",
        },
        fixture.auth,
      );
    assert.equal(createdOffice.outcome, "applied", JSON.stringify(createdOffice));
    await waitForFleetPublication(fixture.host, fixture.subject.repoId, createdOffice.opId, fixture.auth);
    const officePackagePath = String((createdOffice as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(
      fixture.repo,
      officePackagePath,
      (planPath) =>
        fixture.host.run(fixture.subject.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
      "Office Edge Briefing",
    );

    const center = await fixture.center(),
      edgeRoot = path.join(fixture.root, "mixed-edge"),
      edgeUserRoot = path.join(fixture.root, "mixed-edge-user"),
      viewRoot = path.join(fixture.root, "mixed-edge-view"),
      uid = process.getuid?.() ?? 0,
      localAuth = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
      } as const;
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    initRepo(edgeRoot);
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      readFileSync(path.join(fixture.repo, "harness/harness.yaml")),
    );
    git(edgeRoot, "add", "harness");
    git(edgeRoot, "commit", "-qm", "edge harness");

    const syncEdge = async () => {
      await catchUpReplica({
        readAccessToken: async () => `device-token-${fixture.subject.nodeId}`,
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        diskQuotaBytes: replicaQuota,
      });
      assert.equal(applyFleetMirrorCut(viewRoot, fixture.subject.repoId, edgeRoot, "pull").outcome, "applied");
    };
    await syncEdge();

    writeFleetEdgeConfig(edgeUserRoot, fixture.subject.repoId, {
      repoId: fixture.subject.repoId,
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      viewRoot,
      quotaBytes: replicaQuota,
    });
    registerBootstrappedDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: fixture.subject.repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });
    fixture.owners.signIn(edgeUserRoot, fixture.subject.nodeId, edgeRoot);

    const runtimeDefinition: AgentDefinitionSnapshot = {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "edge-office-codex",
        installationId: "edge-office-codex-installation",
        kindId: "codex",
        providerId: "openai",
        model: "office-edge-model",
        reasoningEffort: "high",
        endpointKind: "official",
        baseUrlHash: null,
        authMode: "subscription",
      },
      runtimeInstallation: RuntimeInstallationWitness = {
        installationId: runtimeDefinition.installationId,
        kindId: runtimeDefinition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-11-21T00:00:00.000Z",
      },
      launchedPrompts: string[] = [];

    const edgeHost = await openDaemonHost({
      daemonId: "mixed-vertical-edge",
      userRoot: edgeUserRoot,
      runtimeDiscover: () => [runtimeInstallation],
      runtimeLaunch: (prepared) => {
        launchedPrompts.push(prepared.prompt);
        const runtime = runtimeProcessFixture(t);
        let output: ((chunk: string) => void) | null = null;
        return {
          ...runtime,
          onOutput: (listener) => {
            output = listener;
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            runtime.onExit(listener);
            queueMicrotask(() => {
              output?.(
                `${JSON.stringify({ type: "thread.started", thread_id: "edge-mixed-session" })}\n${JSON.stringify({ type: "item.completed", item: { id: "msg", type: "agent_message", text: "edge ok" } })}\n${JSON.stringify({ type: "turn.completed" })}\n`,
              );
              runtime.exit(0);
            });
          },
        };
      },
    });
    fixture.track(() => edgeHost.close());
    await edgeHost.attachmentsSettled();

    await registerFixtureRuntimeInstance(
      edgeHost,
      fixture.subject.repoId,
      localAuth,
      {
        instanceId: runtimeDefinition.instanceId,
        name: "Edge Office Codex",
        kindId: runtimeDefinition.kindId,
        installationId: runtimeDefinition.installationId,
        providerId: runtimeDefinition.providerId,
        models: [runtimeDefinition.model],
        codex: { reasoningEffort: runtimeDefinition.reasoningEffort },
        authMode: runtimeDefinition.authMode,
      },
      { allowHost: fixture.host },
    );
    await syncEdge();

    // 1. Office-only contributor resolves and launches on Edge for the office/collab task despite software/coding repo default
    const contributorReceipt = await edgeHost.spawnRuntime(
      fixture.subject.repoId,
      {
        runtimeInstanceId: runtimeDefinition.instanceId,
        agentId: "contributor",
        cwd: { scope: "repo-root" },
        taskId: officeTaskId,
        dispatchKey: "edge-office-contributor",
      },
      localAuth,
    );
    assert.equal(contributorReceipt.outcome, "applied", JSON.stringify(contributorReceipt));
    assert.match(launchedPrompts[0]!, /# Agent Identity: contributor \(contributor\)/u);
    assert.match(launchedPrompts[0]!, /Produce the assigned deliverable, handoff package, or meeting minutes/u);

    // 2. Same-name reviewer resolves to office/collab declaration on Edge for the office/collab task
    const officeReviewerPreview = await edgeHost.spawnRuntime(
      fixture.subject.repoId,
      {
        runtimeInstanceId: runtimeDefinition.instanceId,
        agentId: "reviewer",
        cwd: { scope: "repo-root" },
        taskId: officeTaskId,
        dryRun: true,
        dispatchKey: "edge-office-reviewer-preview",
      },
      localAuth,
    );
    assert.equal(officeReviewerPreview.ok, true, JSON.stringify(officeReviewerPreview));
    assert.match(
      String(officeReviewerPreview.prompt),
      /Independently review the submitted deliverable or handoff package/u,
    );

    // 3. Control on the software/coding task in the same repo: same-name reviewer resolves to software/coding, and contributor is rejected
    const codingReviewerPreview = await edgeHost.spawnRuntime(
      fixture.subject.repoId,
      {
        runtimeInstanceId: runtimeDefinition.instanceId,
        agentId: "reviewer",
        cwd: { scope: "repo-root" },
        taskId: fixture.subject.taskId,
        dryRun: true,
        dispatchKey: "edge-coding-reviewer-preview",
      },
      localAuth,
    );
    assert.equal(codingReviewerPreview.ok, true, JSON.stringify(codingReviewerPreview));
    assert.match(
      String(codingReviewerPreview.prompt),
      /Independently review the assigned delivery against the task contract/u,
    );
    assert.doesNotMatch(String(codingReviewerPreview.prompt), /deliverable or handoff package/u);

    await assert.rejects(
      edgeHost.spawnRuntime(
        fixture.subject.repoId,
        {
          runtimeInstanceId: runtimeDefinition.instanceId,
          agentId: "contributor",
          cwd: { scope: "repo-root" },
          taskId: fixture.subject.taskId,
          dryRun: true,
          dispatchKey: "edge-coding-contributor-denied",
        },
        localAuth,
      ),
      { code: "agent_not_found" },
    );
  },
);

test(
  "HA09-8: pre-existing local custom office/collab vertical with same-name local agent files preserves core bundled worker/reviewer across Center cold read",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-office-upgrade-worker-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      home = path.join(parent, "home"),
      repoId = "office-upgrade-worker",
      daemonId = "office-upgrade-worker",
      instanceId = "legacy-office-provider",
      realm = await serveKeycloak(),
      promptFile = path.join(parent, "legacy-worker-prompt.txt");
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      rmSync(parent, { recursive: true, force: true });
    });
    mkdirSync(home);
    initIngressRepo(root, process.getuid?.() ?? 0);

    // Author a baseline-style pre-existing local custom office/collab vertical that ALSO contains
    // uninstalled same-name local agent files (reviewer.json + analyst.json) on disk.
    const localOffice = path.join(root, "verticals", "legacy-office");
    cpSync(new URL("../../preset/assets/software-coding/", import.meta.url), localOffice, { recursive: true });
    rmSync(path.join(localOffice, "agents"), { recursive: true, force: true });
    mkdirSync(path.join(localOffice, "agents"), { recursive: true });
    writeFileSync(
      path.join(localOffice, "agents", "reviewer.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "reviewer",
        name: "Uninstalled Local Reviewer",
        role: "reviewer",
        instructions: "UNINSTALLED LOCAL REVIEWER MUST NOT OVERRIDE CORE.",
        runtimes: [],
        skills: [],
      }),
    );
    writeFileSync(
      path.join(localOffice, "agents", "analyst.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "analyst",
        name: "Uninstalled Local Analyst",
        role: "worker",
        instructions: "UNINSTALLED LOCAL ANALYST MUST NOT BECOME BUNDLED.",
        runtimes: [],
        skills: [],
      }),
    );
    const localVertical = JSON.parse(readFileSync(path.join(localOffice, "vertical.json"), "utf8"));
    localVertical.id = "office/collab";
    localVertical.title = "Legacy Local Office";
    localVertical.completion = {
      sources: {},
      gates: {},
      closeoutDefaults: { review: false, consent: false, factDisposition: false },
    };
    writeFileSync(path.join(localOffice, "vertical.json"), JSON.stringify(localVertical));
    const legacyPresetDir = path.join(localOffice, "presets", "legacy-memo");
    mkdirSync(legacyPresetDir, { recursive: true });
    writeFileSync(
      path.join(legacyPresetDir, "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Pre-existing local office preset.\nwhenToUse: Legacy local office memo workflow.\n---\n# Legacy Memo\n",
    );
    writeFileSync(
      path.join(legacyPresetDir, "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "legacy-memo",
        title: "Legacy Memo",
        vertical: "office/collab",
        version: "1.0.0",
        kind: "template-content",
        outputShape: "artifact-only",
        kernelVersionRange: { min: "1.0.0" },
        capabilityImports: [],
        defaultProfile: "baseline",
        profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }],
      }),
    );
    execFileSync("git", ["-C", root, "add", "verticals"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "add pre-existing local office/collab vertical"]);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);

    realm.bind(userRoot);
    realm.keycloak.account("owner");
    realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "owner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });

    const executablePath = writeProviderExecutable(
      path.join(parent, "legacy-provider.mjs"),
      `import fs from "node:fs";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
fs.writeFileSync(${JSON.stringify(promptFile)}, fs.readFileSync(0, "utf8"));
for (const frame of [
  { type: "thread.started", thread_id: "legacy-worker-session" },
  { type: "item.completed", item: { id: "result", type: "agent_message", text: "legacy worker ok" } },
  { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }
]) console.log(JSON.stringify(frame));
`,
    );
    const launchDaemon = async () => {
      const started = await startDaemon({
        daemonId,
        userRoot,
        buildSupersessionEnabled: false,
        runtimeDiscover: () => [
          {
            installationId: "legacy-office-installation",
            kindId: "codex",
            executablePath,
            version: "1.0.0",
            observedAt: new Date().toISOString(),
          },
        ],
      });
      assert.ok("stop" in started);
      stop = started.stop;
      return started;
    };

    const daemon1 = await launchDaemon();
    const rpc1 = (method: string, params: JsonObject) =>
        requestDaemonJsonRpcAt(daemon1.endpoint, method, params, 1000, 30_000),
      cliEnvFor = (endpoint: string) => ({
        HOME: home,
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
        HARNESS_DAEMON_USER_ROOT: userRoot,
        HARNESS_DAEMON_ID: daemonId,
        HARNESS_DAEMON_ENDPOINT: endpoint,
        HARNESS_DAEMON_REPO_ID: repoId,
      }),
      cliJsonAt = async (endpoint: string, expectedExit: number, ...args: string[]): Promise<JsonObject> => {
        const result = await spawnCli(["--root", root, "--json", ...args], cliEnvFor(endpoint));
        assert.equal(result.status, expectedExit, `${result.stderr}\n${result.stdout}`);
        return JSON.parse(result.stdout) as JsonObject;
      };
    assert.equal(
      (
        await rpc1("daemon.runtimeInstance.create", {
          payload: {
            instanceId,
            name: "Legacy Office Provider",
            kindId: "codex",
            installationId: "legacy-office-installation",
            providerId: "openai",
            models: ["legacy-office-model"],
            permissionMode: "workspace-write",
            authMode: "subscription",
          },
        })
      ).ok,
      true,
    );
    assert.equal(
      (
        await rpc1("repo.task.run", {
          repo: { repoId },
          payload: {
            action: {
              kind: "settings-update",
              defaultVertical: "office/collab",
              defaultPreset: "legacy-memo",
              defaultProfile: "baseline",
              runtimeAllowedInstances: [instanceId],
            },
          },
        })
      ).outcome,
      "applied",
    );
    const created = await cliJsonAt(
      daemon1.endpoint,
      0,
      "task",
      "create",
      "--title",
      "Legacy Office Task",
      "--risk-tier",
      "low",
    );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    const taskId = String(created.taskId);
    await realizeTaskPlanFixture(root, String(created.workspacePackagePath), (planPath: string) =>
      rpc1("repo.task.run", { repo: { repoId }, payload: { action: { kind: "doc-submit", paths: [planPath] } } }),
    );
    assert.equal((await cliJsonAt(daemon1.endpoint, 0, "task", "start", taskId)).outcome, "applied");

    // Cold-restart daemon to prove cold read of existing local office/collab task still resolves core bundled
    // worker/reviewer and ignores uninstalled local agent files under verticals/legacy-office/agents/.
    await daemon1.stop();
    stop = async () => {};
    const daemon2 = await launchDaemon();
    const rpc2 = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon2.endpoint, method, params, 1000, 30_000);

    const legacyCatalog = (await rpc2("repo.gui.catalog.snapshot", { repo: { repoId } })) as {
      bundledAgents: string[];
    };
    assert.ok(legacyCatalog.bundledAgents.includes("worker"), JSON.stringify(legacyCatalog.bundledAgents));
    assert.ok(legacyCatalog.bundledAgents.includes("reviewer"), JSON.stringify(legacyCatalog.bundledAgents));
    assert.ok(!legacyCatalog.bundledAgents.includes("contributor"), JSON.stringify(legacyCatalog.bundledAgents));
    assert.ok(!legacyCatalog.bundledAgents.includes("analyst"), JSON.stringify(legacyCatalog.bundledAgents));

    const reviewerDryRun = await cliJsonAt(
      daemon2.endpoint,
      0,
      "agent",
      "run",
      "reviewer",
      "--task",
      taskId,
      "--instance",
      instanceId,
      "--dry-run",
    );
    assert.equal(reviewerDryRun.ok, true, JSON.stringify(reviewerDryRun));
    assert.match(
      String(reviewerDryRun.prompt),
      /Independently review the assigned delivery against the task contract/u,
    );
    assert.doesNotMatch(String(reviewerDryRun.prompt), /UNINSTALLED LOCAL REVIEWER/u);
    assert.doesNotMatch(String(reviewerDryRun.prompt), /deliverable or handoff package/u);

    const analystDenied = await spawnCli(
      ["--root", root, "--json", "agent", "run", "analyst", "--task", taskId, "--instance", instanceId, "--dry-run"],
      cliEnvFor(daemon2.endpoint),
    );
    assert.notEqual(analystDenied.status, 0, "uninstalled local analyst.json must not resolve as bundled");
    assert.match(`${analystDenied.stdout}\n${analystDenied.stderr}`, /agent_not_found/u);

    const dispatched = await cliJsonAt(
      daemon2.endpoint,
      0,
      "agent",
      "run",
      "worker",
      "--task",
      taskId,
      "--instance",
      instanceId,
    );
    assert.equal(dispatched.ok, true, JSON.stringify(dispatched));
    const settled = await cliJsonAt(
      daemon2.endpoint,
      1,
      "runtime",
      "status",
      String(dispatched.runtimeSessionId),
      "--wait",
      "--no-stream",
    );
    assert.equal(settled.outcome, "stopped", JSON.stringify(settled));
    const launchedPrompt = readFileSync(promptFile, "utf8");
    assert.match(launchedPrompt, /# Agent Identity: worker \(worker\)/u);
    assert.match(launchedPrompt, /Complete the assigned task using the repository rules/u);
  },
);

test(
  "HA09-8: Fleet Edge resolves the same core worker/reviewer declarations as Center for a pre-existing local custom office/collab vertical containing same-name local agent files",
  { timeout: 120_000 },
  async (t) => {
    const replicaQuota = 64 * 1024 * 1024,
      fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"], [], "local", undefined, undefined, false);
    t.after(() => fixture.close());

    const writeLegacyLocalOfficeVertical = (repoDir: string, commit: boolean) => {
      const localOffice = path.join(repoDir, "verticals", "legacy-office");
      cpSync(new URL("../../preset/assets/software-coding/", import.meta.url), localOffice, { recursive: true });
      rmSync(path.join(localOffice, "agents"), { recursive: true, force: true });
      mkdirSync(path.join(localOffice, "agents"), { recursive: true });
      writeFileSync(
        path.join(localOffice, "agents", "reviewer.json"),
        JSON.stringify({
          schema: "agent-declaration/v1",
          id: "reviewer",
          name: "Uninstalled Local Reviewer",
          role: "reviewer",
          instructions: "UNINSTALLED LOCAL REVIEWER MUST NOT OVERRIDE CORE.",
          runtimes: [],
          skills: [],
        }),
      );
      writeFileSync(
        path.join(localOffice, "agents", "analyst.json"),
        JSON.stringify({
          schema: "agent-declaration/v1",
          id: "analyst",
          name: "Uninstalled Local Analyst",
          role: "worker",
          instructions: "UNINSTALLED LOCAL ANALYST MUST NOT BECOME BUNDLED.",
          runtimes: [],
          skills: [],
        }),
      );
      const localVertical = JSON.parse(readFileSync(path.join(localOffice, "vertical.json"), "utf8"));
      localVertical.id = "office/collab";
      localVertical.title = "Legacy Local Office";
      localVertical.completion = {
        sources: {},
        gates: {},
        closeoutDefaults: { review: false, consent: false, factDisposition: false },
      };
      writeFileSync(path.join(localOffice, "vertical.json"), JSON.stringify(localVertical));
      const legacyPresetDir = path.join(localOffice, "presets", "legacy-memo");
      mkdirSync(legacyPresetDir, { recursive: true });
      writeFileSync(
        path.join(legacyPresetDir, "PRESET.md"),
        "---\nschema: preset-document/v1\ndescription: Pre-existing local office preset.\nwhenToUse: Legacy local office memo workflow.\n---\n# Legacy Memo\n",
      );
      writeFileSync(
        path.join(legacyPresetDir, "preset.json"),
        JSON.stringify({
          schema: "preset-manifest/v3",
          id: "legacy-memo",
          title: "Legacy Memo",
          vertical: "office/collab",
          version: "1.0.0",
          kind: "template-content",
          outputShape: "artifact-only",
          kernelVersionRange: { min: "1.0.0" },
          capabilityImports: [],
          defaultProfile: "baseline",
          profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }],
        }),
      );
      if (commit) {
        git(repoDir, "add", "verticals");
        git(repoDir, "commit", "-qm", "add local custom office/collab vertical with same-name agent files");
      }
    };

    writeLegacyLocalOfficeVertical(fixture.repo, false);

    const legacyTaskId = "task-legacy-office-edge",
      createdLegacy = await fixture.host.run(
        fixture.subject.repoId,
        {
          kind: "task-create",
          taskId: legacyTaskId,
          title: "Legacy Local Office Edge Task",
          verticalId: "office/collab",
          presetId: "legacy-memo",
          profileId: "baseline",
          riskTier: "low",
        },
        fixture.auth,
      );
    assert.equal(createdLegacy.outcome, "applied", JSON.stringify(createdLegacy));
    await waitForFleetPublication(fixture.host, fixture.subject.repoId, createdLegacy.opId, fixture.auth);
    const legacyPackagePath = String((createdLegacy as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(
      fixture.repo,
      legacyPackagePath,
      (planPath) =>
        fixture.host.run(fixture.subject.repoId, { kind: "doc-submit", paths: [planPath] }, localAuthFixture()),
      "Legacy Local Office Edge Task",
    );

    const center = await fixture.center(),
      edgeRoot = path.join(fixture.root, "legacy-local-edge"),
      edgeUserRoot = path.join(fixture.root, "legacy-local-edge-user"),
      viewRoot = path.join(fixture.root, "legacy-local-edge-view"),
      uid = process.getuid?.() ?? 0,
      localAuth = {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: { ownerUid: uid, source: "unix-socket-filesystem-owner-boundary" },
      } as const;
    mkdirSync(path.join(edgeRoot, "harness"), { recursive: true });
    initRepo(edgeRoot);
    writeFileSync(
      path.join(edgeRoot, "harness/harness.yaml"),
      readFileSync(path.join(fixture.repo, "harness/harness.yaml")),
    );
    git(edgeRoot, "add", "harness");
    git(edgeRoot, "commit", "-qm", "edge harness");
    writeLegacyLocalOfficeVertical(edgeRoot, true);

    const syncEdge = async () => {
      await catchUpReplica({
        readAccessToken: async () => `device-token-${fixture.subject.nodeId}`,
        port: center.port,
        ca: fixture.cert,
        nodeId: fixture.subject.nodeId,
        credential: "machine-secret",
        repoId: fixture.subject.repoId,
        viewRoot,
        diskQuotaBytes: replicaQuota,
      });
      assert.equal(applyFleetMirrorCut(viewRoot, fixture.subject.repoId, edgeRoot, "pull").outcome, "applied");
    };
    await syncEdge();

    writeFleetEdgeConfig(edgeUserRoot, fixture.subject.repoId, {
      repoId: fixture.subject.repoId,
      host: "127.0.0.1",
      port: center.port,
      caPath: fixture.certFile,
      nodeId: fixture.subject.nodeId,
      credential: "machine-secret",
      viewRoot,
      quotaBytes: replicaQuota,
    });
    registerBootstrappedDaemonRepo({
      canonicalRoot: edgeRoot,
      repoId: fixture.subject.repoId,
      mode: "remote-edge",
      userRoot: edgeUserRoot,
      createConvenienceLinks: false,
    });
    fixture.owners.signIn(edgeUserRoot, fixture.subject.nodeId, edgeRoot);

    const runtimeDefinition: AgentDefinitionSnapshot = {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "edge-legacy-office-codex",
        installationId: "edge-legacy-office-codex-installation",
        kindId: "codex",
        providerId: "openai",
        model: "legacy-office-edge-model",
        reasoningEffort: "high",
        endpointKind: "official",
        baseUrlHash: null,
        authMode: "subscription",
      },
      runtimeInstallation: RuntimeInstallationWitness = {
        installationId: runtimeDefinition.installationId,
        kindId: runtimeDefinition.kindId,
        executablePath: "/usr/bin/true",
        version: "1.0.0",
        observedAt: "2026-11-21T00:00:00.000Z",
      };

    const edgeHost = await openDaemonHost({
      daemonId: "legacy-local-office-edge",
      userRoot: edgeUserRoot,
      runtimeDiscover: () => [runtimeInstallation],
      runtimeLaunch: () => runtimeProcessFixture(t),
    });
    fixture.track(() => edgeHost.close());
    await edgeHost.attachmentsSettled();

    await registerFixtureRuntimeInstance(
      edgeHost,
      fixture.subject.repoId,
      localAuth,
      {
        instanceId: runtimeDefinition.instanceId,
        name: "Edge Legacy Office Codex",
        kindId: runtimeDefinition.kindId,
        installationId: runtimeDefinition.installationId,
        providerId: runtimeDefinition.providerId,
        models: [runtimeDefinition.model],
        codex: { reasoningEffort: runtimeDefinition.reasoningEffort },
        authMode: runtimeDefinition.authMode,
      },
      { allowHost: fixture.host },
    );
    await syncEdge();

    // Both Center and Edge must resolve reviewer and worker to core bundled declarations (never local agents/*.json or builtin office agents)
    const edgeReviewer = await edgeHost.spawnRuntime(
      fixture.subject.repoId,
      {
        runtimeInstanceId: runtimeDefinition.instanceId,
        agentId: "reviewer",
        cwd: { scope: "repo-root" },
        taskId: legacyTaskId,
        dryRun: true,
        dispatchKey: "edge-legacy-office-reviewer",
      },
      localAuth,
    );
    assert.equal(edgeReviewer.ok, true, JSON.stringify(edgeReviewer));
    assert.match(String(edgeReviewer.prompt), /Independently review the assigned delivery against the task contract/u);
    assert.doesNotMatch(String(edgeReviewer.prompt), /UNINSTALLED LOCAL REVIEWER/u);
    assert.doesNotMatch(String(edgeReviewer.prompt), /deliverable or handoff package/u);

    const edgeWorker = await edgeHost.spawnRuntime(
      fixture.subject.repoId,
      {
        runtimeInstanceId: runtimeDefinition.instanceId,
        agentId: "worker",
        cwd: { scope: "repo-root" },
        taskId: legacyTaskId,
        dryRun: true,
        dispatchKey: "edge-legacy-office-worker",
      },
      localAuth,
    );
    assert.equal(edgeWorker.ok, true, JSON.stringify(edgeWorker));
    assert.match(String(edgeWorker.prompt), /Complete the assigned task using the repository rules/u);

    for (const disallowed of ["analyst", "contributor"] as const) {
      await assert.rejects(
        edgeHost.spawnRuntime(
          fixture.subject.repoId,
          {
            runtimeInstanceId: runtimeDefinition.instanceId,
            agentId: disallowed,
            cwd: { scope: "repo-root" },
            taskId: legacyTaskId,
            dryRun: true,
            dispatchKey: `edge-legacy-office-${disallowed}-denied`,
          },
          localAuth,
        ),
        { code: "agent_not_found" },
      );
    }
  },
);
