// harness-test-tier: integration
import assert from "node:assert/strict";
import { removeTempStoreRoot } from "../../kernel/test/store/helpers.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskEventReader,
  type AgentDefinitionSnapshot,
  type RuntimeInstallationWitness,
} from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { requireExecutionRequestScope } from "../src/runtime-execution-scope.ts";
import { CAUSAL_CONTEXT_MAX_BYTES } from "../src/dispatch-causal-context.ts";
import { localUserDaemonEndpoint } from "../src/client/local-daemon-target.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import { actor, evidence, initRepo } from "./task-surface.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";

function assertScopedGuidance(prompt: string, taskId: string): void {
  assert.doesNotMatch(prompt, /ha (?:graph|work show|task create)/u);
  assert.match(prompt, new RegExp(`ha task read-set ${taskId}`, "u"));
  assert.match(prompt, /task_plan\.md 全文与 <task-context> 已注入上面的 mission，不必再读文件/u);
  assert.doesNotMatch(prompt, /Read task_plan\.md in that package/u, "the plan is inlined, not assigned as a read");
  assert.match(prompt, /# Living Deliverable Protocol/u);
  assert.match(prompt, /资料不足[\s\S]*owner/u);
  for (const role of ["implementation", "reviewer"] as const) {
    const principal = {
      personId: "person-worker",
      repoId: "repo",
      runtimeSessionId: "runtime-worker",
      dispatchId: "dispatch-worker",
      taskId,
      executionId: "execution-worker",
      role,
      source: "local" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const request = (kind: string) =>
      requireExecutionRequestScope(principal, "repo.task.read", {
        repo: { repoId: principal.repoId },
        payload: { action: { kind, taskId } },
      });
    assert.doesNotThrow(() => request("task-read-set"));
    assert.doesNotThrow(() =>
      requireExecutionRequestScope(principal, "repo.settings.read", {
        repo: { repoId: principal.repoId },
        payload: {},
      }),
    );
    assert.doesNotThrow(() => request("graph"));
  }
}

const binding: RepoCellBinding = withPolicyGroup({ actor, source: "local" as const }, "contributor"),
  definition: AgentDefinitionSnapshot = {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: "codex-causal",
    installationId: "installation-causal",
    kindId: "codex",
    providerId: "openai",
    model: "causal-model",
    reasoningEffort: "high",
    baseUrl: "https://api.example.test/",
    authMode: "api-key",
  },
  installation: RuntimeInstallationWitness = {
    installationId: definition.installationId,
    kindId: definition.kindId,
    executablePath: "/opt/witnessed/causal",
    version: "1.0.0",
    observedAt: "2026-09-17T00:00:00.000Z",
  };

function instance(): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId: definition.instanceId,
    name: "Codex Causal",
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
  };
}

type Cell = Awaited<ReturnType<typeof openRepoCell>>;

async function createTask(
  cell: Cell,
  root: string,
  spec: {
    readonly taskId: string;
    readonly title: string;
    readonly taskClass?: string;
    readonly parentTaskId?: string;
    readonly profileId?: string;
    readonly presetId?: string;
  },
  planTitle?: string,
): Promise<string> {
  const created = await cell.run({ kind: "task-create", ...spec }, binding);
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await waitForFixturePublication(cell, created.opId, binding);
  const packagePath = (created as Record<string, unknown>).packagePath;
  assert.equal(typeof packagePath, "string", JSON.stringify(created));
  await realizeTaskPlanFixture(
    root,
    String(packagePath),
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    planTitle,
  );
  return String(packagePath);
}

async function relate(cell: Cell, sourceRef: string, targetRef: string, relationType: string): Promise<void> {
  const related = await cell.run(
    { kind: "relation-relate", sourceRef, targetRef, relationType, rationale: "Fixture edge.", expectedVersion: 0 },
    binding,
  );
  assert.equal(related.outcome, "applied", JSON.stringify(related));
  await waitForFixturePublication(cell, related.opId, binding);
}

async function acceptDecision(cell: Cell, decisionId: string): Promise<void> {
  const accepted = await cell.run(
    {
      kind: "decision-accept",
      decisionId,
      rationale: "Fixture prerequisites are ready.",
      judgmentOnlyRationale: "This fixture tests dispatch admission, not decision evidence readiness.",
    },
    withPolicyGroup(binding, "maintainer"),
  );
  assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  await waitForFixturePublication(cell, accepted.opId, binding);
}

function causalBlock(prompt: string): string | null {
  // Line-anchored: the lookup guidance names the tag mid-sentence, so only an
  // element that starts its own line is the injected block.
  const match = /^<task-context[^>]*>[\s\S]*?<\/task-context>/mu.exec(prompt);
  return match === null ? null : match[0];
}

test("task-bound dispatch injects the work, deriving decision, and evidence facts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-context-"));
  let prompt: string | null = null;
  let cell: Cell | undefined;
  try {
    initRepo(root);
    mkdirSync(path.join(root, ".github"));
    writeFileSync(path.join(root, ".github/pull_request_template.md"), "# English\n# 中文\n");
    cell = await openRepoCell({
      repoId: workspaceId("dispatch-context"),
      rootDir: canonicalRoot(root),
      ownerId: "dispatch-context-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "dispatch-context-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [instance()],
      prepareRuntimeLaunch: async (_instanceId, request) => {
        prompt = request.prompt;
        return {
          definition,
          installation,
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => ({
        pid: 4242,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    await createTask(cell, root, { taskId: "task_ctx_root", title: "Causal work", taskClass: "work" });
    // Each spawn holds the task lease for its runtime session, so every dispatch
    // in this test gets its own leaf task under the same causal neighborhood.
    for (const taskId of ["task_ctx_leaf", "task_ctx_explicit", "task_ctx_agent"])
      await createTask(cell, root, { taskId, title: "Leaf worker task", parentTaskId: "task_ctx_root" });
    await createTask(cell, root, { taskId: "task_ctx_lonely", title: "No relations" });
    const proposed = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Dispatch context decision",
          question: "Should workers receive causal context automatically?",
          riskTier: "low",
          urgency: "low",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [
            {
              id: "CH1",
              text: "Inject the causal slice at dispatch",
              rationale: "Agents do not run read-set on their own.",
            },
          ],
          rejected: [{ id: "RJ1", text: "Keep prompts context-free", whyNot: "Cold-start盲区已在事故中复现" }],
          claims: [{ id: "C1", text: "94% of dispatches skip read-set.", loadBearing: true }],
          fulfillments: [],
        }),
        body: "# Dispatch context decision\n\nPush context, do not make the worker guess.\n",
      },
      binding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    await waitForFixturePublication(cell, proposed.opId, binding);
    const decisionId = String(evidence(proposed).decisionId),
      fact = await cell.run(
        {
          kind: "fact-record",
          factId: "F-00CA05A1",
          statement: "Dispatch prompts previously carried no causal topology.",
          evidenceSource: "packages/daemon/src/runtime-spawner.ts",
          confidence: "high",
          memoryClass: "semantic",
        },
        binding,
      );
    assert.equal(fact.outcome, "applied", JSON.stringify(fact));
    await waitForFixturePublication(cell, fact.opId, binding);
    for (const taskId of ["task_ctx_leaf", "task_ctx_explicit", "task_ctx_agent"])
      await relate(cell, `decision/${decisionId}/CH1`, `task/${taskId}`, "derives");
    await relate(cell, `decision/${decisionId}/C1`, "fact/F-00CA05A1", "evidenced-by");
    await assert.rejects(
      cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          cwd: { scope: "repo-root" },
          taskId: "task_ctx_leaf",
          dispatchKey: "dispatch-context-proposed",
        },
        binding,
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "task_dispatch_prerequisite_unmet" &&
        error.message.includes(`ha decision accept ${decisionId}`),
    );
    await acceptDecision(cell, decisionId);

    const receipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        taskId: "task_ctx_leaf",
        dispatchKey: "dispatch-context-leaf",
      },
      binding,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.ok(prompt !== null, "the launch request captured a prompt");
    const block = causalBlock(prompt!);
    assert.ok(block !== null, `no causal block in prompt:\n${prompt}`);
    assert.match(block, /<work ref="task\/task_ctx_root">Causal work<\/work>/u);
    assert.match(block, new RegExp(`<decision ref="decision/${decisionId}" title="Dispatch context decision"/>`, "u"));
    assert.match(
      block,
      new RegExp(
        `<chosen ref="decision/${decisionId}" anchor="CH1">Inject the causal slice at dispatch — Agents do not run`,
        "u",
      ),
    );
    assert.match(
      block,
      new RegExp(`<claims ref="decision/${decisionId}">C1 94% of dispatches skip read-set\\.</claims>`, "u"),
    );
    // dec_BB2BCE9F995CD3A126E2918734 CH4: the injected fact names the commit and time it was
    // recorded against (fixture-resolved, so matched loosely after the evidence source).
    assert.match(
      block,
      /<fact ref="fact\/F-00CA05A1">Dispatch prompts previously carried no causal topology\. \(src:packages\/daemon\/src\/runtime-spawner\.ts; recorded [0-9TZ:.-]+ @ [0-9a-f]{8}\)<\/fact>/u,
    );
    assert.match(block, /^<task-context>\n<note>fact 是历史观察，涉及代码时以现场为准。<\/note>\n/u);
    assert.ok(Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES, "causal block exceeds the byte budget");
    assert.doesNotMatch(block, /ha graph/u, "the causal block no longer spends budget on a bare command word");
    assert.match(prompt!, /# 台账查询引导/u, "the lookup guidance rides every task-bound mission");
    assert.match(
      prompt!,
      /Exercise the fixture's task lifecycle through canonical repository commands\./u,
      "the plan body rides the mission verbatim instead of a read instruction",
    );
    assert.match(
      prompt!,
      /# Living Deliverable Protocol/u,
      "the living deliverable protocol rides every task-bound mission",
    );
    assertScopedGuidance(prompt!, "task_ctx_leaf");

    // An explicit prompt on a task-bound dispatch still gets the same block prepended.
    prompt = null;
    const explicit = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "Finish the leaf task.",
        taskId: "task_ctx_explicit",
        dispatchKey: "dispatch-context-explicit",
      },
      binding,
    );
    assert.equal(explicit.outcome, "applied", JSON.stringify(explicit));
    const explicitBlock = causalBlock(prompt!);
    assert.ok(explicitBlock !== null, "explicit-prompt dispatch lost the causal block");
    assert.match(
      prompt!,
      /Exercise the fixture's task lifecycle through canonical repository commands\./u,
      "an explicit prompt carries the inlined plan too",
    );
    assertScopedGuidance(prompt!, "task_ctx_explicit");
    assert.ok(prompt!.endsWith("Finish the leaf task."), "explicit caller text stays intact");

    // An agent-bound dispatch (ha agent run shape) assembles the same mission body.
    const installed = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "causal-worker",
          name: "Causal Worker",
          instructions: "Do the work.",
          runtimes: [{ type: "codex" }],
        },
      },
      binding,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    prompt = null;
    const agentRun = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        agentId: "causal-worker",
        cwd: { scope: "repo-root" },
        taskId: "task_ctx_agent",
        dispatchKey: "dispatch-context-agent",
      },
      binding,
    );
    assert.equal(agentRun.outcome, "applied", JSON.stringify(agentRun));
    assert.match(prompt!, /# Agent Identity: Causal Worker/u);
    assert.ok(causalBlock(prompt!) !== null, "agent-bound dispatch lost the causal block");
    assertScopedGuidance(prompt!, "task_ctx_agent");

    // A task with no causal neighborhood injects no causal block, but the fixed
    // guidance still directs the worker to its own read-set and owner for missing context.
    prompt = null;
    const lonely = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        taskId: "task_ctx_lonely",
        dispatchKey: "dispatch-context-lonely",
      },
      binding,
    );
    assert.equal(lonely.outcome, "applied", JSON.stringify(lonely));
    assert.equal(causalBlock(prompt!), null, "relation-free task must not carry a fabricated block");
    assert.match(prompt!, /# 台账查询引导/u);
    assertScopedGuidance(prompt!, "task_ctx_lonely");

    // Medium tasks are born with a materialized explainer page; low-risk tasks carry no
    // Living Deliverable Protocol even when the preset has no short profile.
    const baselinePackage = await createTask(cell, root, {
      taskId: "task_ctx_explainer",
      title: "Explainer carrier",
      parentTaskId: "task_ctx_root",
    });
    const baselinePage = readFileSync(
      path.join(canonicalRoot(root), "harness", baselinePackage, "artifacts", "explainer.html"),
      "utf8",
    );
    assert.ok(baselinePage.startsWith("<!DOCTYPE html>"), "the explainer page is materialized at create");
    assert.ok(baselinePage.includes("Explainer carrier"), "the skeleton carries the task title");
    prompt = null;
    const explainerDispatch = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        taskId: "task_ctx_explainer",
        dispatchKey: "dispatch-context-explainer",
      },
      binding,
    );
    assert.equal(explainerDispatch.outcome, "applied", JSON.stringify(explainerDispatch));
    assert.match(prompt!, /# Living Deliverable Protocol/u);
    assert.match(prompt!, /最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实/u);
    assert.match(prompt!, /正文和 closeout 中的机器派生交付事实从 submission 读取/u);
    assert.match(prompt!, /实时说明页/u, "the protocol names the owner-facing live page");
    assert.match(prompt!, /#now[\s\S]*#timeline/u, "mission names the fixed living sections");
    const lowPackage = await createTask(cell, root, {
      taskId: "task_ctx_lite",
      title: "Low risk baseline carrier",
      riskTier: "low",
      profileId: "baseline",
    });
    assert.equal(
      existsSync(path.join(canonicalRoot(root), "harness", lowPackage, "artifacts", "explainer.html")),
      false,
      "a low-risk task does not materialize an explainer based on its profile",
    );
    prompt = null;
    const low = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        taskId: "task_ctx_lite",
        dispatchKey: "dispatch-context-lite",
      },
      binding,
    );
    assert.equal(low.outcome, "applied", JSON.stringify(low));
    assert.match(prompt!, /# 台账查询引导/u, "low-risk missions keep the lookup guidance");
    assert.equal(
      existsSync(path.join(canonicalRoot(root), "harness", lowPackage, "artifacts", "explainer.html")),
      false,
    );
    assert.doesNotMatch(prompt!, /# Living Deliverable Protocol/u, "low risk owes no living deliverable");
    assert.doesNotMatch(prompt!, /explainer\.html/u);
    assert.match(
      prompt!,
      /最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实/u,
      "lightweight owes no explainer but still owes the PR publication note",
    );
    const preview = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        taskId: "task_ctx_lite",
        prompt: "Explicit PR delivery.",
        dispatchKey: "dispatch-context-lite-explicit",
        dryRun: true,
      },
      binding,
    );
    assert.match(String(preview.mission), /最终代码 commit 后先运行 `ha task submit <task-id>` 冻结交付事实/u);
  } finally {
    await cell?.close();
    removeTempStoreRoot(root);
  }
});

test("artifact task dispatch confines writes to its package despite bypass declarations and cwd overrides", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-package-"));
  let cell: Cell | undefined;
  let prepared:
    | {
        readonly cwd: string;
        readonly permissionMode?: string;
        readonly prompt: string;
        readonly callbackRelayPath?: string;
      }
    | undefined;
  let launches = 0;
  let useZcode = false;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("dispatch-package"),
      rootDir: canonicalRoot(root),
      ownerId: "dispatch-package-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "dispatch-package-test",
        endpoint: localUserDaemonEndpoint(path.join(root, ".daemon-user"), "dispatch-package-test"),
      },
      runtimeInstances: () => [{ ...instance(), kindId: useZcode ? "zcode" : "codex", permissionMode: "bypass" }],
      prepareRuntimeLaunch: (_instanceId, request) => {
        prepared = request;
        return {
          definition: { ...definition, kindId: useZcode ? "zcode" : "codex" },
          installation: { ...installation, kindId: useZcode ? "zcode" : "codex" },
          executablePath: installation.executablePath,
          args: [],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => {
        launches += 1;
        return {
          pid: 4242,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    const installed = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "package-worker",
          name: "Package Worker",
          instructions: "Produce the task report.",
          runtimes: [{ type: "codex" }],
          permissionMode: "bypass",
        },
      },
      binding,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    for (const [index, override] of [undefined, "bypass", "read-only"].entries()) {
      const taskId = `task_package_${index}`;
      const packagePath = await createTask(cell, root, {
        taskId,
        title: "Investigate without source edits",
        presetId: "code-impact-analysis",
      });
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          agentId: "package-worker",
          taskId,
          dispatchKey: `package-${index}`,
          cwd: { scope: "repo-root" },
          ...(override ? { permissionMode: override } : {}),
        },
        binding,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      assert.equal(prepared?.cwd, path.join(root, "harness", packagePath));
      assert.equal(prepared?.permissionMode, override === "read-only" ? "read-only" : "workspace-write");
      if (process.platform === "win32") assert.equal(prepared?.callbackRelayPath, undefined);
      else assert.match(prepared?.callbackRelayPath ?? "", /^\/tmp\/harness-anything-\d+\/r-[a-f0-9]{24}\.sock$/u);
      assert.ok(prepared?.prompt.includes(`Worker repository root: ${prepared.cwd}`));
    }
    assert.equal(launches, 3);
    const taskId = "task_package_code_control";
    await createTask(cell, root, { taskId, title: "Implement a code change" });
    const workerRoot = path.join(root, "worker-control");
    mkdirSync(workerRoot);
    const receipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        agentId: "package-worker",
        taskId,
        dispatchKey: "package-code-control",
        cwd: { scope: "repo-relative", path: "worker-control" },
      },
      binding,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(prepared?.cwd, workerRoot);
    assert.equal(prepared?.permissionMode, "bypass");
    assert.equal(prepared?.callbackRelayPath, undefined);
    useZcode = true;
    await createTask(cell, root, {
      taskId: "task_package_zcode",
      title: "Investigate with ZCode",
      presetId: "code-impact-analysis",
    });
    await assert.rejects(
      cell.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          taskId: "task_package_zcode",
          dispatchKey: "package-zcode",
          permissionMode: "bypass",
        },
        binding,
      ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "zcode_unattended_permission_mode_unsupported",
    );
    assert.equal(launches, 4, "the unsupported provider must never start with bypass permissions");
  } finally {
    await cell?.close();
    removeTempStoreRoot(root);
  }
});

test("dry-run preview returns the injected prompt byte-for-byte with zero dispatch side effects", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-preview-"));
  let prompt: string | null = null,
    launchCalls = 0;
  let cell: Cell | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("dispatch-preview"),
      rootDir: canonicalRoot(root),
      ownerId: "dispatch-preview-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "dispatch-preview-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [instance()],
      prepareRuntimeLaunch: async (_instanceId, request) => {
        launchCalls += 1;
        prompt = request.prompt;
        return {
          definition,
          installation,
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => ({
        pid: 4244,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    await createTask(cell, root, { taskId: "task_pv_root", title: "Preview work", taskClass: "work" });
    await createTask(cell, root, {
      taskId: "task_pv_leaf",
      title: "Preview leaf task",
      parentTaskId: "task_pv_root",
    });
    const installed = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "preview-worker",
          name: "Preview Worker",
          instructions: "Follow the preview contract.",
          prompts: ["Check the ledger before acting."],
          runtimes: [{ type: "codex" }],
        },
      },
      binding,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    const proposed = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: "Preview decision",
          question: "Does the preview carry causal context?",
          riskTier: "low",
          urgency: "low",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Inject the same causal slice", rationale: "Preview must not drift." }],
          rejected: [{ id: "RJ1", text: "Preview without context", whyNot: "Context-free previews drift." }],
          claims: [],
          fulfillments: [],
        }),
        body: "# Preview decision\n\nKeep one assembly path.\n",
      },
      binding,
    );
    assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
    await waitForFixturePublication(cell, proposed.opId, binding);
    await relate(cell, `decision/${String(evidence(proposed).decisionId)}/CH1`, "task/task_pv_leaf", "derives");
    await acceptDecision(cell, String(evidence(proposed).decisionId));

    const repoId = workspaceId("dispatch-preview"),
      canonical = canonicalRoot(root),
      spawnPayload = {
        runtimeInstanceId: definition.instanceId,
        agentId: "preview-worker",
        cwd: { scope: "repo-root" as const },
        taskId: "task_pv_leaf",
        dispatchKey: "dispatch-preview-leaf",
      },
      revisionBefore = makeTaskEventReader({ repoId, rootDir: canonical }).read().revision,
      preview = await cell.spawnRuntime({ ...spawnPayload, dryRun: true }, binding);
    assert.equal(preview.schema, "agent-dispatch-preview/v1", JSON.stringify(preview));
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(typeof preview.prompt, "string");
    assert.equal(typeof preview.mission, "string");
    assert.match(String(preview.prompt), /# Agent Identity: Preview Worker/u);
    assert.match(String(preview.prompt), /<task-context/u);

    // No launch, no lease, no ledger write: the preview is a read projection.
    assert.equal(launchCalls, 0, "dry-run must not reach prepareLaunch");
    assert.equal(prompt, null, "dry-run must not produce a launch prompt");
    assert.equal(
      makeTaskEventReader({ repoId, rootDir: canonical }).read().revision,
      revisionBefore,
      "dry-run must not append to the ledger",
    );

    // The real dispatch with the same inputs injects exactly the previewed prompt.
    const real = await cell.spawnRuntime(spawnPayload, binding);
    assert.equal(real.outcome, "applied", JSON.stringify(real));
    assert.equal(launchCalls, 1);
    assert.equal(preview.dispatchId, real.dispatchId, "preview must derive the same dispatch identity");
    assert.equal(preview.runtimeSessionId, real.runtimeSessionId);
    assert.equal(preview.prompt, prompt, "preview prompt must equal the injected prompt byte-for-byte");
    assert.match(String(preview.mission), /<task-context/u);
    assert.match(String(preview.mission), /# Living Deliverable Protocol/u);
    assertScopedGuidance(String(preview.mission), "task_pv_leaf");

    // Negative control: changing an injected declaration field must change the preview.
    const updated = await cell.run(
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "preview-worker",
          name: "Preview Worker",
          instructions: "Follow the revised preview contract.",
          prompts: ["Check the ledger before acting."],
          runtimes: [{ type: "codex" }],
        },
      },
      binding,
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    const revised = await cell.spawnRuntime(
      { ...spawnPayload, dispatchKey: "dispatch-preview-leaf-2", dryRun: true },
      binding,
    );
    assert.equal(revised.ok, true, JSON.stringify(revised));
    assert.notEqual(revised.prompt, preview.prompt, "preview must track declaration changes");
    assert.match(String(revised.prompt), /Follow the revised preview contract\./u);
    assert.equal(launchCalls, 1, "second dry-run must not reach prepareLaunch");
  } finally {
    await cell?.close();
    removeTempStoreRoot(root);
  }
});

test("oversized CJK causal context stays inside the byte budget on a real dispatch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-dispatch-context-cjk-"));
  let prompt: string | null = null;
  let cell: Cell | undefined;
  // Decision payloads bound question (≤499 code points) and rationale (≤199);
  // text fields are unbounded, so the oversized payload lives there.
  const long = "承重裁决理由与证据陈述".repeat(60),
    medium = "问题定义".repeat(100),
    short = "理由".repeat(90);
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("dispatch-context-cjk"),
      rootDir: canonicalRoot(root),
      ownerId: "dispatch-context-cjk-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "dispatch-context-cjk-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [instance()],
      prepareRuntimeLaunch: async (_instanceId, request) => {
        prompt = request.prompt;
        return {
          definition,
          installation,
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: () => ({
        pid: 4243,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    await createTask(cell, root, { taskId: "task_cjk_root", title: long, taskClass: "work" });
    await createTask(cell, root, {
      taskId: "task_cjk_leaf",
      title: "叶子任务",
      parentTaskId: "task_cjk_root",
    });
    const decisionIds: string[] = [];
    for (const [index, suffix] of ["AAAA", "BBBB"].entries()) {
      const proposed = await cell.run(
        {
          kind: "decision-propose",
          jsonInput: JSON.stringify({
            title: `${long}${suffix}`,
            question: medium,
            riskTier: "low",
            urgency: "low",
            vertical: "software/coding",
            preset: "standard-task",
            decisionClass: "ordinary",
            appliesTo: { modules: [], productLines: [] },
            chosen: [{ id: "CH1", text: long, rationale: short }],
            rejected: [{ id: "RJ1", text: "不注入", whyNot: short }],
            claims: [1, 2, 3].map((c) => ({ id: `C${c}`, text: long, loadBearing: true })),
            fulfillments: [],
          }),
          body: `# Decision ${suffix}\n\n${long}\n`,
        },
        binding,
      );
      assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
      await waitForFixturePublication(cell, proposed.opId, binding);
      const decisionId = String(evidence(proposed).decisionId);
      decisionIds.push(decisionId);
      const fact = await cell.run(
        {
          kind: "fact-record",
          factId: `F-CJK${"AB"[index]!}AAA0`,
          statement: long,
          evidenceSource: `packages/daemon/test/cjk-${index}.ts`,
          confidence: "high",
          memoryClass: "semantic",
        },
        binding,
      );
      assert.equal(fact.outcome, "applied", JSON.stringify(fact));
      await waitForFixturePublication(cell, fact.opId, binding);
      await relate(cell, `decision/${decisionId}/CH1`, "task/task_cjk_leaf", "derives");
      await relate(cell, `decision/${decisionId}/C1`, `fact/F-CJK${"AB"[index]!}AAA0`, "evidenced-by");
      await acceptDecision(cell, decisionId);
    }
    const receipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        taskId: "task_cjk_leaf",
        dispatchKey: "dispatch-context-cjk",
      },
      binding,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const block = causalBlock(prompt!);
    assert.ok(block !== null, "long CJK causal context produced no block");
    assert.ok(
      Buffer.byteLength(block, "utf8") <= CAUSAL_CONTEXT_MAX_BYTES,
      `causal block is ${Buffer.byteLength(block, "utf8")} bytes`,
    );
    assert.match(
      block,
      /^<task-context truncated="yes">/u,
      "an over-budget neighborhood marks the root truncated instead of field-cutting",
    );
    assert.doesNotMatch(block, /…/u, "no field inside the kept entries is truncated anymore");
    assert.match(
      block,
      new RegExp(`${"承重裁决理由与证据陈述".repeat(60)} — ${"理由".repeat(90)}`, "u"),
      "the kept chosen clause rides at full length",
    );
    assert.match(block, /<omitted>[^<]*F-CJKBAAA0[^<]*F-CJKAAAA0[^<]*<\/omitted>/u, "shed refs are named");
    assert.match(block, new RegExp(decisionIds[0]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  } finally {
    await cell?.close();
    removeTempStoreRoot(root);
  }
});

test("a dispatch whose declaration mounts self-iteration carries the closeout step; others do not", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-self-iteration-closeout-"));
  let cell: Cell | undefined;
  try {
    initRepo(root);
    cell = await openRepoCell({
      repoId: workspaceId("self-iteration-closeout"),
      rootDir: canonicalRoot(root),
      ownerId: "self-iteration-closeout-test",
      runtimeDaemonRoute: {
        userRoot: path.join(root, ".daemon-user"),
        daemonId: "self-iteration-closeout-test",
        endpoint: path.join(root, ".daemon-user", "daemon.sock"),
      },
      runtimeInstances: () => [instance()],
      prepareRuntimeLaunch: async () => {
        throw new Error("dry-run must not reach prepareLaunch");
      },
      runtimeLaunch: () => ({
        pid: 4245,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      }),
    });
    await createTask(cell, root, { taskId: "task_si_root", title: "Self-iteration work", taskClass: "work" });
    await createTask(cell, root, {
      taskId: "task_si_leaf",
      title: "Self-iteration leaf",
      parentTaskId: "task_si_root",
    });
    // Skills resolve against the harness authored root, so the fixture materializes real skill dirs.
    for (const skill of ["self-iteration", "harness-anything-worker"]) {
      const dir = path.join(root, "harness", "skills", skill);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${skill}\ndescription: Fixture\n---\nFixture body.\n`);
    }
    const install = async (id: string, skills: readonly { readonly id: string; readonly path: string }[]) => {
      const receipt = await cell!.run(
        {
          kind: "agent-install",
          declaration: {
            schema: "agent-declaration/v1",
            id,
            name: id,
            instructions: "Deliver, then reflect.",
            runtimes: [{ type: "codex" }],
            skills,
          },
        },
        binding,
      );
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    };
    await install("opted-in-worker", [{ id: "self-iteration", path: "skills/self-iteration" }]);
    await install("plain-worker", [{ id: "harness-anything-worker", path: "skills/harness-anything-worker" }]);
    const preview = (agentId: string, dispatchKey: string) =>
      cell!.spawnRuntime(
        {
          runtimeInstanceId: definition.instanceId,
          agentId,
          cwd: { scope: "repo-root" as const },
          taskId: "task_si_leaf",
          dispatchKey,
          dryRun: true,
        },
        binding,
      );
    const optedIn = await preview("opted-in-worker", "dispatch-self-iteration-opted-in");
    assert.equal(optedIn.ok, true, JSON.stringify(optedIn));
    assert.match(String(optedIn.prompt), /# Self-iteration closeout/u);
    assert.match(String(optedIn.prompt), /artifacts\/reflections\/dispatch_[a-f0-9]+\.md/u, "the path is rendered");
    assert.match(String(optedIn.prompt), /必须同时列出删除项/u);
    const plain = await preview("plain-worker", "dispatch-self-iteration-plain");
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.doesNotMatch(String(plain.prompt), /# Self-iteration closeout/u, "the opt-in is the only trigger");
  } finally {
    await cell?.close();
    removeTempStoreRoot(root);
  }
});
