// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDispatchStream, readDispatchStream } from "../src/dispatch-stream.ts";
import { attachReceiptAcceptance } from "@harness-anything/kernel";
import { validateDaemonGuiCommandReceipt } from "../src/protocol/daemon-protocol.contract.ts";
import { adoptRuntimes } from "../src/runtime-spawn-adoption.ts";
import { cancelRuntime, steerRuntime } from "../src/runtime-spawn-control.ts";

const binding = { actor: { principal: { personId: "operator" }, executor: null }, source: "local" as const };

test("adoption settles an owned live session whose dispatch never recorded a process", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-dispatch-missing-process-"));
  try {
    const dispatchId = "dispatch_dddddddddddddddddddddddd",
      runtimeSessionId = "runtime_dddddddddddddddddddddddd";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-missing-process");
    const settled: Array<{ readonly runtimeSessionId: string; readonly reason: string | null }> = [],
      context = {
        input: { rootDir, repoId: "missing-process", now: () => "2026-09-13T00:01:00.000Z" },
        requiredRuntimeProjection: () => ({ readRuntimeSessions: () => [liveSession(runtimeSessionId)] }),
        processes: new Map(),
        exiting: new Set<string>(),
        reconcileFallback: () => undefined,
        consumeLine: async () => undefined,
        publishExit: async (active: { runtimeSessionId: string; lossReason: string | null }) => {
          settled.push({ runtimeSessionId: active.runtimeSessionId, reason: active.lossReason });
          context.processes.delete(active.runtimeSessionId);
        },
      };
    await adoptRuntimes(context as never);
    assert.deepEqual(settled, [
      { runtimeSessionId, reason: "runtime process was never recorded before daemon restart" },
    ]);
    assert.equal(context.processes.size, 0);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("recovery adoption preserves a runtime already owned by this daemon", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-owned-runtime-adoption-"));
  try {
    const dispatchId = "dispatch_aaaaaaaaaaaaaaaaaaaaaaaa",
      runtimeSessionId = "runtime_aaaaaaaaaaaaaaaaaaaaaaaa";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "owned-runtime");
    const owned = { runtimeSessionId },
      processes = new Map([[runtimeSessionId, owned]]);
    const context = {
      input: { rootDir, repoId: "owned-runtime", now: () => "2026-09-13T00:01:00.000Z" },
      requiredRuntimeProjection: () => ({ readRuntimeSessions: () => [liveSession(runtimeSessionId)] }),
      processes,
      exiting: new Set<string>(),
      reconcileFallback: () => {
        throw new Error("a live owned runtime must not be reconciled twice");
      },
      consumeLine: async () => undefined,
      publishExit: async () => {
        throw new Error("a live owned runtime must not be settled as missing");
      },
    };
    await adoptRuntimes(context as never);
    await adoptRuntimes(context as never);
    assert.equal(processes.get(runtimeSessionId), owned);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

for (const failurePoint of ["liveness", "settlement", "in-flight"] as const) {
  test(`adoption of a missing process handles ${failurePoint} without orphan ownership`, async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-retry-"));
    try {
      const dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
        runtimeSessionId = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb";
      openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "retry-adoption");
      let unavailable = true,
        settled = 0;
      const context = {
        input: { rootDir, repoId: "retry-adoption", now: () => "2026-09-13T00:01:00.000Z" },
        requiredRuntimeProjection: () => ({
          readRuntimeSessions: () => [{ ...liveSession(runtimeSessionId), liveness: "unknown" }],
        }),
        processes: new Map(),
        exiting: new Set(failurePoint === "in-flight" ? [runtimeSessionId] : []),
        consumeLine: async () => undefined,
        publishRuntimeEvent: async () => {
          assert.fail("a missing process must never publish live before settlement");
        },
        publishExit: async (active: { runtimeSessionId: string }) => {
          if (context.exiting.has(active.runtimeSessionId)) return;
          if (unavailable && failurePoint === "settlement") throw new Error("center disconnected");
          settled++;
          context.processes.delete(active.runtimeSessionId);
        },
      };
      if (failurePoint === "liveness") {
        await adoptRuntimes(context as never);
        assert.equal(settled, 1);
        assert.equal(context.processes.size, 0);
        return;
      }
      if (failurePoint === "in-flight") await adoptRuntimes(context as never);
      else await assert.rejects(adoptRuntimes(context as never), /center disconnected/);
      assert.equal(context.processes.size, 0, "failed or in-flight adoption must not leave an owned runtime");
      unavailable = false;
      context.exiting.clear();
      await adoptRuntimes(context as never);
      assert.equal(settled, 1);
      assert.equal(context.processes.size, 0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
}

test("adoption reports only completed session restorations, never in-flight or failed settlement", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-adoption-progress-"));
  try {
    const sessions = ["a", "b", "c"].map((id) => liveSession(`runtime_${id.repeat(24)}`)),
      progress: number[] = [],
      settlements: string[] = [];
    for (const [index, session] of sessions.entries())
      openMissingProcessStream(
        rootDir,
        `dispatch_${String(index).repeat(24)}`,
        session.runtimeSessionId,
        `op-${index}`,
      );
    let release!: () => void, announceSecond!: () => void;
    const pending = new Promise<void>((resolve) => {
        release = resolve;
      }),
      secondStarted = new Promise<void>((resolve) => {
        announceSecond = resolve;
      });
    const context = {
      input: { rootDir, repoId: "adoption-progress", now: () => "2026-09-13T00:01:00.000Z" },
      requiredRuntimeProjection: () => ({ readRuntimeSessions: () => sessions }),
      processes: new Map(),
      exiting: new Set<string>(),
      consumeLine: async () => undefined,
      publishExit: async (active: { runtimeSessionId: string }) => {
        if (settlements.length === 1) {
          announceSecond();
          await pending;
        }
        assert.equal(progress.length, settlements.length, "starting settlement is not completed progress");
        if (settlements.length === 2) throw new Error("settlement stalled");
        settlements.push(active.runtimeSessionId);
        context.processes.delete(active.runtimeSessionId);
      },
    };
    const adopting = adoptRuntimes(context as never, (completed) => progress.push(completed));
    await secondStarted;
    try {
      assert.deepEqual(progress, [1]);
    } finally {
      release();
    }
    await assert.rejects(adopting, /settlement stalled/);
    assert.deepEqual(progress, [1, 2]);
    assert.equal(settlements.length, 2);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime cancel settles a live projection whose dispatch never recorded a process", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-cancel-missing-process-"));
  try {
    const dispatchId = "dispatch_eeeeeeeeeeeeeeeeeeeeeeee",
      runtimeSessionId = "runtime_eeeeeeeeeeeeeeeeeeeeeeee";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-cancel-missing-process");
    const published: Array<{
        readonly type: string;
        readonly payload: Record<string, unknown>;
        readonly resultBody?: string;
      }> = [],
      context = {
        input: { rootDir, repoId: "cancel-missing-process" },
        requiredRuntimeProjection: () => ({ readRuntimeSessions: () => [liveSession(runtimeSessionId)] }),
        processes: new Map(),
        exiting: new Set<string>(),
        publishRuntimeEvent: async (
          type: string,
          payload: Record<string, unknown>,
          _opId: string,
          _binding: unknown,
          resultBody?: string,
        ) => {
          published.push({ type, payload, resultBody });
          return {};
        },
        controlReceipt: (_opId: string, _runtimeSessionId: string, detail: string) => ({ detail }),
      };
    const receipt = await cancelRuntime(context as never, { runtimeSessionId }, binding);
    assert.equal(
      published.find(({ type }) => type === "runtime_session_outcome_observed")?.resultBody,
      "Runtime session cancelled after its worker process was no longer available.",
    );
    assert.equal(receipt.detail, "cancelled");
    assert.deepEqual(
      published.map(({ type, payload }) => [type, payload]),
      [
        ["runtime_session_cancelled", { runtimeSessionId }],
        ["runtime_session_exited", { runtimeSessionId }],
        [
          "runtime_session_outcome_observed",
          {
            runtimeSessionId,
            outcome: "cancelled",
            exitCode: null,
            resultRef: `artifact:runtime-result/sha256/${createHash("sha256").update("Runtime session cancelled after its worker process was no longer available.").digest("hex")}`,
            result: {
              sha256: createHash("sha256")
                .update("Runtime session cancelled after its worker process was no longer available.")
                .digest("hex"),
              size: Buffer.byteLength("Runtime session cancelled after its worker process was no longer available."),
              mediaType: "text/plain; charset=utf-8",
            },
            reasonCode: "runtime_process_missing",
          },
        ],
      ],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer records the requesting actor and prompt without settling the dispatch", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-"));
  try {
    const dispatchId = "dispatch_ffffffffffffffffffffffff",
      runtimeSessionId = "runtime_ffffffffffffffffffffffff";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer");
    const active = {
        dispatchId,
        runtimeSessionId,
        kindId: "codex",
        providerSessionId: "provider-thread",
        process: { pid: process.pid },
      },
      context = {
        input: { rootDir, repoId: "steer-test", now: () => "2026-09-13T00:01:00.000Z" },
        processes: new Map([[runtimeSessionId, active]]),
      };
    const receipt = await steerRuntime(
      context as never,
      { dispatchId, prompt: "Stop exploring; fix the parser." },
      binding,
    );
    assert.equal(receipt.outcome, "applied");
    const records = readDispatchStream(rootDir, dispatchId)!.records;
    assert.deepEqual(
      records.filter((record) => record.kind === "steer_requested").map((record) => [record.actor, record.prompt]),
      [[binding.actor, "Stop exploring; fix the parser."]],
    );
    assert.equal(
      records.some((record) => record.kind === "process_exit"),
      false,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a successful steer receipt survives the GUI write exit instead of reporting ok must be false", async () => {
  // The reported defect: the prompt reached the dispatch stream, but the CLI answered
  // `invalid_result: field=ok; actual=true; must be false`. The steer receipt was passed through
  // ledger acceptance even though steer never writes the ledger, so `applied` became
  // `indeterminate` while `ok` stayed true — a shape the GUI receipt exit has to reject.
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-gui-receipt-"));
  try {
    const dispatchId = "dispatch_bbbbbbbbbbbbbbbbbbbbbbbb",
      runtimeSessionId = "runtime_bbbbbbbbbbbbbbbbbbbbbbbb";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-gui-receipt");
    const context = {
        input: { rootDir, repoId: "steer-gui-receipt", now: () => "2026-09-13T00:01:00.000Z" },
        processes: new Map([
          [
            runtimeSessionId,
            {
              dispatchId,
              runtimeSessionId,
              kindId: "codex",
              providerSessionId: "provider-thread",
              process: { pid: process.pid },
            },
          ],
        ]),
      },
      receipt = await steerRuntime(context as never, { dispatchId, prompt: "Also cover the timeout." }, binding),
      // `repo.agentRuntime.steer` answers through its own RPC branch: the receipt goes straight to
      // parseDaemonGuiActionResult, with no makeDaemonCommandReceipt to recompute `ok`. That is why
      // the reported failure shows actual=true — the acceptance step had already turned the outcome
      // indeterminate while `ok` stayed true. A store without a command outcome is production's
      // state: a steer appends to the dispatch stream and never to the ledger.
      wire = attachReceiptAcceptance(
        receipt as never,
        { readCommandOutcome: () => null } as never,
        { readCut: () => ({ watermark: 0 }) } as never,
      ) as unknown as Record<string, unknown>;
    assert.equal(wire.ok, true, JSON.stringify(wire));
    assert.equal(wire.outcome, "applied", JSON.stringify(wire));
    assert.deepEqual(validateDaemonGuiCommandReceipt(wire), [], JSON.stringify(wire));
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      true,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer applies to an ACP kind through the dispatch stream, adopted process included", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-acp-"));
  try {
    const dispatchId = "dispatch_0123456789abcdef01234567",
      runtimeSessionId = "runtime_0123456789abcdef01234567";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-acp");
    // An adopted process has no in-memory control handle; the dispatch stream is the channel.
    const active = {
        dispatchId,
        runtimeSessionId,
        kindId: "codex-acp",
        providerSessionId: "provider-session",
        process: { pid: process.pid },
      },
      context = {
        input: { rootDir, repoId: "steer-acp-test", now: () => "2026-09-13T00:01:00.000Z" },
        processes: new Map([[runtimeSessionId, active]]),
      };
    const receipt = await steerRuntime(
      context as never,
      { runtimeSessionId, prompt: "Focus on the failing test." },
      binding,
    );
    assert.equal(receipt.outcome, "applied");
    assert.equal(receipt.runtimeSessionId, runtimeSessionId);
    assert.deepEqual(
      readDispatchStream(rootDir, dispatchId)!
        .records.filter((record) => record.kind === "steer_requested")
        .map((record) => record.prompt),
      ["Focus on the failing test."],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer still refuses before the provider established a session", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-unbound-"));
  try {
    const dispatchId = "dispatch_111111111111111111111111",
      runtimeSessionId = "runtime_111111111111111111111111";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-unbound");
    const context = {
      input: { rootDir, repoId: "steer-unbound-test", now: () => "2026-09-13T00:01:00.000Z" },
      processes: new Map([
        [
          runtimeSessionId,
          {
            dispatchId,
            runtimeSessionId,
            kindId: "codex-acp",
            providerSessionId: null,
            process: { pid: process.pid },
          },
        ],
      ]),
    };
    await assert.rejects(
      steerRuntime(context as never, { runtimeSessionId, prompt: "Continue" }, binding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_steer_unavailable",
    );
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      false,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer rejects a provider without a declared steer strategy", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-unsupported-"));
  try {
    const dispatchId = "dispatch_eeeeeeeeeeeeeeeeeeeeeeee",
      runtimeSessionId = "runtime_eeeeeeeeeeeeeeeeeeeeeeee";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-unsupported");
    const context = {
      input: { rootDir, repoId: "steer-test", now: () => "2026-09-13T00:01:00.000Z" },
      processes: new Map([
        [
          runtimeSessionId,
          {
            dispatchId,
            runtimeSessionId,
            kindId: "agy",
            providerSessionId: "provider-session",
            process: { pid: process.pid },
          },
        ],
      ]),
    };
    await assert.rejects(
      steerRuntime(context as never, { runtimeSessionId, prompt: "Continue" }, binding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_steer_unsupported",
    );
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      false,
      "a rejected steer must not write a command record",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime steer refuses a dispatch whose worker host is already gone", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-runtime-steer-dead-host-"));
  try {
    const dispatchId = "dispatch_dddddddddddddddddddddddd",
      runtimeSessionId = "runtime_dddddddddddddddddddddddd";
    openMissingProcessStream(rootDir, dispatchId, runtimeSessionId, "dispatch-op-steer-dead-host");
    const context = {
      input: { rootDir, repoId: "steer-dead-host-test", now: () => "2026-09-13T00:01:00.000Z" },
      processes: new Map([
        [
          runtimeSessionId,
          {
            dispatchId,
            runtimeSessionId,
            kindId: "codex-acp",
            providerSessionId: "provider-session",
            // A pid that cannot exist: the request would land in a stream nobody follows, so the
            // command must be refused rather than reported as applied.
            process: { pid: 2_147_483_646 },
          },
        ],
      ]),
    };
    await assert.rejects(
      steerRuntime(context as never, { runtimeSessionId, prompt: "Continue" }, binding),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "runtime_steer_unavailable",
    );
    assert.equal(
      readDispatchStream(rootDir, dispatchId)!.records.some((record) => record.kind === "steer_requested"),
      false,
      "a refused steer must not leave a command record behind",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function openMissingProcessStream(rootDir: string, dispatchId: string, runtimeSessionId: string, dispatchOpId: string) {
  openDispatchStream(rootDir, {
    dispatchId,
    taskId: null,
    executionId: null,
    runtimeSessionId,
    instanceId: "instance-1",
    startedAt: "2026-09-13T00:00:00.000Z",
    dispatchOpId,
    kindId: "codex",
    permissionMode: null,
    binding,
    cwd: rootDir,
    prompt: "missing process",
    model: "gpt-5.6-sol",
    reasoningEffort: null,
    fast: false,
  });
}

function liveSession(runtimeSessionId: string) {
  return { runtimeSessionId, instanceId: "instance-1", providerSessionId: null, liveness: "live", outcome: null };
}
