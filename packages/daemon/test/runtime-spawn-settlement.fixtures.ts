import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime } from "../src/runtime-spawn-types.ts";

export const fixtureTaskId = "task_0123456789abcdef01234567";

export function fixtureArtifacts(fixture: WorkerGitFixture) {
  void fixture;
  const question = "low 档含 GUI 改动时，是否仍必须通过 GUI 行为验收？";
  return {
    question,
    options: ["保留 GUI 验收（推荐）", "low 档不要求 GUI 验收"],
    body: `---\nruling: awaiting\nquestion: ${question}\noptions:\n  - 保留 GUI 验收（推荐）\n  - low 档不要求 GUI 验收\n---\n`,
  };
}

export function active(overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return {
    rawUsage: {},
    cacheWriteTokens: 0,
    dispatchId: "dispatch_0123456789abcdef01234567",
    instanceId: "provider-a",
    model: "model-a",
    cancelRequested: false,
    kindId: "codex",
    publicationOwner: "runtime",
    fallbackAttempt: null,
    permissionMode: "bypass",
    providerFault: null,
    errorOverflowed: false,
    errorBuffer: "",
    toolCallObserved: false,
    failureText: null,
    lossReason: null,
    planIncomplete: false,
    planObserved: true,
    protocolError: false,
    providerOutcome: "succeeded",
    writeItemObserved: true,
    ...overrides,
  } as ActiveRuntime;
}

export function tasklessSettlementRuntime(rootDir: string, finalText: string | null): ActiveRuntime {
  return active({
    process: {
      pid: process.pid,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    runtimeSessionId: `runtime-taskless-${finalText === null ? "missing" : "complete"}`,
    dispatchOpId: `dispatch-taskless-${finalText === null ? "missing" : "complete"}`,
    binding: {
      actor: {
        principal: { kind: "human", id: "operator" },
        executor: { kind: "agent", id: "runtime-session:runtime-taskless" },
      },
      source: "local",
    },
    task: null,
    schedule: null,
    squadId: null,
    delegatedBy: null,
    cwd: rootDir,
    prompt: "settle taskless result",
    onExitCommand: null,
    reasoningEffort: null,
    fast: false,
    startedAt: "2026-09-29T00:00:00.000Z",
    stream: {
      ref: "runtime-stream:dispatch-taskless",
      appendAttemptOutcome: () => undefined,
      appendTerminalOutcome: () => undefined,
    } as never,
    buffer: "",
    durableOutputCount: 0,
    stdoutObserved: true,
    providerSessionId: "provider-session",
    resumeProviderSessionId: null,
    finalText,
    cancelBinding: null,
    cancelOpId: null,
  });
}

export type WorkerGitFixture = {
  readonly root: string;
  readonly bare: string;
  readonly canonical: string;
  readonly worker: string;
};

export function workerGitFixture(
  context: { after(handler: () => void): unknown },
  slug: string,
  options: { readonly reachableRemote: boolean; readonly delivery?: boolean },
): WorkerGitFixture {
  const root = mkdtempSync(path.join(tmpdir(), `ha-settle-${slug}-`)),
    bare = path.join(root, "remote.git"),
    canonical = path.join(root, "project"),
    worker = path.join(root, "worker");
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "--bare", bare);
  git(root, "init", "-q", "project");
  git(canonical, "config", "user.email", "settle-test@example.invalid");
  git(canonical, "config", "user.name", "Settle Test");
  writeFileSync(path.join(canonical, "README.md"), "fixture\n");
  git(canonical, "add", "README.md");
  git(canonical, "commit", "--quiet", "-m", "fixture");
  git(canonical, "remote", "add", "origin", bare);
  git(canonical, "push", "--quiet", "origin", "HEAD:main");
  if (!options.reachableRemote) git(canonical, "remote", "set-url", "origin", path.join(root, "missing.git"));
  // Settlement publishes the branch named after the dispatched task.
  git(canonical, "worktree", "add", "--quiet", worker, "-b", fixtureTaskId);
  git(worker, "config", "user.name", "operator");
  git(worker, "config", "user.email", "operator@users.noreply.github.com");
  if (options.delivery !== false) {
    writeFileSync(path.join(worker, "change.txt"), "worker\n");
    git(worker, "add", "change.txt");
    git(worker, "commit", "--quiet", "-m", "feat: worker change");
  }
  return { root, bare, canonical, worker };
}

export function workerSettlementRuntime(fixture: WorkerGitFixture, overrides: Partial<ActiveRuntime>): ActiveRuntime {
  return active({
    process: {
      pid: process.pid,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    },
    runtimeSessionId: "runtime-settle-push",
    dispatchOpId: "settle-dispatch-op",
    binding: {
      actor: {
        principal: { kind: "human", id: "operator", personId: "operator" },
        executor: { kind: "agent", id: "runtime-session:runtime-settle-push" },
      },
      source: "local",
    },
    task: { taskId: fixtureTaskId, executionId: "execution-owner", leaseVersion: 1 },
    schedule: null,
    squadId: null,
    delegatedBy: null,
    cwd: fixture.worker,
    prompt: "settle this result",
    onExitCommand: null,
    reasoningEffort: null,
    fast: false,
    startedAt: "2026-09-14T00:00:00.000Z",
    stream: {
      ref: "runtime-stream:dispatch_0123456789abcdef01234567",
      appendAttemptOutcome: () => undefined,
      appendTerminalOutcome: () => undefined,
    } as never,
    buffer: "",
    durableOutputCount: 0,
    stdoutObserved: true,
    providerSessionId: "provider-session",
    resumeProviderSessionId: null,
    finalText: null,
    cancelBinding: null,
    cancelOpId: null,
    toolCallObserved: true,
    ...overrides,
  });
}

export function workerSettlementContext(
  fixture: WorkerGitFixture,
  publishRuntimeEvent: (
    type: string,
    payload?: Record<string, unknown>,
    opId?: string,
    binding?: unknown,
    resultBody?: string,
  ) => Promise<unknown>,
  resultText = "worker delivery",
  submittedCommitSha?: string,
): RuntimeSpawnerContext {
  return {
    exiting: new Set<string>(),
    processes: new Map(),
    input: {
      repoId: "canonical",
      rootDir: fixture.canonical,
      now: () => "2026-09-14T00:01:00.000Z",
      stream: { publish: () => ({}) },
      // This node holds a projection; `requiredRuntimeProjection` below is the read every test steers.
      projection: () => deliveryProjection(null),
      remote: { archive: async () => ({ outcome: "applied" }) },
    },
    resultMediaType: "text/markdown",
    runtimeResultText: () => resultText,
    markProtocolError: () => undefined,
    settleFallback: async () => undefined,
    prepareDaemonGitEnvironment: async () => ({}),
    requiredRuntimeProjection: () =>
      deliveryProjection(submittedCommitSha ?? git(fixture.worker, "rev-parse", "HEAD").trim()),
    requiredRuntimeStore: () => ({}) as never,
    publishRuntimeEvent,
  } as unknown as RuntimeSpawnerContext;
}

export function deliveryProjection(
  commitSha: string | null,
  outputShape = "repository-diff",
  artifacts: readonly Record<string, unknown>[] = [],
  reviews: readonly Record<string, unknown>[] = [],
  closeoutRecorded = false,
  submissionPresent = false,
) {
  return {
    read: () => ({
      packagePath: "tasks/task_0123456789abcdef01234567-fixture",
      snapshot: {
        task: { presetSnapshotDigest: "sha256:preset" },
        reviews,
        executions: [
          {
            executionId: "execution-owner",
            submission:
              commitSha === null && artifacts.length === 0 && !submissionPresent ? null : { commitSha, artifacts },
          },
        ],
      },
    }),
    readDocument: (documentPath: string) => ({
      document:
        closeoutRecorded && documentPath.endsWith("/closeout.md")
          ? { path: documentPath, body: "## Summary\nDelivered.\n" }
          : null,
    }),
    readPresetSnapshot: () => ({ snapshot: { profile: { outputShape } } }),
  } as never;
}

export function git(root: string, ...args: string[]): string {
  // Fixture pushes to main are harness-side git, not a task-bound worker push the wrapper
  // refuses. A task-bound host injects GIT_AUTHOR_*/GIT_COMMITTER_* and its own git config;
  // env beats both repo config and -c flags, so the fixture must not inherit either.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
  for (const name of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"])
    delete env[name];
  delete env.HARNESS_TASK_BOUND;
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env });
}
