#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { catalog, selectScenarios } from "./gui-e2e/catalog.mjs";
import { withStdoutReservedForJson } from "./gui-e2e/emit-json.mjs";
import { prepareE2EProbeGui, recordE2EProbeFailure } from "./e2e-probe.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

export async function runGuiE2E(options = {}) {
  const [{ startGuiDriver, runScenario }, { openLane }] = await Promise.all([
    import("./gui-e2e/driver.mjs"),
    import("./gui-e2e/lanes.mjs"),
  ]);
  const runId = `gui-e2e-${new Date().toISOString().replaceAll(/[^0-9A-Za-z]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const outputRoot = options.shots ? path.resolve(options.shots) : path.join(workspaceRoot, ".harness/gui-e2e");
  const runRoot = path.join(outputRoot, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  if (!options.noBuild) prepareE2EProbeGui(workspaceRoot, process.env);
  const selected = selectScenarios({ lane: options.lane, ids: options.scenarios });
  const lanes = [
    ...new Set(
      selected.flatMap((scenario) => (scenario.lane === "both" ? ["canonical", "isolated"] : [scenario.lane])),
    ),
  ].filter((lane) => options.lane === "all" || options.lane === lane);
  const results = [];
  for (const lane of lanes) {
    const laneRoot = path.join(runRoot, lane);
    mkdirSync(laneRoot, { recursive: true, mode: 0o700 });
    const active = await openLane({
      lane,
      workspaceRoot,
      env: process.env,
      runRoot: laneRoot,
      startDriver: startGuiDriver,
    });
    try {
      for (const scenario of selected.filter((item) => item.lane === lane || item.lane === "both")) {
        results.push(await runScenario(active.driver, { ...scenario, lane }, { shots: options.shots }));
      }
    } finally {
      await active.close();
    }
  }
  const failed = results.find((result) => result.outcome === "failed");
  const result = {
    schema: "gui-e2e-result/v1",
    outcome: failed ? "failed" : "healthy",
    runId,
    lanes,
    scenarios: results,
    failureSignature: failed ? signature(failed) : null,
    taskId: null,
    deduplicated: null,
  };
  if (failed)
    writeFileSync(path.join(runRoot, "failure.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return { result, runRoot };
}

function signature(failure) {
  return createHash("sha256")
    .update(`${failure.id}\0${failure.failedStep}\0${failure.message}`)
    .digest("hex")
    .slice(0, 20);
}

function parseArgs(argv) {
  const options = { agentRun: false, lane: "all", noBuild: false, scenarios: [], shots: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent-run") options.agentRun = true;
    else if (arg === "--no-build") options.noBuild = true;
    else if (arg === "--lane") options.lane = argv[++index];
    else if (arg === "--scenario") options.scenarios.push(argv[++index]);
    else if (arg === "--shots") options.shots = argv[++index];
    else if (arg === "--list") options.list = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!["canonical", "isolated", "all"].includes(options.lane)) throw new Error(`Invalid lane: ${options.lane}`);
  const known = new Set(catalog.map((scenario) => scenario.id));
  for (const id of options.scenarios) if (!known.has(id)) throw new Error(`Unknown scenario: ${id}`);
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.list) return { schema: "gui-e2e-catalog/v1", scenarios: catalog.map(({ run: _run, ...entry }) => entry) };
  const { result, runRoot } = await runGuiE2E(options);
  if (options.agentRun && result.outcome === "failed") {
    const first = result.scenarios.find((scenario) => scenario.outcome === "failed");
    const compatibleBundle = path.join(runRoot, "probe-failure.json");
    writeFileSync(
      compatibleBundle,
      `${JSON.stringify(
        {
          schema: "e2e-probe-journey/v1",
          outcome: "failed",
          runId: result.runId,
          startedAt: new Date(Date.now() - (first?.durationMs ?? 0)).toISOString(),
          failedStep: first?.failedStep,
          message: first?.message,
          failureSignature: result.failureSignature,
        },
        null,
        2,
      )}\n`,
    );
    const closure = await recordE2EProbeFailure({ bundlePath: compatibleBundle });
    result.taskId = closure.taskId;
    result.deduplicated = closure.deduplicated;
  }
  if (result.outcome === "failed") process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void withStdoutReservedForJson(
    () => main(process.argv.slice(2)),
    (error) => ({
      schema: "gui-e2e-result/v1",
      outcome: "failed",
      runId: null,
      lanes: [],
      scenarios: [],
      message: error instanceof Error ? error.message : String(error),
    }),
  );
