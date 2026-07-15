#!/usr/bin/env node
// usage-acceptance :: scaffold
//
// Deterministic HANDS-side of a usage-acceptance run. It does NOT judge — it
// assembles the intent-context bundle a vision/eyes agent needs, then scaffolds
// the findings artifacts the agent fills in. The split is deliberate
// (hands = deterministic capture; eyes = agent semantic judgment).
//
// What it does now (real work, not a placeholder):
//   1. resolve the feature task under review from context.taskIndex,
//   2. collect the decisions that spawned it (intent authority, in priority
//      order: task goal -> spawning decisions -> facts -> transcripts),
//   3. emit artifacts/usage-acceptance-report.md   (editorial scaffold for humans),
//      emit artifacts/usage-acceptance-findings.json (structured skeleton the
//      eyes-agent fills; consumed by the `check` entrypoint / gate),
//      emit artifacts/preset-result.json           (machine envelope).
//
// GUI capture guidance (the actual screenshots) is written INTO the report so
// the eyes-agent drives packages/gui/e2e/harness-fixture.mjs against a REAL
// persona ledger (never the hermetic smoke fixture) with HARNESS_GUI_E2E_SHOTS
// pointed at artifacts/shots/. Driving is deferred to the agent step because it
// is flaky/expensive and must run under a real scenario, not in this script.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT ?? process.env.HARNESS_SCRIPT_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const paths = context.paths ?? {};
const inputs = context.inputs ?? {};
const outputRoot = context.outputRoot;
const artifactsDir = path.join(outputRoot, "artifacts");
const shotsDir = path.join(artifactsDir, "shots");
mkdirSync(shotsDir, { recursive: true });

const featureTaskId = resolveInput(inputs.featureTaskId, context.taskId);
const persona = String(inputs.persona ?? "").trim() || "first-time user of the feature under review";
const surface = String(inputs.surface ?? "gui").trim() || "gui";
const scenario = String(inputs.scenario ?? "").trim();

const featureTask = findFeatureTask(featureTaskId);
const intentSources = collectIntentSources(featureTaskId);

const findings = {
  schema: "usage-acceptance-findings/v1",
  featureTaskId,
  persona,
  surface,
  scenario: scenario || "(fill: the job-to-be-done, derived from intentSources — NOT from the implementation)",
  intentSources: intentSources.map((source) => ({ ref: source.ref, title: source.title, path: source.sourcePath })),
  // Eyes-agent fills the rest. `check` validates it.
  findings: [],          // { id, severity: blocker|friction|nit, expected, actual, evidence: [".../shots/x.png"], resolution }
  semanticQuestions: [], // { question, escalate: bool, reason }
  verdict: "pending",    // pending | pass | blocked
  capturedAt: new Date().toISOString()
};

writeFileSync(path.join(artifactsDir, "usage-acceptance-findings.json"), `${JSON.stringify(findings, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "usage-acceptance-report.md"), renderReport({ featureTask, findings, intentSources }), "utf8");

const report = {
  schema: "usage-acceptance-capture/v1",
  taskId: context.taskId,
  featureTaskId,
  status: "captured",
  generatedAt: new Date().toISOString(),
  featureTaskTitle: featureTask?.title ?? null,
  intentSourceCount: intentSources.length,
  shotsDir: relative(shotsDir)
};
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok: true,
  rows: intentSources.length,
  report,
  produced: [
    "artifacts/usage-acceptance-findings.json",
    "artifacts/usage-acceptance-report.md"
  ]
}, null, 2)}\n`, "utf8");

function findFeatureTask(taskId) {
  if (!Array.isArray(context.taskIndex)) return null;
  const row = context.taskIndex.find((task) => task.taskId === taskId);
  if (!row) return null;
  return {
    taskId: row.taskId,
    title: row.title ?? row.goal ?? null,
    preset: row.preset ?? null,
    packagePath: row.packagePath ?? row.indexPath ?? null
  };
}

// Intent authority (ADR: task goal -> spawning decisions -> facts -> transcripts).
// We surface the decisions that mention this task so the eyes-agent reads the
// real "why", instead of re-deriving intent from code.
function collectIntentSources(taskId) {
  const decisionsRoot = paths.decisionsRoot;
  if (!decisionsRoot || !existsSync(decisionsRoot)) return [];
  const sources = [];
  for (const filePath of walkFiles(decisionsRoot)) {
    if (!/\.(json|md)$/u.test(filePath)) continue;
    let text;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(taskId)) continue;
    sources.push({
      ref: `decision/${path.basename(path.dirname(filePath))}`,
      title: firstHeading(text) ?? path.basename(filePath),
      sourcePath: relative(filePath)
    });
  }
  return dedupeByRef(sources);
}

function renderReport({ featureTask, findings, intentSources }) {
  const lines = [
    "# Usage Acceptance Report",
    "",
    `- Feature task: ${findings.featureTaskId}${featureTask?.title ? ` — ${featureTask.title}` : ""}`,
    `- Persona: ${findings.persona}`,
    `- Surface: ${findings.surface}`,
    `- Verdict: ${findings.verdict}`,
    "",
    "## Scenario",
    "",
    findings.scenario,
    "",
    "## Intent Sources (read these to reconstruct a satisfied user — do NOT read the implementation)",
    ""
  ];
  if (intentSources.length === 0) {
    lines.push("- (none auto-found; open the spawning decision(s) and task goal by hand)");
  } else {
    for (const source of intentSources) lines.push(`- ${source.ref} — ${source.title} (${source.sourcePath})`);
  }
  lines.push(
    "",
    "## How to capture (eyes-agent)",
    "",
    "- GUI: drive `packages/gui/e2e/harness-fixture.mjs` against a REAL persona ledger",
    "  (never the hermetic smoke fixture), with `HARNESS_GUI_E2E_SHOTS` set to this",
    "  package's `artifacts/shots/`. Walk the scenario as the persona would.",
    "- CLI / multi-actor business flows: run the real end-to-end as distinct actors;",
    "  tee the transcript into `artifacts/`.",
    "- Read each screenshot; narrate friction from the USER's angle.",
    "",
    "## Findings (fill usage-acceptance-findings.json; severity: blocker | friction | nit)",
    "",
    "- Each finding needs: expected-vs-actual + an evidence anchor (a real shot/transcript path).",
    "- Blocker = cannot complete the intended job. Friction = completes but confusing/mismatch.",
    "- A report with zero friction and no off-happy-path attempts is treated as suspect by `check`.",
    "",
    "## Semantic Questions (escalate to human only when the ledger can't resolve intent)",
    "",
    "- Intent ambiguity / decision conflict / scope creep / cross-collaboration constraint.",
    "",
    "## Verdict",
    "",
    "- Set `verdict` to `pass` only after every blocker is fixed & re-walked; log residual friction as facts."
  );
  return `${lines.join("\n")}\n`;
}

function resolveInput(value, fallback) {
  if (typeof value !== "string") return fallback;
  return /^\{\{.+\}\}$/u.test(value.trim()) || value.trim() === "" ? fallback : value.trim();
}

function firstHeading(text) {
  const md = /^#\s+(.+)$/mu.exec(text);
  if (md) return md[1].trim();
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.title === "string") return parsed.title;
  } catch {
    // not json
  }
  return null;
}

function dedupeByRef(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.ref)) continue;
    seen.add(item.ref);
    out.push(item);
  }
  return out;
}

function walkFiles(root) {
  if (!root || !existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  }).sort();
}

function relative(filePath) {
  return path.relative(paths.rootDir ?? outputRoot, filePath).split(path.sep).join("/");
}
