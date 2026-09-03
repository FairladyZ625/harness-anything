// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { consumeKnownError, makeTaskEventReader, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-orphan",
  installationId: "installation-codex-orphan",
  kindId: "codex",
  providerId: "openai",
  model: "test-model",
  reasoningEffort: null,
  baseUrl: null,
  authMode: "subscription",
};

test("provider exit zero is incomplete while a runtime descendant remains alive", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-orphan-")),
    root = path.join(parent, "repo"),
    repoId = "runtime-orphan",
    executablePath = writeProviderExecutable(
      path.join(parent, "orphan-provider.mjs"),
      `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
child.unref();
console.log(JSON.stringify({ type: "thread.started", thread_id: "orphan-provider" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: String(child.pid) } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    ),
    cleanExecutablePath = writeProviderExecutable(
      path.join(parent, "clean-provider.mjs"),
      `console.log(JSON.stringify({ type: "thread.started", thread_id: "clean-provider" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "done" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
`,
    );
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Orphan Test");
  git(root, "config", "user.email", "orphan@example.invalid");
  git(root, "commit", "--allow-empty", "-qm", "base");
  const cell = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(root),
    ownerId: "orphan-test",
    runtimeInstances: () => [],
    prepareRuntimeLaunch: (_instanceId, request) => ({
      definition,
      installation: {
        installationId: definition.installationId,
        kindId: "codex",
        executablePath: request.prompt === "leave descendant" ? executablePath : cleanExecutablePath,
        version: "1.0.0",
        observedAt: "2026-09-04T00:00:00.000Z",
      },
      executablePath: request.prompt === "leave descendant" ? executablePath : cleanExecutablePath,
      args: [],
      env: process.env,
      cwd: request.cwd,
      prompt: request.prompt,
    }),
  });
  let descendantPid = 0;
  try {
    const orphan = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "leave descendant",
        taskId: null,
        idempotencyKey: "orphan",
      },
      { actor: { principal: { personId: "orphan-test" }, executor: null }, source: "local" },
    );
    const orphanOutcome = await eventuallyValue(
      () =>
        makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.find(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === orphan.runtimeSessionId,
          ) ?? null,
    );
    const orphanSession = await eventuallyValue(async () => {
      const value = await cell.read("repo.agentRuntime.sessions.read", {
        runtimeSessionId: orphan.runtimeSessionId,
      });
      return value.result ? value : null;
    });
    descendantPid = Number(orphanSession.result?.text);
    const orphanStream = readFileSync(
      path.join(root, ".harness/runtime/dispatches", `${String(orphan.dispatchId)}.jsonl`),
      "utf8",
    );
    assert.equal(orphanOutcome.payload.outcome, "unknown", orphanStream);
    assert.doesNotThrow(() => process.kill(descendantPid, 0));

    const clean = await cell.spawnRuntime(
      {
        runtimeInstanceId: definition.instanceId,
        cwd: { scope: "repo-root" },
        prompt: "finish cleanly",
        taskId: null,
        idempotencyKey: "clean",
      },
      { actor: { principal: { personId: "orphan-test" }, executor: null }, source: "local" },
    );
    const cleanOutcome = await eventuallyValue(
      () =>
        makeTaskEventReader({ repoId, rootDir: root })
          .read()
          .events.find(
            (event) =>
              event.type === "runtime_session_outcome_observed" &&
              event.payload.runtimeSessionId === clean.runtimeSessionId,
          ) ?? null,
    );
    assert.equal(cleanOutcome.payload.outcome, "succeeded", JSON.stringify(cleanOutcome));
  } finally {
    if (descendantPid > 0) {
      try {
        process.kill(descendantPid, "SIGTERM");
      } catch (error) {
        consumeKnownError(error);
      }
    }
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

async function eventuallyValue<T>(read: () => T | null | Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for runtime settlement");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}
