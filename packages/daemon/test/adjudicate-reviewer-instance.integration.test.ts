// harness-test-tier: integration
import assert from "node:assert/strict";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { RuntimeInstanceSummary, RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell, waitForFixturePublication } from "./repo-settings.fixture.ts";
import type { RuntimeProcess } from "../src/runtime-spawn-types.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";

import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

import { grantTestPolicyGroups } from "./keycloak-policy.fixtures.ts";

const ciBin = mkdtempSync(path.join(tmpdir(), "ha-adjudicate-instance-bin-"));
const originalPath = process.env.PATH;
before(() => {
  writeProviderExecutable(
    path.join(ciBin, "gh"),
    'if (process.argv[2] !== "run" || process.argv[3] !== "list") process.exit(1); console.log("[]");\n',
  );
  process.env.PATH = `${ciBin}${path.delimiter}${originalPath ?? ""}`;
});
after(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(ciBin, { recursive: true, force: true });
});

const binding = withPolicyGroup(
  {
    actor: { principal: { personId: "person-adjudicate-instance" }, executor: null },
    source: "local" as const,
  },
  "admin",
);
const installation: RuntimeInstallationWitness = {
  installationId: "installation-adjudicate-instance",
  kindId: "codex",
  executablePath: "/opt/witnessed/adjudicate-instance",
  version: "1.0.0",
  observedAt: "2026-09-28T00:00:00.000Z",
};

// An unpinned bundled reviewer (closeout-reviewer declares no instance and no model) would
// otherwise land on an unpredictable default instance; --instance/--model must pin the dispatch.
test("adjudicate --forward pins reviewer resources and carries the owner context", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-adjudicate-instance-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    instances = ["review-instance-a", "review-instance-b"].map(runtimeInstance),
    launched: { readonly instanceId: string; readonly model: string }[] = [],
    prompts: string[] = [],
    ownerNote =
      "Owner context: review the submitted source cut.\nPost-merge verification remains a separate completion step.";
  let pid = 9100;
  mkdirSync(root);
  initRepo(root);
  grantTestPolicyGroups([binding.actor.principal.personId], "admin");
  const cell = await openRepoCell({
    repoId: workspaceId("adjudicate-instance"),
    rootDir: canonicalRoot(root),
    ownerId: "adjudicate-instance",
    runtimeDaemonRoute: {
      userRoot,
      daemonId: "adjudicate-instance",
      endpoint: path.join(userRoot, "adjudicate-instance.sock"),
    },
    runtimeInstances: () => instances,
    prepareRuntimeLaunch: async (instanceId, request) => ({
      definition: {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId,
        installationId: installation.installationId,
        kindId: "codex",
        providerId: "openai",
        model: request.model ?? `${instanceId}-model`,
        reasoningEffort: null,
        fast: false,
        baseUrl: null,
        authMode: "subscription",
      },
      installation,
      executablePath: installation.executablePath,
      args: ["exec", "--json", "-"],
      env: {},
      cwd: request.cwd,
      prompt: request.prompt,
    }),
    runtimeLaunch: (prepared) => {
      launched.push({ instanceId: prepared.definition.instanceId, model: prepared.definition.model });
      prompts.push(prepared.prompt);
      return fakeProcess(++pid);
    },
  });
  try {
    const taskId = "task_adjudicate_instance",
      executionId = "execution-adjudicate-instance",
      created = await cell.run(
        { kind: "task-create", taskId, title: "Adjudicate instance pin", riskTier: "low" },
        binding,
      );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(root, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
    writeFileSync(
      path.join(root, "harness", packagePath, "closeout.md"),
      `# Closeout\n\n## Summary\n\nAdjudicate instance fixture ${git(root, "rev-parse", "fixture-delivery")} is ready.\n\n## Verification\n\nIntegration assertions pin the reviewer dispatch resources.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nThe dispatch-review pin flags share this path.\n`,
    );
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
    const unavailableResume = await cell.run(
      {
        kind: "task-adjudicate",
        taskId,
        return: true,
        workerMode: "resume",
        followUp: "Revise the fixture.",
        reason: "No worker dispatched yet.",
      },
      binding,
    );
    assert.equal(unavailableResume.code, "runtime_dispatch_not_resumable", JSON.stringify(unavailableResume));
    const adjudicated = await cell.run(
      {
        kind: "task-adjudicate",
        taskId,
        executionId,
        forward: true,
        reason: ownerNote,
        reviewer: "closeout-reviewer",
        runtimeInstanceId: "review-instance-b",
        model: "review-pinned-model",
      },
      binding,
    );
    assert.equal(adjudicated.outcome, "applied", JSON.stringify(adjudicated));
    assert.deepEqual(launched, [{ instanceId: "review-instance-b", model: "review-pinned-model" }]);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes(ownerNote), "the launched reviewer must receive the complete owner note");
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function runtimeInstance(instanceId: string): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId,
    name: instanceId,
    kindId: "codex",
    installationId: installation.installationId,
    providerId: instanceId,
    models: [`${instanceId}-model`, "review-pinned-model"],
    defaultModel: `${instanceId}-model`,
    enabled: true,
    permissionMode: "read-only",
    codex: {
      reasoningEffort: null,
      fast: false,
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
  };
}

for (const mode of ["resume", "fresh"] as const)
  test(`adjudicate --return ${mode} continues the implementation worker after review`, async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "ha-return-worker-")),
      root = path.join(parent, "repo"),
      userRoot = path.join(parent, "user"),
      prompts: string[] = [],
      efforts: (string | undefined)[] = [],
      sessions: (string | undefined)[] = [],
      launchedInstances: string[] = [];
    let pid = 9200;
    mkdirSync(root);
    initRepo(root);
    grantTestPolicyGroups([binding.actor.principal.personId], "admin");
    const cell = await openRepoCell({
      repoId: workspaceId(`return-worker-${mode}`),
      rootDir: canonicalRoot(root),
      ownerId: `return-worker-${mode}`,
      runtimeDaemonRoute: { userRoot, daemonId: "return-worker", endpoint: path.join(userRoot, "return.sock") },
      runtimeInstances: () => [
        runtimeInstance("worker-instance"),
        {
          ...runtimeInstance("reviewer-only-instance"),
          kindId: "claude",
          providerId: "reviewer-only-instance",
          models: ["reviewer-model"],
          defaultModel: "reviewer-model",
        },
      ],
      prepareRuntimeLaunch: async (instanceId, request) => {
        prompts.push(request.prompt);
        efforts.push(request.effort);
        sessions.push(request.providerSessionId);
        const kindId = instanceId === "reviewer-only-instance" ? "claude" : "codex";
        return {
          definition: {
            schema: "agent-definition-snapshot/v1",
            configVersion: 1,
            instanceId,
            installationId: installation.installationId,
            kindId,
            providerId: "openai",
            model: request.model ?? "worker-instance-model",
            reasoningEffort: request.effort ?? null,
            fast: false,
            baseUrl: null,
            authMode: "subscription",
          },
          installation: { ...installation, kindId },
          executablePath: installation.executablePath,
          args: ["exec", "--json", "-"],
          env: {},
          cwd: request.cwd,
          prompt: request.prompt,
        };
      },
      runtimeLaunch: (prepared) => {
        launchedInstances.push(prepared.definition.instanceId);
        return fakeProcess(++pid, sessions.at(-1));
      },
    });
    try {
      assert.equal(
        (
          await cell.run(
            {
              kind: "agent-install",
              declaration: {
                schema: "agent-declaration/v1",
                id: "return-worker",
                name: "Return worker",
                instructions: "Continue the assigned task.",
                runtimes: [{ type: "codex", effort: "high" }],
                role: "worker",
              },
            },
            binding,
          )
        ).outcome,
        "applied",
      );
      const taskId = "task_return_worker",
        executionId = "execution-original",
        created = await cell.run({ kind: "task-create", taskId, title: "Return worker", riskTier: "low" }, binding);
      assert.equal(created.outcome, "applied", JSON.stringify(created));
      await waitForFixturePublication(cell, created.opId, binding);
      const packagePath = String((created as Record<string, unknown>).packagePath);
      await realizeTaskPlanFixture(root, packagePath, (planPath) =>
        cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
      );
      assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
      const source = await cell.spawnRuntime(
        {
          taskId,
          agentId: "return-worker",
          cwd: { scope: "repo-root" },
          runtimeInstanceId: "worker-instance",
          prompt: "Implement the delivery.",
          dispatchKey: "original-worker",
        },
        binding,
      );
      assert.equal(efforts[0], "high", "the original Agent dispatch uses its declared effort");
      await cell.awaitRuntimeOutcome(String(source.runtimeSessionId));
      assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
      writeFileSync(
        path.join(root, "harness", packagePath, "closeout.md"),
        "# Closeout\n\n## Summary\n\nPrevious worker conclusion: change the parser.\n\n## Verification\n\nParser fixture passes.\n\n## Residual Risk\n\nRemote provider remains unverified.\n\n## Same Mechanism Elsewhere\n\nThe CLI shares the contract.\n",
      );
      assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
      const missing = await cell.run({ kind: "task-adjudicate", taskId, return: true, reason: "Revise." }, binding);
      assert.equal(missing.code, "invalid_command", JSON.stringify(missing));
      assert.match(JSON.stringify(missing), /worker-mode/u);
      const emptyMessage = await cell.run(
        { kind: "task-adjudicate", taskId, return: true, workerMode: mode, followUp: " ", reason: "Revise." },
        binding,
      );
      assert.equal(emptyMessage.outcome, "op_rejected", JSON.stringify(emptyMessage));
      const forwarded = await cell.run(
        {
          kind: "task-adjudicate",
          taskId,
          forward: true,
          reason: "Review.",
          reviewer: "closeout-reviewer",
          runtimeInstanceId: "reviewer-only-instance",
        },
        binding,
      );
      assert.equal(forwarded.outcome, "applied", JSON.stringify(forwarded));
      const reviewer = (forwarded as unknown as { steps: { runtimeSessionId: string }[] }).steps.at(-1)!;
      await cell.awaitRuntimeOutcome(reviewer.runtimeSessionId);
      assert.equal(launchedInstances[1], "reviewer-only-instance");
      assert.equal(
        (
          await cell.run(
            {
              kind: "agent-install",
              declaration: {
                schema: "agent-declaration/v1",
                id: "return-observer",
                name: "Return observer",
                instructions: "Observe the frozen cut.",
                runtimes: [],
                permissionMode: "read-only",
              },
            },
            binding,
          )
        ).outcome,
        "applied",
      );
      const observer = await cell.spawnRuntime(
        {
          taskId,
          agentId: "return-observer",
          prompt: "Observe the frozen cut without changing it.",
          dispatchKey: "read-only-observer",
          runtimeInstanceId: "worker-instance",
        },
        binding,
      );
      await cell.awaitRuntimeOutcome(String(observer.runtimeSessionId));
      const returned = await cell.run(
        {
          kind: "task-adjudicate",
          taskId,
          return: true,
          workerMode: mode,
          followUp: "Correct the parser edge case.",
          reason: "Small revision.",
          runtimeInstanceId: "reviewer-only-instance",
        },
        binding,
      );
      assert.equal(returned.outcome, "applied", JSON.stringify(returned));
      const continuation = (returned as unknown as { continuation: { runtimeSessionId: string; dispatchId: string } })
        .continuation;
      assert.ok(continuation, JSON.stringify(returned));
      await cell.awaitRuntimeOutcome(continuation.runtimeSessionId);
      assert.equal(sessions.length, 4);
      assert.equal(efforts[3], "high", "task return resolves the original Agent's declared effort again");
      assert.equal(
        sessions[3],
        mode === "resume" ? "reviewer-9201" : undefined,
        "resume selects the lease-holding worker, never a newer reviewer or read-only observer",
      );
      assert.equal(
        launchedInstances[3],
        "worker-instance",
        "the returned worker runs on its own declared runtime, never the reviewer's foreign instance",
      );
      assert.match(prompts[3], /Correct the parser edge case/u);
      // The re-dispatched worker answers the latest owner return: its mission carries the managed
      // returns/iteration-0.md verbatim, while the first dispatch and the reviewer carry none.
      assert.match(prompts[3], /# Owner rework instruction/u);
      assert.match(prompts[3], /# Owner return for iteration 0/u);
      assert.match(prompts[3], /## Rework instruction/u);
      assert.match(prompts[3], /Small revision\./u);
      assert.doesNotMatch(prompts[0], /# Owner rework instruction/u);
      assert.doesNotMatch(prompts[1], /# Owner rework instruction/u);
      if (mode === "fresh") {
        assert.match(prompts[3], /Previous worker conclusion: change the parser/u);
        assert.match(prompts[3], /Parser fixture passes/u);
        assert.match(prompts[3], /Remote provider remains unverified/u);
      }
      const dispatches = await cell.read("repo.task.dispatches", { taskId }, binding);
      assert.notEqual(
        dispatches.dispatches.find((row) => row.dispatchId === continuation.dispatchId)?.executionId,
        executionId,
      );
    } finally {
      await cell.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

test("adjudicate --return --worker-mode none returns the cut without dispatching a worker", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-return-none-")),
    root = path.join(parent, "repo");
  mkdirSync(root);
  initRepo(root);
  grantTestPolicyGroups([binding.actor.principal.personId], "admin");
  const cell = await openRepoCell({
    repoId: workspaceId("return-none"),
    rootDir: canonicalRoot(root),
    ownerId: "return-none",
  });
  try {
    const taskId = "task_return_none",
      executionId = "execution-original",
      created = await cell.run(
        { kind: "task-create", taskId, title: "Return without worker", riskTier: "low" },
        binding,
      );
    assert.equal(created.outcome, "applied", JSON.stringify(created));
    await waitForFixturePublication(cell, created.opId, binding);
    const packagePath = String((created as Record<string, unknown>).packagePath);
    await realizeTaskPlanFixture(root, packagePath, (planPath) =>
      cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
    writeFileSync(
      path.join(root, "harness", packagePath, "closeout.md"),
      "# Closeout\n\n## Summary\n\nThe owner already fixed this cut.\n\n## Verification\n\nIntegration assertions pin the none return.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nThe CLI shares the contract.\n",
    );
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId }, binding)).outcome, "applied");
    // A none return that still carries a worker message is rejected before the durable return.
    const withMessage = await cell.run(
      {
        kind: "task-adjudicate",
        taskId,
        return: true,
        workerMode: "none",
        followUp: "Revise.",
        reason: "Owner fixed it.",
      },
      binding,
    );
    assert.equal(withMessage.code, "invalid_command", JSON.stringify(withMessage));
    assert.match(JSON.stringify(withMessage), /--note/u);
    assert.equal(
      (await cell.read("repo.tasks.list", { status: "submitted" })).rows.some((row) => row.taskId === taskId),
      true,
      "the rejected none return must not move the task",
    );
    const returned = await cell.run(
      { kind: "task-adjudicate", taskId, return: true, workerMode: "none", reason: "Owner fixed it; re-submit." },
      binding,
    );
    assert.equal(returned.outcome, "applied", JSON.stringify(returned));
    const receipt = returned as unknown as {
      continuation: { mode: string };
      next: { command: string }[];
    };
    assert.deepEqual(receipt.continuation, { mode: "none" });
    assert.deepEqual(
      receipt.next.map(({ command }) => command),
      [`ha task start ${taskId}`, `ha task submit ${taskId}`],
    );
    assert.equal(
      (await cell.read("repo.task.dispatches", { taskId }, binding)).dispatches.length,
      0,
      "a none return must not dispatch a worker",
    );
    // The receipt's manual lanes are real: start the next execution and re-submit the cut.
    const rework = "execution-rework";
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId: rework }, binding)).outcome, "applied");
    writeFileSync(
      path.join(root, "harness", packagePath, "closeout.md"),
      "# Closeout\n\n## Summary\n\nRe-submitted after the owner-side fix.\n\n## Verification\n\nIntegration assertions pin the none return.\n\n## Residual Risk\n\nNone.\n\n## Same Mechanism Elsewhere\n\nThe CLI shares the contract.\n",
    );
    assert.equal((await cell.run({ kind: "task-submit", taskId, executionId: rework }, binding)).outcome, "applied");
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function fakeProcess(pid: number, sessionId = `reviewer-${pid}`): RuntimeProcess {
  let output: ((chunk: string) => void) | null = null,
    exit: ((code: number | null) => void) | null = null;
  return {
    pid,
    onOutput: (listener) => {
      output = listener;
    },
    onErrorOutput: () => undefined,
    onExit: (listener) => {
      exit = listener;
      setImmediate(() => {
        output?.(
          `${[
            { type: "thread.started", thread_id: sessionId },
            { type: "item.completed", item: { id: "message", type: "agent_message", text: "reviewed" } },
            { type: "turn.completed" },
          ]
            .map((frame) => JSON.stringify(frame))
            .join("\n")}\n`,
        );
        exit?.(0);
      });
    },
    terminate: () => undefined,
  };
}

function initRepo(rootDir: string): void {
  git(rootDir, "init", "-q");
  git(rootDir, "config", "user.name", "Adjudicate Instance Test");
  git(rootDir, "config", "user.email", "adjudicate-instance@example.invalid");
  git(rootDir, "commit", "--allow-empty", "-qm", "base");
  writeFileSync(path.join(rootDir, "README.md"), "# Adjudicate instance fixture delivery\n");
  git(rootDir, "add", "README.md");
  git(rootDir, "commit", "-qm", "fixture delivery");
  git(rootDir, "tag", "fixture-delivery");
}
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
