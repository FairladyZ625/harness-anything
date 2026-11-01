#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

export function buildProbeFailureBundle(result, scenario, now = Date.now()) {
  return {
    schema: "e2e-probe-journey/v1",
    outcome: "failed",
    runId: result.runId,
    startedAt: new Date(now - (scenario?.durationMs ?? 0)).toISOString(),
    scenarioId: scenario?.id,
    lane: scenario?.lane,
    failedStep: scenario?.failedStep,
    message: scenario?.message,
    screenshotPath: scenario?.screenshotPath ?? null,
    failureSignature: result.failureSignature,
  };
}

export function prepareE2EProbeGui(rootDir = repositoryRoot, env = process.env) {
  const guiRoot = path.join(rootDir, "packages", "gui"),
    vite = path.join(rootDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) throw probeError("gui_dependencies_missing", `Missing ${vite}; run npm install first.`);
  for (const config of ["vite.config.ts", "vite.preload.config.ts"])
    try {
      execFileSync(process.execPath, [vite, "build", "--config", config], {
        cwd: guiRoot,
        env,
        encoding: "utf8",
        stdio: "pipe",
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      const detail = typeof error?.stderr === "string" ? error.stderr.trim() : String(error);
      throw probeError("gui_build_failed", `${config}: ${detail}`);
    }
}

export function resolveE2EProbeElectronForTest(rootDir = repositoryRoot, env = process.env) {
  const packageRoot = path.join(rootDir, "node_modules", "electron"),
    marker = path.join(packageRoot, "path.txt");
  if (!existsSync(marker))
    return unavailableElectronTestRuntime("The Electron binary is not installed in this environment.", env);
  if (process.platform === "linux" && !env.DISPLAY)
    return unavailableElectronTestRuntime(
      "The canonical GUI journey requires an existing DISPLAY and is skipped in headless environments.",
      env,
    );
  return { available: true, reason: null, env, close: () => undefined };
}

function unavailableElectronTestRuntime(reason, env) {
  return { available: false, reason, env, close: () => undefined };
}

export async function recordE2EProbeFailure({
  rootDir = repositoryRoot,
  workspaceRoot = repositoryRoot,
  bundlePath,
  env = process.env,
  now = () => new Date().toISOString(),
  runCli = runCliJson,
} = {}) {
  const journey = readFailureBundle(bundlePath),
    updatedAfter = new Date(Date.parse(now()) - 24 * 60 * 60 * 1_000).toISOString(),
    title = `E2E probe failure [${journey.failureSignature}]`,
    screenshotPath =
      typeof journey.screenshotPath === "string" ? path.resolve(workspaceRoot, journey.screenshotPath) : null,
    screenshotDestination =
      screenshotPath !== null && existsSync(screenshotPath)
        ? probeScreenshotArtifactDestination(journey.runId, screenshotPath)
        : null,
    existing = cliRows(
      await runCli(workspaceRoot, rootDir, ["task", "list", "--search", title, "--updated-after", updatedAfter], env),
    )[0];
  const attachScreenshot = async (taskId) => {
    if (screenshotDestination === null || screenshotPath === null) return;
    await runCli(
      workspaceRoot,
      rootDir,
      ["task", "artifact", "add", taskId, "--source", screenshotPath, "--destination", screenshotDestination],
      env,
    );
  };
  // The closure runs as agent:e2e-probe — the task creator — so it can attach the probe's own
  // first-triage evidence to the task it opened. The schedule-bound runtime doing the deeper
  // diagnosis stays bound to its dispatch and cannot write here; its findings live in the
  // schedule receipt. A failed fact write must never mask the task-closure result.
  const recordFailureFact = async (taskId) => {
    try {
      await runCli(
        workspaceRoot,
        rootDir,
        [
          "fact",
          "record",
          "--task",
          taskId,
          "--statement",
          `E2E probe failure ${journey.failureSignature}: step ${journey.failedStep ?? "unknown"} ` +
            `failed with ${String(journey.message ?? "").slice(0, 400)} ` +
            `(run ${journey.runId}, deduped=${Boolean(existing)}).`,
          "--source",
          bundlePath,
          "--confidence",
          "high",
        ],
        env,
      );
      return { factRecorded: true, factError: null };
    } catch (error) {
      return { factRecorded: false, factError: error instanceof Error ? error.message : String(error) };
    }
  };
  if (existing) {
    const taskId = String(existing.taskId);
    await attachScreenshot(taskId);
    return {
      schema: "e2e-probe-result/v1",
      outcome: "failed",
      runId: journey.runId,
      failureSignature: journey.failureSignature,
      taskId,
      deduplicated: true,
      ...(await recordFailureFact(taskId)),
    };
  }
  const planFile = path.join(rootDir, ".harness", "e2e-probe", `task-plan-${randomUUID()}.md`);
  mkdirSync(path.dirname(planFile), { recursive: true });
  writeFileSync(planFile, probeFailureTaskPlan(journey, screenshotDestination, path.basename(bundlePath)), {
    encoding: "utf8",
    mode: 0o600,
  });
  let created;
  try {
    created = await runCli(
      workspaceRoot,
      rootDir,
      [
        "task",
        "create",
        "--title",
        title,
        "--idempotency-key",
        `e2e-probe:${journey.failureSignature}:${journey.startedAt}`,
        "--kind",
        "fix",
        "--risk-tier",
        "medium",
        "--urgency",
        "high",
        "--surface",
        "tools/e2e-probe.mjs",
        "--surface",
        "packages/gui",
        "--plan-file",
        path.relative(rootDir, planFile),
      ],
      env,
    );
  } finally {
    rmSync(planFile, { force: true });
  }
  const taskId = requiredText(created.taskId, "taskId"),
    destination = `artifacts/e2e-probe/${path.basename(bundlePath)}`;
  await runCli(
    workspaceRoot,
    rootDir,
    ["task", "artifact", "add", taskId, "--source", bundlePath, "--destination", destination],
    env,
  );
  await attachScreenshot(taskId);
  return {
    schema: "e2e-probe-result/v1",
    outcome: "failed",
    runId: journey.runId,
    failureSignature: journey.failureSignature,
    taskId,
    deduplicated: false,
    ...(await recordFailureFact(taskId)),
  };
}

function probeScreenshotArtifactDestination(runId, screenshotPath) {
  const safeSegment = (value) => value.replaceAll(/[^0-9A-Za-z._-]+/gu, "-").replaceAll(/^-+|-+$/gu, "");
  return `artifacts/e2e-probe/${safeSegment(runId) || "run"}-${safeSegment(path.basename(screenshotPath)) || "failure.png"}`;
}

function probeFailureTaskPlan(journey, screenshotDestination, bundleName) {
  const scenarioId =
      typeof journey.scenarioId === "string" && journey.scenarioId
        ? journey.scenarioId
        : (journey.failedStep ?? "unknown"),
    failureMessage = String(journey.message ?? "No failure message was recorded."),
    screenshotDescription =
      screenshotDestination !== null
        ? `Screenshot artifact: ${markdownCodeSpan(screenshotDestination)}.`
        : typeof journey.screenshotPath === "string"
          ? `Runner screenshot path: ${markdownCodeSpan(journey.screenshotPath)}. The image was unavailable when the task was created.`
          : "The runner did not produce a screenshot.",
    markdownFence = "`".repeat(Math.max(3, longestRunOfBackticks(failureMessage) + 1));
  return [
    `# E2E probe failure [${journey.failureSignature}]`,
    "",
    "Task Contract: harness-task v1",
    "",
    "## Brief",
    "",
    `E2E scenario ${markdownCodeSpan(scenarioId)} failed in run ${markdownCodeSpan(journey.runId)}.`,
    "",
    "Failure message:",
    `${markdownFence}text`,
    failureMessage,
    markdownFence,
    "",
    screenshotDescription,
    "",
    "## Goal",
    "",
    "Determine whether this failure is a product regression or an outdated scenario, then implement the smallest correction supported by the current contract.",
    "",
    "## Context",
    "",
    `The original result is attached as ${markdownCodeSpan(`artifacts/e2e-probe/${bundleName}`)}. Reproduce the named scenario before changing behavior.`,
    "",
    "## Required Reading",
    "",
    `Read the ${markdownCodeSpan(scenarioId)} scenario and the production contract it exercises.`,
    "",
    "## Entry Conditions",
    "",
    "Use the attached run result and current repository state as the reproduction evidence.",
    "",
    "## Dependencies",
    "",
    "No prerequisite task is required.",
    "",
    "## Execution Surface",
    "",
    "Keep implementation and verification within the scenario's owning product and test paths.",
    "",
    "## Constraints",
    "",
    "Keep scenario expectations aligned with the accepted product design; do not weaken a failing assertion without evidence that the contract changed.",
    "",
    "## Checkpoint",
    "",
    "If the current product contract contradicts the scenario, record that evidence and update only the stale expectation.",
    "",
    "## Implementation Plan",
    "",
    "Reproduce the failure headlessly, trace it to the owning contract, make the smallest correction, and rerun the scenario plus affected tests.",
    "",
    "## Deliverable Contract",
    "",
    "Deliver the correction, focused regression evidence, and a task closeout with changed paths and residual risk.",
    "",
    "## Evidence Protocol",
    "",
    "Record the exact scenario command and its JSON result; distinguish observed output from inferred cause.",
    "",
    "## Verification",
    "",
    `Run the headless ${markdownCodeSpan(scenarioId)} scenario and every affected test file; require all assertions to pass.`,
    "",
  ].join("\n");
}

function longestRunOfBackticks(value) {
  return Math.max(0, ...[...value.matchAll(/`+/gu)].map(([run]) => run.length));
}

function markdownCodeSpan(value) {
  const text = String(value),
    fence = "`".repeat(longestRunOfBackticks(text) + 1),
    padding = /^\s|\s$/u.test(text) ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

export async function warmDaemonProjection({
  rootDir = repositoryRoot,
  workspaceRoot = repositoryRoot,
  env = process.env,
  attempts = 30,
  delayMs = 1_000,
  readProjection = () => runCliJson(workspaceRoot, rootDir, ["task", "list"], env),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastDetail = "the daemon answered no projection read";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const observation = projectionObservation(await readProjection()),
        status = observation.status;
      if (observation.daemonBuild?.code === "daemon_build_stale")
        throw probeError(
          "daemon_build_stale",
          `Canonical GUI lane cannot use daemon build ${observation.daemonBuild.loadedBuildId ?? "missing"}; ` +
            `disk build is ${observation.daemonBuild.diskBuildId ?? "missing"}. ` +
            "Restart the resident daemon from an operator shell before running the canonical lane.",
        );
      if (status === "ready") return { attempts: attempt + 1, status };
      lastDetail = `projection status ${status ?? "unknown"} after ${attempt + 1} read(s)`;
    } catch (error) {
      if (error?.code === "daemon_build_stale") throw error;
      lastDetail = error instanceof Error ? error.message : String(error);
    }
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  throw probeError("daemon_projection_unready", `Daemon projection never reached ready: ${lastDetail}.`);
}

function projectionObservation(receipt) {
  try {
    const evidence = JSON.parse(receipt.evidence);
    return { status: evidence.status ?? null, daemonBuild: receipt.daemonBuild ?? null };
  } catch {
    return { status: null, daemonBuild: null };
  }
}

async function runCliJson(workspaceRoot, rootDir, args, env) {
  const child = spawn(
    process.execPath,
    [path.join(workspaceRoot, "packages", "cli", "src", "index.ts"), "--root", rootDir, "--json", ...args],
    {
      cwd: rootDir,
      env: { ...env, HARNESS_ACTOR: "agent:e2e-probe" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const [status] = await once(child, "close");
  let receipt;
  try {
    receipt = JSON.parse(stdout.trim());
  } catch {
    throw probeError(
      "probe_closure_invalid_receipt",
      `CLI produced no JSON receipt. stderr=${stderr.trim() || "<empty>"}`,
    );
  }
  if (status !== 0 || receipt.ok !== true || receipt.outcome !== "applied") {
    // Daemon rejections (command-receipt/v2, ok:false) carry a code but no nextAction/hint and
    // an empty stderr; `??` alone would hand back that empty string (observed 2026-10-09: a
    // rejected artifact attach surfaced as `message:""`), so every part must be non-empty text.
    const hint = [receipt.nextAction, receipt.error?.hint].find((part) => typeof part === "string" && part) ?? null,
      detail = [typeof receipt.code === "string" ? receipt.code : null, hint, stderr.trim() || null, `exit ${status}`]
        .filter((part) => part !== null)
        .join(" · ");
    throw probeError("probe_closure_rejected", detail);
  }
  return receipt;
}

export const runCliJsonForTest = runCliJson;

function cliRows(receipt) {
  try {
    const evidence = JSON.parse(receipt.evidence);
    return Array.isArray(evidence.rows) ? evidence.rows : [];
  } catch {
    throw probeError("probe_closure_invalid_receipt", "Task list receipt omitted its structured rows.");
  }
}

function readFailureBundle(bundlePath) {
  if (typeof bundlePath !== "string" || !bundlePath)
    throw probeError("probe_bundle_missing", "Failure bundle path is required.");
  const parsed = JSON.parse(readFileSync(bundlePath, "utf8"));
  if (
    parsed.schema !== "e2e-probe-journey/v1" ||
    parsed.outcome !== "failed" ||
    typeof parsed.runId !== "string" ||
    typeof parsed.startedAt !== "string" ||
    typeof parsed.failureSignature !== "string"
  )
    throw probeError("probe_bundle_invalid", "Failure bundle must be a failed e2e-probe-journey/v1 object.");
  return parsed;
}

export function signatureOf(step, code, message, rootDir) {
  const normalized = message.replaceAll(rootDir, "<repo>").replaceAll(/\s+/gu, " ").trim().slice(0, 512);
  return createHash("sha256").update(`${step}\0${code}\0${normalized}`).digest("hex").slice(0, 20);
}

export function probeError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function errorCode(error) {
  return typeof error === "object" && error !== null && typeof error.code === "string" ? error.code : "probe_failed";
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value) throw probeError("probe_closure_invalid_receipt", `Missing ${field}.`);
  return value;
}
