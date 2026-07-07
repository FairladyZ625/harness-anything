import assert from "node:assert/strict";
import test from "node:test";
import { selectGuiE2eCommand } from "./run-gui-e2e-tests.mjs";

test("GUI E2E runner uses npm directly when a display is available", () => {
  assert.deepEqual(
    selectGuiE2eCommand({ platform: "linux", display: ":99", hasXvfbRun: true }),
    {
      command: "npm",
      args: ["run", "test:e2e", "-w", "@harness-anything/gui"],
      requiresXvfb: false
    }
  );
});

test("GUI E2E runner wraps headless Linux with xvfb-run", () => {
  assert.deepEqual(
    selectGuiE2eCommand({ platform: "linux", display: undefined, hasXvfbRun: true }),
    {
      command: "xvfb-run",
      args: ["--auto-servernum", "npm", "run", "test:e2e", "-w", "@harness-anything/gui"],
      requiresXvfb: true
    }
  );
});

test("GUI E2E runner reports a missing display server dependency", () => {
  assert.deepEqual(
    selectGuiE2eCommand({ platform: "linux", display: "", hasXvfbRun: false }),
    {
      command: "npm",
      args: ["run", "test:e2e", "-w", "@harness-anything/gui"],
      requiresXvfb: true,
      missingXvfb: true
    }
  );
});
