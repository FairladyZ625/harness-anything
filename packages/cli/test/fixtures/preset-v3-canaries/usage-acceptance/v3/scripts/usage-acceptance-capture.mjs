#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const context = readContext();
const tasks = readCapability("tasks").tasks;
const decisions = readCapability("decisions").decisions;
const featureTaskId = context.inputs.featureTaskId;
const persona = String(context.inputs.persona ?? "").trim() || "first-time user of the feature under review";
const surface = String(context.inputs.surface ?? "gui").trim() || "gui";
const scenario = String(context.inputs.scenario ?? "").trim();
const featureTask = tasks.find((task) => task.taskId === featureTaskId) ?? null;
const intentSources = decisions.map((decision) => ({
  ref: decision.ref,
  title: decision.title,
  sourcePath: decision.sourcePath
}));
const findings = {
  schema: "usage-acceptance-findings/v1",
  featureTaskId,
  persona,
  surface,
  scenario: scenario || "(fill: the job-to-be-done, derived from intentSources — NOT from the implementation)",
  intentSources: intentSources.map((source) => ({ ref: source.ref, title: source.title, path: source.sourcePath })),
  findings: [],
  semanticQuestions: [],
  verdict: "pending",
  capturedAt: new Date().toISOString()
};
writeFileSync(outputRepresentation("usage-acceptance-findings", "application/json").path, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
const reportRepresentation = outputRepresentation("usage-acceptance-report", "text/markdown");
writeFileSync(reportRepresentation.path, renderReport({ featureTask, findings, intentSources }), "utf8");
const report = {
  schema: "usage-acceptance-capture/v1",
  taskId: context.run.taskId,
  featureTaskId,
  status: "captured",
  generatedAt: new Date().toISOString(),
  featureTaskTitle: featureTask?.title ?? null,
  intentSourceCount: intentSources.length,
  shotsDir: `${reportRepresentation.logicalPath.slice(0, reportRepresentation.logicalPath.lastIndexOf("/"))}/shots`
};
writeResult({
  schema: "script-result/v1",
  ok: true,
  rows: intentSources.length,
  report,
  produced: ["usage-acceptance-findings", "usage-acceptance-report"]
});

function renderReport({ featureTask: task, findings: value, intentSources: sources }) {
  const lines = [
    "# Usage Acceptance Report", "",
    `- Feature task: ${value.featureTaskId}${task?.title ? ` — ${task.title}` : ""}`,
    `- Persona: ${value.persona}`, `- Surface: ${value.surface}`, `- Verdict: ${value.verdict}`,
    "", "## Scenario", "", value.scenario, "",
    "## Intent Sources (read these to reconstruct a satisfied user — do NOT read the implementation)", ""
  ];
  if (sources.length === 0) lines.push("- (none auto-found; open the spawning decision(s) and task goal by hand)");
  else for (const source of sources) lines.push(`- ${source.ref} — ${source.title} (${source.sourcePath})`);
  lines.push(
    "", "## How to capture (eyes-agent)", "",
    "- GUI: drive `packages/gui/e2e/harness-fixture.mjs` against a REAL persona ledger",
    "  (never the hermetic smoke fixture), with `HARNESS_GUI_E2E_SHOTS` set to this",
    "  package's `artifacts/shots/`. Walk the scenario as the persona would.",
    "- CLI / multi-actor business flows: run the real end-to-end as distinct actors;",
    "  tee the transcript into `artifacts/`.",
    "- Read each screenshot; narrate friction from the USER's angle.",
    "", "## Findings (fill usage-acceptance-findings.json; severity: blocker | friction | nit)", "",
    "- Each finding needs: expected-vs-actual + an evidence anchor (a real shot/transcript path).",
    "- Blocker = cannot complete the intended job. Friction = completes but confusing/mismatch.",
    "- A report with zero friction and no off-happy-path attempts is treated as suspect by `check`.",
    "", "## Semantic Questions (escalate to human only when the ledger can't resolve intent)", "",
    "- Intent ambiguity / decision conflict / scope creep / cross-collaboration constraint.",
    "", "## Verdict", "",
    "- Set `verdict` to `pass` only after every blocker is fixed & re-walked; log residual friction as facts."
  );
  return `${lines.join("\n")}\n`;
}

function readContext() {
  const filename = process.env.HARNESS_PRESET_CONTEXT;
  if (!filename) throw new Error("HARNESS_PRESET_CONTEXT is required");
  return JSON.parse(readFileSync(filename, "utf8"));
}

function readCapability(id) {
  const handle = context.capabilities.reads[id]?.[0];
  if (!handle) throw new Error(`missing ${id} capability handle`);
  return JSON.parse(readFileSync(handle.path, "utf8"));
}

function outputRepresentation(id, mediaType) {
  const writer = context.capabilities.writes["task-artifacts"]?.[0];
  const representation = writer?.artifacts?.[id]?.representations?.find((entry) => entry.mediaType === mediaType);
  if (!representation) throw new Error(`missing ${id} ${mediaType} writer`);
  return representation;
}

function writeResult(value) {
  writeFileSync(context.result.path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
