import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateEmbeddedBrowserTarget,
  evaluateExternalUrlTarget,
  evaluateFileTarget,
  evaluateTerminalOutputLink,
  validateTrustPolicy,
  type TrustPolicy
} from "../src/index.ts";

const policy: TrustPolicy = {
  projectId: "project-a",
  allowedRoots: ["/workspace/project-a", "/tmp/preview"],
  allowedLocalhostPorts: [3000, 5173],
  allowedUrlOrigins: ["https://docs.example.test"],
  openExternalByDefault: true
};

test("TrustPolicy allows file targets only under allowed roots", () => {
  assert.deepEqual(validateTrustPolicy(policy), { ok: true });
  assert.deepEqual(evaluateFileTarget(policy, "/workspace/project-a/README.md"), {
    action: "allow",
    reason: "file_target_allowed_root"
  });
  assert.deepEqual(evaluateFileTarget(policy, "/workspace/project-a/../project-a/src/index.ts"), {
    action: "allow",
    reason: "file_target_allowed_root"
  });
  assert.deepEqual(evaluateFileTarget(policy, "/workspace/other/README.md"), {
    action: "deny",
    reason: "file_target_outside_allowed_roots",
    detail: "/workspace/other/README.md"
  });
  assert.deepEqual(evaluateFileTarget(policy, "relative/file.txt"), {
    action: "deny",
    reason: "invalid_target",
    detail: "relative/file.txt"
  });
  assert.deepEqual(evaluateFileTarget({ ...policy, allowedRoots: ["relative-root"] }, "/workspace/project-a/README.md"), {
    action: "deny",
    reason: "invalid_policy"
  });
});

test("TrustPolicy gates embedded browser targets by localhost port or allowed origin", () => {
  assert.deepEqual(evaluateEmbeddedBrowserTarget(policy, "http://127.0.0.1:3000/preview"), {
    action: "allow",
    reason: "embedded_browser_allowed_localhost"
  });
  assert.deepEqual(evaluateEmbeddedBrowserTarget(policy, "http://localhost:9999/preview"), {
    action: "deny",
    reason: "embedded_browser_denied",
    detail: "http://localhost:9999/preview"
  });
  assert.deepEqual(evaluateEmbeddedBrowserTarget(policy, "https://docs.example.test/path"), {
    action: "allow",
    reason: "embedded_browser_allowed_origin"
  });
  assert.deepEqual(evaluateEmbeddedBrowserTarget(policy, "https://evil.example.test"), {
    action: "deny",
    reason: "embedded_browser_denied",
    detail: "https://evil.example.test"
  });
  assert.deepEqual(evaluateEmbeddedBrowserTarget({ ...policy, allowedLocalhostPorts: [0] }, "http://127.0.0.1:3000"), {
    action: "deny",
    reason: "invalid_policy"
  });
});

test("TrustPolicy sends external URLs to the system browser only when allowed", () => {
  assert.deepEqual(evaluateExternalUrlTarget(policy, "https://example.test"), {
    action: "open_external",
    reason: "external_url_system_browser"
  });
  assert.deepEqual(evaluateExternalUrlTarget({ ...policy, openExternalByDefault: false }, "https://example.test"), {
    action: "deny",
    reason: "external_url_denied",
    detail: "https://example.test"
  });
});

test("TrustPolicy requires terminal output links to be user initiated", () => {
  assert.deepEqual(evaluateTerminalOutputLink(policy, { target: "https://example.test", userGesture: false }), {
    action: "deny",
    reason: "terminal_link_requires_user_gesture",
    detail: "https://example.test"
  });
  assert.deepEqual(evaluateTerminalOutputLink(policy, { target: "/workspace/project-a/log.txt", userGesture: true }), {
    action: "allow",
    reason: "file_target_allowed_root"
  });
  assert.deepEqual(evaluateTerminalOutputLink(policy, { target: "https://example.test", userGesture: true }), {
    action: "open_external",
    reason: "external_url_system_browser"
  });
});
