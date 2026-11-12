// harness-test-tier: integration
import test from "node:test";
import { runCut } from "./fixtures/fleet-backup-cut/driver.ts";
import { runLifecycle } from "./fixtures/fleet-backup-cut/lifecycle.ts";

test("a stationary first replica pins one accepted and projected cut", { timeout: 120_000 }, (t) =>
  runCut(t, "stationary"),
);
test("a first replica preserves one cut across a real center write between SELECTs", { timeout: 120_000 }, (t) =>
  runCut(t, "between-selects"),
);
test("a real center write after pinning preserves first replica catch-up", { timeout: 120_000 }, (t) =>
  runCut(t, "after-pinned"),
);
test("a cancelled snapshot waiter never starts its worker and releases the write queue", { timeout: 120_000 }, (t) =>
  runLifecycle(t, "queued-abort"),
);
test("a failure before pinning preserves its error and releases the write queue", { timeout: 120_000 }, (t) =>
  runLifecycle(t, "before-pinned-failure"),
);
test("an archive failure after pinning preserves its error and releases the write queue", { timeout: 120_000 }, (t) =>
  runLifecycle(t, "after-pinned-failure"),
);
test("cancelling an archive after pinning releases its worker and the write queue", { timeout: 120_000 }, (t) =>
  runLifecycle(t, "after-pinned-abort"),
);
