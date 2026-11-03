#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readTrafficLogs, extractTrafficModel } from "./center-model.mjs";

export function defaultTrafficModel() {
  // Calibration only. A measured baseline must supply a model extracted from connection logs.
  const records = [];
  for (let index = 0; index < 20; index++) {
    const method = index % 10 === 1 ? "repo.task.run" : index % 2 ? "observe.tail" : "repo.agentRuntime.overview";
    for (const [offset, name, command] of [
      [0, "protocol.hello", "protocol.hello"],
      [1, method, method === "repo.task.run" ? "fact-record" : method],
    ]) {
      records.push({
        schema: "daemon-conn-log/v1",
        event: "request",
        at: new Date(index * 500 + offset).toISOString(),
        method: name,
        command,
        conn: String(index),
        pid: 1,
      });
    }
  }
  return extractTrafficModel(records);
}

export function markdownReport(report) {
  const lines = [
    "# Center benchmark",
    "",
    `Source: ${JSON.stringify(report.source)}`,
    "",
    `Synthetic ledger: ${report.ledger.generatedEvents} events, ${report.ledger.documents} documents, ${report.ledger.jsonBytes} JSON bytes.`,
    `Attach: ${report.attachMs.toFixed(1)} ms.`,
    "",
    "| Nodes | Connected | Read p50 ms | Read p99 ms | Write p50 ms | Write p99 ms | Errors | Unavailable ms |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of report.capacity)
    lines.push(
      `| ${row.nodes} | ${row.replication.recovered} | ${row.read.p50Ms} | ${row.read.p99Ms} | ${row.write.p50Ms} | ${row.write.p99Ms} | ${row.errorRate} | ${row.unavailableMs} |`,
    );
  lines.push("", "## Fault observations", "");
  for (const row of report.faults)
    lines.push(`- ${row.scenario}: ${JSON.stringify(row.observations)}; unavailable ${row.unavailableMs} ms.`);
  lines.push("", "## Limits", "", ...report.limitations.map((line) => `- ${line}`));
  return lines.join("\n") + "\n";
}

export async function runCenterBenchmark({
  nodes = [1, 10, 100, 500, 1000],
  scale = 0.001,
  seed = "20261103",
  durationMs = 10_000,
  model = defaultTrafficModel(),
  bindings = {},
  scenarios,
  track,
  onProgress = () => undefined,
} = {}) {
  if (!nodes.length || nodes.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 1000))
    throw new Error("nodes must be integers from 1 to 1000");
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 600_000)
    throw new Error("duration-ms must be >0 and <=600000");
  const [{ createCenterFixture }, { replayTraffic }, campaign] = await Promise.all([
    import("./center-fixture.mjs"),
    import("./center-replay.mjs"),
    import("./center-campaign.mjs"),
  ]);
  const fixture = await createCenterFixture({ nodes: Math.max(...nodes), scale, seed, track, onProgress });
  const report = {
    schema: "center-bench/v1",
    source: {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
      }).trim(),
      base: process.env.FLEET_STRESS_CENTER_BASE ?? null,
      dirty:
        execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
          cwd: path.resolve(import.meta.dirname, "../.."),
          encoding: "utf8",
        }).trim().length > 0,
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
    },
    seed,
    scale,
    durationMs,
    model: { methods: model.methods, classes: model.classes, rate: model.rate },
    ledger: fixture.ledger,
    attachMs: fixture.attachMs,
    attachSamples: fixture.attachSamples,
    capacity: [],
    faults: [],
    limitations: [
      "Synthetic replica ACKs do not persist or project: this measures center-side cost, not real edge disk recovery.",
      "Warm-edge curves start at the replication head; fresh base-backup admission is measured separately.",
      "A curve point is invalid if required replicas fail to connect or the generator hits its concurrency limit.",
      "Capacity points reuse the same ledger in increasing node order; caches and writes carry forward.",
      "Probe traffic adds four repo.tasks.list(limit=1) requests/s plus hello; measurement IPC adds one sample/s.",
      "Historical #4253 edge binary and the original 37s attach environment are not reconstructed by this run.",
      "Authorization uses the repository Keycloak fixture and one owner with many device sessions; real IAM capacity is not measured.",
    ],
  };
  try {
    for (const count of nodes) {
      onProgress({ phase: "capacity", nodes: count });
      const connected = await campaign.connectReplicas(fixture, count);
      try {
        const row = await campaign.measureCenter(fixture, () =>
          replayTraffic({ model, fixture, nodes: count, durationMs, bindings }),
        );
        report.capacity.push({
          ...row,
          replication: {
            ...connected.report,
            connectedAfter: connected.clients.filter(({ state }) => !state.closed && !state.error).length,
            commitsReceived: connected.clients.reduce((sum, { state }) => sum + state.commits, 0),
            streamErrors: connected.clients.filter(({ state }) => state.error).map(({ state }) => state.error.message),
          },
          valid:
            connected.report.recovered === count &&
            connected.clients.every(({ state }) => !state.closed && !state.error) &&
            !row.errors.generator_concurrency_limit,
        });
        onProgress({ phase: "capacity-result", result: report.capacity.at(-1) });
      } finally {
        for (const replica of connected.clients) replica.close();
      }
    }
    for (const name of scenarios ?? campaign.faultScenarios) {
      onProgress({ phase: "fault", scenario: name });
      try {
        report.faults.push(
          await campaign.runFaultScenario(name, { fixture, model, bindings, nodes: Math.max(...nodes), durationMs }),
        );
      } catch (error) {
        // A product failure in one fault must not discard already measured capacity points.
        report.faults.push({ scenario: name, error: { code: error.code ?? null, message: error.message } });
      }
      onProgress({ phase: "fault-result", result: report.faults.at(-1) });
    }
    return report;
  } finally {
    report.recordedTraffic = await fixture.close();
    for (const row of report.capacity) row.wireObservedMethods = report.recordedTraffic?.tagged[row.traceTag] ?? {};
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      log: { type: "string", multiple: true },
      from: { type: "string" },
      until: { type: "string" },
      out: { type: "string" },
      model: { type: "string" },
      bindings: { type: "string" },
      scale: { type: "string", default: "0.001" },
      nodes: { type: "string", default: "1,10,100,500,1000" },
      scenario: { type: "string", multiple: true },
      seed: { type: "string", default: "20261103" },
      "duration-ms": { type: "string", default: "10000" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "center-bench model --log <conn.jsonl> [--log ...] --out model.json [--from ISO --until ISO]\n" +
        "center-bench run --model model.json --nodes 1,10,100,500,1000 --scale 1 --out report.json [--scenario NAME]\n" +
        "center-bench generate --scale 1 --seed 20261103 --out <new-repository-directory>\n" +
        "Run campaigns only via the isolated test entry; see tools/scale/CENTER-BENCH.md.",
    );
    return;
  }
  if (!values.out) throw new Error("--out is required");
  if (positionals[0] === "model") {
    if (!values.log?.length) throw new Error("--log is required");
    const model = await readTrafficLogs(values.log, {
      ...(values.from ? { from: Date.parse(values.from) } : {}),
      ...(values.until ? { until: Date.parse(values.until) } : {}),
    });
    writeFileSync(values.out, JSON.stringify(model, null, 2) + "\n");
    console.log(JSON.stringify({ methods: model.methods, classes: model.classes, rate: model.rate }));
  } else if (positionals[0] === "generate") {
    if (process.env.FLEET_STRESS_CENTER_ISOLATED !== "1")
      throw new Error("generate requires an isolated benchmark environment");
    const { initializeSyntheticLedger } = await import("./center-ledger.mjs");
    console.log(
      JSON.stringify(await initializeSyntheticLedger(values.out, { scale: Number(values.scale), seed: values.seed })),
    );
  } else if (positionals[0] === "run") {
    if (process.env.FLEET_STRESS_CENTER_ISOLATED !== "1")
      throw new Error("run requires the isolated campaign entry (FLEET_STRESS_CENTER_ISOLATED=1)");
    const model = values.model ? JSON.parse(readFileSync(values.model, "utf8")) : defaultTrafficModel();
    const report = await runCenterBenchmark({
      model,
      bindings: values.bindings ? JSON.parse(readFileSync(values.bindings, "utf8")) : {},
      nodes: values.nodes.split(",").map(Number),
      scale: Number(values.scale),
      seed: values.seed,
      durationMs: Number(values["duration-ms"]),
      scenarios: values.scenario,
      onProgress: (row) => console.error(JSON.stringify(row)),
    });
    writeFileSync(values.out, JSON.stringify(report, null, 2) + "\n");
    writeFileSync(values.out + ".md", markdownReport(report));
  } else throw new Error("expected model or run");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
