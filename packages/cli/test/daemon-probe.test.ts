// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCapturePort, probeJsStack, type CaptureRequest } from "../src/daemon/probe/probe-capture.ts";
import {
  createProcessMetricsReader,
  parseDarwinPs,
  parseDarwinThreadCount,
  parseLsofFileCount,
  parseProcStat,
  parseProcStatus,
  type ProcessMetrics,
} from "../src/daemon/probe/probe-metrics.ts";
import { parseDurationMs, parseProbeArgs, parseSummaryArgs } from "../src/daemon/probe/probe-options.ts";
import { pingDaemon, runProbeLoop, takeProbeSample } from "../src/daemon/probe/probe-run.ts";
import { currentDaemonProtocolVersion } from "@harness-anything/daemon/internal/protocol/version";
import { createTimelineWriter, readProbeTimeline } from "../src/daemon/probe/probe-timeline.ts";
import { createTriggerTracker, type TriggerSample } from "../src/daemon/probe/probe-trigger.ts";

type FakeMode = "normal" | "slow" | "status-hang" | "hang";

interface FakeDaemon {
  readonly socketPath: string;
  readonly requests: string[];
  readonly dir: string;
  setMode: (mode: FakeMode) => void;
  close: () => Promise<void>;
}

async function startFakeDaemon(options: { readonly advertiseStack?: boolean } = {}): Promise<FakeDaemon> {
  const dir = mkdtempSync(path.join(process.platform === "win32" ? tmpdir() : "/tmp", "ha-probe-socket-")),
    socketPath = path.join(dir, "daemon.sock"),
    requests: string[] = [],
    state = { mode: "normal" as FakeMode },
    sockets = new Set<net.Socket>(),
    advertised = [
      "protocol.hello",
      "daemon.status",
      ...(options.advertiseStack === true ? ["daemon.diagnostics.stack"] : []),
    ];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line.trim() === "") continue;
        void answer(
          socket,
          JSON.parse(line) as { readonly id: number; readonly method: string },
          state,
          requests,
          advertised,
        );
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    socketPath,
    requests,
    dir,
    setMode: (mode) => {
      state.mode = mode;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function answer(
  socket: net.Socket,
  request: { readonly id: number; readonly method: string },
  state: { mode: FakeMode },
  requests: string[],
  advertised: readonly string[],
): void {
  requests.push(request.method);
  if (state.mode === "hang") return;
  if (request.method === "protocol.hello") {
    reply(socket, request.id, { ok: true, protocolVersion: currentDaemonProtocolVersion, methods: advertised });
    return;
  }
  if (state.mode === "status-hang") return;
  const delayMs = state.mode === "slow" ? 150 : 0;
  setTimeout(() => {
    if (!socket.destroyed)
      reply(
        socket,
        request.id,
        request.method === "daemon.diagnostics.stack"
          ? { ok: true, frames: ["at main"] }
          : { ok: true, summary: "fake" },
      );
  }, delayMs);
}

function reply(socket: net.Socket, id: number, result: Record<string, unknown>): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const zeroMetrics: ProcessMetrics = {
  pid: 1234,
  cpuPercent: 0,
  rssBytes: 128 * 1024 * 1024,
  threadCount: 8,
  openFileCount: 20,
  source: "proc",
  unavailable: [],
  error: null,
};

test("probe defaults and duration parsing are explicit", () => {
  const parsed = parseProbeArgs(["daemon", "probe"], "/tmp/ha-probe");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.intervalMs, 5_000);
  assert.equal(parsed.value.timeoutMs, 2_000);
  assert.equal(parsed.value.unresponsiveMs, 30_000);
  assert.equal(parsed.value.cpuSustainMs, 60_000);
  assert.equal(parsed.value.rssBytes, 8 * 1024 * 1024 * 1024);
  assert.equal(parsed.value.keptDays, 7);
  assert.equal(parsed.value.jsStackMethod, "daemon.diagnostics.stack");
  assert.equal(parsed.value.captureDir, path.join("/tmp/ha-probe", "logs", "probe-captures"));
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("10m"), 600_000);
  assert.equal(parseDurationMs("2h"), 7_200_000);
  assert.equal(parseDurationMs("0s"), null);
  assert.equal(parseDurationMs("five"), null);
});

test("probe rejects unknown flags and a sub-interval duration", () => {
  const unknown = parseProbeArgs(["daemon", "probe", "--interval", "5s", "--bogus", "x"], "/tmp/ha-probe");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.message, /Unknown option --bogus/u);
  const tooShort = parseProbeArgs(["daemon", "probe", "--duration", "2s"], "/tmp/ha-probe");
  assert.equal(tooShort.ok, false);
  if (!tooShort.ok) assert.match(tooShort.message, /at least one --interval/u);
  const badCpu = parseProbeArgs(["daemon", "probe", "--cpu-percent", "101"], "/tmp/ha-probe");
  assert.equal(badCpu.ok, false);
  const controlMethod = parseProbeArgs(["daemon", "probe", "--js-stack-method", "daemon.stop"], "/tmp/ha-probe");
  assert.equal(controlMethod.ok, false);
  if (!controlMethod.ok) assert.match(controlMethod.message, /read-only diagnostic/u);
});

test("summary accepts a UTC day and rejects an impossible one", () => {
  const day = parseSummaryArgs(["daemon", "probe", "summary", "--day", "20261103"]);
  assert.equal(day.ok, true);
  if (!day.ok) return;
  assert.equal(day.value.sinceMs, Date.parse("2026-11-03T00:00:00.000Z"));
  assert.equal(day.value.untilMs, Date.parse("2026-11-04T00:00:00.000Z"));
  assert.equal(day.value.dayLabel, "20261103");
  const invalid = parseSummaryArgs(["daemon", "probe", "summary", "--day", "2026-02-31"]);
  assert.equal(invalid.ok, false);
  const window = parseSummaryArgs(["daemon", "probe", "summary", "--window", "1h"], 1_000_000);
  assert.equal(window.ok, true);
  if (window.ok) assert.equal(window.value.sinceMs, 1_000_000 - 3_600_000);
  const until = parseSummaryArgs([
    "daemon",
    "probe",
    "summary",
    "--day",
    "20261103",
    "--until",
    "2026-11-03T15:20:00Z",
  ]);
  assert.equal(until.ok, true);
  if (until.ok) {
    assert.equal(until.value.sinceMs, Date.parse("2026-11-03T00:00:00.000Z"));
    assert.equal(until.value.untilMs, Date.parse("2026-11-03T15:20:00.000Z"));
  }
  const beforeDay = parseSummaryArgs([
    "daemon",
    "probe",
    "summary",
    "--day",
    "20261103",
    "--until",
    "2026-11-02T23:00:00Z",
  ]);
  assert.equal(beforeDay.ok, false);
});

test("process counter parsers keep unavailable fields null", () => {
  const stat = parseProcStat(
    "42 (daemon worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25\n",
  );
  assert.equal(stat.utimeTicks, 11);
  assert.equal(stat.stimeTicks, 12);
  assert.equal(stat.startTicks, 19);
  assert.equal(stat.rssPages, 21);
  const status = parseProcStatus("Name:\tdaemon\nVmRSS:\t 1024 kB\nThreads:\t17\n");
  assert.equal(status.rssBytes, 1024 * 1024);
  assert.equal(status.threadCount, 17);
  assert.deepEqual(parseProcStatus("Name:\tdaemon\n"), { rssBytes: null, threadCount: null });
  assert.deepEqual(parseDarwinPs(" 1.5 2048\n"), { cpuPercent: 1.5, rssBytes: 2048 * 1024 });
  assert.deepEqual(parseDarwinPs(""), { cpuPercent: null, rssBytes: null });
  assert.equal(parseDarwinThreadCount("USER PID TT STATE\nroot 1 s 0\nroot 1 s 1\n"), 2);
  assert.equal(parseDarwinThreadCount("USER PID TT STATE\n"), null);
  assert.equal(parseLsofFileCount("p42\nfcwd\nn/tmp\nf1\nn/var/log\n"), 2);
  assert.equal(parseLsofFileCount(""), null);
});

test("linux CPU percent is a full-core ratio over elapsed seconds", async () => {
  let at = 0,
    ticks = 0;
  const reader = createProcessMetricsReader({
    platform: "linux",
    now: () => at,
    clockTicksPerSecond: 100,
    readFileText: async (file) => {
      if (file.endsWith("/status")) return "VmRSS:\t100 kB\nThreads:\t1\n";
      const fields = Array(22).fill("0");
      fields[11] = String(ticks);
      return `1 (daemon) ${fields.join(" ")}`;
    },
    readDirNames: async () => [],
  });
  assert.equal((await reader.read(1)).cpuPercent, null);
  at = 1_000;
  ticks = 100;
  assert.equal((await reader.read(1)).cpuPercent, 100);
  const tracker = createTriggerTracker({
    unresponsiveMs: 10_000,
    cpuPercent: 90,
    cpuSustainMs: 1_000,
    rssBytes: 1_000_000,
    cooldownMs: 0,
  });
  assert.equal(tracker.evaluate({ at: 0, state: "up", cpuPercent: null, rssBytes: 0 }), null);
  assert.equal(tracker.evaluate({ at: 1_000, state: "up", cpuPercent: 100, rssBytes: 0 }), null);
  assert.equal(tracker.evaluate({ at: 2_000, state: "up", cpuPercent: 100, rssBytes: 0 }), "high-cpu");
});

test("ping classifies a normal, slow, and unresponsive daemon", async (t) => {
  const fake = await startFakeDaemon();
  t.after(async () => fake.close());
  const up = await pingDaemon(fake.socketPath, 1_000, 500);
  assert.equal(up.state, "up");
  assert.equal(up.helloOk, true);
  assert.equal(up.statusOk, true);
  assert.ok(up.latencyMs < 500);
  fake.setMode("slow");
  const slow = await pingDaemon(fake.socketPath, 1_000, 50);
  assert.equal(slow.state, "slow");
  assert.equal(slow.statusOk, true);
  assert.ok((slow.statusMs ?? 0) >= 100);
  fake.setMode("hang");
  const down = await pingDaemon(fake.socketPath, 120, 500);
  assert.equal(down.state, "down");
  assert.equal(down.helloOk, false);
  assert.equal(down.statusOk, false);
});

test("hello can succeed while status hangs; that is still down", async (t) => {
  const fake = await startFakeDaemon();
  t.after(async () => fake.close());
  fake.setMode("status-hang");
  const result = await pingDaemon(fake.socketPath, 120, 500);
  assert.equal(result.state, "down");
  assert.equal(result.helloOk, true);
  assert.equal(result.statusOk, false);
});

test("trigger fires once per event, disarms on recovery, and honors cooldown", () => {
  const tracker = createTriggerTracker({
    unresponsiveMs: 300,
    cpuPercent: 90,
    cpuSustainMs: 60_000,
    rssBytes: 1_000,
    cooldownMs: 600_000,
  });
  const down = (at: number): TriggerSample => ({ at, state: "down", cpuPercent: 0, rssBytes: 0 });
  const up = (at: number): TriggerSample => ({ at, state: "up", cpuPercent: 0, rssBytes: 0 });
  assert.equal(tracker.evaluate(down(0)), null);
  assert.equal(tracker.evaluate(down(100)), null);
  assert.equal(tracker.evaluate(down(300)), "unresponsive");
  assert.equal(tracker.evaluate(down(400)), null);
  assert.equal(tracker.evaluate(down(900)), null);
  assert.equal(tracker.evaluate(up(1_000)), null);
  assert.equal(tracker.evaluate(down(1_100)), null);
  assert.equal(tracker.evaluate(down(1_400)), null, "a new event inside the cooldown is suppressed");
  assert.equal(tracker.evaluate(down(1_500)), null);
  assert.equal(tracker.evaluate(up(1_600)), null);
  assert.equal(tracker.evaluate(down(1_700)), null);
  assert.equal(tracker.evaluate(down(2_000)), null);
  assert.equal(tracker.evaluate(up(2_100)), null);
  assert.equal(tracker.evaluate(down(601_700)), null);
  assert.equal(tracker.evaluate(down(602_000)), "unresponsive");
  const cpu = createTriggerTracker({
    unresponsiveMs: 10_000,
    cpuPercent: 90,
    cpuSustainMs: 60_000,
    rssBytes: 1_000,
    cooldownMs: 0,
  });
  for (let at = 0; at <= 60_000; at += 15_000)
    assert.equal(cpu.evaluate({ at, state: "up", cpuPercent: 95, rssBytes: 0 }), at === 60_000 ? "high-cpu" : null);
  const rss = createTriggerTracker({
    unresponsiveMs: 10_000,
    cpuPercent: 90,
    cpuSustainMs: 60_000,
    rssBytes: 1_000,
    cooldownMs: 0,
  });
  assert.equal(rss.evaluate({ at: 0, state: "up", cpuPercent: 0, rssBytes: 2_000 }), "rss");
  assert.equal(rss.evaluate({ at: 1, state: "up", cpuPercent: 0, rssBytes: 2_000 }), null);
});

test("one sustained multi-signal event captures exactly once", () => {
  const tracker = createTriggerTracker({
    unresponsiveMs: 30_000,
    cpuPercent: 90,
    cpuSustainMs: 60_000,
    rssBytes: 100,
    cooldownMs: 600_000,
  });
  const combined = (at: number): TriggerSample => ({ at, state: "down", cpuPercent: 95, rssBytes: 200 });
  assert.equal(tracker.evaluate(combined(0)), "rss");
  for (const at of [30_000, 35_000, 60_000, 65_000]) assert.equal(tracker.evaluate(combined(at)), null);
  assert.equal(tracker.evaluate({ at: 700_000, state: "up", cpuPercent: 0, rssBytes: 0 }), null);
  assert.equal(tracker.evaluate(combined(700_001)), "rss");
});

test("unresponsive loop captures one scene and writes a capture record", async (t) => {
  const fake = await startFakeDaemon();
  const dir = mkdtempSync(path.join(tmpdir(), "ha-probe-loop-"));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  fake.setMode("hang");
  let clock = 0;
  const writer = createTimelineWriter({
    dir: path.join(dir, "logs"),
    daemonId: "default",
    keptDays: 7,
    now: () => new Date(clock),
  });
  const captures: CaptureRequest[] = [];
  const result = await runProbeLoop(
    {
      socketPath: fake.socketPath,
      timeoutMs: 100,
      slowMs: 500,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      readPid: () => 1234,
      readMetrics: async () => zeroMetrics,
      writer,
      capture: {
        capture: async (request) => {
          captures.push(request);
          return {
            files: [path.join(request.dir, "scene.sample.txt")],
            errors: [],
            jsStack: { method: request.jsStackMethod, status: "not-advertised", file: null, detail: null },
          };
        },
      },
      jsStackMethod: "daemon.diagnostics.stack",
      sampleSeconds: 5,
      shouldStop: () => false,
    },
    {
      intervalMs: 100,
      iterations: 8,
      durationMs: null,
      unresponsiveMs: 300,
      cpuPercent: 90,
      cpuSustainMs: 60_000,
      rssBytes: 8 * 1024 * 1024 * 1024,
      cooldownMs: 600_000,
      captureDir: path.join(dir, "captures"),
    },
  );
  await writer.close();
  assert.equal(result.samples, 8);
  assert.equal(result.down, 8);
  assert.equal(result.captures, 1);
  assert.equal(captures.length, 1);
  assert.equal(captures[0]!.reason, "unresponsive");
  assert.equal(result.captureFiles.length, 1);
  const records = await collectTimeline(path.join(dir, "logs"));
  assert.equal(records.filter((record) => record.kind === "sample").length, 8);
  assert.equal(records.filter((record) => record.kind === "capture").length, 1);
  assert.equal(records.at(-1)?.kind, "probe_stop");
});

test("takeProbeSample records metrics and tolerates a failing pid read", async (t) => {
  const fake = await startFakeDaemon();
  t.after(async () => fake.close());
  const sample = await takeProbeSample({
    socketPath: fake.socketPath,
    timeoutMs: 1_000,
    slowMs: 500,
    now: () => 0,
    readPid: () => 1234,
    readMetrics: async () => zeroMetrics,
  });
  assert.equal(sample.state, "up");
  assert.equal(sample.pid, 1234);
  assert.equal(sample.threadCount, 8);
  const noPid = await takeProbeSample({
    socketPath: fake.socketPath,
    timeoutMs: 1_000,
    slowMs: 500,
    now: () => 0,
    readPid: () => null,
    readMetrics: async () => ({ ...zeroMetrics, pid: null, unavailable: ["pid"] }),
  });
  assert.equal(noPid.pid, null);
});

test("timeline writer recovers after a transient directory failure", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-probe-recover-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "logs"),
    at = Date.parse("2026-11-03T10:00:00.000Z");
  writeFileSync(dir, "not a directory");
  const writer = createTimelineWriter({ dir, daemonId: "default", keptDays: 7, now: () => new Date(at) });
  await assert.rejects(writer.append({ kind: "sample", at: new Date(at).toISOString(), state: "down" }));
  rmSync(dir);
  mkdirSync(dir);
  await writer.append({ kind: "sample", at: new Date(at).toISOString(), state: "up" });
  await writer.close();
  const records = await collectTimelineRange(dir, "default", at - 1, at + 1);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.state, "up");
});

test("timeline rolls by day and streams only the requested range", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ha-probe-timeline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const day1 = Date.parse("2026-11-03T10:00:00.000Z");
  let now = day1;
  const writer = createTimelineWriter({ dir, daemonId: "default", keptDays: 7, now: () => new Date(now) });
  await writer.append({ kind: "sample", at: new Date(day1).toISOString(), state: "up" });
  now = Date.parse("2026-11-04T10:00:00.000Z");
  await writer.append({ kind: "sample", at: new Date(now).toISOString(), state: "down" });
  await writer.close();
  const first = await collectTimelineRange(dir, "default", day1 - 1, day1 + 86_400_000 - 1);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.state, "up");
  const both = await collectTimelineRange(dir, "default", day1 - 1, now + 1);
  assert.equal(both.length, 2);
});

test("linux capture writes a proc dump and names an unavailable stack", async () => {
  const writes = new Map<string, string>();
  const port = createCapturePort({
    platform: "linux",
    readFileText: async (file) => {
      if (file.endsWith("/stack")) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return file.endsWith("/status") ? "Name:\tdaemon\nThreads:\t9\n" : "0\n";
    },
    writeCaptureFile: async (dir, name, body) => {
      const file = path.join(dir, name);
      writes.set(file, body);
      return file;
    },
    ensureDirectory: async () => undefined,
    jsStackProbe: async (socketPath, method) => ({
      method,
      status: "not-advertised",
      file: null,
      detail: socketPath,
    }),
  });
  const result = await port.capture({
    pid: 42,
    reason: "high-cpu",
    at: Date.parse("2026-11-03T13:00:00.000Z"),
    dir: "/tmp/captures",
    socketPath: "/tmp/captures/daemon.sock",
    jsStackMethod: "daemon.diagnostics.stack",
    jsStackTimeoutMs: 1_000,
    sampleSeconds: 5,
  });
  assert.equal(result.files.length, 1);
  assert.match(result.files[0]!, /20261103T130000000Z-high-cpu\.proc\.txt$/u);
  const body = writes.get(result.files[0]!)!;
  assert.match(body, /## \/proc\/42\/status\nName:\tdaemon/u);
  assert.match(body, /unavailable: EACCES/u);
  assert.equal(result.jsStack.status, "not-advertised");
});

test("darwin capture invokes sample and records its file", async () => {
  const calls: { readonly file: string; readonly args: readonly string[] }[] = [];
  const port = createCapturePort({
    platform: "darwin",
    runCommand: async (file, args) => {
      calls.push({ file, args });
      return { stdout: "", stderr: "", exitCode: 0, error: null };
    },
    writeCaptureFile: async (dir, name) => path.join(dir, name),
    ensureDirectory: async () => undefined,
    jsStackProbe: async (socketPath, method) => ({ method, status: "unreachable", file: null, detail: socketPath }),
  });
  const result = await port.capture({
    pid: 99,
    reason: "unresponsive",
    at: Date.parse("2026-11-03T13:00:00.000Z"),
    dir: "/tmp/captures",
    socketPath: "/tmp/captures/daemon.sock",
    jsStackMethod: "daemon.diagnostics.stack",
    jsStackTimeoutMs: 1_000,
    sampleSeconds: 5,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, "sample");
  assert.deepEqual(calls[0]!.args.slice(0, 3), ["99", "5", "-file"]);
  assert.match(result.files[0]!, /unresponsive\.sample\.txt$/u);
});

test("JS stack is captured only when hello advertises the method", async (t) => {
  const fake = await startFakeDaemon({ advertiseStack: true });
  const dir = mkdtempSync(path.join(tmpdir(), "ha-probe-stack-"));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const captured = await probeJsStack(fake.socketPath, "daemon.diagnostics.stack", 1_000, dir);
  assert.equal(captured.status, "captured");
  assert.ok(captured.file !== null);
  assert.match(readFileSync(captured.file!, "utf8"), /at main/u);
  const missing = await probeJsStack(fake.socketPath, "daemon.other.stack", 1_000, dir);
  assert.equal(missing.status, "failed");
  assert.equal(missing.file, null);
  const control = await probeJsStack(fake.socketPath, "daemon.stop", 1_000, dir);
  assert.equal(control.status, "failed");
  assert.match(control.detail ?? "", /refused non-diagnostic method daemon\.stop/u);
});

test("JS stack probe reports unreachable when hello times out", async (t) => {
  const fake = await startFakeDaemon();
  const dir = mkdtempSync(path.join(tmpdir(), "ha-probe-stack-down-"));
  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  fake.setMode("hang");
  const result = await probeJsStack(fake.socketPath, "daemon.diagnostics.stack", 100, dir);
  assert.equal(result.status, "unreachable");
});

async function collectTimeline(dir: string): Promise<readonly Record<string, unknown>[]> {
  return collectTimelineRange(dir, "default", 0, Date.parse("2030-01-01T00:00:00.000Z"));
}

async function collectTimelineRange(
  dir: string,
  daemonId: string,
  sinceMs: number,
  untilMs: number,
): Promise<readonly Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for await (const record of readProbeTimeline({ dir, daemonId, sinceMs, untilMs }))
    records.push(record as Record<string, unknown>);
  return records;
}
