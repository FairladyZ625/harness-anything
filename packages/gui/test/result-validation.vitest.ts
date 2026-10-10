// harness-test-tier: contract
import { describe, expect, it } from "vitest";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import { daemonSettingsRead } from "../../daemon/src/protocol/daemon-settings-read-types.ts";
import { isSettingsSuccess } from "../src/renderer/settings-payload.ts";
import { localErrorHint, rendererErrorHint, rendererReadError } from "../src/renderer/result-validation.ts";

// daemonProtocolError() 的真实拒绝形状(packages/daemon/src/protocol/daemon-protocol-validate-results.ts:599):
// 合法的 op_rejected 回执带 code + rejectionExplanation + error.code,没有 error.hint。
// 换版排空期 daemon_stopping(json-rpc-dispatch-support.ts:176)、仓库未挂载 repo_unavailable
// (repo-cell coded error → protocolFailure)都长这样。
const daemonRejection = {
  schema: "command-receipt/v2",
  ok: false,
  command: "runtime-spawn",
  outcome: "op_rejected",
  opId: "N/A",
  origin: "daemon",
  code: "daemon_stopping",
  evidence: "rejection:daemon_stopping",
  rejectionExplanation: "The daemon is draining before it exits.",
  error: { code: "daemon_stopping" },
} as const;

describe("renderer rejection hint extraction", () => {
  it("shows the daemon rejection code and explanation instead of the invalid-receipt fallback", () => {
    expect(rendererErrorHint(daemonRejection, "Dispatch preview returned an invalid receipt.")).toBe(
      "daemon_stopping: The daemon is draining before it exits.",
    );
  });
  it("prefers error.hint, prefixed with the rejection code when both are present", () => {
    expect(
      rendererErrorHint({ ok: false, error: { code: "terminal_closed", hint: "Session closed." } }, "fallback"),
    ).toBe("terminal_closed: Session closed.");
    expect(rendererErrorHint({ ok: false, error: { hint: "Session closed." } }, "fallback")).toBe("Session closed.");
  });
  it("falls back to the bare rejection code when the receipt carries no explanation", () => {
    expect(
      rendererErrorHint({ ok: false, code: "repo_unavailable", error: { code: "repo_unavailable" } }, "fallback"),
    ).toBe("repo_unavailable");
  });
  it("keeps the caller fallback for values with nothing to extract", () => {
    expect(rendererErrorHint({ schema: "command-receipt/v2", ok: true }, "fallback")).toBe("fallback");
    expect(rendererErrorHint("garbage", "fallback")).toBe("fallback");
    expect(rendererErrorHint({ ok: false, rejectionExplanation: "   " }, "fallback")).toBe("fallback");
  });
  it("localErrorHint consumes the same chain but only from explicitly failed results", () => {
    expect(localErrorHint(daemonRejection, "fallback")).toBe(
      "daemon_stopping: The daemon is draining before it exits.",
    );
    expect(localErrorHint({ ok: true, rejectionExplanation: "stale" }, "fallback")).toBe("fallback");
  });
  it("rendererReadError carries the rejection code for retryability classification", () => {
    const error = rendererReadError(daemonRejection, "fallback");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("daemon_stopping: The daemon is draining before it exits.");
    expect((error as { readonly code?: string }).code).toBe("daemon_stopping");
  });
});

// dec_4190D5EA63D9DD208CE946F133: omitted defaults remain omitted at the renderer boundary.
it("accepts unset closeout settings and rejects malformed declared profiles", () => {
  const response = daemonSettingsRead(INITIAL_SETTINGS_V1, "initial");
  expect(isSettingsSuccess(response)).toBe(true);
  for (const closeout of [{}, { profile: "standard" }, { profile: "strict" }])
    expect(isSettingsSuccess({ ...response, settings: { ...response.settings, closeout } })).toBe(true);
  for (const closeout of [null, [], "strict", { profile: "unknown" }])
    expect(isSettingsSuccess({ ...response, settings: { ...response.settings, closeout } })).toBe(false);
});
