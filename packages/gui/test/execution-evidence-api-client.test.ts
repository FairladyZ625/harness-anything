// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { harnessClient } from "../src/renderer/api-client.ts";

test("execution evidence client rejects incomplete nested page DTOs", async () => {
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      harness: {
        getExecutionEvidencePage: async () => ({
          ok: true,
          groups: [{
            taskId: "task_00000000000000000000000001",
            title: "Task",
            latestAt: "2026-07-13T00:00:00.000Z",
            executions: [{
              executionId: "exe_00000000000000000000000001",
              taskRef: "task/task_00000000000000000000000001",
              taskId: "task_00000000000000000000000001",
              state: "submitted",
              executorId: "codex",
              executorKind: "agent",
              responsibleHuman: "person_zeyu",
              claimedAt: "2026-07-13T00:00:00.000Z",
              submittedAt: "2026-07-13T00:01:00.000Z",
              closedAt: null,
              outputs: [],
              outputCount: 0,
              hasMoreOutputs: false,
              archival: false
            }]
          }],
          stats: {
            totalExecutions: 1,
            archivalExecutions: 0,
            realExecutions: 1,
            totalOutputs: 0,
            passingReceiptOutputs: 0,
            tasksWithExecutions: 1
          },
          nextCursor: null
        })
      }
    }
  });
  try {
    await assert.rejects(
      harnessClient.getExecutionEvidencePage({ limit: 25 }),
      /rows outside the page DTO/
    );
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow
    });
  }
});
