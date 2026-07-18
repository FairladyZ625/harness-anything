#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "../packages/cli/src/cli/parse-args.ts";
import { productionAuthorityTypedIngressKinds } from "../packages/cli/src/cli/command-spec/index.ts";
import { commandRunPayload } from "../packages/cli/src/daemon/client.ts";
import { createCliCommandService } from "../packages/cli/src/daemon/command-service.ts";

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

    const bodyProbe = parseArgs(["--root", rootDir, "decision", "amend", missingDecision, "--body", "undeclared body"]);
    if (bodyProbe.ok) {
      findings.push("decision-amend: --body is accepted by the CLI but body is not an amendable DecisionPackage field");
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
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
  return findings;
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

function fixtureRuntime() {
  return {
    enqueueInteractiveWrite: async (request) => ({
      flush: { reason: "cli-daemon-parity-gate", opCount: request.ops.length, committed: request.ops.length > 0 }
    }),
    status: () => ({}),
    enqueueMaterializerBatch: async () => ({ branches: [] })
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
