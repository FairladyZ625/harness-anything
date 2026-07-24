#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../packages/cli/src/cli/parse-args.ts";
import { productionAuthorityTypedIngressKinds } from "../packages/cli/src/cli/command-spec/index.ts";
import { commandRunPayload } from "../packages/cli/src/daemon/client.ts";
import { createDaemonCommandService, productionObservedWriteAttemptIntent } from "@harness-anything/daemon";
import { cliDaemonCommandHostServices } from "../packages/cli/src/composition/daemon-command-host-services.ts";
import { resolveHostedDocument } from "@harness-anything/daemon";
import { taskEntityId } from "../packages/kernel/src/index.ts";

const missingTask = "task_01KXT3E1MN1VBS64DCNZ4VX81B";
const missingExecution = "exe_01KXT3E1MN1VBS64DCNZ4VX81C";
const missingDecision = "dec_01KXT3E1MN1VBS64DCNZ4VX81D";

const cases = {
  "session-export": ["session", "export"],
  "new-task": ["task", "create", "--title", "Parity task", "--dry-run"],
  "task-claim": ["task", "claim", missingTask],
  "status-set": ["task", "transition", missingTask, "active"],
  "progress-append": ["task", "progress", "append", missingTask, "--text", "parity"],
  "task-amend": ["task", "amend", missingTask, "--set", "queue:ready"],
  "task-archive": ["task", "archive", missingTask, "--reason", "parity"],
  "task-supersede": ["task", "supersede", missingTask, "--by", `${missingTask}2`, "--confirm", missingTask, "--reason", "parity"],
  "task-delete": ["task", "delete", "--soft", missingTask, "--reason", "parity"],
  "task-reopen": ["task", "reopen", missingTask, "--reason", "parity"],
  "task-retire-execution": ["task", "retire-execution", missingTask, "--execution-id", missingExecution, "--reason", "parity"],
  "task-relate": ["task", "relate", missingTask, "depends-on", `${missingTask}2`, "--rationale", "parity"],
  "task-code-doc-reconcile": ["task", "code-doc", "reconcile", missingTask, "--commit", "0123456789abcdef0123456789abcdef01234567", "--path", "README.md"],
  "task-consent-record": ["task", "consent-record", missingTask, "--execution-id", missingExecution, "--utterance", "Approved"],
  "task-review-execution": ["task", "review-execution", missingTask, "--execution-id", missingExecution, "--verdict", "dismissed", "--findings", "none", "--rationale", "parity"],
  "task-complete": ["task", "complete", missingTask],
  "decision-propose": ["decision", "propose", "--id", "dec_01KXT3E1MN1VBS64DCNZ4VX81E", "--title", "Parity decision", "--question", "Equivalent?", "--chosen", "Yes", "--rejected", "No", "--why-not", "Not selected", "--dry-run"],
  "decision-transition": ["decision", "transition", "rejected", missingDecision],
  "decision-relate": ["decision", "relate", missingDecision, "--anchor", "CH1", "--type", "derives", "--target", `task/${missingTask}`, "--rationale", "parity"],
  "decision-amend": ["decision", "amend", missingDecision, "--title", "Parity amendment"],
  "decision-relation-retire": ["decision", "relation", "retire", missingDecision, "--relation", "rel_0123456789abcdef"],
  "decision-relation-replace": ["decision", "relation", "replace", missingDecision, "--relation", "rel_0123456789abcdef", "--anchor", "CH1", "--type", "relates", "--target", "decision/dec_MISSING", "--rationale", "parity"],
  "record-fact": ["fact", "record", "--task", missingTask, "--statement", "Parity fact"],
  "fact-invalidate": ["fact", "invalidate", "--task", missingTask, "--id", "F-DEADBEEF", "--by", "F-FEEDFACE", "--rationale", "parity"],
  "module-register": ["module", "register", "parity", "--title", "Parity module", "--scope", "packages/parity/**"],
  "module-unregister": ["module", "unregister", "missing"],
  "module-step": ["module", "step", "missing", "P-1", "--state", "done"]
};

const actor = {
  personId: "person_parity",
  displayName: "Parity Gate",
  primaryEmail: "parity@example.test",
  providerId: "transport-derived/v1",
  resolvedCredential: { kind: "unix-socket-owner-boundary", issuer: "parity-gate", subject: "fixture" }
};

const session = {
  runtime: "codex",
  sessionId: "cli-daemon-parity-gate",
  source: "runtime",
  detectedAt: "2026-07-19T00:00:00.000Z"
};

const createCliCommandService = (runtime, options = {}) =>
  createDaemonCommandService(runtime, cliDaemonCommandHostServices, options);

export async function checkCliDaemonParity() {
  const rootDir = makeRoot();
  const findings = [];
  try {
    const declared = Object.keys(cases).sort();
    const actual = productionAuthorityTypedIngressKinds();
    if (JSON.stringify(declared) !== JSON.stringify(actual)) {
      findings.push(`coverage: expected executable cases for ${actual.join(", ")}; got ${declared.join(", ")}`);
    }

    const service = createCliCommandService(fixtureRuntime());
    for (const [kind, argv] of Object.entries(cases)) {
      const parsed = parseCommand(rootDir, argv);
      if (!parsed.ok) {
        findings.push(`${kind}: CLI arm did not parse: ${parsed.error?.code ?? "unknown"}`);
        continue;
      }
      if (parsed.value.action.kind !== kind) {
        findings.push(`${kind}: CLI arm parsed as ${parsed.value.action.kind}`);
        continue;
      }
      const explicit = wireClone(commandRunPayload(parsed.value, session));
      const omitted = omitDefaultValues(explicit);
      const [omittedReceipt, explicitReceipt] = await Promise.all([
        runArm(service, omitted),
        runArm(service, explicit)
      ]);
      const left = parityOutcome(omittedReceipt);
      const right = parityOutcome(explicitReceipt);
      if (JSON.stringify(left) !== JSON.stringify(right)) {
        findings.push(`${kind}: omitted-default and explicit-default arms diverged; actual=${JSON.stringify(left)} expected=${JSON.stringify(right)}`);
      }
    }

    const bodyProbe = parseArgs(["--root", rootDir, "decision", "amend", missingDecision, "--body", "typed body amendment"]);
    if (!bodyProbe.ok) {
      findings.push(`decision-amend: --body must parse as the typed body amend road (task_01KY297QCMY1K3TFPFHQB0S4QA); got ${bodyProbe.error?.code ?? "unknown"}`);
    }

    const ordinary = await runParsed(service, rootDir, ["decision", "amend", missingDecision, "--title", "Parity amendment"]);
    const dryRun = await runParsed(service, rootDir, ["decision", "amend", missingDecision, "--title", "Parity amendment", "--dry-run"]);
    const ordinaryCode = errorCode(ordinary);
    const dryRunCode = errorCode(dryRun);
    if (ordinaryCode !== "decision_read_failed" || dryRunCode !== ordinaryCode) {
      findings.push(
        `decision-amend --dry-run: negative receipt must preserve the non-dry-run error code; actual=${dryRunCode ?? "success"} expected=${ordinaryCode ?? "decision_read_failed"}`
      );
    }

    await checkDryRunWriteBarrier(findings);
    checkSluggedTaskRelatePathCas(findings);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
  return findings;
}

function checkSluggedTaskRelatePathCas(findings) {
  const rootDir = makeRoot();
  try {
    const authoredRoot = path.join(rootDir, "harness");
    const sourceTaskId = "task_01KXT3E1MN1VBS64DCNZ4VX82B";
    const targetTaskId = "task_01KXT3E1MN1VBS64DCNZ4VX82C";
    seedTask(rootDir, sourceTaskId, "source-slug");
    seedTask(rootDir, targetTaskId, "target-slug");
    const sourcePath = `tasks/${sourceTaskId}/INDEX.md`;
    const targetPath = `tasks/${targetTaskId}/INDEX.md`;
    const intent = productionObservedWriteAttemptIntent({
      action: {
        kind: "task-relate", sourceTaskId, targetTaskId, relationType: "depends-on",
        rationale: "slugged portable-path CAS parity", dryRun: false
      }
    }, {
      opId: "parity-gate", entityId: taskEntityId(sourceTaskId), kind: "doc_write",
      payload: { path: "INDEX.md", body: readFileSync(resolveHostedDocument(authoredRoot, sourcePath).physicalPath, "utf8") }
    }, authoredRoot);
    const declared = intent.declaredPathCas.map((entry) => entry.path);
    if (JSON.stringify(declared) !== JSON.stringify([sourcePath, targetPath])) {
      findings.push(`task-relate slugged path CAS: declared/required paths differ; declared=${JSON.stringify(declared)} required=${JSON.stringify([sourcePath, targetPath])}`);
    }
    for (const portablePath of [sourcePath, targetPath]) {
      const resolved = resolveHostedDocument(authoredRoot, portablePath);
      if (!resolved || path.basename(path.dirname(resolved.physicalPath)) === portablePath.split("/")[1]) {
        findings.push(`task-relate slugged path CAS: shared resolver did not resolve ${portablePath} to a slugged physical task package`);
      }
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

async function checkDryRunWriteBarrier(findings) {
  const rootDir = makeRoot();
  const observed = { interactiveWrites: 0, materializerRuns: 0 };
  try {
    const service = createCliCommandService(fixtureRuntime(observed));
    const dryRun = await runParsed(service, rootDir, ["task", "create", "--title", "Dry-run barrier probe", "--dry-run"]);
    if (!dryRun.ok) findings.push(`dry-run write barrier: dry-run control failed: ${JSON.stringify(parityOutcome(dryRun))}`);
    if (observed.interactiveWrites !== 0 || observed.materializerRuns !== 0) {
      findings.push(`dry-run write barrier: observed persistent activity; interactiveWrites=${observed.interactiveWrites} materializerRuns=${observed.materializerRuns}`);
    }

    const ordinary = await runParsed(service, rootDir, ["task", "create", "--title", "Positive write control"]);
    if (!ordinary.ok) findings.push(`dry-run write barrier: positive control failed: ${JSON.stringify(parityOutcome(ordinary))}`);
    if (observed.interactiveWrites === 0) {
      findings.push("dry-run write barrier: positive control did not reach enqueueInteractiveWrite; probe is blind");
    }

    observed.interactiveWrites = 0;
    observed.materializerRuns = 0;
    const taskId = "task_01KXT3E1MN1VBS64DCNZ4VX82A";
    seedTask(rootDir, taskId);
    const progressDryRun = await runParsed(service, rootDir, ["task", "progress", "append", taskId, "--text", "Dry-run progress probe", "--dry-run"]);
    if (!progressDryRun.ok) findings.push(`progress-append dry-run barrier: dry-run control failed: ${JSON.stringify(parityOutcome(progressDryRun))}`);
    if (observed.interactiveWrites !== 0 || observed.materializerRuns !== 0) {
      findings.push(`progress-append dry-run barrier: observed persistent activity; interactiveWrites=${observed.interactiveWrites} materializerRuns=${observed.materializerRuns}`);
    }
    const progressOrdinary = await runParsed(service, rootDir, ["task", "progress", "append", taskId, "--text", "Positive progress control"]);
    if (!progressOrdinary.ok) findings.push(`progress-append dry-run barrier: positive control failed: ${JSON.stringify(parityOutcome(progressOrdinary))}`);
    if (observed.interactiveWrites === 0) {
      findings.push("progress-append dry-run barrier: positive control did not reach enqueueInteractiveWrite; probe is blind");
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function seedTask(rootDir, taskId, slug = "") {
  const taskDir = path.join(rootDir, "harness", "tasks", `${taskId}${slug ? `-${slug}` : ""}`);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Parity dry-run probe",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref:",
    "  titleSnapshot: Parity dry-run probe",
    "  url:",
    "  bindingCreatedAt: 2026-07-19T00:00:00.000Z",
    `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: codex, sessionId: cli-daemon-parity-gate, boundAt: 2026-07-19T00:00:00.000Z}",
    "---",
    "",
    "# Parity dry-run probe",
    ""
  ].join("\n"));
}

export function parityOutcome(receipt) {
  return {
    ok: receipt?.ok === true,
    command: typeof receipt?.command === "string" ? receipt.command : null,
    errorCode: errorCode(receipt),
    errorHint: errorCode(receipt) === "thrown" && typeof receipt?.error?.hint === "string" ? receipt.error.hint : null,
    dataKeys: Object.keys(receipt?.details?.data ?? {}).sort(),
    pathRoles: Array.isArray(receipt?.paths) ? receipt.paths.map((entry) => entry?.role).filter(Boolean).sort() : []
  };
}

function parseCommand(rootDir, argv) {
  return parseArgs(["--root", rootDir, "--json", ...argv]);
}

async function runParsed(service, rootDir, argv) {
  const parsed = parseCommand(rootDir, argv);
  if (!parsed.ok) return { ok: false, command: argv.slice(0, 2).join(" "), error: parsed.error };
  return runArm(service, wireClone(commandRunPayload(parsed.value, session)));
}

async function runArm(service, payload) {
  try {
    return await service.runCommand(payload, { actor });
  } catch (error) {
    return { ok: false, command: "thrown", error: { code: "thrown", hint: error instanceof Error ? error.message : String(error) } };
  }
}

function errorCode(receipt) {
  return typeof receipt?.error?.code === "string" ? receipt.error.code : null;
}

function omitDefaultValues(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => omitDefaultValues(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([childKey, childValue]) => {
    if (childValue === false || childValue === undefined) return [];
    if (Array.isArray(childValue) && childValue.length === 0 && key === "action") return [];
    return [[childKey, omitDefaultValues(childValue, childKey)]];
  }));
}

function wireClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureRuntime(observed) {
  return {
    enqueueInteractiveWrite: async (request) => {
      if (observed) observed.interactiveWrites += 1;
      return {
        flush: { reason: "cli-daemon-parity-gate", opCount: request.ops.length, committed: request.ops.length > 0 }
      };
    },
    status: () => ({}),
    enqueueMaterializerBatch: async () => {
      if (observed) observed.materializerRuns += 1;
      return { branches: [] };
    }
  };
}

function makeRoot() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-cli-daemon-parity-"));
  const harnessDir = path.join(rootDir, "harness");
  mkdirSync(harnessDir, { recursive: true });
  writeFileSync(path.join(harnessDir, "harness.yaml"), [
    "schema: harness-anything/v1",
    "layout:",
    "  authoredRoot: harness",
    "settings:",
    "  identity:",
    "    personId: person_parity",
    "    displayName: Parity Gate",
    ""
  ].join("\n"));
  writeFileSync(path.join(harnessDir, "modules.json"), '{"schema":"module-registry/v1","modules":[]}\n');
  return rootDir;
}

async function main() {
  const findings = await checkCliDaemonParity();
  if (findings.length > 0) {
    console.error("CLI-daemon executable parity check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`CLI-daemon executable parity check passed (${Object.keys(cases).length} live typed write commands, dual-arm; includes all 25 interface-snapshot rows).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
