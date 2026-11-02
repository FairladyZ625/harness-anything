// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import type { RuntimeSpawnerContext } from "../src/runtime-spawn-context.ts";
import type { ActiveRuntime, RuntimeAttemptTerminal } from "../src/runtime-spawn-types.ts";
import { active } from "./runtime-spawn-settlement.fixtures.ts";

test("escalation settlement waits for full tree cleanup before releasing the task", async (context) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-escalation-tree-stop-")),
    packageRoot = path.join(rootDir, "harness", "tasks", "task-owner");
  context.after(() => rmSync(rootDir, { recursive: true, force: true }));
  mkdirSync(path.join(packageRoot, "artifacts", "rulings"), { recursive: true });
  writeFileSync(
    path.join(packageRoot, "artifacts", "rulings", "dispatch_0123456789abcdef01234567.md"),
    "---\nruling: awaiting\nquestion: May this worker change the shared transport?\noptions:\n  - Keep the boundary\n---\n",
  );

  let finishTreeCleanup!: () => void,
    treeCleanupStarted = false,
    treeCleaned = false,
    released = false,
    stopProofAvailable = false,
    settlementAttempts = 0;
  const treeCleanup = new Promise<void>((resolve) => {
      finishTreeCleanup = () => {
        treeCleaned = true;
        resolve();
      };
    }),
    runtime = active({
      process: {
        pid: process.pid,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
        terminateTree: () => {
          treeCleanupStarted = true;
          return treeCleanup;
        },
        release: () => {
          released = true;
        },
      },
      dispatchId: "dispatch_0123456789abcdef01234567",
      runtimeSessionId: "runtime-escalation-tree-stop",
      cancelRequested: true,
      cancelOpId: "runtime-cancel:escalation",
      binding: {
        actor: {
          principal: { kind: "human", id: "operator" },
          executor: { kind: "agent", id: "runtime-session:runtime-escalation-tree-stop" },
        },
        source: "local",
      },
      task: { taskId: "task-owner", executionId: "execution-owner", leaseVersion: 1 },
      cwd: rootDir,
      stream: {
        ref: "runtime-stream:dispatch_0123456789abcdef01234567",
        appendAttemptOutcome: () => undefined,
        appendTerminalOutcome: () => undefined,
      } as never,
    }) as ActiveRuntime,
    published: string[] = [],
    terminals: RuntimeAttemptTerminal[] = [],
    contextValue = {
      exiting: new Set<string>(),
      processes: new Map([[runtime.runtimeSessionId, runtime]]),
      input: {
        repoId: "canonical",
        rootDir,
        now: () => "2026-11-02T00:00:00.000Z",
        stream: { publish: () => ({}) },
        remote: {
          archive: async () => ({ outcome: "applied" }),
          taskContext: async () => ({ packageRoot }),
        },
      },
      resultMediaType: "text/markdown",
      runtimeResultText: () => "worker requested an owner ruling",
      markProtocolError: () => undefined,
      publishRuntimeEvent: async (type: string) => {
        published.push(type);
        return {};
      },
      settleFallback: async (_runtime: ActiveRuntime, _attempt: unknown, terminal: RuntimeAttemptTerminal) => {
        assert.equal(treeCleaned, true, "the lease must not be released before descendants stop");
        settlementAttempts += 1;
        if (!stopProofAvailable)
          throw Object.assign(new Error("process group stop proof is not available yet"), {
            code: "runtime_process_group_unproven",
          });
        terminals.push(terminal);
      },
    } as unknown as RuntimeSpawnerContext,
    settlement = publishExit(contextValue, runtime, null);

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(treeCleanupStarted, true, "settlement must join complete process-tree cleanup");
    assert.equal(terminals.length, 0, "task lease release must wait for process-tree cleanup");
    assert.deepEqual(published, [], "a terminal dispatch outcome must not be published early");
    assert.equal(contextValue.processes.has(runtime.runtimeSessionId), true, "the runtime stays retryable");
    assert.equal(released, false, "the process owner stays available until release is safe");

    finishTreeCleanup();
    await assert.rejects(
      settlement,
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_process_group_unproven",
    );
    assert.equal(settlementAttempts, 1);
    assert.equal(terminals.length, 0, "an unavailable stop proof must not publish unknown or retire the runtime");
    assert.deepEqual(published, []);
    assert.equal(contextValue.processes.has(runtime.runtimeSessionId), true);
    assert.equal(released, false);

    stopProofAvailable = true;
    await publishExit(contextValue, runtime, null);

    assert.equal(settlementAttempts, 2);
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0]?.waitingOnOwner, true);
    assert.equal(contextValue.processes.has(runtime.runtimeSessionId), false);
    assert.equal(released, true);
    assert.deepEqual(published, ["runtime_session_exited", "runtime_session_outcome_observed"]);
  } finally {
    finishTreeCleanup();
    await settlement.catch(() => undefined);
  }
});
