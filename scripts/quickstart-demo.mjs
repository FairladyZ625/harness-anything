#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const defaultCliPath = path.join(repoRoot, "packages/cli/dist/cli/src/index.js");
const demoAttribution = {
  actor: "agent:quickstart-demo",
  gitAuthorName: "Harness Quickstart Demo",
  gitAuthorEmail: "quickstart-demo@example.invalid"
};

const options = parseArgs(process.argv.slice(2));
const cliPath = path.resolve(options.cliPath ?? defaultCliPath);
if (!existsSync(cliPath)) {
  fail(`CLI entry not found: ${cliPath}. Run npm -w @harness-anything/cli run build first.`);
}

const workspace = options.rootDir
  ? path.resolve(options.rootDir)
  : mkdtempSync(path.join(tmpdir(), "ha-quickstart-"));
mkdirSync(workspace, { recursive: true });
ensureGitWorkspace(workspace);

let step = "start";
try {
  step = "init";
  const init = runCli(["init", "--name", "quickstart-demo", "--add-npm-scripts"]);
  assertEqual(init.command, "init", "init command");
  assertEqual(init.report?.configureVerify?.smokeTaskFound, true, "init smoke task query");

  step = "task create";
  const task = runCli([
    "task",
    "create",
    "--title",
    "First harness value",
    "--vertical",
    "software/coding",
    "--preset",
    "standard-task"
  ]);
  const taskId = assertString(task.taskId, "created task id");

  step = "fact record";
  const factId = options.breakStep === "fact-record" ? "F-BAD" : "F-ABCDEF12";
  const fact = runCli([
    "fact",
    "record",
    "--task",
    taskId,
    "--id",
    factId,
    "--statement",
    "The quickstart created a task and recorded a queryable fact.",
    "--source",
    "scripts/quickstart-demo.mjs",
    "--confidence",
    "high",
    "--memory-class",
    "episodic",
    "--memory-tag",
    "task_skill"
  ]);
  const factRef = assertString(fact.factRef, "created fact ref");

  step = "fact list";
  const facts = runCli(["fact", "list", "--task", taskId]);
  const factRows = Number(facts.rows);
  if (!Number.isFinite(factRows) || factRows < 1) {
    throw new Error(`expected at least one fact row, got ${String(facts.rows)}`);
  }

  step = "graph";
  const graph = runCli([
    "graph",
    "--focus",
    factRef,
    "--out",
    ".harness/generated/graph-panorama/quickstart.html"
  ]);
  assertEqual(graph.command, "graph", "graph command");
  const graphPath = path.join(workspace, ".harness/generated/graph-panorama/quickstart.html");
  if (!existsSync(graphPath)) throw new Error(`graph HTML missing: ${graphPath}`);
  const graphHtml = readFileSync(graphPath, "utf8");
  if (!graphHtml.includes("Relation Graph Panorama")) {
    throw new Error("graph HTML did not contain the expected panorama marker");
  }

  console.log(JSON.stringify({
    ok: true,
    schema: "quickstart-demo/v1",
    workspace,
    taskId,
    factRef,
    graphPath,
    initSmokeTaskId: init.report.configureVerify.smokeTaskId,
    attribution: {
      actor: demoAttribution.actor,
      gitAuthorName: demoAttribution.gitAuthorName,
      gitAuthorEmail: demoAttribution.gitAuthorEmail
    }
  }, null, 2));
  if (options.cleanup) rmSync(workspace, { recursive: true, force: true });
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    schema: "quickstart-demo/v1",
    step,
    workspace,
    error: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exitCode = 1;
}

function runCli(args) {
  const stdout = runCliProcess(args);
  const parsed = JSON.parse(stdout);
  const receipt = unwrapReceipt(parsed);
  if (!receipt.ok) {
    const hint = receipt.error?.hint ?? parsed.summary ?? "command failed";
    throw new Error(`${args.join(" ")} failed: ${hint}`);
  }
  return receipt;
}

function runCliProcess(args) {
  try {
    return execFileSync(process.execPath, [cliPath, "--root", workspace, "--json", ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        HARNESS_ACTOR: demoAttribution.actor,
        HARNESS_GIT_AUTHOR_NAME: demoAttribution.gitAuthorName,
        HARNESS_GIT_AUTHOR_EMAIL: demoAttribution.gitAuthorEmail,
        HARNESS_DAEMON_PROFILE: "isolated",
        HARNESS_BOOTSTRAP_MACHINE_IDENTITY: "1",
        ANTIGRAVITY_SESSION_ID: "",
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_SESSION_ID: "",
        CODEX_SESSION_ID: "",
        CODEX_THREAD_ID: "",
        ZCODE_SESSION_ID: ""
      },
      maxBuffer: 64 * 1024 * 1024
    });
  } catch (error) {
    const failure = error;
    const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
    if (stdout.length > 0) {
      const parsed = JSON.parse(stdout);
      const hint = parsed.error?.hint ?? parsed.summary ?? stdout;
      throw new Error(`${args.join(" ")} exited non-zero: ${hint}`);
    }
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    throw new Error(`${args.join(" ")} exited non-zero${stderr ? `: ${stderr}` : ""}`);
  }
}

function ensureGitWorkspace(rootDir) {
  try {
    execFileSync("git", ["-C", rootDir, "rev-parse", "--is-inside-work-tree"], {
      stdio: "ignore"
    });
  } catch {
    execFileSync("git", ["-C", rootDir, "init", "-q"], {
      stdio: "ignore"
    });
  }
}

function unwrapReceipt(value) {
  const data = value.details?.data && typeof value.details.data === "object" ? value.details.data : {};
  const paths = Object.fromEntries(Array.isArray(value.paths) ? value.paths.map((entry) => [entry.role, entry.path]) : []);
  return {
    ...data,
    ok: value.ok,
    command: value.command?.replaceAll(" ", "-"),
    error: value.error,
    path: paths.primary,
    packagePath: paths.package,
    projectionPath: paths.projection
  };
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} missing`);
  }
  return value;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function parseArgs(args) {
  const options = { cleanup: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--cli") {
      options.cliPath = requireValue(args, index);
      index += 1;
    } else if (arg === "--root") {
      options.rootDir = requireValue(args, index);
      index += 1;
    } else if (arg === "--cleanup") {
      options.cleanup = true;
    } else if (arg === "--break-step") {
      options.breakStep = requireValue(args, index);
      index += 1;
    } else {
      fail(`unknown option: ${arg}`);
    }
  }
  if (options.breakStep && options.breakStep !== "fact-record") {
    fail(`unsupported --break-step value: ${options.breakStep}`);
  }
  return options;
}

function requireValue(args, index) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`missing value for ${args[index]}`);
  return value;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
