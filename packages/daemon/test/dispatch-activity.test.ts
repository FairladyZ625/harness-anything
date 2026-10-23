// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchActivityStatus, DISPATCH_STALLED_AFTER_MS } from "../src/dispatch-activity.ts";

const now = Date.parse("2026-10-21T08:00:00.000Z");

test("a submitted implementation waits on external checks before it can be called stuck", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "submitted",
        role: "implementation",
        lastObservedAt: new Date(now - DISPATCH_STALLED_AFTER_MS * 2).toISOString(),
        processAlive: true,
      },
      now,
    ),
    "waiting_ci",
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
      },
      now,
    ),
    "progressing",
  );
});

test("a running dispatch with no recent activity becomes suspect at the threshold", () => {
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - DISPATCH_STALLED_AFTER_MS).toISOString(),
        processAlive: true,
      },
      now,
    ),
    "stalled",
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
      },
      now,
    ),
    "stalled",
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
      },
      now,
    ),
    "progressing",
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
      },
      now,
    ),
    "progressing",
  );
  assert.equal(
    dispatchActivityStatus(
      {
        status: "running",
        taskStatus: "active",
        role: "implementation",
        lastObservedAt: new Date(now - DISPATCH_STALLED_AFTER_MS).toISOString(),
        processAlive: null,
      },
      now,
    ),
    "stalled",
  );
});

test("terminal and unknown dispatches are never labeled as progressing or stuck", () => {
  for (const status of ["succeeded", "unknown", "lost"] as const) {
    assert.equal(
      dispatchActivityStatus(
        {
          status,
          taskStatus: "active",
          role: "implementation",
          lastObservedAt: new Date(now - DISPATCH_STALLED_AFTER_MS * 2).toISOString(),
          processAlive: false,
        },
        now,
      ),
      "unknown",
    );
  }
});
