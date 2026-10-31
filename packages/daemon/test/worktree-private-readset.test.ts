// harness-test-tier: integration
/**
 * The deliverable's before/after: a dispatch whose agent declaration names private ledger files,
 * spawned while the worker cwd is a REAL task worktree of a real repository — the same prepare →
 * assemble → launch path production uses. It asserts the worker-received prompt sets every
 * `harness/…` reference next to an absolute path that exists at that moment.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentDefinitionSnapshot, RuntimeInstallationWitness } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { actor } from "./task-surface.fixtures.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { realizeTaskPlanFixture } from "../../../tools/fixtures/task-plan.mjs";
import { workerLedgerPath } from "../src/worktree-setup.ts";

const binding: RepoCellBinding = withPolicyGroup({ actor, source: "local" as const }, "contributor"),
  definition: AgentDefinitionSnapshot = {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: "codex-private",
    installationId: "installation-private",
    kindId: "codex",
    providerId: "openai",
    model: "private-model",
    reasoningEffort: "high",
    baseUrl: "https://api.example.test/",
    authMode: "api-key",
  },
  installation: RuntimeInstallationWitness = {
    installationId: definition.installationId,
    kindId: definition.kindId,
    version: "1.0.0",
    executablePath: "/usr/local/bin/codex",
    observedAt: "2026-10-22T00:00:00.000Z",
    digest: `sha256:${"a".repeat(64)}`,
  },
  standard = path.join("harness", "governance", "standards", "testing-standard.md"),
  skill = path.join("harness", "skills", "agent-dev-standards", "SKILL.md"),
  skillScript = path.join("harness", "skills", "agent-dev-standards", "scripts", "census.mjs"),
  // As written in a prompt: forward slashes, exactly what the reference extractor records.
  entry = "harness/skills/test-isolation/dispatch-isolated-test.mjs";

test("a real worktree dispatch hands the worker an openable path for every private file it names", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-worktree-private-")));
  let prepared: { readonly cwd: string; readonly prompt: string } | undefined;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  repositoryWithPrivateLedger(root);
  const cell = await openRepoCell({
    repoId: workspaceId("worktree-private"),
    rootDir: canonicalRoot(root),
    ownerId: "worktree-private-test",
    runtimeDaemonRoute: {
      userRoot: path.join(root, ".daemon-user"),
      daemonId: "worktree-private-test",
      endpoint: path.join(root, ".daemon-user", "daemon.sock"),
    },
    runtimeInstances: () => [instance()],
    prepareRuntimeLaunch: (_instanceId, request) => {
      prepared = request;
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
      pid: 5252,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    }),
  });
  const installed = await cell.run(
    {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "private-reader",
        name: "Private Reader",
        instructions: "Read the private standards before acting.",
        prompts: [`预置 Read Set：${skill}；${standard}；……`],
        // The same file is also a Required Skill, which is the case that used to get two paths.
        skills: [{ id: "agent-dev-standards", path: "skills/agent-dev-standards" }],
        runtimes: [{ type: "codex" }],
      },
    },
    binding,
  );
  assert.equal(installed.outcome, "applied", JSON.stringify(installed));
  const created = await cell.run(
    { kind: "task-create", taskId: "task_private_worker", title: "Read the private ledger" },
    binding,
  );
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  // The standard-task preset binds a repository-diff task to its own worktree, and the dispatch
  // prepares that checkout itself — the production shape, not a hand-made directory.
  await realizeTaskPlanFixture(
    root,
    String(created.packagePath),
    (planPath) => cell.run({ kind: "doc-submit", paths: [planPath] }, binding),
    "Read the private ledger",
  );
  const receipt = await cell.spawnRuntime(
    {
      runtimeInstanceId: definition.instanceId,
      agentId: "private-reader",
      taskId: "task_private_worker",
      dispatchKey: "private-dispatch",
    },
    binding,
  );
  await cell.close();
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.equal(prepared?.cwd, path.join(root, ".worktrees", "task_private_worker"));
  const prompt = prepared!.prompt;

  // The premise stands: the referenced files are absent under the worker root.
  assert.equal(existsSync(path.join(prepared!.cwd, standard)), false, "a worktree checks out no private ledger");
  // And the delivered prompt carries the path that opens each one — the same `workerLedgerPath`
  // port Required Skills uses, so one file never gets two different paths.
  assert.match(prompt, /# Private Ledger Paths \(read-only\)/u);
  for (const reference of [standard, skill]) {
    const readable = workerLedgerPath(root, prepared!.cwd, path.join(root, reference));
    assert.equal(existsSync(readable), true, `${reference} must be openable at ${readable}`);
    assert.match(
      prompt,
      new RegExp(`${reference.replaceAll("/", "\\/")} -> ${readable.replaceAll("/", "\\/")}`, "u"),
      `${reference} must be paired with its openable path`,
    );
    // Required Skills prints `- <id>: <path>` and the appendix prints `- <ref> -> <path>`. One port
    // means one path: the canonical file path must never appear beside the worker's copy.
    assert.equal(
      prompt.includes(path.join(root, reference)),
      false,
      `${reference} must not also be handed out under its canonical path`,
    );
    assert.equal(
      prompt.includes(`${reference} -> ${readable}`),
      true,
      `${reference} must be answered by the same path Required Skills uses`,
    );
  }
  // Required Skills names the skill's manifest, but a skill is consumed as its directory: the
  // scripts beside SKILL.md are part of it. A manifest-only copy made reviewers report the tools as
  // missing; the manifest must stay at the one path the read-set appendix also prints.
  const requiredSkill = /(?:^|\n)- agent-dev-standards: (.+)(?:\n|$)/u.exec(prompt)?.[1];
  assert.ok(requiredSkill, "Required Skills must name the selected skill");
  assert.equal(existsSync(requiredSkill), true, `the skill manifest must exist at ${requiredSkill}`);
  const copiedSkillScript = path.join(path.dirname(requiredSkill), "scripts", "census.mjs");
  assert.equal(
    existsSync(copiedSkillScript),
    true,
    `a script beside SKILL.md must be copied with the skill: ${copiedSkillScript}`,
  );
  const canonicalSkillScript = path.join(root, skillScript);
  assert.equal(readFileSync(copiedSkillScript, "utf8"), readFileSync(canonicalSkillScript, "utf8"));
  writeFileSync(copiedSkillScript, "worker mutation\n");
  assert.equal(readFileSync(canonicalSkillScript, "utf8"), "# census.mjs\n", "the canonical script is only read");
  assert.match(prompt, /Never copy one into this repository, never write through one/u);
  assert.match(prompt, /ha doc show --path <ledger path> --raw/u, "read-set locators name their opening command");
  // The isolated-test entry rides every coding dispatch whether or not anything names it —
  // task_936005e1 read the entry as absent and stopped without its targeted tests.
  const entryReadable = workerLedgerPath(root, prepared!.cwd, path.join(root, entry));
  assert.equal(existsSync(entryReadable), true, `the fixed entry must be openable at ${entryReadable}`);
  assert.match(
    prompt,
    new RegExp(`- ${entry.replaceAll("/", "\\/")} -> ${entryReadable.replaceAll("/", "\\/")}`, "u"),
    "the fixed entry must be paired with its openable path",
  );
  t.diagnostic(`worktree=${prepared!.cwd} prompt bytes=${String(prompt.length)}`);
});

function instance(): RuntimeInstanceSummary {
  return {
    schemaVersion: 2,
    instanceId: definition.instanceId,
    name: "Codex Private",
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

/** A repository whose private ledger holds one standard, one skill and the isolated-test entry, exactly as production does. */
function repositoryWithPrivateLedger(root: string): void {
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Worktree Private Test");
  git(root, "config", "user.email", "worktree-private@example.invalid");
  writeFileSync(path.join(root, "README.md"), "base\n");
  writeFileSync(path.join(root, ".gitignore"), "/harness/\n/.harness/\n/.worktrees/\n");
  git(root, "add", "README.md", ".gitignore");
  git(root, "commit", "-qm", "base");
  git(root, "branch", "origin/main");
  for (const relative of [standard, skill, skillScript, entry]) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), `# ${path.basename(relative)}\n`);
  }
  mkdirSync(path.join(root, "harness", "tasks", "task_private_worker-fixture"), { recursive: true });
  writeFileSync(path.join(root, "harness", "tasks", "task_private_worker-fixture", "task_plan.md"), "# Plan\n");
}

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
