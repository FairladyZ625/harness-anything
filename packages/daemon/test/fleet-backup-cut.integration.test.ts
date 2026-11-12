// harness-test-tier: integration
import test from "node:test";
import { runCut } from "./fixtures/fleet-backup-cut/driver.ts";

test("a stationary first replica pins one accepted and projected cut", { timeout: 120_000 }, (t) =>
  runCut(t, "stationary"),
);
test("a real center write after pinning preserves first replica catch-up", { timeout: 120_000 }, (t) =>
  runCut(t, "after-pinned"),
);
