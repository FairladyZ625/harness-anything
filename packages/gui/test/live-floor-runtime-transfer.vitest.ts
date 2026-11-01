// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { FIXTURE_RUNTIME_OVERVIEW } from "./entityIdGateFixtures.ts";

const FRAME_LIMIT = 98_304;
const SESSION_COUNT = 300;
const sessions = Array.from({ length: SESSION_COUNT }, (_, index) => ({
  ...FIXTURE_RUNTIME_OVERVIEW.sessions[0]!,
  runtimeSessionId: `runtime-${String(index).padStart(4, "0")}`,
  liveness: index % 5 === 0 ? ("exited" as const) : ("live" as const),
}));
const fullResult = { ...FIXTURE_RUNTIME_OVERVIEW, sessions };

afterEach(() => {
  Reflect.deleteProperty(window, "harness");
  resetGuiTransportForTest();
});

describe("live floor active runtime sessions", () => {
  it("reads an oversized active-session result through the transport envelope", async () => {
    expect(Buffer.byteLength(JSON.stringify(fullResult))).toBeGreaterThan(FRAME_LIMIT);
    const calls: Array<{ readonly limit?: number; readonly cursor?: string }> = [];
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: {
        request: vi.fn(async (method: string, payload: { readonly limit?: number; readonly cursor?: string }) => {
          expect(method).toBe("getAgentRuntimeOverview");
          calls.push(payload);
          expect(payload.limit).toBeUndefined();
          const result = {
            ...FIXTURE_RUNTIME_OVERVIEW,
            sessions,
          };
          return result;
        }),
      },
    });

    const result = await agentRuntimeClient.overview("live-floor-paging-probe");

    expect(result.sessions).toHaveLength(SESSION_COUNT);
    expect(calls).toEqual([{ repoId: "live-floor-paging-probe" }]);
  });
});
