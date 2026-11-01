// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { FIXTURE_RUNTIME_OVERVIEW } from "./entityIdGateFixtures.ts";

const FRAME_LIMIT = 98_304;
const SESSION_COUNT = 300;
const PAGE_LIMIT = 16;
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
  it("reads an oversized active-session result in bounded cursor pages", async () => {
    expect(Buffer.byteLength(JSON.stringify(fullResult))).toBeGreaterThan(FRAME_LIMIT);
    const calls: Array<{ readonly limit?: number; readonly cursor?: string }> = [];
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: {
        request: vi.fn(async (method: string, payload: { readonly limit?: number; readonly cursor?: string }) => {
          expect(method).toBe("getAgentRuntimeOverview");
          calls.push(payload);
          if (payload.limit === undefined) throw new Error(`invalid_frame: Fleet frame exceeds ${FRAME_LIMIT} bytes`);
          const cursorIndex = payload.cursor
            ? Number(decodeURIComponent(payload.cursor.slice("runtime-session:".length)).slice(8))
            : -1;
          const start = cursorIndex + 1;
          const pageSessions = sessions.slice(start, start + payload.limit);
          const lastIndex = start + pageSessions.length - 1;
          const nextCursor =
            lastIndex + 1 >= sessions.length
              ? null
              : `runtime-session:${encodeURIComponent(sessions[lastIndex]!.runtimeSessionId)}`;
          const result = {
            ...FIXTURE_RUNTIME_OVERVIEW,
            sessions: pageSessions,
            page: {
              limit: payload.limit,
              cursor: payload.cursor ?? null,
              nextCursor,
              remainingCount: Math.max(0, sessions.length - lastIndex - 1),
            },
          };
          expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(FRAME_LIMIT);
          return result;
        }),
      },
    });

    const result = await agentRuntimeClient.overview("live-floor-paging-probe");

    expect(result.sessions).toHaveLength(SESSION_COUNT - Math.ceil(SESSION_COUNT / 5));
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every(({ limit }) => limit === PAGE_LIMIT)).toBe(true);
    expect(calls[0]?.cursor).toBeUndefined();
    const lastPageStart = Math.floor((SESSION_COUNT - 1) / PAGE_LIMIT) * PAGE_LIMIT,
      previousSessionId = `runtime-${String(lastPageStart - 1).padStart(4, "0")}`;
    expect(calls.at(-1)?.cursor).toBe(`runtime-session:${previousSessionId}`);
  });
});
