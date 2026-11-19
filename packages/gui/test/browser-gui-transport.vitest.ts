// harness-test-tier: fast
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserGuiTransport } from "../src/browser/browser-gui-transport.ts";
import { emptyRuntimeSnapshot, runtimeCursor } from "../../daemon/test/fixtures/runtime-stream.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const repoId = "repo-a",
  runtimeSessionId = "runtime-a";
const heartbeat = (seq: number, epoch?: string) => ({
  schema: "agent-runtime-attach-event/v2",
  runtimeSessionId,
  type: "heartbeat",
  occurredAt: "2026-11-19T00:00:00Z",
  cursor: runtimeCursor(repoId, seq, epoch),
});
const initial = (seq: number, events: readonly unknown[] = [], epoch?: string, status = "attached") => ({
  ok: true,
  status,
  runtimeSessionId,
  cursor: runtimeCursor(repoId, seq, epoch),
  events,
});
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function response(chunks: readonly string[], keepOpen = false, cancelled?: () => void) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        if (!keepOpen) controller.close();
      },
      cancel: cancelled,
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

// dec_89D06D7360CBEC09795F7B12EC/CH3: one chunk can contain several complete frames; a partial
// frame can span chunks. A restarted epoch uses its own sequence and duplicates apply once.
it("reconnects with the applied cursor and consumes a gap snapshot before new increments", async () => {
  vi.useFakeTimers();
  const final = Promise.withResolvers<void>(),
    received: unknown[] = [],
    sent: RequestInit[] = [];
  const gap = { ...heartbeat(0, "new"), type: "gap", snapshotSeq: 0, snapshot: emptyRuntimeSnapshot };
  const fetch = vi.fn(async (_url: string, request: RequestInit) => {
    sent.push(request);
    return sent.length === 1
      ? response([
          frame(initial(0)) + frame(heartbeat(1)).slice(0, 38),
          frame(heartbeat(1)).slice(38) + frame(heartbeat(1)),
        ])
      : response([frame(initial(0, [gap], "new", "gap")) + frame(heartbeat(1, "new")) + "event: end\ndata: {}\n\n"]);
  });
  vi.stubGlobal("fetch", fetch);
  const stop = createBrowserGuiTransport("test-token").subscribe(
    "repo.agentRuntime.attach",
    { repo: { repoId }, payload: { runtimeSessionId } },
    (value) => {
      received.push(value);
      if (received.length === 4) final.resolve();
    },
    final.reject,
  );
  try {
    await vi.runAllTimersAsync();
    await final.promise;
    expect(received).toEqual([initial(0), heartbeat(1), initial(0, [gap], "new", "gap"), heartbeat(1, "new")]);
    expect(JSON.parse(String(sent[1]?.body)).params.payload.afterCursor).toEqual(runtimeCursor(repoId, 1));
    expect(sent[0]?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it("reports a permanent SSE end code after data without retrying", async () => {
  vi.useFakeTimers();
  const onValue = vi.fn(),
    failure = Promise.withResolvers<unknown>(),
    fetch = vi.fn(async () =>
      response([frame(initial(1, [heartbeat(1)])) + 'event: end\ndata: {"code":"invalid_result"}\n\n']),
    );
  vi.stubGlobal("fetch", fetch);
  const stop = createBrowserGuiTransport("test-token").subscribe(
    "repo.agentRuntime.attach",
    { repo: { repoId }, payload: { runtimeSessionId } },
    onValue,
    failure.resolve,
  );
  try {
    await vi.runAllTimersAsync();
    expect(await failure.promise).toMatchObject({ code: "invalid_result" });
    expect(onValue).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    stop();
  }
});

it("aborts a parked HTTP reader and rejects an invalid snapshot sequence", async () => {
  const delivered = Promise.withResolvers<void>();
  const fetch = vi.fn(async (_url: string, request: RequestInit) => {
    expect(request.signal?.aborted).toBe(false);
    return response([frame(initial(0))], true);
  });
  vi.stubGlobal("fetch", fetch);
  const params = { repo: { repoId }, payload: { runtimeSessionId } };
  const browser = createBrowserGuiTransport("test-token");
  const stop = browser.subscribe("repo.agentRuntime.attach", params, delivered.resolve, delivered.reject);
  await delivered.promise;
  stop();
  expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);

  fetch.mockResolvedValueOnce(
    response([
      frame(
        initial(
          1,
          [
            {
              ...heartbeat(1),
              type: "gap",
              snapshotSeq: 0,
              snapshot: emptyRuntimeSnapshot,
            },
          ],
          undefined,
          "gap",
        ),
      ),
    ]),
  );
  const failure = Promise.withResolvers<unknown>(),
    onValue = vi.fn();
  const close = browser.subscribe("repo.agentRuntime.attach", params, onValue, failure.resolve);
  try {
    expect(await failure.promise).toMatchObject({ message: expect.stringContaining("invalid") });
    expect(onValue).not.toHaveBeenCalled();
  } finally {
    close();
  }
});
