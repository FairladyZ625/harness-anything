#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { catalog, selectScenarios, SMOKE_SCENARIO_IDS } from "./gui-e2e/catalog.mjs";
import { withStdoutReservedForJson } from "./gui-e2e/emit-json.mjs";
import { buildProbeFailureBundle, prepareE2EProbeGui, recordE2EProbeFailure } from "./e2e-probe-support.mjs";

const workspaceRoot = path.resolve(import.meta.dirname, "..");

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function existingFailureArtifact(scenarioRoot, scenarioId, suffix) {
  const candidate = path.join(scenarioRoot, `${scenarioId}-${suffix}`);
  return existsSync(candidate) ? candidate : null;
}

export async function runGuiE2E(options = {}) {
  const [{ startGuiDriver, runScenario }, { createLaneSessionPool }] = await Promise.all([
    import("./gui-e2e/driver.mjs"),
    import("./gui-e2e/session-pool.mjs"),
  ]);
  const runId = `gui-e2e-${new Date().toISOString().replaceAll(/[^0-9A-Za-z]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const outputRoot = options.shots ? path.resolve(options.shots) : path.join(workspaceRoot, ".harness/gui-e2e");
  const runRoot = path.join(outputRoot, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  if (!options.noBuild) prepareE2EProbeGui(workspaceRoot, process.env);
  const requestedLane = options.lane ?? (options.smoke ? "isolated" : "all");
  const selected =
    options.selectedScenarios ??
    selectScenarios({ lane: requestedLane, ids: options.scenarios ?? [], smoke: options.smoke });
  const lanes = [
    ...new Set(
      selected.flatMap((scenario) => (scenario.lane === "both" ? ["canonical", "isolated"] : [scenario.lane])),
    ),
  ].filter((lane) => requestedLane === "all" || requestedLane === lane);
  const results = [];
  for (const lane of lanes) {
    const laneRoot = path.join(runRoot, lane);
    mkdirSync(laneRoot, { recursive: true, mode: 0o700 });
    const createPool = options.createPool ?? createLaneSessionPool;
    const pool = createPool({
      lane,
      workspaceRoot,
      env: process.env,
      startDriver: options.startDriver ?? startGuiDriver,
      ...(options.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: options.acquireTimeoutMs }),
      ...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
    });
    try {
      for (const scenario of selected.filter((item) => item.lane === lane || item.lane === "both")) {
        // Read-only scenarios share one lane-scoped hermetic fixture daemon + hidden Electron
        // with per-scenario storage/route resets and crash self-healing; write-state scenarios
        // still own their isolated daemon/repo directory.
        const scenarioRoot = path.join(laneRoot, scenario.id);
        mkdirSync(scenarioRoot, { recursive: true, mode: 0o700 });
        const setupStartedAt = Date.now();
        let setupMs = 0;
        let lease = null;
        let result = null;
        try {
          lease = await pool.acquire(scenario, scenarioRoot);
          setupMs = Date.now() - setupStartedAt;
          result = await runScenario(
            lease.driver,
            { ...scenario, lane },
            {
              shots: options.shots,
              trace: options.trace ?? true,
              prepare: lease.prepare,
              injectFault: options.injectFault,
              ...(options.scenarioTimeoutMs === undefined ? {} : { scenarioTimeoutMs: options.scenarioTimeoutMs }),
              ...(options.cleanupTimeoutMs === undefined ? {} : { cleanupTimeoutMs: options.cleanupTimeoutMs }),
            },
          );
        } catch (error) {
          if (setupMs === 0) setupMs = Date.now() - setupStartedAt;
          result = {
            id: scenario.id,
            feature: scenario.feature,
            lane,
            outcome: "failed",
            durationMs: Date.now() - setupStartedAt,
            failedStep: scenario.id,
            message: failureMessage(error),
            screenshotPath: existingFailureArtifact(scenarioRoot, scenario.id, "failure.png"),
            tracePath: existingFailureArtifact(scenarioRoot, scenario.id, "trace.zip"),
            ipcTracePath: existingFailureArtifact(scenarioRoot, scenario.id, "ipc-trace.json"),
          };
        } finally {
          const teardownStartedAt = Date.now();
          if (lease) {
            try {
              await lease.release({ outcome: result?.outcome ?? "failed" });
            } catch (releaseError) {
              const releaseMsg = failureMessage(releaseError);
              if (!result) {
                result = {
                  id: scenario.id,
                  feature: scenario.feature,
                  lane,
                  outcome: "failed",
                  durationMs: Date.now() - setupStartedAt,
                  failedStep: scenario.id,
                  message: releaseMsg,
                  screenshotPath: existingFailureArtifact(scenarioRoot, scenario.id, "failure.png"),
                  tracePath: existingFailureArtifact(scenarioRoot, scenario.id, "trace.zip"),
                  ipcTracePath: existingFailureArtifact(scenarioRoot, scenario.id, "ipc-trace.json"),
                };
              } else if (result.outcome !== "failed") {
                result.outcome = "failed";
                result.failedStep = scenario.id;
                result.message = releaseMsg;
              } else {
                result.message = `${result.message}; release: ${releaseMsg}`;
              }
            }
          }
          if (result) {
            result.setupMs = setupMs;
            result.teardownMs = Date.now() - teardownStartedAt;
            results.push(result);
          }
        }
      }
    } finally {
      await pool.close().catch(() => undefined);
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
  // Persisted for every run, healthy or failed: the nightly schedule reports per-scenario
  // timings from this file instead of relying on the runner capturing stdout.
  writeFileSync(path.join(runRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
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

export function parseArgs(argv) {
  const options = { agentRun: false, lane: null, noBuild: false, scenarios: [], shots: null, smoke: false };
  let laneExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--agent-run") options.agentRun = true;
    else if (arg === "--no-build") options.noBuild = true;
    else if (arg === "--smoke") options.smoke = true;
    else if (arg === "--lane") {
      laneExplicit = true;
      options.lane = argv[++index];
    } else if (arg === "--scenario") options.scenarios.push(argv[++index]);
    else if (arg === "--shots") options.shots = argv[++index];
    else if (arg === "--list") options.list = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  options.lane ??= options.smoke ? "isolated" : "all";
  if (!["canonical", "isolated", "all"].includes(options.lane)) throw new Error(`Invalid lane: ${options.lane}`);
  if (options.smoke && laneExplicit && options.lane !== "isolated") {
    throw new Error("--smoke only supports --lane isolated");
  }
  if (options.smoke && options.scenarios.length > 0) {
    throw new Error("--smoke cannot be combined with --scenario");
  }
  const known = new Set(catalog.map((scenario) => scenario.id));
  for (const id of options.scenarios) if (!known.has(id)) throw new Error(`Unknown scenario: ${id}`);
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.list)
    return {
      schema: "gui-e2e-catalog/v1",
      smokeScenarios: SMOKE_SCENARIO_IDS,
      scenarios: catalog.map(({ run: _run, ...entry }) => entry),
    };
  const { result, runRoot } = await runGuiE2E(options);
  if (options.agentRun && result.outcome === "failed") {
    const first = result.scenarios.find((scenario) => scenario.outcome === "failed");
    const compatibleBundle = path.join(runRoot, "probe-failure.json");
    writeFileSync(compatibleBundle, `${JSON.stringify(buildProbeFailureBundle(result, first), null, 2)}\n`);
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
