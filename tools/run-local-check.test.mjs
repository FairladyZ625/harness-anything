import assert from "node:assert/strict";
import test from "node:test";
import { buildSteps, parseLocalCheckArgs, selectQosPrefix } from "./run-local-check.mjs";

test("parseLocalCheckArgs defaults to the waiting fast tier", () => {
  assert.deepEqual(parseLocalCheckArgs([]), { full: false, wait: true, pollMs: 2000 });
});

test("parseLocalCheckArgs recognizes --full, --fast and --no-wait", () => {
  assert.equal(parseLocalCheckArgs(["--full"]).full, true);
  assert.equal(parseLocalCheckArgs(["--fast"]).full, false);
  assert.equal(parseLocalCheckArgs(["--no-wait"]).wait, false);
  // last tier flag wins
  assert.equal(parseLocalCheckArgs(["--full", "--fast"]).full, false);
});

test("parseLocalCheckArgs rejects unknown options", () => {
  assert.throws(() => parseLocalCheckArgs(["--bogus"]), /unknown run-local-check option/u);
});

test("buildSteps appends integration and gui only in the full tier", () => {
  const fastScripts = buildSteps(false).map(([, script]) => script);
  const fullScripts = buildSteps(true).map(([, script]) => script);

  assert.ok(!fastScripts.includes("test:integration"));
  assert.ok(!fastScripts.includes("test:gui"));
  assert.ok(fullScripts.includes("test:integration"));
  assert.ok(fullScripts.includes("test:gui"));
  assert.equal(fullScripts.length, fastScripts.length + 2);

  // Fast tier mirrors the CI boundaries + package-policy surface.
  assert.ok(fastScripts.includes("harness:check-import-boundaries"));
  assert.ok(fastScripts.includes("harness:check-gate-surface"));
  assert.ok(fastScripts.includes("harness:check-package-policy"));
});

test("selectQosPrefix wraps with taskpolicy on darwin when available", () => {
  assert.deepEqual(
    selectQosPrefix({ platform: "darwin", hasTaskpolicy: true, hasNice: true }),
    ["taskpolicy", "-c", "utility"]
  );
});

test("selectQosPrefix falls back to nice off darwin or without taskpolicy", () => {
  assert.deepEqual(
    selectQosPrefix({ platform: "linux", hasTaskpolicy: false, hasNice: true }),
    ["nice", "-n", "10"]
  );
  assert.deepEqual(
    selectQosPrefix({ platform: "darwin", hasTaskpolicy: false, hasNice: true }),
    ["nice", "-n", "10"]
  );
});

test("selectQosPrefix runs bare when no QoS tool is available", () => {
  assert.deepEqual(
    selectQosPrefix({ platform: "linux", hasTaskpolicy: false, hasNice: false }),
    []
  );
});
