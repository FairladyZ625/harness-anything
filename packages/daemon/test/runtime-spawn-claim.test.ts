// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeRuntimeSpawner } from "../src/runtime-spawner.ts";
import type { RemoteRuntimePersistence } from "../src/runtime-spawn-types.ts";
import { definition, scheduleRuntimePorts } from "./schedule-actions.fixtures.ts";
import { emptyDispatchLifecycleRead } from "./dispatch-lifecycle-read.fixtures.ts";

for (const boundary of ["context", "census", "preparation"] as const)
  for (const acquired of [true, false])
    test(`failed remote ${boundary} releases only its own newly acquired claim (acquired=${acquired})`, async (t) => {
      const rootDir = mkdtempSync(path.join(tmpdir(), "runtime-spawn-claim-"));
      t.after(() => rmSync(rootDir, { recursive: true, force: true }));
      const packageRoot = path.join(rootDir, "task-claim");
      mkdirSync(packageRoot);
      const failure = new Error(`refused at ${boundary}`);
      let released = 0;
      const spawner = makeRuntimeSpawner({
        repoId: "claim-repo",
        rootDir,
        daemonGeneration: 1,
        now: () => new Date().toISOString(),
        stream: { publish: () => ({}) as never },
        runtimeDaemonRoute: { userRoot: rootDir, daemonId: "claim-test", endpoint: path.join(rootDir, "daemon.sock") },
        readSettings: () => ({ runtime: { allowedInstances: [definition.instanceId] } }) as never,
        runtimeInstances: scheduleRuntimePorts().runtimeInstances,
        prepareLaunch: async () => {
          throw failure;
        },
        schedule: () => undefined,
        remote: {
          existing: async () => null,
          taskContext: async (_taskId, _mission, _review, onClaimed) => {
            if (acquired)
              onClaimed?.(async () => {
                released += 1;
              });
            if (boundary === "context") throw failure;
            return {
              executionId: "execution-claim",
              packageRoot,
              worktree: null,
              mission: () => "Run the assigned task.",
              planBody: null,
              riskTier: "low",
              riskTierFlowVersion: null,
              profileId: null,
              taskClass: "standard",
              causalContext: null,
              continuationContext: null,
              ownerReturnBody: null,
              reviewerNote: null,
            };
          },
          readDispatchLifecycle: emptyDispatchLifecycleRead,
          readRuntimeSessions: async () => {
            if (boundary === "census") throw failure;
            return [];
          },
          publish: async () => assert.fail("a refused spawn must not publish a runtime"),
        } as RemoteRuntimePersistence,
      });
      t.after(() => spawner.close());
      await assert.rejects(
        spawner.spawn(
          { runtimeInstanceId: definition.instanceId, taskId: "task-claim", dispatchKey: boundary },
          {
            actor: { principal: { personId: "owner" }, executor: null },
            source: { kind: "node", nodeId: "node-one" },
          },
        ),
        (error) => error === failure,
      );
      assert.equal(released, acquired ? 1 : 0);
    });
