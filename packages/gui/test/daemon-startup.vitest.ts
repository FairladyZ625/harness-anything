// harness-test-tier: integration
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  daemonRetryDelay,
  daemonStartupBudgetMs,
  daemonStartupPhase,
  isRetryableDaemonError,
} from "../src/renderer/daemon-startup.ts";
import { harnessClient } from "../src/renderer/api-client.ts";

describe("daemon startup state machine", () => {
  it("moves pending to waiting and then ready", () => {
    expect(daemonStartupPhase({ pending: true, ready: false, elapsedMs: 0 })).toBe("pending");
    expect(daemonStartupPhase({ pending: false, ready: false, elapsedMs: 1_000 })).toBe("waiting");
    expect(daemonStartupPhase({ pending: false, ready: true, elapsedMs: 1_001 })).toBe("ready");
  });

  it("moves waiting to timeout and a fresh retry can become ready", () => {
    expect(daemonStartupPhase({ pending: false, ready: false, elapsedMs: daemonStartupBudgetMs })).toBe("timeout");
    expect(daemonStartupPhase({ pending: true, ready: false, elapsedMs: 0 })).toBe("pending");
    expect(daemonStartupPhase({ pending: false, ready: true, elapsedMs: 250 })).toBe("ready");
  });

  it("retries only classified daemon availability failures with capped backoff", () => {
    for (const code of ["daemon_unavailable", "daemon_stopping", "daemon_closed", "daemon_response_timeout"])
      expect(isRetryableDaemonError(Object.assign(new Error(code), { code }))).toBe(true);
    expect(isRetryableDaemonError(Object.assign(new Error("bad request"), { code: "invalid_request" }))).toBe(false);
    expect(daemonRetryDelay(0)).toBe(250);
    expect(daemonRetryDelay(20)).toBe(2_000);
  });

  it("preserves the bridge error code for retry classification", async () => {
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: {
        getSystemStatus: async () => ({
          ok: false,
          error: { code: "daemon_stopping", hint: "The daemon is draining." },
        }),
      },
    });
    await expect(harnessClient.getSystemStatus()).rejects.toMatchObject({ code: "daemon_stopping" });
    Reflect.deleteProperty(window, "harness");
  });
});
