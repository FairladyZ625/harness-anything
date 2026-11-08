#!/usr/bin/env node
/**
 * Static gate: every CI job that installs dependencies or executes an Electron-importing
 * suite must use `.github/actions/electron-runtime-cache`.
 *
 * Why this exists: Electron's postinstall downloads a release archive from
 * github.com/electron/electron/releases/download. On 2026-11-08 a releases 504 turned
 * unrelated PRs red because each job paid that download independently. The cache action
 * removes the per-job network dependency, but a new job can silently reintroduce it.
 * This gate walks every workflow file and derives the needing jobs from their commands
 * instead of keeping a second, hand-maintained job list, so a newly added lane is covered
 * the moment it runs `npm ci` or the fast/contract/integration/GUI gates.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const CACHE_ACTION_PATH = "./.github/actions/electron-runtime-cache";
export const RETRY_COMMAND = "node tools/ci/electron-runtime.mjs";
export const CACHE_ACTION_FILE = ".github/actions/electron-runtime-cache/action.yml";

const defaultRepoRoot = path.resolve(import.meta.dirname, "..");

export function discoverWorkflowFiles(repoRoot = defaultRepoRoot) {
  return readdirSync(path.join(repoRoot, ".github/workflows"))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => `.github/workflows/${name}`);
}

// Commands that either download Electron themselves (`npm ci`) or execute a suite that
// imports `electron` at module load (`tools/gui-e2e/driver.mjs` is reachable from the fast
// capture-element test, the integration driver test, and the GUI build/test lane).
const electronTriggers = [
  { description: "installs dependencies", pattern: /\bnpm (?:ci|install)\b/u },
  {
    description: "runs the Electron-importing fast/contract tests",
    pattern: /run-manifest-gates\.mjs --workflow-job fast-contract\b/u,
  },
  {
    description: "runs the Electron-importing integration tests",
    pattern: /run-manifest-gates\.mjs --workflow-job (?:integration-shard|windows-integration-shard)\b/u,
  },
  {
    description: "runs the Electron-importing GUI suite or build",
    pattern: /run-manifest-gates\.mjs --workflow-job gui-build\b/u,
  },
  // The aggregate check includes test:fast (capture-element imports the driver) and test:gui.
  { description: "runs the aggregate check", pattern: /\bnpm run check\s*$/u },
  {
    description: "runs a node or GUI test suite",
    pattern: /\b(?:run-node-tests|run-gui-tests)\.mjs\b|\bnpm run test:(?:fast|contract|integration|gui|gui:e2e)\b/u,
  },
  { description: "runs the GUI e2e tools", pattern: /\b(?:smoke:gui:headless|test:gui:e2e)\b|node tools\/gui-e2e\//u },
  { description: "packages the Electron app", pattern: /\b(?:electron-builder|package:prepare)\b/u },
];

const actionRequirements = [
  { description: "the actions/cache restore step", pattern: /uses:\s*actions\/cache@/u },
  { description: "the ~/.cache/electron path", pattern: /path:\s*~\/\.cache\/electron/u },
  {
    description: "a key derived from the locked Electron version",
    pattern:
      /key:\s*electron-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*runner\.arch\s*\}\}-\$\{\{\s*steps\.electron-version\.outputs\.version\s*\}\}/u,
  },
  { description: `the ${RETRY_COMMAND} bounded-retry step`, pattern: /run:\s*node tools\/ci\/electron-runtime\.mjs/u },
  { description: "the electron_config_cache environment variable", pattern: /electron_config_cache=/u },
];

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Minimal job parser: job id, its line range, and every `run:` command with the line index
 * that declared it. Multiline `run: |` blocks contribute each non-empty command line, so a
 * `npm ci` nested in a script is still recognized.
 */
export function parseWorkflowJobs(text) {
  const jobs = new Map();
  const lines = text.split(/\r?\n/u);
  let inJobs = false;
  let current = null;
  let multilineIndent = null;
  for (const [index, line] of lines.entries()) {
    if (multilineIndent !== null) {
      const indent = /^\s*/u.exec(line)?.[0].length ?? 0;
      if (line.trim() && indent > multilineIndent) {
        current.runCommands.push({ index, command: line.trim() });
        continue;
      }
      multilineIndent = null;
    }
    if (/^jobs:\s*$/u.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const jobMatch = /^  ([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (jobMatch) {
      current = { id: jobMatch[1], startLine: index, endLine: index, block: [], runCommands: [] };
      jobs.set(current.id, current);
      continue;
    }
    if (!current) continue;
    current.endLine = index;
    current.block.push({ index, line });
    const runMatch = /^\s+(?:-\s*)?run:\s*(.+?)\s*$/u.exec(line);
    if (!runMatch) continue;
    const command = unquoteYamlScalar(runMatch[1]);
    if (command === "|" || command === ">") multilineIndent = /^\s*/u.exec(line)?.[0].length ?? 0;
    else current.runCommands.push({ index, command });
  }
  return jobs;
}

function electronTriggerFor(job) {
  for (const trigger of electronTriggers) {
    const command = job.runCommands.find((entry) => trigger.pattern.test(entry.command));
    if (command) return { ...trigger, command };
  }
  return undefined;
}

function cacheActionLine(job) {
  return job.block.find((entry) =>
    new RegExp(`uses:\\s*${CACHE_ACTION_PATH.replaceAll(".", "\\.")}\\s*$`, "u").test(entry.line),
  );
}

function workflowFindings(workflowName, text) {
  const findings = [];
  for (const job of parseWorkflowJobs(text).values()) {
    const trigger = electronTriggerFor(job);
    if (!trigger) continue;
    const cacheLine = cacheActionLine(job);
    if (!cacheLine) {
      findings.push(
        `${workflowName} job ${job.id} ${trigger.description} but does not use ${CACHE_ACTION_PATH} (trigger: ${trigger.command.command}).`,
      );
      continue;
    }
    if (cacheLine.index > trigger.command.index) {
      findings.push(
        `${workflowName} job ${job.id} places ${CACHE_ACTION_PATH} after the command that needs it (line ${cacheLine.index + 1} > ${trigger.command.index + 1}: ${trigger.command.command}).`,
      );
    }
  }
  return findings;
}

function actionFindings(actionText) {
  if (actionText === undefined) return [`${CACHE_ACTION_FILE} is missing.`];
  const findings = [];
  for (const requirement of actionRequirements) {
    if (!requirement.pattern.test(actionText))
      findings.push(`${CACHE_ACTION_FILE} is missing ${requirement.description}.`);
  }
  return findings;
}

export function checkElectronCiCache({
  repoRoot = defaultRepoRoot,
  workflows,
  actionText,
  workflowNames = discoverWorkflowFiles(repoRoot),
} = {}) {
  const findings = [];
  const resolvedWorkflows =
    workflows ?? workflowNames.map((name) => ({ name, text: readFileSync(path.join(repoRoot, name), "utf8") }));
  for (const workflow of resolvedWorkflows) findings.push(...workflowFindings(workflow.name, workflow.text));

  const resolvedActionText =
    actionText === undefined && existsSync(path.join(repoRoot, CACHE_ACTION_FILE))
      ? readFileSync(path.join(repoRoot, CACHE_ACTION_FILE), "utf8")
      : actionText;
  findings.push(...actionFindings(resolvedActionText));

  return { ok: findings.length === 0, findings, workflows: resolvedWorkflows.map((workflow) => workflow.name) };
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length > 0) throw new Error("usage: node tools/check-electron-ci-cache.mjs");
  const result = checkElectronCiCache();
  if (result.ok) {
    console.log(`Electron cache gate passed (${result.workflows.join(", ")}).`);
    return 0;
  }
  for (const finding of result.findings) console.error(`Electron cache gate: ${finding}`);
  return 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`Electron cache gate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
