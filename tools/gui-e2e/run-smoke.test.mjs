// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { selectGuiSmokeCommand } from "./run-smoke.mjs";

test("GUI E2E smoke runner invokes node directly when a display is available", () => {
  assert.deepEqual(selectGuiSmokeCommand({ platform: "linux", display: ":99", hasXvfbRun: true }), {
    command: process.execPath,
    args: ["tools/gui-e2e.mjs", "--smoke", "--no-build"],
    requiresXvfb: false,
    shell: false,
  });
});

test("GUI E2E smoke runner wraps headless Linux with xvfb-run", () => {
  assert.deepEqual(selectGuiSmokeCommand({ platform: "linux", display: undefined, hasXvfbRun: true }), {
    command: "xvfb-run",
    args: ["--auto-servernum", process.execPath, "tools/gui-e2e.mjs", "--smoke", "--no-build"],
    requiresXvfb: true,
    shell: false,
  });
});

test("GUI E2E smoke runner reports a missing display server dependency", () => {
  assert.deepEqual(selectGuiSmokeCommand({ platform: "linux", display: "", hasXvfbRun: false }), {
    command: process.execPath,
    args: ["tools/gui-e2e.mjs", "--smoke", "--no-build"],
    requiresXvfb: true,
    missingXvfb: true,
    shell: false,
  });
});
