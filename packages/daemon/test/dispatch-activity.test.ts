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
        },
        now,
      ),
      "unknown",
    );
  }
});
