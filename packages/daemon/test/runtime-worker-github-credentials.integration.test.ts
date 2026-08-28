// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore } from "../../kernel/src/index.ts";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("task-bound runtime settlement pushes only its own codex branch with the bound GitHub credential", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-worker-github-")),
    root = path.join(parent, "repo"),
    workerRoot = path.join(root, ".worktrees", "worker"),
    remote = path.join(parent, "origin.git"),
    userRoot = path.join(parent, "user"),
    secret = randomUUID(),
    credentialRef = "credential:v1:github-worker",
    repoId = "runtime-worker-github",
    instanceId = "codex-github-worker",
    taskId = "task-github-worker",
    executionId = "execution-github-worker";
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    initRepo(root, repoId);
    installGitHelpers(root);
    execFileSync("git", ["init", "--bare", remote]);
    git(root, "remote", "add", "origin", remote);
    git(root, "worktree", "add", "--quiet", workerRoot, "-b", "codex/github-worker");
    writeFileSync(path.join(workerRoot, "worker-change.txt"), "task-bound worker change\n");
    git(workerRoot, "add", "worker-change.txt");
    git(workerRoot, "commit", "--quiet", "-m", "feat: add worker change");

    const installation: RuntimeInstallationWitness = {
        installationId: "codex-github-worker-installation",
        kindId: "codex",
        executablePath: "/opt/witnessed/codex-github-worker",
        version: "1.0.0",
        observedAt: "2026-08-25T00:00:00.000Z",
      },
      instances = openRuntimeInstanceStore({
        userRoot,
        discover: () => [installation],
        resolveCredential: async (reference) => {
          assert.equal(reference, credentialRef);
          return secret;
        },
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      });
    instances.create({
      schemaVersion: 2,
      instanceId,
      name: "Codex GitHub Worker",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      permissionMode: "read-only",
      codex: {},
      auth: { mode: "subscription" },
    });
    const bound = instances.command({
      kind: "runtime-instance-github-credential-set",
      instanceId,
      githubCredentialRef: credentialRef,
    });

    let taskBoundLaunches = 0;
    let mainPush: ReturnType<typeof spawnSync> | null = null;
    cell = await openRepoCell({
      repoId: workspaceId(repoId),
      rootDir: canonicalRoot(root),
      ownerId: "runtime-worker-github-test",
      runtimeDaemonRoute: {
        userRoot: path.join(parent, "daemon-user"),
        daemonId: "runtime-worker-github-test",
        endpoint: path.join(parent, "daemon.sock"),
      },
      runtimeInstances: instances.listPublic,
      prepareRuntimeLaunch: instances.prepareLaunch,
      prepareWorkerGitEnvironment: instances.prepareWorkerGitEnvironment,
      runtimeLaunch: (prepared) => {
        const taskBound = prepared.env.HARNESS_TASK_BOUND === "1";
        if (taskBound) {
          taskBoundLaunches += 1;
          assert.equal(prepared.env.GH_TOKEN, secret);
          assert.equal(prepared.env.HARNESS_GITHUB_TOKEN, secret);
          assert.equal(prepared.env.GIT_ASKPASS, path.join(root, "tools", "git-hooks", "git-askpass"));
          mainPush = spawnSync("git", ["-C", workerRoot, "push", "origin", "HEAD:main"], {
            cwd: workerRoot,
            encoding: "utf8",
            env: prepared.env,
          });
        } else {
          assert.equal(prepared.env.GH_TOKEN, undefined);
          assert.equal(prepared.env.HARNESS_GITHUB_TOKEN, undefined);
          assert.equal(prepared.env.GIT_ASKPASS, undefined);
        }
        return successfulRuntimeProcess();
      },
    });

    const actor = { principal: { personId: "person-github-worker" }, executor: null },
      binding = { actor, source: "local" as const },
      unbound = await cell.spawnRuntime(
        {
          runtimeInstanceId: instanceId,
          cwd: { scope: "repo-root" },
          prompt: "Inspect without a task binding",
          taskId: null,
          idempotencyKey: "github-worker-unbound",
        },
        binding,
      );
    await runtimeOutcome(root, repoId, String(unbound.runtimeSessionId));

    assert.equal(
      (await cell.run({ kind: "task-create", taskId, title: "GitHub worker push" }, binding)).outcome,
      "applied",
    );
    assert.equal((await cell.run({ kind: "task-start", taskId, executionId }, binding)).outcome, "applied");
    const spawned = await cell.spawnRuntime(
      {
        runtimeInstanceId: instanceId,
        cwd: { scope: "repo-relative", path: ".worktrees/worker" },
        prompt: "Publish the completed worker branch",
        taskId,
        idempotencyKey: "github-worker-task-bound",
      },
      binding,
    );
    await runtimeOutcome(root, repoId, String(spawned.runtimeSessionId));

    assert.equal(taskBoundLaunches, 1);
    assert.match(String(mainPush?.stderr), /outside refs\/heads\/codex/u);
    assert.notEqual(mainPush?.status, 0, mainPush?.stderr);
    assert.match(gitText(remote, "show-ref", "--verify", "refs/heads/codex/github-worker"), /codex\/github-worker/u);
    assert.notEqual(spawnSync("git", ["-C", remote, "show-ref", "--verify", "refs/heads/main"]).status, 0);

    const shown = instances.command({ kind: "runtime-instance-show", instanceId }),
      events = makeTaskEventStore({ repoId, rootDir: root }).read().events,
      stream = readFileSync(
        path.join(root, ".harness", "runtime", "dispatches", `${String(spawned.dispatchId)}.jsonl`),
        "utf8",
      );
    assert.equal((shown.instance as Record<string, unknown>).githubCredentialState, "configured");
    const unsetReceipt = instances.command({ kind: "runtime-instance-github-credential-unset", instanceId });
    assert.equal("githubCredentialState" in (unsetReceipt.instance as Record<string, unknown>), false);
    assert.equal(await instances.prepareWorkerGitEnvironment(instanceId), null);
    for (const observed of [bound, shown, unsetReceipt, events, stream]) {
      assert.doesNotMatch(JSON.stringify(observed), new RegExp(secret, "u"));
      assert.doesNotMatch(JSON.stringify(observed), /githubCredentialRef|credential:v1:github-worker/u);
    }
  } finally {
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function successfulRuntimeProcess() {
  return {
    pid: process.pid,
    onOutput: (listener: (chunk: string) => void) => {
      queueMicrotask(() =>
        listener(
          [
            { type: "thread.started", thread_id: "github-worker-provider" },
            {
              type: "item.completed",
              item: { id: "message", type: "agent_message", text: "worker push ready" },
            },
            { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
          ]
            .map((frame) => JSON.stringify(frame))
            .join("\n") + "\n",
        ),
      );
    },
    onErrorOutput: () => undefined,
    onExit: (listener: (code: number | null) => void) => queueMicrotask(() => listener(0)),
    terminate: () => undefined,
  };
}

function initRepo(root: string, repoId: string): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "GitHub Worker Test");
  git(root, "config", "user.email", "github-worker@example.invalid");
  writeFileSync(
    path.join(root, "harness", "harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  writeFileSync(
    path.join(root, "harness", "people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(process.getuid?.() ?? 0) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write", "admin"] }] }, null, 2)}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "--quiet", "-m", "test: initialize fixture");
}

function installGitHelpers(root: string): void {
  const target = path.join(root, "tools", "git-hooks");
  mkdirSync(target, { recursive: true });
  for (const name of ["git", "git-askpass"]) {
    const destination = path.join(target, name);
    copyFileSync(path.join(repositoryRoot, "tools", "git-hooks", name), destination);
    chmodSync(destination, 0o755);
  }
}

async function runtimeOutcome(root: string, repoId: string, runtimeSessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (
      makeTaskEventStore({ repoId, rootDir: root })
        .read()
        .events.some(
          (event) =>
            event.type === "runtime_session_outcome_observed" && event.payload.runtimeSessionId === runtimeSessionId,
        )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`runtime ${runtimeSessionId} did not settle`);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}

function gitText(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}
