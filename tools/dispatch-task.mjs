#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dispatchTaskCommand, parseToolOptions, renderToolHelp, toolValue } from "./tool-command-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class DispatchCommandError extends Error {
  constructor(command, status, stdout, stderr) {
    super(`${command.join(" ")} exited ${status}`);
    this.name = "DispatchCommandError";
    this.command = command;
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function parseDispatchArgs(argv) {
  const parsed = parseToolOptions(dispatchTaskCommand, argv);
  if (parsed.help) return { help: true };
  return {
    help: false,
    planFile: toolValue(parsed, "--plan-file"),
    preset: toolValue(parsed, "--preset"),
    title: toolValue(parsed, "--title"),
    instance: toolValue(parsed, "--instance"),
    promptFile: toolValue(parsed, "--prompt-file"),
  };
}

function parseReceiptText(text, command) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new Error(`${command.join(" ")} did not return one JSON receipt.`);
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error(`${command.join(" ")} returned an invalid receipt.`);
  return receipt;
}

function subprocessRunner({ haBin = process.env.HA_BIN, cwd }) {
  return ({ args }) => {
    const launcher = haBin
      ? { executable: haBin, leadingArgs: [] }
      : { executable: process.execPath, leadingArgs: [path.join(repositoryRoot, "packages/cli/src/index.ts")] };
    const command = [launcher.executable, ...launcher.leadingArgs, "--json", ...args];
    const result = spawnSync(launcher.executable, [...launcher.leadingArgs, "--json", ...args], { cwd, env: process.env, encoding: "utf8" });
    const status = result.status ?? 1, stdout = result.stdout ?? "", stderr = result.stderr ?? "";
    if (status !== 0) throw new DispatchCommandError(command, status, stdout, stderr);
    return { command, receipt: parseReceiptText(stdout, command) };
  };
}

function findWorkspaceRoot(start = repositoryRoot) {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, "harness", "harness.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Could not find harness/harness.yaml above ${start}.`);
    current = parent;
  }
}

function receiptText(receipt, field, step) {
  const value = receipt?.[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${step} receipt has no ${field}; refusing to infer it.`);
  return value;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function turnCompletedCountCommand(jsonlPath) {
  const target = shellQuote(jsonlPath);
  return `if [ -f ${target} ]; then grep -c '"type":"turn.completed"' ${target} || true; else printf '0\\n'; fi`;
}

export function dispatchSentinelCommand(jsonlPath) {
  const target = shellQuote(jsonlPath), count = turnCompletedCountCommand(jsonlPath);
  return `(while :; do completed=$(${count}); if [ "$completed" -gt 0 ]; then printf '%s\\n' ${target}; break; fi; sleep 5; done) &`;
}

export function runDispatch(input, dependencies = {}) {
  const callerCwd = dependencies.cwd ?? process.cwd();
  const workspaceRoot = dependencies.workspaceRoot ?? findWorkspaceRoot();
  const planSource = path.resolve(callerCwd, input.planFile);
  const planBody = readFileSync(planSource, "utf8");
  if (planBody.trim().length === 0) throw new Error("--plan-file must contain the caller-authored task plan.");
  const promptFile = input.promptFile === undefined ? undefined : path.resolve(callerCwd, input.promptFile);
  if (promptFile !== undefined) readFileSync(promptFile, "utf8");

  const run = dependencies.run ?? subprocessRunner({ cwd: workspaceRoot });
  const steps = [];
  const invoke = (step, args) => {
    const result = run({ step, args });
    steps.push({ step, command: result.command, receipt: result.receipt });
    return result.receipt;
  };

  const created = invoke("task-create", ["task", "create", "--title", input.title, "--preset", input.preset]);
  const taskId = receiptText(created, "taskId", "task create");
  const packagePath = receiptText(created, "packagePath", "task create");
  const planPath = path.join(workspaceRoot, "harness", ...packagePath.split("/"), "task_plan.md");
  writeFileSync(planPath, planBody, "utf8");
  steps.push({ step: "plan-write", source: planSource, path: planPath });

  const started = invoke("task-start", ["task", "start", taskId]);
  const executionId = receiptText(started, "executionId", "task start");
  const runtimeArgs = ["runtime", "run", input.instance, "--task", taskId, "--detach"];
  if (promptFile !== undefined) runtimeArgs.push("--prompt-file", promptFile);
  const dispatched = invoke("runtime-run", runtimeArgs);
  const dispatchId = receiptText(dispatched, "dispatchId", "runtime run");
  const runtimeSessionId = receiptText(dispatched, "runtimeSessionId", "runtime run");
  const dispatchJsonlPath = path.join(workspaceRoot, ".harness", "runtime", "dispatches", `${dispatchId}.jsonl`);
  const sentinelCommand = dispatchSentinelCommand(dispatchJsonlPath);
  steps.push({ step: "sentinel", path: dispatchJsonlPath, command: sentinelCommand });

  return { schema: "dispatch-task-receipt/v1", ok: true, taskId, executionId, packagePath, planPath, dispatchId, runtimeSessionId, dispatchJsonlPath, sentinelCommand, steps };
}

function main() {
  try {
    const parsed = parseDispatchArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${renderToolHelp(dispatchTaskCommand)}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify(runDispatch(parsed), null, 2)}\n`);
  } catch (error) {
    if (error instanceof DispatchCommandError) {
      process.stdout.write(error.stdout);
      process.stderr.write(error.stderr);
      process.exitCode = error.status;
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
