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
      created = await cell.run({ kind: "task-create", taskId, title: "Adjudicate instance pin" }, binding);
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

function fakeProcess(pid: number): RuntimeProcess {
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
            { type: "thread.started", thread_id: `reviewer-${pid}` },
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
