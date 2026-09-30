// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const here = path.resolve(import.meta.dirname, "..");
test("repro: synchronous dispatch scans defer timers and hold queued repo-cell reads", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-dispatch-sync-freeze-")),
    rootDir = path.join(parent, "repo"),
    repoId = workspaceId("dispatch-sync-freeze");
  let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
  try {
    mkdirSync(rootDir);
    initRepo(rootDir);
    const primitive = measurePrimitiveCurve(parent);
    for (const sample of primitive) {
      assert.equal(sample.rows, sample.expectedRows, JSON.stringify(sample));
      assert.equal(sample.timerFiredDuringScan, false, JSON.stringify(sample));
      assert.ok(sample.elapsedMs >= 0, JSON.stringify(sample));
      assert.ok(sample.timerDelayMs >= sample.elapsedMs, JSON.stringify(sample));
    }
    context.diagnostic(`primitive=${JSON.stringify(primitive)}`);

    writeStreams(rootDir, 4_000, { payloadBytes: 128 * 1024 });
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "dispatch-sync-freeze" });
    const startedAt = performance.now();
    const list = cell.read("repo.agentRuntime.tokenUsage", {});
    const reads = Array.from({ length: 20 }, () =>
      cell.read("repo.settings.read").then(() => Math.round(performance.now() - startedAt)),
    );
    await list;
    const completionMs = await Promise.all(reads),
      rangeMs = Math.max(...completionMs) - Math.min(...completionMs),
      maxMs = Math.max(...completionMs);
    assert.ok(maxMs > 0, JSON.stringify({ completionMs, maxMs, rangeMs }));
    context.diagnostic(
      `cell=${JSON.stringify({ completionMs, maxMs, rangeMs, queueDepth: cell.status().queueDepth })}`,
    );
  } finally {
    await cell?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

function measurePrimitiveCurve(parent: string): readonly ProbeSample[] {
  const samples: ProbeSample[] = [];
  for (const count of [100, 1_000, 4_000] as const) {
    const rootDir = path.join(parent, `primitive-${count}`);
    mkdirSync(rootDir);
    writeStreams(rootDir, count, { payloadBytes: 0 });
    samples.push(measureInProbe(rootDir, "headers", count, false), measureInProbe(rootDir, "summaries", count, false));
    rmSync(rootDir, { recursive: true, force: true });
  }
  const rootDir = path.join(parent, "primitive-4000-large");
  mkdirSync(rootDir);
  writeStreams(rootDir, 4_000, { payloadBytes: 128 * 1024 });
  samples.push(measureInProbe(rootDir, "headers", 4_000, false), measureInProbe(rootDir, "summaries", 4_000, false));
  archiveStreams(rootDir, 200);
  samples.push(measureInProbe(rootDir, "headers", 3_800, true), measureInProbe(rootDir, "summaries", 4_000, true));
  rmSync(rootDir, { recursive: true, force: true });
  return samples;
}

function writeStreams(rootDir: string, count: number, input: { readonly payloadBytes: number }): void {
  const live = path.join(rootDir, ".harness", "runtime", "dispatches"),
    payload = "x".repeat(input.payloadBytes),
    startedAt = "2026-09-30T03:17:27.784Z";
  mkdirSync(live, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString(16).padStart(24, "0"),
      dispatchId = `dispatch_${suffix}`,
      header = {
        schema: "runtime-dispatch-stream/v1",
        kind: "dispatch",
        dispatchId,
        taskId: null,
        executionId: null,
        runtimeSessionId: `runtime_${suffix}`,
        instanceId: "repro",
        startedAt,
        eventStreamRef: `file:.harness/runtime/dispatches/${dispatchId}.jsonl`,
      },
      body = `${JSON.stringify(header)}\n${JSON.stringify({ schema: header.schema, kind: "provider_event", occurredAt: startedAt, event: payload })}\n`;
    writeFileSync(path.join(live, `${dispatchId}.jsonl`), body);
  }
}

function archiveStreams(rootDir: string, count: number): void {
  const live = path.join(rootDir, ".harness", "runtime", "dispatches"),
    archive = path.join(live, "archive");
  mkdirSync(archive);
  for (let index = 0; index < count; index += 1) {
    const suffix = index.toString(16).padStart(24, "0"),
      name = `dispatch_${suffix}.jsonl`;
    renameSync(path.join(live, name), path.join(archive, name));
  }
}

function measureInProbe(
  rootDir: string,
  operation: "headers" | "summaries",
  expectedRows: number,
  archive: boolean,
): ProbeSample {
  const script = `
    import { readAllDispatchStreamSummaries, readDispatchStreamHeaders } from ${JSON.stringify(path.join(here, "src/dispatch-stream.ts"))};
    const rootDir = ${JSON.stringify(rootDir)};
    let scanFinished = false;
    let timerFiredDuringScan = false;
    const startedAt = performance.now();
    let timerDelayMs = -1;
    setTimeout(() => { timerFiredDuringScan = !scanFinished; timerDelayMs = performance.now() - startedAt; }, 0);
    const rows = ${operation === "headers" ? "readDispatchStreamHeaders(rootDir)" : "readAllDispatchStreamSummaries(rootDir)"};
    const elapsedMs = performance.now() - startedAt;
    scanFinished = true;
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.stdout.write(JSON.stringify({ operation: ${JSON.stringify(operation)}, expectedRows: ${String(expectedRows)}, archive: ${String(archive)}, rows: rows.length, elapsedMs, timerDelayMs, timerFiredDuringScan }));
  `;
  const output = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(output) as ProbeSample;
}

type ProbeSample = {
  readonly operation: "headers" | "summaries";
  readonly expectedRows: number;
  readonly archive: boolean;
  readonly rows: number;
  readonly elapsedMs: number;
  readonly timerDelayMs: number;
  readonly timerFiredDuringScan: boolean;
};
