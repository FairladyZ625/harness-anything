// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { assertDaemonHello, daemonHelloParams } from "../src/client/daemon-hello.ts";
import { shape, validateShape } from "../src/protocol/daemon-protocol-gui-types.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";

// The hello schema of the previous release (98b51e9), frozen verbatim. The previous daemon is
// already running when a new CLI starts, so this is the object its closed validator sees: any new
// field is rejected with `unknown_field` before version negotiation can happen. Keep this copy
// until the 1.0 compatibility window closes (by 2026-12-04 or when the current minor becomes 1.1),
// then replace it with the 1.1 schema and bump the protocol minor.
const previousHelloParams = shape({
  protocolVersion: shape({ major: "number", minor: "number" }),
  sessionEnvironment: "json?",
  executionCredential: "string?",
  reportStaleBuild: "boolean?",
  invokingCommand: "string?",
});

/** The previous release's hello handler: closed-schema validation, then its bare success reply. */
function previousDaemonHello(params: unknown): JsonObject {
  const errors = validateShape(params, previousHelloParams, "params");
  assert.deepEqual(errors, [], "the previous daemon must accept the current client's hello params");
  return { ok: true };
}

test("a current client completes hello against the frozen previous-release contract", () => {
  const params = daemonHelloParams({
      sessionEnvironment: { cwd: "/tmp/worktree" },
      invokingCommand: "task.list",
      reportStaleBuild: true,
    }),
    reply = previousDaemonHello(params);

  assert.equal(params.buildCommit, undefined, "a hello field with no daemon consumer must not be sent");
  // The bare reply is exactly what the previous diagnostics worker returned; the main daemon shape
  // also reports the version. Both must be admitted without widening the window itself.
  assertDaemonHello(reply);
  assertDaemonHello({ ok: true, protocolVersion: currentDaemonProtocolVersion });
});

test("the round trip still refuses a peer outside the current/previous window", () => {
  assert.throws(
    () =>
      assertDaemonHello({
        ok: true,
        protocolVersion: { major: currentDaemonProtocolVersion.major, minor: currentDaemonProtocolVersion.minor + 1 },
      }),
    (error: unknown) => (error as { readonly code?: string }).code === "incompatible_protocol_version",
  );
});

test("a daemon rejection keeps its own code instead of becoming a version mismatch", () => {
  assert.throws(
    () =>
      assertDaemonHello({
        ok: false,
        code: "unknown_field",
        rejectionExplanation: 'params contains an unknown field "buildCommit"',
      }),
    (error: unknown) => (error as { readonly code?: string }).code === "unknown_field",
  );
});
