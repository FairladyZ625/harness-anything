// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchActivityStatus,
  DISPATCH_SILENT_AFTER_MS,
  dispatchProviderActivity,
} from "../src/dispatch-activity.ts";

const now = Date.parse("2026-10-21T08:00:00.000Z");

test("a submitted implementation waits on external checks before it can be called stuck", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "submitted",
        role: "implementation",
        lastObservedAt: new Date(now - DISPATCH_SILENT_AFTER_MS * 2).toISOString(),
        processAlive: true,
        providerActivity: "thinking",
      },
      now,
    ),
    "waiting",
  );
});

test("review work keeps progressing even when its task has been submitted", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "submitted",
        role: "reviewer",
        lastObservedAt: new Date(now - 1_000).toISOString(),
        processAlive: true,
        providerActivity: "thinking",
      },
      now,
    ),
    "thinking",
  );
});

test("a running dispatch with no progress becomes stalled at its configured threshold", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - 30_000).toISOString(),
        lastProgressAt: new Date(now - 30_000).toISOString(),
        processAlive: true,
        providerActivity: "thinking",
        stallTimeoutMs: 30_000,
      },
      now,
    ),
    "stalled",
  );
});

test("a long dispatch with continuing provider events stays active beyond the old silence window", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - DISPATCH_SILENT_AFTER_MS * 2).toISOString(),
        lastProgressAt: new Date(now - 1_000).toISOString(),
        processAlive: true,
        providerActivity: "thinking",
        stallTimeoutMs: 30_000,
      },
      now,
    ),
    "thinking",
  );
});

test("a dead worker process is a stuck signal on its own, without waiting out the silence window", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - 1_000).toISOString(),
        processAlive: false,
        providerActivity: "thinking",
      },
      now,
    ),
    "silent",
  );
  // 一个还活着、刚刚有观测的进程不受影响。
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - 1_000).toISOString(),
        processAlive: true,
        providerActivity: "thinking",
      },
      now,
    ),
    "thinking",
  );
});

test("an absent process signal is not a dead process: only the time window judges then", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - 1_000).toISOString(),
        processAlive: null,
        providerActivity: null,
      },
      now,
    ),
    "thinking",
  );
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - DISPATCH_SILENT_AFTER_MS).toISOString(),
        processAlive: null,
        providerActivity: null,
      },
      now,
    ),
    "silent",
  );
});

test("terminal and unknown dispatches are never labeled as active or silent", () => {
  for (const status of ["succeeded", "unknown", "lost"] as const) {
    assert.equal(
      dispatchActivityStatus(
        {
          status,
          taskStatus: "active",
          role: "implementation",
          lastObservedAt: new Date(now - DISPATCH_SILENT_AFTER_MS * 2).toISOString(),
          processAlive: false,
          providerActivity: "thinking",
        },
        now,
      ),
      "unknown",
    );
  }
});

test("provider frames project thinking, tool, and waiting without exposing provider vocabulary", () => {
  assert.equal(
    dispatchProviderActivity("codex", { type: "item.started", item: { type: "command_execution" } }),
    "tool",
  );
  assert.equal(
    dispatchProviderActivity("codex", { type: "item.updated", item: { type: "command_execution" } }),
    "tool",
  );
  assert.equal(
    dispatchProviderActivity("codex", { type: "item.completed", item: { type: "command_execution" } }),
    "thinking",
  );
  assert.equal(
    dispatchProviderActivity("claude", {
      type: "assistant",
      message: { content: [{ type: "thinking", thinking: "working" }] },
    }),
    "thinking",
  );
  assert.equal(
    dispatchProviderActivity("agy", {
      event: "step_update",
      step_update: { step_type: "tool", state: "ACTIVE" },
    }),
    "tool",
  );
  assert.equal(dispatchProviderActivity("zcode", { type: "model.streaming", payload: { kind: "tool_call" } }), "tool");
  assert.equal(dispatchProviderActivity("acp", { type: "acp.update", update: { sessionUpdate: "tool_call" } }), "tool");
  assert.equal(
    dispatchProviderActivity("acp", {
      type: "acp.update",
      update: { sessionUpdate: "tool_call_update", status: "completed" },
    }),
    "thinking",
  );
  assert.equal(
    dispatchProviderActivity("acp", {
      type: "acp.update",
      update: { sessionUpdate: "tool_call_update", status: "in_progress" },
    }),
    "tool",
  );
  assert.equal(dispatchProviderActivity("codex", { type: "turn.completed" }), "waiting");
  assert.equal(dispatchProviderActivity("claude", { type: "result" }), "waiting");
});
