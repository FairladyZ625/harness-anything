// harness-test-tier: integration
import { describe, expect, it, vi } from "vitest";
import {
  closeTerminalTab,
  mostRecentAttachableTerminal,
  reconcileTerminalGeneration,
  reduceTerminalStream,
  requestTerminalTermination,
  type TerminalTab,
} from "../src/renderer/terminal-model.ts";
import { terminalClient } from "../src/renderer/terminal-client.ts";
import {
  defaultTerminalPreferences,
  readTerminalPreferences,
  writeTerminalPreferences,
} from "../src/renderer/terminal-preferences.ts";

const tab: TerminalTab = {
  sessionId: "terminal-a",
  name: "Build",
  state: "running",
  daemonGeneration: 7,
  attachmentId: "attach-a",
  lastSeq: 2,
  output: "ready\n",
  notice: null,
  cwd: ".",
  requestedBackend: "direct-pty",
  backend: "direct-pty",
  durability: "daemon-process",
  warning: null,
  attachable: true,
};

describe("terminal renderer control", () => {
  it("closes a tab by detaching its stream and daemon attachment without terminating", async () => {
    const stopStream = vi.fn(),
      detach = vi.fn(async () => ({ schema: "terminal-detach-ack/v1", ok: true })),
      terminate = vi.fn();
    await closeTerminalTab("repo-a", tab, { stopStream, detach });
    expect(stopStream).toHaveBeenCalledOnce();
    expect(detach).toHaveBeenCalledWith("repo-a", "terminal-a", "attach-a");
    expect(terminate).not.toHaveBeenCalled();
  });

  it("requires explicit confirmation before sending terminate", async () => {
    const terminate = vi.fn(async () => ({ outcome: "applied" }));
    expect(await requestTerminalTermination("repo-a", tab, false, { terminate })).toEqual({
      state: "confirmation_required",
    });
    expect(terminate).not.toHaveBeenCalled();
    expect(await requestTerminalTermination("repo-a", tab, true, { terminate })).toEqual({ state: "requested" });
    expect(terminate).toHaveBeenCalledWith("repo-a", "terminal-a", true);
  });

  it("surfaces sequence gaps and daemon backpressure instead of presenting continuous output", () => {
    const skipped = reduceTerminalStream(tab, {
      schema: "terminal-attach-event/v1",
      sessionId: "terminal-a",
      seq: 5,
      kind: "output",
      utf8: "late\n",
      droppedThrough: null,
      occurredAt: "2026-08-14T00:00:00.000Z",
    });
    expect(skipped.lastSeq).toBe(5);
    expect(skipped.notice).toContain("sequence gap");
    const dropped = reduceTerminalStream(skipped, {
      schema: "terminal-attach-event/v1",
      sessionId: "terminal-a",
      seq: 6,
      kind: "gap",
      utf8: "",
      droppedThrough: 5,
      occurredAt: "2026-08-14T00:00:01.000Z",
    });
    expect(dropped.notice).toContain("backpressure");
    expect(dropped.notice).toContain("5");
  });

  it("marks running tabs unknown when the daemon generation changes", () => {
    const durable = {
        ...tab,
        sessionId: "terminal-tmux",
        requestedBackend: "tmux" as const,
        backend: "tmux" as const,
        durability: "daemon-restart" as const,
      },
      restarted = reconcileTerminalGeneration(
        [tab, durable, { ...tab, sessionId: "terminal-exited", state: "exited" }],
        8,
      );
    expect(restarted[0]).toMatchObject({ state: "unknown", daemonGeneration: 8, attachmentId: null });
    expect(restarted[0]?.notice).toContain("not durable");
    expect(restarted[1]).toMatchObject({ state: "running", daemonGeneration: 8, backend: "tmux", attachmentId: null });
    expect(restarted[2]?.state).toBe("exited");
  });

  it("sends a closed repo-scoped terminal packet without secret or environment fields", async () => {
    const spawnTerminal = vi.fn(async () => ({
      schema: "terminal-control-receipt/v1",
      ok: true,
      outcome: "applied",
      operationId: "terminal-op-a",
      sessionId: "terminal-a",
      daemonGeneration: 7,
      state: "running",
      error: null,
    }));
    vi.stubGlobal("window", {
      harness: {
        listTerminalSessions: vi.fn(),
        spawnTerminal,
        attachTerminal: vi.fn(),
        sendTerminalInput: vi.fn(),
        resizeTerminal: vi.fn(),
        detachTerminal: vi.fn(),
        terminateTerminal: vi.fn(),
      },
    });
    await terminalClient.spawn("repo-a", {
      idempotencyKey: "terminal-gui-a",
      backend: "tmux",
      name: "Build",
      cwd: { scope: "repo-relative", path: "packages/gui" },
      shellProfileId: "zsh",
      taskId: "TASK-9",
    });
    expect(spawnTerminal).toHaveBeenCalledWith({
      repoId: "repo-a",
      idempotencyKey: "terminal-gui-a",
      backend: "tmux",
      name: "Build",
      cwd: { scope: "repo-relative", path: "packages/gui" },
      shellProfileId: "zsh",
      taskId: "TASK-9",
    });
    expect(JSON.stringify(spawnTerminal.mock.calls[0]?.[0])).not.toMatch(/secret|token|password|env/iu);
  });

  it("round-trips the versioned terminal backend preference and ignores retired dock-era fields", () => {
    const values = new Map<string, string>(),
      storage = {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
      },
      selected = { backend: "tmux" as const };
    writeTerminalPreferences(storage, selected);
    expect(readTerminalPreferences(storage)).toEqual(selected);
    // dock 撤销前写入的旧载荷仍可读:多余的停靠字段被忽略,不作为否决条件。
    values.set(
      [...values.keys()][0]!,
      JSON.stringify({
        schema: "terminal-preferences/v1",
        backend: "tmux",
        dockPosition: "right",
        bottomHeight: 440,
        rightWidth: 620,
      }),
    );
    expect(readTerminalPreferences(storage)).toEqual({ backend: "tmux" });
    values.set([...values.keys()][0]!, JSON.stringify({ schema: "terminal-preferences/v1", backend: "remote" }));
    expect(readTerminalPreferences(storage)).toEqual(defaultTerminalPreferences);
  });

  it("prefers the most recent attachable session for the first-open fast path", () => {
    const rows = [
      { sessionId: "old", status: "running", attachable: true },
      { sessionId: "gone", status: "exited", attachable: false },
      { sessionId: "restored", status: "running", attachable: true },
    ];
    expect(mostRecentAttachableTerminal(rows)?.sessionId).toBe("restored");
    expect(mostRecentAttachableTerminal(rows.map((row) => ({ ...row, attachable: false })))).toBeNull();
  });
});
