#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { describeDependencyChange } from "./dependency-policy.mjs";
import { repoRoot } from "./git.mjs";
import { deriveProtectedSurfaceRules } from "../../packages/kernel/src/domain/protected-surface-governance.ts";
import { readSubmissionFacts } from "../../packages/kernel/src/domain/submission-facts.ts";
import {
  governanceDecisionAuthority,
  renderTaskPrBody as renderTaskPrBodyFromCut,
} from "../../packages/kernel/src/domain/task-pr-body.ts";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function taskProjection(receipt, taskId) {
  if (!record(receipt) || receipt.ok !== true || typeof receipt.evidence !== "string")
    throw new Error(`ha task show ${taskId} did not return a successful task projection`);
  const projection = JSON.parse(receipt.evidence),
    task = projection.task;
  if (!record(task) || task.taskId !== taskId || !Number.isSafeInteger(task.iteration))
    throw new Error(`task projection does not identify ${taskId}`);
  const candidates = (Array.isArray(projection.executions) ? projection.executions : [])
      .filter(
        (execution) =>
          record(execution) &&
          execution.taskId === taskId &&
          execution.iteration === task.iteration &&
          record(execution.submission),
      )
      .sort((left, right) => String(left.submittedAt ?? "").localeCompare(String(right.submittedAt ?? ""))),
    current = candidates.at(-1);
  if (!current) throw new Error(`task ${taskId} has no submitted cut for iteration ${task.iteration}`);
  return {
    submission: current.submission,
    workspacePackagePath: projection.workspacePackagePath,
    profileId: record(task.metadata) && typeof task.metadata.profileId === "string" ? task.metadata.profileId : null,
    decisionAuthority: governanceDecisionAuthority(
      Array.isArray(projection.decisionRelations) ? projection.decisionRelations : [],
    ),
  };
}

/**
 * The CLI adapter over the kernel renderer. The daemon publication port calls the same kernel
 * service, so this signature survives only as the worker-facing entry and its fixture surface.
 */
export function renderTaskPrBody({ taskId, receipt, template, body = template, closeout, manifest, rootDir }) {
  const { submission, profileId, decisionAuthority } = taskProjection(receipt, taskId),
    submissionFacts = readSubmissionFacts(submission),
    dependencyDescription = describeDependencyChange({
      paths: submissionFacts.changedFiles,
      rootDir,
      base: submissionFacts.productionDelta?.baseSha,
      head: submission.commitSha,
    });
  return renderTaskPrBodyFromCut({
    taskId,
    submission,
    profileId,
    decisionAuthority,
    template,
    body,
    closeout,
    protectedSurfaceRules: manifest === undefined ? [] : deriveProtectedSurfaceRules(manifest),
    dependencyDescription,
  });
}

function parseArgs(argv) {
  let taskId = null;
  let bodyFile = ".github/pull_request_template.md";
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    if (option !== "--task" && option !== "--body-file") throw new Error(`unknown argument: ${option}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (option === "--task") taskId = value;
    else bodyFile = value;
    index += 1;
  }
  if (!taskId) throw new Error("usage: node tools/gates/render-task-pr-body.mjs --task <task-id> [--body-file <path>]");
  return { taskId, bodyFile };
}

function readCloseout(rootDir, workspacePackagePath) {
  if (
    typeof workspacePackagePath !== "string" ||
    workspacePackagePath.length === 0 ||
    workspacePackagePath.startsWith("/") ||
    workspacePackagePath.split("/").includes("..")
  )
    throw new Error("task projection has no usable workspacePackagePath for closeout.md");
  const docPath = `${workspacePackagePath}/closeout.md`;
  try {
    return execFileSync("ha", ["doc", "show", "--path", docPath, "--raw"], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = record(error) && error.stderr !== undefined ? String(error.stderr).trim() : String(error),
      detail = stderr.split(/\r?\n/u)[0] || "unknown ha doc show failure";
    throw new Error(`cannot read ${docPath} with ha doc show: ${detail}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log("Usage: node tools/gates/render-task-pr-body.mjs --task <task-id> [--body-file <path>]");
      return 0;
    }
    const rootDir = repoRoot(),
      receipt = JSON.parse(
        execFileSync("ha", ["task", "show", options.taskId, "--json"], {
          cwd: rootDir,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        }),
      ),
      { workspacePackagePath } = taskProjection(receipt, options.taskId),
      closeout = readCloseout(rootDir, workspacePackagePath),
      template = readFileSync(path.resolve(rootDir, ".github/pull_request_template.md"), "utf8"),
      input =
        path.resolve(rootDir, options.bodyFile) === path.resolve(rootDir, ".github/pull_request_template.md")
          ? template
          : readFileSync(path.resolve(rootDir, options.bodyFile), "utf8"),
      manifest = JSON.parse(readFileSync(path.resolve(rootDir, "tools/gate-manifest.json"), "utf8")),
      body = renderTaskPrBody({
        taskId: options.taskId,
        receipt,
        template,
        body: input,
        closeout,
        manifest,
        rootDir,
      });
    process.stdout.write(body);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
