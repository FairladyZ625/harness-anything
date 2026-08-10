import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  cleanupFixture,
  createFixture,
  discoverCapabilities,
  git,
  receiptValue,
  renderMarkdownReport,
  runCli,
  settleCliWrite,
  writeJson,
  writeText
} from "./coldstart-exhaustive-runtime.mjs";
import { coldstartOperationManifest } from "./coldstart-exhaustive-manifest.mjs";
import {
  buildColdstartConclusionMatrix,
  classifyColdstartOperation,
  coldstartReportFails,
  loadColdstartKnownIssues
} from "./coldstart-known-issues.mjs";

const reportPath = parseReportPath(process.argv.slice(2));
const fixture = createFixture();
const results = new Map();
const setupResults = [];
let discovery;
let fatalError = null;
const knownIssues = loadColdstartKnownIssues();
for (const operationId of knownIssues.issues.keys()) {
  if (!coldstartOperationManifest.some((row) => row.id === operationId)) {
    knownIssues.invalid.push({ operationId, file: knownIssues.issues.get(operationId).file, errors: ["sidecar names an operation absent from the manifest"] });
    knownIssues.issues.delete(operationId);
  }
}

try {
  discovery = discoverCapabilities(fixture);
  verifyInventory(discovery);
  for (const row of coldstartOperationManifest) {
    if (!row.excludedByDesign) continue;
    const runtime = discovery.operations.find((operation) => operation.id === row.id);
    results.set(row.id, {
      ...row,
      status: "excluded-by-design",
      reason: row.excludedByDesign,
      commandTemplate: runtime?.capability.command ?? null,
      exitCode: null,
      receiptOk: null,
      errorCode: null,
      errorHint: null,
      stdout: "",
      stderr: ""
    });
  }
  await exerciseOperations();
} catch (error) {
  fatalError = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
} finally {
  const cleanup = await cleanupFixture(fixture).catch((error) => ({
    baseRemoved: false,
    protectedUnchanged: false,
    errors: [error instanceof Error ? error.stack ?? error.message : String(error)]
  }));
  const report = buildReport(cleanup);
  writeJson(jsonReportPath(reportPath), report);
  writeText(reportPath, renderMarkdownReport(report));
  process.stderr.write(`[report] markdown=${reportPath} json=${jsonReportPath(reportPath)} signature=${report.signature}\n`);
  process.exitCode = coldstartReportFails(report) ? 1 : 0;
}

async function exerciseOperations() {
  const init = exercise("init.init", ["init", "--name", "coldstart-exhaustive"]);
  const manifestPath = stringOr(receiptValue(init, "manifestPath"), path.join(fixture.daemonUserRoot, "authority-service-state/authority-production.json"));
  if (init.receipt?.details?.data?.report?.authorityBootstrap?.schema !== "init-authority-bootstrap/v1") {
    init.status = "failed";
    init.errorCode = init.errorCode ?? "authority_bootstrap_missing";
    init.errorHint = init.errorHint ?? "ha init did not return init-authority-bootstrap/v1 with external authority state.";
  }
  exercise("daemon.register", ["daemon", "repo", "register", "--root", fixture.root, "--user-root", fixture.daemonUserRoot]);
  exercise("daemon.start", ["daemon", "start", "--service", "--user-root", fixture.daemonUserRoot, "--authority-manifest", manifestPath], { timeoutMs: 30_000 });
  exercise("daemon.status", ["daemon", "status", "--user-root", fixture.daemonUserRoot]);
  exercise("daemon.logs", ["daemon", "logs", "--errors"]);

  writeText(path.join(fixture.root, "README.md"), "# Cold-start exhaustive fixture\n");
  git(fixture, "add", "--all");
  git(fixture, "commit", "-m", "test: seed cold-start public anchor");
  const publicHead = git(fixture, "rev-parse", "HEAD");

  exercise("status.status", ["status"]);
  exercise("doctor.doctor", ["doctor"]);
  exercise("check.check", ["check", "--profile", "target-project"]);
  exercise("authority.cutover-status", ["authority", "cutover", "status"]);
  exercise("vertical.validate", ["vertical", "validate", "software/coding"]);
  exercise("preset.seed", ["preset", "seed"]);

  const primary = exercise("task.create", taskCreateArgs("Cold-start primary completion"));
  const tasks = {
    primary: taskFrom(primary, "primary"),
    relationSource: prepareTask("Task relation source"),
    relationTarget: prepareTask("Task relation target"),
    transition: prepareTask("Task transition target"),
    retire: prepareTask("Task retired execution"),
    archive: prepareTask("Task archive target"),
    supersede: prepareTask("Task supersede target"),
    disposition: prepareTask("Task delete reopen target"),
    amend: prepareTask("Task amend target"),
    review: prepareTask("Task review lint target"),
    worktree: prepareTask("Task worktree target"),
    closeout: prepareTask("Task closeout facade target")
  };
  for (const task of Object.values(tasks)) writeTaskDocuments(task);
  writeText(path.join(fixture.root, tasks.archive.packagePath, "closeout.md"), closeoutBody("Archive evidence is substantive and retained."));
  exercise("doc.status", ["doc", "status"]);
  const authoredDocs = Object.values(tasks).flatMap((task) => [authoredPath(task, "task_plan.md"), authoredPath(task, "closeout.md")]);
  exercise("doc.sync", ["doc", "sync", "--submit", ...authoredDocs.flatMap((documentPath) => ["--path", documentPath])]);
  exercise("materializer.run", ["materializer", "run"]);
  exercise("worktree.create", ["worktree", "create", "--task", tasks.worktree.taskId, "--agent", "coldstart-exhaustive", "--base", "HEAD", "--path", path.join(fixture.base, "worktree")]);
  exercise("worktree.status", ["worktree", "status", "--task", tasks.worktree.taskId]);
  writeText(path.join(fixture.root, "evidence.txt"), "Cold-start artifact evidence.\n");
  writeText(path.join(fixture.root, "source-note.md"), "A repeatable cold-start exercise records durable evidence.\n");
  exercise("task.list", ["task", "list"]);
  exercise("task.show", ["task", "show", tasks.primary.taskId]);
  exercise("task.transition", ["task", "transition", tasks.transition.taskId, "active"]);
  exercise("task.progress-append", ["task", "progress", "append", tasks.primary.taskId, "--text", "Exercised the cold-start CLI graph."]);
  exercise("task.artifact-add", ["task", "artifact", "add", tasks.primary.taskId, "evidence.txt"]);
  exercise("task.amend", ["task", "amend", tasks.amend.taskId, "--set", "taskClass:milestone"]);
  exercise("task.contract-migrate", ["task", "contract", "migrate", "--apply"]);
  exercise("task.relate", ["task", "relate", tasks.relationSource.taskId, "depends-on", tasks.relationTarget.taskId, "--rationale", "The source verifies the target fixture first."]);

  const firstFact = exercise("fact.record", ["fact", "record", "--task", tasks.primary.taskId, "--statement", "The isolated fixture initialized successfully.", "--source", "coldstart exercise", "--confidence", "high"]);
  const firstFactId = stringOr(receiptValue(firstFact, "factId"), "F-MISSING01");
  const secondFact = prepare("fact record invalidator", ["fact", "record", "--task", tasks.primary.taskId, "--statement", "The newer fixture observation supersedes the initial observation.", "--source", "coldstart exercise", "--confidence", "high"]);
  const secondFactId = stringOr(receiptValue(secondFact, "factId"), "F-MISSING02");
  exercise("fact.list", ["fact", "list", "--task", tasks.primary.taskId]);
  exercise("fact.show", ["fact", "show", "--task", tasks.primary.taskId, "--id", firstFactId]);
  exercise("fact.invalidate", ["fact", "invalidate", "--task", tasks.primary.taskId, "--id", firstFactId, "--by", secondFactId, "--rationale", "A later direct observation is more precise."]);

  const candidate = exercise("distill.candidate", ["distill", "candidate", "--task", tasks.primary.taskId, "--input", "source-note.md"]);
  const candidatePath = stringOr(receiptValue(candidate, "path", "candidatePath"), ".harness/generated/distill/missing.json");
  exercise("distill.promote", ["distill", "promote", "--task", tasks.primary.taskId, "--candidate", candidatePath, "--claim", "Cold-start exercise evidence is reproducible.", "--id", "F-C01D0001", "--confidence", "high", "--memory-class", "procedural", "--memory-tag", "pattern"]);

  exercise("module.register", ["module", "register", "coldstart-module", "--title", "Cold-start Module", "--scope", "src/**", "--prefix", "CSE", "--current-step", "plan"]);
  exercise("module.list", ["module", "list"]);
  exercise("module.inspect", ["module", "inspect", "coldstart-module"]);
  exercise("module.scaffold", ["module", "scaffold", "coldstart-module"]);
  exercise("module.step", ["module", "step", "coldstart-module", "plan", "--state", "done"]);

  const decision = exercise("decision.propose", [
    "decision", "propose", "--title", "Cold-start exhaustive policy", "--question", "Should the fixture exercise every applicable op?",
    "--chosen", "Exercise every applicable operation", "--rejected", "Sample only common commands", "--why-not", "Sampling hides cold-start dependencies",
    "--claim", "Every applicable operation has executable evidence", "--non-load-bearing", "--body", "## Background\n\nThe fixture validates a new user path.\n\n## Decision\n\nExercise the whole applicable surface."
  ]);
  const decisionId = stringOr(receiptValue(decision, "decisionId"), "dec_MISSING");
  exercise("decision.transition", ["--actor", "human:person_coldstart_exhaustive_2bfb590688", "decision", "transition", "active", decisionId, "--judgment-only", "The isolated socket owner approves this disposable fixture decision."]);
  exercise("decision.amend", ["decision", "amend", decisionId, "--body", "## Background\n\nThe cold-start run is disposable.\n\n## Decision\n\nKeep the fixture decision concise and non-load-bearing."]);
  const related = exercise("decision.relate", ["decision", "relate", decisionId, "--anchor", "CH1", "--type", "relates", "--target", `task/${tasks.primary.taskId}`, "--rationale", "The decision describes the exercise task."]);
  const relationRows = exercise("relation.list", ["relation", "list"]);
  const relatedId = findRelationId(relationRows.receipt, decisionId, "relates", `task/${tasks.primary.taskId}`) ?? stringOr(receiptValue(related, "relationId"), "rel_missing");
  const replace = exercise("relation.relation-replace", ["decision", "relation", "replace", decisionId, "--relation", relatedId, "--anchor", "CH1", "--type", "relates", "--target", `task/${tasks.relationTarget.taskId}`, "--rationale", "The replacement edge points to the verification fixture."]);
  const replacedRows = prepare("list replaced decision relation", ["relation", "list"]);
  const replacementId = findRelationId(replacedRows.receipt, decisionId, "relates", `task/${tasks.relationTarget.taskId}`) ?? stringOr(receiptValue(replace, "relationId", "newRelationId"), relatedId);
  exercise("relation.relation-retire", ["decision", "relation", "retire", decisionId, "--relation", replacementId, "--body", "The fixture retires its temporary evidence edge."]);
  exercise("decision.list", ["decision", "list"]);
  exercise("decision.show", ["decision", "show", decisionId]);
  exercise("decision.verify", ["decision", "verify", decisionId]);
  exercise("decision.reckon", ["decision", "reckon", decisionId, "--task", tasks.primary.taskId]);

  const presetSource = writePresetSource();
  exercise("preset.validate", ["preset", "validate", path.join(presetSource, "preset.json"), "--kernel-version", "1.0.0"]);
  exercise("preset.install", ["preset", "install", presetSource, "--project"]);
  exercise("preset.list", ["preset", "list"]);
  exercise("preset.inspect", ["preset", "inspect", "coldstart-action"]);
  exercise("preset.check", ["preset", "check", "coldstart-action"]);
  const customTask = prepareTask("Custom preset task", ["--preset", "coldstart-action"]);
  exercise("preset.entrypoint", ["preset", "entrypoint", "coldstart-action", "plan", "--task", customTask.taskId, "--allow-scripts"]);
  const scripts = exercise("script.list", ["script", "list"]);
  const scriptId = findScriptId(scripts.receipt) ?? "preset:coldstart-action:plan";
  exercise("script.inspect", ["script", "inspect", scriptId]);
  exercise("script.run", ["script", "run", scriptId, "--task", customTask.taskId]);
  exercise("preset.audit", ["preset", "audit"]);
  prepare("terminal custom preset task", ["task", "transition", customTask.taskId, "cancelled", "--force", "--reason", "fixture preset uninstall"]);
  exercise("preset.uninstall", ["preset", "uninstall", "coldstart-action", "--project"]);

  const templates = exercise("template.list", ["template", "list"]);
  const templateRef = findTemplateRef(templates.receipt) ?? "task_plan";
  exercise("template.render", ["template", "render", templateRef, "--locale", "en-US"]);

  const primarySession = "coldstart-primary-session";
  const retireSession = "coldstart-retire-session";
  const closeoutSession = "coldstart-closeout-session";
  const transcripts = createSessionTranscripts([primarySession, retireSession, closeoutSession]);
  exercise("session.export", sessionExportArgs(primarySession, transcripts[primarySession]));
  prepare("export retire session", sessionExportArgs(retireSession, transcripts[retireSession]));
  prepare("export closeout session", sessionExportArgs(closeoutSession, transcripts[closeoutSession]));
  exercise("session.show", ["session", "show", primarySession]);
  exercise("session.backfill", ["session", "backfill", "--runtime", "codex", "--limit", "20"]);
  exercise("session.sync", ["session", "sync", "--apply"]);
  exercise("event.append", ["event", "append", "--session", "coldstart-event-session", "--kind", "tool", "--tool", "ha", "--summary", "Exhaustive CLI exercise"]);
  exercise("event.list", ["event", "list", "--session", "coldstart-event-session"]);
  exercise("diagnostics.command-usage", ["diagnostics", "command-usage"]);

  const started = exercise("task.start", ["task", "start", tasks.primary.taskId], { env: sessionEnv(primarySession) });
  const primaryExecutionId = stringOr(receiptValue(started, "executionId"), "exe_MISSING_PRIMARY");
  exercise("execution.show", ["execution", "show", primaryExecutionId]);
  exercise("execution.list", ["execution", "list", "--task", tasks.primary.taskId]);

  const retireStarted = prepare("start retire execution", ["task", "start", tasks.retire.taskId], { env: sessionEnv(retireSession) });
  const retireExecutionId = stringOr(receiptValue(retireStarted, "executionId"), "exe_MISSING_RETIRE");
  exercise("task.holder", ["task", "holder", tasks.retire.taskId]);
  exercise("task.release", ["task", "release", tasks.retire.taskId]);
  exercise("task.retire-execution", ["task", "retire-execution", tasks.retire.taskId, "--execution-id", retireExecutionId, "--reason", "Exercise explicit abandoned round retirement."]);

  const submissionPath = path.join(fixture.base, "submission.json");
  writeJson(submissionPath, submissionPacket());
  exercise("task.submit", ["task", "submit", tasks.primary.taskId, "--from-file", submissionPath], { env: sessionEnv(primarySession) });
  exercise("task.code-doc-reconcile", ["task", "code-doc", "reconcile", tasks.primary.taskId, "--commit", publicHead, "--path", "README.md", "--force"]);
  prepare("publish primary reconciliation", ["materializer", "run"]);
  const consent = exercise("task.consent-record", ["task", "consent-record", tasks.primary.taskId, "--execution-id", primaryExecutionId, "--asserted", "Fixture owner approved through the isolated local channel.", "--consent-action", "approve_execution", "--consent-action", "complete_task"]);
  const consentId = stringOr(receiptValue(consent, "consentId"), "consent_MISSING");
  const reviewed = exercise("task.review-execution", [
    "task", "review-execution", tasks.primary.taskId, "--execution-id", primaryExecutionId,
    "--verdict", "approved", "--findings", "All exercised evidence is present.", "--rationale", "The isolated run demonstrates the applicable surface.",
    "--consent", consentId, "--evidence-checked", "ev_cli_1", "--acknowledge-archive-warnings"
  ]);
  const reviewId = stringOr(receiptValue(reviewed, "reviewId"), "rev_MISSING");
  exercise("review.show", ["review", "show", reviewId]);
  const approvalPath = path.join(fixture.base, "approval.json");
  writeJson(approvalPath, approvalPacket(primaryExecutionId, publicHead));
  exercise("task.complete", ["task", "complete", tasks.primary.taskId, "--approve", "--from-file", approvalPath], { env: sessionEnv(primarySession) });
  exercise("audit.provenance", ["audit", "provenance", "--task", tasks.primary.taskId]);

  const closeoutStarted = prepare("start closeout task", ["task", "start", tasks.closeout.taskId], { env: sessionEnv(closeoutSession) });
  const closeoutExecutionId = stringOr(receiptValue(closeoutStarted, "executionId"), "exe_MISSING_CLOSEOUT");
  prepare("submit closeout task", ["task", "submit", tasks.closeout.taskId, "--from-file", submissionPath], { env: sessionEnv(closeoutSession) });
  prepare("reconcile closeout task", ["task", "code-doc", "reconcile", tasks.closeout.taskId, "--commit", publicHead, "--path", "README.md", "--force"]);
  prepare("publish closeout reconciliation", ["materializer", "run"]);
  const closeoutPacketPath = path.join(fixture.base, "closeout-packet.json");
  writeJson(closeoutPacketPath, { ...submissionPacket(), ...approvalPacket(closeoutExecutionId, publicHead) });
  exercise("task.closeout", ["task", "closeout", tasks.closeout.taskId, "--from-file", closeoutPacketPath], { env: sessionEnv(closeoutSession) });

  writeText(path.join(fixture.root, tasks.review.packagePath, "review.md"), "# Review\n\n## Verdict\n\nPASS\n\n## Findings\n\nNo open findings.\n");
  exercise("task.review", ["task", "review", tasks.review.taskId]);
  exercise("task.archive", ["task", "archive", tasks.archive.taskId, "--reason", "Fixture archive lifecycle exercised."]);
  exercise("task.supersede", ["task", "supersede", tasks.supersede.taskId, "--title", "Replacement cold-start task", "--reason", "Fixture replacement lifecycle exercised."]);
  exercise("task.delete", ["task", "delete", "--soft", tasks.disposition.taskId, "--reason", "Fixture tombstone lifecycle exercised."]);
  exercise("task.reopen", ["task", "reopen", tasks.disposition.taskId, "--reason", "Fixture reopen lifecycle exercised."]);
  exercise("cas.gc", ["cas", "gc", "--apply"]);
  exercise("governance.rebuild", ["governance", "rebuild", "--apply"]);
  exercise("graph.graph", ["graph", "--out", path.join(fixture.root, "coldstart-relations.html")]);
  exercise("git.diff", ["git", "diff", "--base", "HEAD"]);
  exercise("module.unregister", ["module", "unregister", "coldstart-module"]);
  exercise("daemon.restart", ["daemon", "restart", "--user-root", fixture.daemonUserRoot], { timeoutMs: 45_000 });
  exercise("daemon.refresh", ["daemon", "refresh", "--user-root", fixture.daemonUserRoot, "--reason", "coldstart exhaustive fixture"], { timeoutMs: 45_000 });
  exercise("daemon.stop", ["daemon", "stop", "--timeout-ms", "10000", "--user-root", fixture.daemonUserRoot], { timeoutMs: 20_000 });
}

function exercise(id, args, options = {}) {
  if (results.has(id)) throw new Error(`Operation already recorded: ${id}`);
  const manifest = coldstartOperationManifest.find((row) => row.id === id);
  if (!manifest) throw new Error(`Operation is absent from manifest: ${id}`);
  if (manifest.excludedByDesign) throw new Error(`Excluded operation must not execute: ${id}`);
  const runtime = discovery.operations.find((operation) => operation.id === id);
  const invoked = runCli(fixture, args, options);
  const record = invoked.exitCode === 0 && invoked.receiptOk ? settleCliWrite(fixture, invoked) : invoked;
  const result = {
    ...manifest,
    commandTemplate: runtime?.capability.command ?? null,
    status: record.exitCode === 0 && record.receiptOk ? "passed" : "failed",
    ...record
  };
  Object.assign(result, classifyColdstartOperation(
    result,
    knownIssues.issues.get(id),
    knownIssues.invalid.find((entry) => entry.operationId === id)
  ));
  results.set(id, result);
  process.stderr.write(`[${result.conclusion}] ${id} exit=${String(result.exitCode)} ok=${String(result.receiptOk)}${result.errorCode ? ` code=${result.errorCode}` : ""}\n`);
  return result;
}

function prepare(label, args, options = {}) {
  const invoked = runCli(fixture, args, options);
  const record = invoked.exitCode === 0 && invoked.receiptOk ? settleCliWrite(fixture, invoked) : invoked;
  setupResults.push({ label, ...record });
  process.stderr.write(`[setup:${record.exitCode === 0 && record.receiptOk ? "passed" : "failed"}] ${label}${record.errorCode ? ` code=${record.errorCode}` : ""}\n`);
  if (record.exitCode !== 0 || record.receiptOk !== true) {
    throw new Error(`Infrastructure setup failed at ${label}: ${record.errorCode ?? record.errorHint ?? `exit ${String(record.exitCode)}`}`);
  }
  return record;
}

function prepareTask(title, extraArgs = []) {
  return taskFrom(prepare(`create task: ${title}`, taskCreateArgs(title, extraArgs)), title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-"));
}

function taskCreateArgs(title, extraArgs = []) {
  return ["task", "create", "--title", title, "--vertical", "software/coding", ...extraArgs, ...(extraArgs.includes("--preset") ? [] : ["--preset", "standard-task"])];
}

function taskFrom(record, fallback) {
  const receipt = record?.receipt ?? record;
  const packagePath = receipt?.details?.pathsByRole?.package
    ?? receipt?.paths?.find?.((entry) => entry?.role === "package")?.path;
  return {
    taskId: stringOr(receiptValue(record, "taskId"), `task_MISSING_${fallback}`),
    packagePath: stringOr(packagePath, `harness/tasks/task_MISSING_${fallback}`)
  };
}

function authoredPath(task, filename) {
  return `${task.packagePath.replace(/^harness\//u, "")}/${filename}`;
}

function writeTaskDocuments(task) {
  const directory = path.join(fixture.root, task.packagePath);
  if (!existsSync(directory)) return;
  writeText(path.join(directory, "task_plan.md"), substantivePlan());
  writeText(path.join(directory, "closeout.md"), closeoutBody("The isolated operation exercise completed with recorded evidence."));
}

function writePresetSource() {
  const source = path.join(fixture.base, "coldstart-action-preset");
  const scripts = path.join(source, "scripts");
  mkdirSync(scripts, { recursive: true });
  writeJson(path.join(source, "preset.json"), {
    schema: "preset-manifest/v2",
    id: "coldstart-action",
    title: "Cold-start Action",
    vertical: "software/coding",
    version: "0.1.0",
    kind: "process-action",
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [],
    entrypoints: {
      plan: { type: "script", command: "scripts/plan.mjs", reads: ["{{outputRoot}}/**"], writes: ["{{outputRoot}}/**"] }
    },
    profiles: [{ id: "baseline", title: "Baseline", checkerProfile: "standard", completionGates: [], templateSelections: [] }],
    defaultProfile: "baseline"
  });
  const scriptPath = path.join(scripts, "plan.mjs");
  writeText(scriptPath, [
    "#!/usr/bin/env node",
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "let target = process.env.HARNESS_SCRIPT_RESULT;",
    "if (!target) {",
    "  const context = JSON.parse(readFileSync(process.env.HARNESS_PRESET_CONTEXT, 'utf8'));",
    "  const artifacts = path.join(context.outputRoot, 'artifacts');",
    "  mkdirSync(artifacts, { recursive: true });",
    "  target = path.join(artifacts, 'preset-result.json');",
    "}",
    "writeFileSync(target, JSON.stringify({ schema: 'script-result/v1', ok: true, report: {}, produced: [] }));",
    ""
  ].join("\n"));
  chmodSync(scriptPath, 0o755);
  return source;
}

function createSessionTranscripts(sessionIds) {
  const directory = path.join(fixture.home, ".codex/sessions");
  mkdirSync(directory, { recursive: true });
  return Object.fromEntries(sessionIds.map((sessionId, index) => {
    const transcriptPath = path.join(directory, `${sessionId}.jsonl`);
    writeText(transcriptPath, [
      JSON.stringify({ timestamp: `2026-08-08T00:00:0${index}.000Z`, type: "event_msg", payload: { type: "user_message", message: `Exercise ${sessionId}` } }),
      JSON.stringify({ timestamp: `2026-08-08T00:00:1${index}.000Z`, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "verified" }] } }),
      ""
    ].join("\n"));
    return [sessionId, transcriptPath];
  }));
}

function sessionExportArgs(sessionId, transcriptPath) {
  return ["session", "export", "--session", sessionId, "--runtime", "codex", "--source", "runtime", "--detected-at", "2026-08-08T00:00:00.000Z", "--transcript-file", transcriptPath];
}

function sessionEnv(sessionId) {
  return { CODEX_THREAD_ID: sessionId, CODEX_SESSION_ID: sessionId };
}

function submissionPacket() {
  return {
    completionClaim: "The cold-start CLI operation is exercised.",
    deliverables: ["Structured exhaustive report"],
    outputs: ["Cold-start execution evidence"],
    verificationNotes: ["The isolated daemon path was invoked."],
    knownGaps: [],
    residualRisks: []
  };
}

function approvalPacket(executionId, commit) {
  return {
    executionId,
    verdict: "approved",
    findings: "The submitted evidence and public code anchor satisfy this fixture task.",
    evidenceChecked: ["ev_cli_1"],
    rationale: "The isolated daemon path provides direct cold-start evidence.",
    archiveWarningsAcknowledged: true,
    consentAssertedRationale: "Fixture owner approval was received through the isolated local channel.",
    consentActions: ["approve_execution", "complete_task"],
    commit,
    paths: ["README.md"],
    ci: "passed",
    reviewerId: "person_coldstart_exhaustive_2bfb590688",
    externalCheckpointRefs: []
  };
}

function substantivePlan() {
  return [
    "# Substantive Plan", "", "Task Contract: harness-task v1", "", "## Brief", "", "Exercise one cold-start CLI operation.", "",
    "## Goal", "", "Produce and verify a concrete isolated receipt.", "", "## Context", "", "Use the temporary project and fixture daemon.", "",
    "## Constraints", "", "Keep all writes inside the temporary fixture roots.", "", "## Checkpoint", "", "Stop if isolation cannot be proven.", "",
    "## CI/Gate Authority Stop Condition", "", "This fixture does not alter gate authority.", "", "## Implementation Plan", "", "- Prepare state, invoke the operation, and record its receipt.", "",
    "## Verification", "", "- Inspect exit code, receipt ok, persisted output, and cleanup.", ""
  ].join("\n");
}

function closeoutBody(summary) {
  return `# Closeout\n\n## Summary\n\n${summary}\n\n## Verification\n\nThe disposable fixture captured the command receipt.\n\n## Residual Risk\n\nNo fixture state is retained.\n`;
}

function findScriptId(receipt) {
  return findObject(receipt, (value) => typeof value.id === "string" && value.id.includes("coldstart-action"))?.id;
}

function findTemplateRef(receipt) {
  const row = findObject(receipt, (value) => ["templateRef", "ref", "id"].some((key) => typeof value[key] === "string"));
  return row?.templateRef ?? row?.ref ?? row?.id;
}

function findRelationId(receipt, decisionId, relationType, targetRef) {
  return findObject(receipt, (value) => value.relationType === relationType
    && typeof value.sourceRef === "string"
    && value.sourceRef.startsWith(`decision/${decisionId}/`)
    && value.state === "active"
    && (!targetRef || value.targetRef === targetRef)
    && typeof value.relationId === "string")?.relationId;
}

function findObject(root, predicate) {
  const queue = [root];
  const seen = new Set();
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (!Array.isArray(value) && predicate(value)) return value;
    for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
  }
  return undefined;
}

function verifyInventory(runtime) {
  const expected = coldstartOperationManifest.map((row) => row.id).sort();
  const actual = runtime.operations.map((row) => row.id).sort();
  if (runtime.kindCount !== 35 || runtime.opCount !== 121 || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Capability inventory mismatch: expected 35/121, received ${runtime.kindCount}/${runtime.opCount}; missing=${expected.filter((id) => !actual.includes(id)).join(",")}; extra=${actual.filter((id) => !expected.includes(id)).join(",")}`);
  }
}

function buildReport(cleanup) {
  for (const row of coldstartOperationManifest) {
    if (results.has(row.id)) continue;
    results.set(row.id, {
      ...row,
      status: "failed",
      commandTemplate: discovery?.operations.find((operation) => operation.id === row.id)?.capability.command ?? null,
      commandLine: null,
      exitCode: null,
      receiptOk: false,
      errorCode: "exercise_aborted_before_invocation",
      errorHint: fatalError ?? "The runner did not reach this operation.",
      conclusion: "infrastructure_invalid",
      knownIssue: null,
      detail: "The exercise aborted before this operation was invoked.",
      stdout: "",
      stderr: ""
    });
  }
  const ordered = coldstartOperationManifest.map((row) => results.get(row.id));
  const conclusions = buildColdstartConclusionMatrix({
    results: ordered,
    setupResults,
    advertisedFailures: discovery?.advertisedFailures ?? [],
    invalidMarkers: knownIssues.invalid,
    fatalError
  });
  const signatureInput = ordered.map(({ id, conclusion, errorCode }) => `${id}:${conclusion ?? "excluded-by-design"}:${errorCode ?? "-"}`).join("\n");
  return {
    schema: "coldstart-exhaustive-report/v2",
    generatedAt: new Date().toISOString(),
    node: process.version,
    cliEntry: "packages/cli/dist/cli/src/index.js",
    fixture: {
      root: fixture.root,
      daemonUserRoot: fixture.daemonUserRoot,
      daemonId: fixture.daemonId,
      userRootExternal: !fixture.daemonUserRoot.startsWith(`${fixture.root}${path.sep}`)
    },
    discovery: discovery ?? { kindCount: 0, opCount: 0, index: [], kinds: [], operations: [], advertisedFailures: [] },
    inventory: coldstartOperationManifest.map((row) => ({
      ...row,
      commandTemplate: discovery?.operations.find((operation) => operation.id === row.id)?.capability.command ?? null
    })),
    coverage: {
      total: ordered.length,
      passed: conclusions.passed.count,
      failed: ordered.filter((result) => ["product_failure", "infrastructure_invalid", "known_issue_drift", "fixed_candidate"].includes(result.conclusion)).length,
      knownIssue: conclusions.known_issue.count,
      excludedByDesign: ordered.filter((result) => result.status === "excluded-by-design").length
    },
    conclusions,
    knownIssues: {
      active: [...knownIssues.issues.values()].map(({ file: _file, ...marker }) => marker),
      invalid: knownIssues.invalid
    },
    signatureInput,
    signature: createHash("sha256").update(signatureInput).digest("hex"),
    results: ordered,
    setupResults,
    fatalError,
    cleanup
  };
}

function parseReportPath(args) {
  const index = args.indexOf("--report");
  const selected = index >= 0 ? args[index + 1] : "/tmp/coldstart-exhaustive-report.md";
  if (!selected || !path.isAbsolute(selected)) throw new Error("--report must be followed by an absolute path");
  return selected;
}

function jsonReportPath(markdownPath) {
  return markdownPath.endsWith(".md") ? `${markdownPath.slice(0, -3)}.json` : `${markdownPath}.json`;
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
