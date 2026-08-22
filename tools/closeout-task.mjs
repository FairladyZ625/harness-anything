#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requiredSubmissionFields = Object.freeze(["completionClaim", "deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks", "commitSha"]);
const requiredReviewFields = Object.freeze(["verdict", "reason", "evidenceChecked"]);
const requiredConsentFields = Object.freeze(["approved"]);
const requiredCompletionFields = Object.freeze(["ci", "codeDocPaths"]);

export class CloseoutCommandError extends Error {
  constructor(command, status, stdout, stderr) {
    super(`${command.join(" ")} exited ${status}`);
    this.name = "CloseoutCommandError";
    this.command = command;
    this.status = status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

function usage() {
  return [
    "Usage: node tools/closeout-task.mjs --task-id <task-id> --execution-id <execution-id> --from-file <judgment.json>",
    "",
    "The judgment packet must contain exactly:",
    "  submission: completionClaim, deliverables, outputs, verificationNotes, knownGaps, residualRisks, commitSha",
    "  review: verdict, reason, evidenceChecked",
    "  consent: approved=true",
    "  completion: ci=passed, codeDocPaths[]",
    "",
    "The script derives the submitter and owner actor postures from the active task, binds Review to submission.commitSha,",
    "uses the transport human as independent reviewer, and invokes every existing lifecycle gate without bypasses.",
  ].join("\n");
}

export function parseCloseoutArgs(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!["--task-id", "--execution-id", "--from-file"].includes(flag) || typeof value !== "string" || value.length === 0) throw new Error(usage());
    if (values.has(flag)) throw new Error(`${flag} may be supplied once.\n\n${usage()}`);
    values.set(flag, value);
  }
  if (values.size !== 3) throw new Error(usage());
  return { help: false, taskId: values.get("--task-id"), executionId: values.get("--execution-id"), fromFile: values.get("--from-file") };
}

function exactObject(value, fields, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be one JSON object.`);
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  if (actual.join("\0") !== expected.join("\0")) throw new Error(`${name} requires exactly: ${fields.join(", ")}.`);
  return value;
}

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function stringList(value, name) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) throw new Error(`${name} must be an array of non-empty strings.`);
  return value;
}

export function validateCloseoutJudgment(value) {
  const packet = exactObject(value, ["submission", "review", "consent", "completion"], "judgment packet");
  const submission = exactObject(packet.submission, requiredSubmissionFields, "submission");
  nonEmpty(submission.completionClaim, "submission.completionClaim");
  for (const field of ["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"]) stringList(submission[field], `submission.${field}`);
  if (!/^[0-9a-f]{40}$/u.test(String(submission.commitSha))) throw new Error("submission.commitSha must be a full 40-character Git SHA.");

  const review = exactObject(packet.review, requiredReviewFields, "review");
  if (!["approved", "changes_requested", "dismissed"].includes(review.verdict)) throw new Error("review.verdict must be approved, changes_requested, or dismissed.");
  nonEmpty(review.reason, "review.reason");
  stringList(review.evidenceChecked, "review.evidenceChecked");

  const consent = exactObject(packet.consent, requiredConsentFields, "consent");
  if (consent.approved !== true) throw new Error("consent.approved must be true; the script never invents consent intent.");

  const completion = exactObject(packet.completion, requiredCompletionFields, "completion");
  if (completion.ci !== "passed") throw new Error("completion.ci must be passed; the script never invents a CI judgment.");
  stringList(completion.codeDocPaths, "completion.codeDocPaths");
  return { submission, review, consent, completion };
}

function parseReceiptText(text, command) {
  let receipt;
  try {
    receipt = JSON.parse(text);
  } catch {
    throw new Error(`${command.join(" ")} did not return one JSON receipt.`);
  }
  if (!receipt || typeof receipt !== "object") throw new Error(`${command.join(" ")} returned an invalid receipt.`);
  return receipt;
}

function subprocessRunner({ haBin = process.env.HA_BIN, cwd = process.cwd() } = {}) {
  return ({ args, actor }) => {
    const environment = { ...process.env };
    if (actor === null) delete environment.HARNESS_ACTOR;
    else environment.HARNESS_ACTOR = actor;
    const launcher = haBin
      ? { executable: haBin, leadingArgs: [] }
      : { executable: process.execPath, leadingArgs: [path.join(cwd, "packages/cli/src/index.ts")] };
    const command = [launcher.executable, ...launcher.leadingArgs, "--json", ...args];
    const result = spawnSync(launcher.executable, [...launcher.leadingArgs, "--json", ...args], { cwd, env: environment, encoding: "utf8" });
    const status = result.status ?? 1, stdout = result.stdout ?? "", stderr = result.stderr ?? "";
    if (status !== 0) throw new CloseoutCommandError(command, status, stdout, stderr);
    return { command, status, stdout, stderr, receipt: parseReceiptText(stdout, command) };
  };
}

function receiptEvidence(receipt, name) {
  if (typeof receipt.evidence !== "string") throw new Error(`${name} receipt has no machine-readable evidence.`);
  return receipt.evidence;
}

function taskSnapshot(receipt) {
  let value;
  try {
    value = JSON.parse(receiptEvidence(receipt, "task show"));
  } catch {
    throw new Error("task show evidence is not JSON.");
  }
  if (!value?.task || !Array.isArray(value.executions) || typeof value.packagePath !== "string") throw new Error("task show evidence is missing task, executions, or packagePath.");
  return value;
}

function docRows(receipt) {
  const evidence = receiptEvidence(receipt, "doc status"), prefix = "doc-scan:";
  const encoded = evidence.startsWith(prefix) ? evidence.slice(prefix.length) : evidence;
  let scan;
  try {
    scan = JSON.parse(encoded);
  } catch {
    throw new Error("doc status evidence is not a doc-scan JSON payload.");
  }
  if (!Array.isArray(scan.rows)) throw new Error("doc status evidence has no rows.");
  return scan.rows;
}

function actorEnvironment(actor, name) {
  if (!actor?.principal || typeof actor.principal.personId !== "string") throw new Error(`${name} has no principal identity.`);
  if (actor.executor === null) return null;
  if (actor.executor?.kind === "agent" && typeof actor.executor.id === "string" && actor.executor.id.length > 0) return `agent:${actor.executor.id}`;
  throw new Error(`${name} uses an unsupported executor identity.`);
}

function sameActor(left, right) {
  return left?.principal?.personId === right?.principal?.personId
    && left?.executor?.kind === right?.executor?.kind
    && left?.executor?.id === right?.executor?.id
    && (left?.executor === null) === (right?.executor === null);
}

function deterministicId(prefix, taskId, executionId, commitSha) {
  return `${prefix}-${createHash("sha256").update(`${taskId}\0${executionId}\0${commitSha}`).digest("hex").slice(0, 16)}`;
}

function writePacket(directory, name, value) {
  const target = path.join(directory, name);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

export function runCloseout(input, dependencies = {}) {
  const judgment = validateCloseoutJudgment(input.judgment);
  const run = dependencies.run ?? subprocessRunner(dependencies);
  const workspaceRoot = dependencies.cwd ?? process.cwd();
  const receipts = [];
  const invoke = (step, args, actor) => {
    const result = run({ step, args, actor });
    receipts.push({ step, command: result.command, receipt: result.receipt });
    return result.receipt;
  };

  const shown = taskSnapshot(invoke("task-show", ["task", "show", input.taskId], null));
  if (shown.task.taskId !== input.taskId || shown.task.status !== "active" || shown.task.currentNode !== "implementation") throw new Error("closeout requires the active implementation execution; no lifecycle transition is inferred.");
  const execution = shown.executions.find((candidate) => candidate.executionId === input.executionId);
  if (!execution || execution.state !== "active" || execution.submission !== null) throw new Error(`execution ${input.executionId} is not the active unsubmitted execution.`);
  if (!shown.lease || shown.lease.executionId !== input.executionId || !sameActor(shown.lease.actor, execution.actor)) throw new Error(`execution ${input.executionId} does not hold its active lease.`);
  if (execution.actor?.executor === null) throw new Error("the active execution declared no executor; an independent same-person transport review cannot be derived. Use a different reviewing person or repair executor attribution before closeout.");
  const submitterActor = actorEnvironment(execution.actor, "execution actor");
  const ownerActor = actorEnvironment(shown.task.createdBy, "task owner");

  const statusRows = docRows(invoke("doc-status", ["doc", "status"], submitterActor));
  const eligible = statusRows.filter((row) => row.state === "eligible");
  const foreign = eligible.filter((row) => typeof row.path !== "string" || !(row.path === shown.packagePath || row.path.startsWith(`${shown.packagePath}/`)));
  const ownEligible = eligible.filter((row) => !foreign.includes(row));
  const blocked = statusRows.filter((row) => typeof row.path === "string" && row.path.startsWith(`${shown.packagePath}/`) && ["blocked", "conflict", "deletion"].includes(row.state));
  if (blocked.length > 0) throw new Error(`task document candidates are not eligible: ${blocked.map((row) => `${row.path}:${row.state}`).join(", ")}`);
  const completionManaged = ownEligible.filter((row) => row.path === `${shown.packagePath}/closeout.md` || row.path.startsWith(`${shown.packagePath}/artifacts/`));
  const unmanaged = ownEligible.filter((row) => !completionManaged.includes(row));
  if (foreign.length > 0 && unmanaged.length > 0) throw new Error(`foreign candidates prevent safe unscoped doc sync, while task complete cannot carry: ${unmanaged.map((row) => row.path).join(", ")}`);
  const docSyncMode = foreign.length > 0 && ownEligible.length > 0 ? "deferred_to_task_complete" : ownEligible.length > 0 ? "submitted_before_review" : "clean";
  if (docSyncMode === "submitted_before_review") invoke("doc-sync", ["doc", "sync", "--submit", "--execution-id", input.executionId], submitterActor);

  // Daemon packet-file reads are workspace-contained by contract, so lifecycle
  // packets must live under the repository root until the command finishes.
  const temporaryDirectory = dependencies.temporaryDirectory ?? mkdtempSync(path.join(workspaceRoot, ".ha-closeout-"));
  const ownsTemporaryDirectory = dependencies.temporaryDirectory === undefined;
  try {
    const submissionPath = writePacket(temporaryDirectory, "submission.json", judgment.submission);
    invoke("task-submit", ["task", "submit", input.taskId, "--execution-id", input.executionId, "--from-file", submissionPath], submitterActor);

    const reviewId = deterministicId("review-closeout", input.taskId, input.executionId, judgment.submission.commitSha);
    const reviewPath = writePacket(temporaryDirectory, "review.json", { ...judgment.review, commitSha: judgment.submission.commitSha, iteration: execution.iteration });
    invoke("task-review-execution", ["task", "review-execution", input.taskId, "--execution-id", input.executionId, "--review-id", reviewId, "--from-file", reviewPath], null);

    const consentId = deterministicId("consent-closeout", input.taskId, input.executionId, judgment.submission.commitSha);
    invoke("task-review-consent", ["task", "review-consent", input.taskId, "--execution-id", input.executionId, "--review-id", reviewId, "--consent-id", consentId], ownerActor);

    const completeArgs = ["task", "complete", input.taskId, "--execution-id", input.executionId, "--ci", judgment.completion.ci, "--commit-sha", judgment.submission.commitSha, "--iteration", String(execution.iteration)];
    for (const codePath of judgment.completion.codeDocPaths) completeArgs.push("--path", codePath);
    invoke("task-complete", completeArgs, ownerActor);
    return { schema: "closeout-task-receipt/v1", ok: true, taskId: input.taskId, executionId: input.executionId, reviewId, consentId, commitSha: judgment.submission.commitSha, docSyncMode, deferredForeignCandidates: foreign.map((row) => row.path), steps: receipts };
  } finally {
    if (ownsTemporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function main() {
  let parsed;
  try {
    parsed = parseCloseoutArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const judgment = JSON.parse(readFileSync(path.resolve(parsed.fromFile), "utf8"));
    const receipt = runCloseout({ taskId: parsed.taskId, executionId: parsed.executionId, judgment });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    if (error instanceof CloseoutCommandError) {
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
