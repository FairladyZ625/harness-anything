// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

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
      removeTempRepository(parent);
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
        { id: "work-root", validity: "valid" },
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
    assert.deepEqual(officeCatalog.bundledAgents, [
      "chronicler",
      "closeout-reviewer",
      "contributor",
      "coordinator",
      "reviewer",
    ]);

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
  "dec_42EB7B8F636C12381A447E52A3/CH1: local custom office/collab vertical resolves its own verticals/<dir>/agents/*.json across Center cold read without falling back to software/coding",
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
      removeTempRepository(parent);
    });
    mkdirSync(home);
    initIngressRepo(root, process.getuid?.() ?? 0);

    // Author a local custom office/collab vertical providing its own business role declarations
    // under verticals/legacy-office/agents/{reviewer,analyst}.json.
    const localOffice = path.join(root, "verticals", "legacy-office");
    cpSync(new URL("../../preset/assets/software-coding/", import.meta.url), localOffice, { recursive: true });
    removeTempRepository(path.join(localOffice, "agents"));
    mkdirSync(path.join(localOffice, "agents"), { recursive: true });
    writeFileSync(
      path.join(localOffice, "agents", "reviewer.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "reviewer",
        name: "Local Office Reviewer",
        role: "reviewer",
        instructions: "Apply local custom office review checklist.",
        runtimes: [],
        skills: [],
      }),
    );
    writeFileSync(
      path.join(localOffice, "agents", "analyst.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "analyst",
        name: "Local Office Analyst",
        role: "worker",
        instructions: "Synthesize local office brief with domain rules.",
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

    // Cold-restart daemon to prove cold read of local custom office/collab task resolves its own
    // verticals/legacy-office/agents/*.json roles without falling back to software/coding.
    await daemon1.stop();
    stop = async () => {};
    const daemon2 = await launchDaemon();
    const rpc2 = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon2.endpoint, method, params, 1000, 30_000);

    const legacyCatalog = (await rpc2("repo.gui.catalog.snapshot", { repo: { repoId } })) as {
      bundledAgents: string[];
    };
    assert.deepEqual(legacyCatalog.bundledAgents, ["analyst", "reviewer"]);

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
    assert.match(String(reviewerDryRun.prompt), /Apply local custom office review checklist/u);
    assert.doesNotMatch(String(reviewerDryRun.prompt), /deliverable or handoff package/u);

    const workerDenied = await spawnCli(
      ["--root", root, "--json", "agent", "run", "worker", "--task", taskId, "--instance", instanceId, "--dry-run"],
      cliEnvFor(daemon2.endpoint),
    );
    assert.notEqual(workerDenied.status, 0, "software/coding worker must not leak into local office vertical");
    assert.match(`${workerDenied.stdout}\n${workerDenied.stderr}`, /agent_not_found/u);

    const dispatched = await cliJsonAt(
      daemon2.endpoint,
      0,
      "agent",
      "run",
      "analyst",
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
    assert.match(launchedPrompt, /# Agent Identity: Local Office Analyst \(analyst\)/u);
    assert.match(launchedPrompt, /Synthesize local office brief with domain rules/u);
  },
);

test(
  "dec_42EB7B8F636C12381A447E52A3/CH1: Fleet Edge resolves the same local vertical agents/*.json as Center without falling back to software/coding",
  { timeout: 120_000 },
  async (t) => {
    const replicaQuota = 64 * 1024 * 1024,
      fixture = await fleetFixture(t, ["tasks/task-fleet-fleet"], [], "local", undefined, undefined, false);
    t.after(() => fixture.close());

    const writeLegacyLocalOfficeVertical = (repoDir: string, commit: boolean) => {
      const localOffice = path.join(repoDir, "verticals", "legacy-office");
      cpSync(new URL("../../preset/assets/software-coding/", import.meta.url), localOffice, { recursive: true });
      removeTempRepository(path.join(localOffice, "agents"));
      mkdirSync(path.join(localOffice, "agents"), { recursive: true });
      writeFileSync(
        path.join(localOffice, "agents", "reviewer.json"),
        JSON.stringify({
          schema: "agent-declaration/v1",
          id: "reviewer",
          name: "Local Office Reviewer",
          role: "reviewer",
          instructions: "Apply local custom office review checklist.",
          runtimes: [],
          skills: [],
        }),
      );
      writeFileSync(
        path.join(localOffice, "agents", "analyst.json"),
        JSON.stringify({
          schema: "agent-declaration/v1",
          id: "analyst",
          name: "Local Office Analyst",
          role: "worker",
          instructions: "Synthesize local office brief with domain rules.",
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

    // Both Center and Edge must resolve reviewer and analyst from local verticals/legacy-office/agents/*.json
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
    assert.match(String(edgeReviewer.prompt), /Apply local custom office review checklist/u);
    assert.doesNotMatch(String(edgeReviewer.prompt), /deliverable or handoff package/u);

    const edgeAnalyst = await edgeHost.spawnRuntime(
      fixture.subject.repoId,
      {
        runtimeInstanceId: runtimeDefinition.instanceId,
        agentId: "analyst",
        cwd: { scope: "repo-root" },
        taskId: legacyTaskId,
        dryRun: true,
        dispatchKey: "edge-legacy-office-analyst",
      },
      localAuth,
    );
    assert.equal(edgeAnalyst.ok, true, JSON.stringify(edgeAnalyst));
    assert.match(String(edgeAnalyst.prompt), /Synthesize local office brief with domain rules/u);

    for (const disallowed of ["worker", "contributor"] as const) {
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

test(
  "HA09-5 & HA09-9: Center non-dry-run preflight resolves task verticalId in a mixed-vertical repo, and retire/delete protect built-in agents across both default verticals",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-office-mixed-center-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      home = path.join(parent, "home"),
      repoId = "office-mixed-center",
      daemonId = "office-mixed-center",
      instanceId = "mixed-center-provider",
      realm = await serveKeycloak(),
      promptDir = path.join(parent, "prompts");
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      removeTempRepository(parent);
    });
    mkdirSync(home);
    mkdirSync(promptDir);
    initIngressRepo(root, process.getuid?.() ?? 0);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    realm.bind(userRoot);
    realm.keycloak.account("owner");
    realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "owner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });

    const executablePath = writeProviderExecutable(
        path.join(parent, "mixed-provider.mjs"),
        `import fs from "node:fs";
import path from "node:path";
if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
const prompt = fs.readFileSync(0, "utf8");
const files = fs.readdirSync(${JSON.stringify(promptDir)}).length;
fs.writeFileSync(path.join(${JSON.stringify(promptDir)}, String(files + 1) + ".txt"), prompt);
for (const frame of [
  { type: "thread.started", thread_id: "mixed-center-session-" + String(files + 1) },
  { type: "item.completed", item: { id: "result", type: "agent_message", text: "mixed center completed" } },
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
            installationId: "mixed-center-installation",
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

    assert.equal(
      (
        await rpc("daemon.runtimeInstance.create", {
          payload: {
            instanceId,
            name: "Mixed Center Provider",
            kindId: "codex",
            installationId: "mixed-center-installation",
            providerId: "openai",
            models: ["mixed-model"],
            permissionMode: "workspace-write",
            authMode: "subscription",
          },
        })
      ).ok,
      true,
    );
    // Repository stays on defaultVertical=software/coding.
    assert.equal((await run({ kind: "settings-update", runtimeAllowedInstances: [instanceId] })).outcome, "applied");

    // HA09-5: Create one office/collab task and one software/coding task in the same software-default repository.
    const officeCreated = await cliJson(
      0,
      "task",
      "create",
      "--title",
      "Mixed Center Office Deliverable",
      "--vertical",
      "office/collab",
      "--preset",
      "deliverable-task",
      "--profile",
      "baseline",
      "--risk-tier",
      "low",
    );
    assert.equal(officeCreated.outcome, "applied", JSON.stringify(officeCreated));
    const officeTaskId = String(officeCreated.taskId);
    await realizeTaskPlanFixture(root, String(officeCreated.workspacePackagePath), (planPath: string) =>
      run({ kind: "doc-submit", paths: [planPath] }),
    );
    assert.equal((await cliJson(0, "task", "start", officeTaskId)).outcome, "applied");

    const codingCreated = await cliJson(
      0,
      "task",
      "create",
      "--title",
      "Mixed Center Software Task",
      "--preset",
      "docs-task",
      "--risk-tier",
      "low",
    );
    assert.equal(codingCreated.outcome, "applied", JSON.stringify(codingCreated));
    const codingTaskId = String(codingCreated.taskId);
    await realizeTaskPlanFixture(root, String(codingCreated.workspacePackagePath), (planPath: string) =>
      run({ kind: "doc-submit", paths: [planPath] }),
    );
    assert.equal((await cliJson(0, "task", "start", codingTaskId)).outcome, "applied");

    // Non-dry-run Center dispatch of office-only contributor on the office/collab task must pass prepareWorktree preflight.
    const officeDispatch = await cliJson(
      0,
      "agent",
      "run",
      "contributor",
      "--task",
      officeTaskId,
      "--instance",
      instanceId,
    );
    assert.equal(officeDispatch.ok, true, JSON.stringify(officeDispatch));
    const officeSettled = await cliJson(
      1,
      "runtime",
      "status",
      String(officeDispatch.runtimeSessionId),
      "--wait",
      "--no-stream",
    );
    assert.equal(officeSettled.outcome, "stopped", JSON.stringify(officeSettled));
    const officePrompt = readFileSync(path.join(promptDir, "1.txt"), "utf8");
    assert.match(officePrompt, /# Agent Identity: contributor \(contributor\)/u);
    assert.match(officePrompt, /Produce the assigned deliverable, handoff package, or meeting minutes/u);

    // Non-dry-run Center dispatch of software/coding worker on the software task in the same repo must still succeed.
    const codingDispatch = await cliJson(0, "agent", "run", "worker", "--task", codingTaskId, "--instance", instanceId);
    assert.equal(codingDispatch.ok, true, JSON.stringify(codingDispatch));
    const codingSettled = await cliJson(
      1,
      "runtime",
      "status",
      String(codingDispatch.runtimeSessionId),
      "--wait",
      "--no-stream",
    );
    assert.equal(codingSettled.outcome, "stopped", JSON.stringify(codingSettled));
    const codingPrompt = readFileSync(path.join(promptDir, "2.txt"), "utf8");
    assert.match(codingPrompt, /# Agent Identity: worker \(worker\)/u);
    assert.match(codingPrompt, /Complete the assigned task using the repository rules/u);

    // Non-dry-run negative control: office-only contributor must still be rejected on the software/coding task.
    const codingDenied = await spawnCli(
      ["--root", root, "--json", "agent", "run", "contributor", "--task", codingTaskId, "--instance", instanceId],
      cliEnv,
    );
    assert.notEqual(codingDenied.status, 0, "contributor must be denied on software/coding task");
    assert.match(`${codingDenied.stdout}\n${codingDenied.stderr}`, /agent_not_found/u);

    // HA09-9: Under defaultVertical=software/coding, an installed override for office built-in `contributor`
    // must be protected against retire/delete, while an ordinary custom agent remains retirable and deletable.
    const installedContributor = await run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "contributor",
        name: "Custom Contributor Override",
        role: "worker",
        instructions: "Override office contributor.",
        runtimes: [{ type: "codex", model: "mixed-model" }],
      },
    });
    assert.equal(installedContributor.outcome, "applied", JSON.stringify(installedContributor));
    const contributorRetireDenied = await run({
      kind: "agent-retire",
      agentId: "contributor",
      reason: "attempt to retire office builtin under software default",
    });
    assert.equal(contributorRetireDenied.outcome, "op_rejected", JSON.stringify(contributorRetireDenied));
    assert.equal(contributorRetireDenied.code, "agent_system_builtin");
    const contributorDeleteDenied = await run({
      kind: "agent-delete",
      agentId: "contributor",
      reason: "attempt to delete office builtin under software default",
      expectedVersion: Number(installedContributor.revision),
    });
    assert.equal(contributorDeleteDenied.outcome, "op_rejected", JSON.stringify(contributorDeleteDenied));
    assert.equal(contributorDeleteDenied.code, "agent_system_builtin");

    // Positive control: an ordinary custom installed agent can be retired and deleted.
    const installedCustom = await run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "custom-office-helper",
        name: "Custom Office Helper",
        role: "worker",
        instructions: "Temporary custom helper.",
        runtimes: [{ type: "codex", model: "mixed-model" }],
      },
    });
    assert.equal(installedCustom.outcome, "applied", JSON.stringify(installedCustom));
    const customRetired = await run({
      kind: "agent-retire",
      agentId: "custom-office-helper",
      reason: "retire ordinary custom agent",
    });
    assert.equal(customRetired.outcome, "applied", JSON.stringify(customRetired));
    const customDeleted = await run({
      kind: "agent-delete",
      agentId: "custom-office-helper",
      reason: "delete ordinary custom agent",
      expectedVersion: Number(installedCustom.revision),
    });
    assert.equal(customDeleted.outcome, "applied", JSON.stringify(customDeleted));

    // Switch defaultVertical to office/collab and verify software/coding built-in `worker` override stays protected.
    assert.equal(
      (
        await run({
          kind: "settings-update",
          defaultVertical: "office/collab",
          defaultPreset: "deliverable-task",
          defaultProfile: "baseline",
        })
      ).outcome,
      "applied",
    );
    const installedWorker = await run({
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "worker",
        name: "Custom Worker Override",
        role: "worker",
        instructions: "Override software worker.",
        runtimes: [{ type: "codex", model: "mixed-model" }],
      },
    });
    assert.equal(installedWorker.outcome, "applied", JSON.stringify(installedWorker));
    const workerRetireDenied = await run({
      kind: "agent-retire",
      agentId: "worker",
      reason: "attempt to retire software builtin under office default",
    });
    assert.equal(workerRetireDenied.outcome, "op_rejected", JSON.stringify(workerRetireDenied));
    assert.equal(workerRetireDenied.code, "agent_system_builtin");
    const workerDeleteDenied = await run({
      kind: "agent-delete",
      agentId: "worker",
      reason: "attempt to delete software builtin under office default",
      expectedVersion: Number(installedWorker.revision),
    });
    assert.equal(workerDeleteDenied.outcome, "op_rejected", JSON.stringify(workerDeleteDenied));
    assert.equal(workerDeleteDenied.code, "agent_system_builtin");
  },
);

test(
  "HA09-10: pre-upgrade retired custom agents colliding with newly shipped office/collab ids can be deleted or reinstalled across cold daemon restart while core roles stay protected",
  { timeout: 120_000 },
  async (t) => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-office-ha09-10-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      home = path.join(parent, "home"),
      repoId = "office-ha09-10",
      daemonId = "office-ha09-10",
      instanceId = "ha09-10-provider",
      realm = await serveKeycloak();
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      removeTempRepository(parent);
    });
    mkdirSync(home);
    initIngressRepo(root, process.getuid?.() ?? 0);

    // Pre-upgrade state: before built-in office/collab shipped, contributor and coordinator were ordinary custom ids.
    // Shadow office/collab locally with a local agent during pre-upgrade setup so contributor/coordinator can be legally installed and retired.
    const preUpgradeVerticalDir = path.join(root, "verticals", "pre-upgrade-office");
    mkdirSync(path.join(preUpgradeVerticalDir, "agents"), { recursive: true });
    writeFileSync(path.join(preUpgradeVerticalDir, "vertical.json"), JSON.stringify({ id: "office/collab" }));
    writeFileSync(
      path.join(preUpgradeVerticalDir, "agents", "legacy-helper.json"),
      JSON.stringify({
        schema: "agent-declaration/v1",
        id: "legacy-helper",
        name: "Legacy Helper",
        role: "worker",
        instructions: "Pre-upgrade local vertical helper.",
        runtimes: [],
        skills: [],
      }),
    );
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);

    realm.bind(userRoot);
    realm.keycloak.account("owner");
    realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "owner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });

    const executablePath = writeProviderExecutable(
      path.join(parent, "ha09-10-provider.mjs"),
      `if (process.argv[2] === "auth" || process.argv[2] === "login") process.exit(0);
for (const frame of [
  { type: "thread.started", thread_id: "ha09-10-session" },
  { type: "item.completed", item: { id: "result", type: "agent_message", text: "ok" } },
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
            installationId: "ha09-10-installation",
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
    const cliEnvFor = (endpoint: string) => ({
      HOME: home,
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_DAEMON_ID: daemonId,
      HARNESS_DAEMON_ENDPOINT: endpoint,
      HARNESS_DAEMON_REPO_ID: repoId,
    });
    const cliJsonAt = async (endpoint: string, expectedExit: number, ...args: string[]): Promise<JsonObject> => {
      const result = await spawnCli(["--root", root, "--json", ...args], cliEnvFor(endpoint));
      assert.equal(result.status, expectedExit, `${result.stderr}\n${result.stdout}`);
      return JSON.parse(result.stdout) as JsonObject;
    };

    const daemon1 = await launchDaemon();
    const rpc1 = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon1.endpoint, method, params, 1000, 30_000);
    const run1 = (action: JsonObject) => rpc1("repo.task.run", { repo: { repoId }, payload: { action } });

    assert.equal(
      (
        await rpc1("daemon.runtimeInstance.create", {
          payload: {
            instanceId,
            name: "HA09-10 Provider",
            kindId: "codex",
            installationId: "ha09-10-installation",
            providerId: "openai",
            models: ["ha09-10-model"],
            permissionMode: "workspace-write",
            authMode: "subscription",
          },
        })
      ).ok,
      true,
    );
    assert.equal((await run1({ kind: "settings-update", runtimeAllowedInstances: [instanceId] })).outcome, "applied");

    const installAndRetire = async (id: string, name: string, withSquad = false) => {
      const installed = await run1({
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id,
          name,
          role: "worker",
          instructions: `Pre-upgrade custom ${id} declaration.`,
          runtimes: [{ type: "codex", model: "ha09-10-model" }],
        },
      });
      assert.equal(installed.outcome, "applied", JSON.stringify(installed));
      if (withSquad) {
        const squad = await run1({
          kind: "squad-install",
          declaration: {
            schema: "squad-declaration/v1",
            id: `legacy-${id}-squad`,
            name: `Legacy ${id} Squad`,
            leader: id,
            workers: [id],
            leaderTurnBudget: 1,
            roster: `Retains historical reference to ${id}.`,
          },
        });
        assert.equal(squad.outcome, "applied", JSON.stringify(squad));
      }
      const retired = await run1({
        kind: "agent-retire",
        agentId: id,
        reason: `Pre-upgrade retirement of custom ${id}`,
      });
      assert.equal(retired.outcome, "applied", JSON.stringify(retired));
      return Number(installed.revision);
    };

    const contributorVersion = await installAndRetire("contributor", "Legacy Custom Contributor");
    const coordinatorVersion = await installAndRetire("coordinator", "Legacy Custom Coordinator", true);
    const customOnlyVersion = await installAndRetire("retired-custom-only", "Legacy Custom Only");

    // Simulate upgrade: stop daemon, remove pre-upgrade shadow so bundled office/collab ships live, then cold-start.
    await daemon1.stop();
    stop = async () => {};
    removeTempRepository(path.join(root, "verticals"));

    const daemon2 = await launchDaemon();
    const rpc2 = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon2.endpoint, method, params, 1000, 30_000);
    const run2 = (action: JsonObject) => rpc2("repo.task.run", { repo: { repoId }, payload: { action } });

    const officeTask = await cliJsonAt(
      daemon2.endpoint,
      0,
      "task",
      "create",
      "--title",
      "Upgrade Recovery Office Task",
      "--vertical",
      "office/collab",
      "--preset",
      "deliverable-task",
      "--profile",
      "baseline",
      "--risk-tier",
      "low",
    );
    assert.equal(officeTask.outcome, "applied", JSON.stringify(officeTask));
    const officeTaskId = String(officeTask.taskId);
    await realizeTaskPlanFixture(root, String(officeTask.workspacePackagePath), (planPath: string) =>
      run2({ kind: "doc-submit", paths: [planPath] }),
    );
    assert.equal((await cliJsonAt(daemon2.endpoint, 0, "task", "start", officeTaskId)).outcome, "applied");

    // Before recovery, retired pre-upgrade contributor still rejects dispatch cleanly with agent_retired.
    const preRecoveryDispatch = await spawnCli(
      [
        "--root",
        root,
        "--json",
        "agent",
        "run",
        "contributor",
        "--task",
        officeTaskId,
        "--instance",
        instanceId,
        "--dry-run",
      ],
      cliEnvFor(daemon2.endpoint),
    );
    assert.notEqual(preRecoveryDispatch.status, 0);
    assert.match(`${preRecoveryDispatch.stdout}\n${preRecoveryDispatch.stderr}`, /agent_retired/u);

    // Path 1: Delete unreferenced retired custom contributor -> recovers bundled office/collab contributor.
    const deletedContributor = await run2({
      kind: "agent-delete",
      agentId: "contributor",
      expectedVersion: contributorVersion,
      reason: "Remove retired pre-upgrade custom contributor so bundled office/collab role is active",
    });
    assert.equal(deletedContributor.outcome, "applied", JSON.stringify(deletedContributor));

    // Path 2: Referenced retired custom coordinator still rejects delete with agent_referenced,
    // and can be recovered via authorized agent-install override.
    const coordinatorDeleteReferenced = await run2({
      kind: "agent-delete",
      agentId: "coordinator",
      expectedVersion: coordinatorVersion,
      reason: "Should fail because squad still references coordinator",
    });
    assert.equal(coordinatorDeleteReferenced.outcome, "op_rejected", JSON.stringify(coordinatorDeleteReferenced));
    assert.equal(coordinatorDeleteReferenced.code, "agent_referenced");

    const reinstalledCoordinator = await run2({
      kind: "agent-install",
      expectedVersion: coordinatorVersion,
      declaration: {
        schema: "agent-declaration/v1",
        id: "coordinator",
        name: "Recovered Office Coordinator",
        role: "commander",
        instructions: "Coordinate office/collab deliverables and handoffs.",
        runtimes: [{ type: "codex", model: "ha09-10-model" }],
      },
    });
    assert.equal(reinstalledCoordinator.outcome, "applied", JSON.stringify(reinstalledCoordinator));

    // Control: Ordinary non-bundled retired custom agent stays blocked from reinstallation.
    const customOnlyReinstallDenied = await run2({
      kind: "agent-install",
      expectedVersion: customOnlyVersion,
      declaration: {
        schema: "agent-declaration/v1",
        id: "retired-custom-only",
        name: "Should Stay Blocked",
        role: "worker",
        instructions: "Ordinary retired custom agent must remain non-reinstallable.",
        runtimes: [{ type: "codex", model: "ha09-10-model" }],
      },
    });
    assert.equal(customOnlyReinstallDenied.outcome, "op_rejected", JSON.stringify(customOnlyReinstallDenied));
    assert.equal(customOnlyReinstallDenied.code, "agent_retired");

    // Cold-restart daemon again to prove both deleted contributor and reinstalled coordinator survive cold replay.
    await daemon2.stop();
    stop = async () => {};
    const daemon3 = await launchDaemon();
    const rpc3 = (method: string, params: JsonObject) =>
      requestDaemonJsonRpcAt(daemon3.endpoint, method, params, 1000, 30_000);
    const run3 = (action: JsonObject) => rpc3("repo.task.run", { repo: { repoId }, payload: { action } });

    const contributorDryRun = await cliJsonAt(
      daemon3.endpoint,
      0,
      "agent",
      "run",
      "contributor",
      "--task",
      officeTaskId,
      "--instance",
      instanceId,
      "--dry-run",
    );
    assert.equal(contributorDryRun.ok, true, JSON.stringify(contributorDryRun));
    assert.match(
      String(contributorDryRun.prompt),
      /Produce the assigned deliverable, handoff package, or meeting minutes/u,
    );

    const coordinatorDryRun = await cliJsonAt(
      daemon3.endpoint,
      0,
      "agent",
      "run",
      "coordinator",
      "--task",
      officeTaskId,
      "--instance",
      instanceId,
      "--dry-run",
    );
    assert.equal(coordinatorDryRun.ok, true, JSON.stringify(coordinatorDryRun));
    assert.match(String(coordinatorDryRun.prompt), /Coordinate office\/collab deliverables and handoffs/u);

    // Once active again, coordinator and core worker are protected from retire/delete (agent_system_builtin).
    const activeCoordinatorDeleteDenied = await run3({
      kind: "agent-delete",
      agentId: "coordinator",
      expectedVersion: Number(reinstalledCoordinator.revision),
      reason: "Active bundled override must stay protected",
    });
    assert.equal(activeCoordinatorDeleteDenied.outcome, "op_rejected", JSON.stringify(activeCoordinatorDeleteDenied));
    assert.equal(activeCoordinatorDeleteDenied.code, "agent_system_builtin");

    const coreWorkerRetireDenied = await run3({
      kind: "agent-retire",
      agentId: "worker",
      reason: "Core worker must stay protected",
    });
    assert.equal(coreWorkerRetireDenied.outcome, "op_rejected", JSON.stringify(coreWorkerRetireDenied));
    assert.equal(coreWorkerRetireDenied.code, "agent_system_builtin");
  },
);

test(
  "HA09-11: real daemon command witness blocks upstream-fresh completion when live canonical upstream advances v1->v2 while submission retains v1 copy, and passes when aligned to v2",
  { timeout: 120_000 },
  async (t) => {
    const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex"),
      parent = mkdtempSync(path.join(tmpdir(), "ha-office-ha09-11-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      home = path.join(parent, "home"),
      repoId = "office-ha09-11",
      daemonId = "office-ha09-11",
      realm = await serveKeycloak();
    let stop = async (): Promise<void> => {};
    t.after(async () => {
      await stop();
      await realm.close();
      removeTempRepository(parent);
    });
    mkdirSync(home);
    initIngressRepo(root, process.getuid?.() ?? 0);
    execFileSync("git", ["-C", root, "update-ref", "refs/remotes/origin/main", "HEAD"]);
    realm.bind(userRoot);
    realm.keycloak.account("owner");
    realm.keycloak.permit("owner", repoId, effectivePolicyGroupScopes(deriveBasePolicyGroups(), "admin"));
    signInAt(userRoot, "owner");
    registerBootstrappedDaemonRepo({ canonicalRoot: root, repoId, userRoot, createConvenienceLinks: false });

    const daemon = await startDaemon({
      daemonId,
      userRoot,
      buildSupersessionEnabled: false,
      runtimeDiscover: () => [],
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

    // 1. Create an independent upstream task holding the canonical upstream charter at v1.
    const upstreamCreated = await cliJson(
      0,
      "task",
      "create",
      "--title",
      "Upstream Charter Source",
      "--vertical",
      "office/collab",
      "--preset",
      "deliverable-task",
      "--profile",
      "baseline",
      "--risk-tier",
      "low",
    );
    assert.equal(upstreamCreated.outcome, "applied", JSON.stringify(upstreamCreated));
    const upstreamTaskId = String(upstreamCreated.taskId);
    const upstreamWorkspacePkg = String(upstreamCreated.workspacePackagePath);
    const upstreamPkg = upstreamWorkspacePkg.replace(/^harness\//u, "");
    await realizeTaskPlanFixture(root, upstreamWorkspacePkg, (planPath: string) =>
      run({ kind: "doc-submit", paths: [planPath] }),
    );
    assert.equal((await cliJson(0, "task", "start", upstreamTaskId)).outcome, "applied");

    const charterV1 = "# Upstream Charter\n\nApproved Q4 scope v1.\n";
    const charterV1Sha = sha256(charterV1);
    const upstreamCharterLogical = `${upstreamPkg}/artifacts/charter.md`;
    const upstreamCharterFile = path.join(root, upstreamWorkspacePkg, "artifacts", "charter.md");
    mkdirSync(path.dirname(upstreamCharterFile), { recursive: true });
    writeFileSync(upstreamCharterFile, charterV1);
    assert.equal((await run({ kind: "doc-submit", paths: [upstreamCharterLogical] })).outcome, "applied");

    // 2. Create downstream deliverable-task (--profile upstream-verified) pinned to charter v1.
    const prepareDownstreamSubmission = async (
      title: string,
      charterBody: string,
      charterSha: string,
    ): Promise<string> => {
      const created = await cliJson(
        0,
        "task",
        "create",
        "--title",
        title,
        "--vertical",
        "office/collab",
        "--preset",
        "deliverable-task",
        "--profile",
        "upstream-verified",
        "--risk-tier",
        "low",
      );
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      const taskId = String(created.taskId);
      const wsPkg = String(created.workspacePackagePath);
      const pkg = wsPkg.replace(/^harness\//u, "");
      await realizeTaskPlanFixture(root, wsPkg, (planPath: string) => run({ kind: "doc-submit", paths: [planPath] }));
      assert.equal((await cliJson(0, "task", "start", taskId)).outcome, "applied");

      const deliverableBody =
        "# Quarterly Deliverable\n\n## Executive Summary\n\nAligned with approved charter.\n\n## Action Plan\n\n- Deliver final review packet\n";
      const deliverableSha = sha256(deliverableBody);
      const artifactsDir = path.join(root, wsPkg, "artifacts");
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(path.join(artifactsDir, "deliverable.md"), deliverableBody);
      writeFileSync(
        path.join(artifactsDir, "deliverable-manifest.json"),
        JSON.stringify({
          schema: "office-collab/deliverable-manifest/v1",
          title,
          deliverableKind: "report",
          owner: "coordinator",
          audience: "operations",
          documentPath: "artifacts/deliverable.md",
          documentSha256: deliverableSha,
          requiredSections: ["## Executive Summary", "## Action Plan"],
        }),
      );
      writeFileSync(path.join(artifactsDir, "upstream-charter.md"), charterBody);
      writeFileSync(
        path.join(artifactsDir, "upstream-freshness.json"),
        JSON.stringify({
          schema: "office-collab/upstream-freshness/v1",
          checkedAt: "2026-11-21T09:00:00Z",
          baselines: [
            {
              ref: "artifacts/upstream-charter.md",
              sourcePath: upstreamCharterLogical,
              expectedSha256: charterSha,
            },
          ],
        }),
      );
      writeFileSync(
        path.join(root, wsPkg, "closeout.md"),
        "# Closeout\n\n## Summary\n\nPrepared quarterly deliverable with verified upstream baseline.\n\n## Verification\n\nDeliverable contract and upstream freshness manifests synced.\n",
      );
      const synced = await run({
        kind: "doc-submit",
        paths: [
          `${pkg}/artifacts/deliverable.md`,
          `${pkg}/artifacts/deliverable-manifest.json`,
          `${pkg}/artifacts/upstream-charter.md`,
          `${pkg}/artifacts/upstream-freshness.json`,
          `${pkg}/closeout.md`,
        ],
      });
      assert.equal(synced.outcome, "applied", JSON.stringify(synced));
      const submitted = await cliJson(0, "task", "submit", taskId);
      assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
      return taskId;
    };

    const staleDownstreamTaskId = await prepareDownstreamSubmission(
      "Downstream Stale Deliverable",
      charterV1,
      charterV1Sha,
    );

    // 3. Advance the independent upstream charter from v1 -> v2 WITHOUT modifying the frozen downstream submission.
    const charterV2 = "# Upstream Charter\n\nApproved Q4 scope v2 with updated compliance threshold.\n";
    const charterV2Sha = sha256(charterV2);
    writeFileSync(upstreamCharterFile, charterV2);
    assert.equal((await run({ kind: "doc-submit", paths: [upstreamCharterLogical] })).outcome, "applied");

    // 4. Attempting to complete the frozen v1 downstream submission (which initially passed at submit)
    // must detect live canonical upstream drift atomically in completeTask and reject completion
    // WITHOUT mutating gateRuns or forging an owner rerun (HA09-12 / HA09-13).
    const beforeCompleteShow = await cliJson(0, "task", "show", staleDownstreamTaskId);
    const staleComplete = await run({ kind: "task-complete", taskId: staleDownstreamTaskId });
    assert.equal(staleComplete.outcome, "op_rejected", JSON.stringify(staleComplete));
    assert.equal(staleComplete.code, "gate_witness_missing", JSON.stringify(staleComplete));
    assert.match(JSON.stringify(staleComplete), /Live upstream drift/u);
    const afterCompleteShow = await cliJson(0, "task", "show", staleDownstreamTaskId);
    assert.equal(
      JSON.stringify((afterCompleteShow as { evidence?: unknown }).evidence),
      JSON.stringify((beforeCompleteShow as { evidence?: unknown }).evidence),
      "completeTask rejection on live upstream drift must not mutate gateRuns or task revision",
    );

    // 4b. Pre-submit drift: a new downstream submission carrying frozen v1 copy after upstream already advanced to v2
    // must also fail upstream-fresh immediately and block completion.
    const preSubmitStaleTaskId = await prepareDownstreamSubmission(
      "Downstream Pre-Submit Stale Deliverable",
      charterV1,
      charterV1Sha,
    );
    const preSubmitStaleComplete = await run({ kind: "task-complete", taskId: preSubmitStaleTaskId });
    assert.equal(preSubmitStaleComplete.outcome, "op_rejected", JSON.stringify(preSubmitStaleComplete));
    assert.equal(preSubmitStaleComplete.code, "gate_witness_missing", JSON.stringify(preSubmitStaleComplete));

    // 5. Positive control: a downstream submission aligned to the live v2 charter passes both gates and completes.
    const freshDownstreamTaskId = await prepareDownstreamSubmission(
      "Downstream Fresh Deliverable",
      charterV2,
      charterV2Sha,
    );
    const freshComplete = await run({ kind: "task-complete", taskId: freshDownstreamTaskId });
    assert.equal(freshComplete.outcome, "applied", JSON.stringify(freshComplete));
  },
);
