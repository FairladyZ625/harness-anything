#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const context = readContext();
const trackedPresets = context.inputs.trackedPresets;
const trackedArtifacts = context.inputs.trackedArtifacts;
const taskPackages = readCapability("tasks").tasks;
const artifactHandles = readCapability("task-artifacts").artifacts;
const runtimeEvents = readCapability("runtime-events");
const generatedInventory = readCapability("generated-artifacts");
const writeJournal = readCapability("write-journal");
const docmap = readCapability("docmap");
const presetEvidence = artifactHandles.flatMap(readPresetEvidence);
const artifactItems = trackedArtifacts.map(evaluateArtifact);
const presetItems = trackedPresets.map(evaluatePreset);
const items = [...presetItems, ...artifactItems];
const summary = {
  green: items.filter((item) => item.status === "green").length,
  yellow: items.filter((item) => item.status === "yellow").length,
  red: items.filter((item) => item.status === "red").length,
  total: items.length
};
const report = {
  schema: "dogfood-utilization-audit/v1",
  taskId: context.run.taskId,
  status: summary.red === 0 ? "passed" : "blocked",
  generatedAt: new Date().toISOString(),
  summary,
  sources: {
    taskPackageCount: taskPackages.length,
    runtimeEventFiles: runtimeEvents.files,
    runtimeEventRows: runtimeEvents.rows,
    presetEvidenceArtifacts: presetEvidence.length
  },
  items,
  orphanCandidates: items.filter((item) => item.status === "red"),
  weakSignals: items.filter((item) => item.status === "yellow")
};
writeFileSync(outputPath("dogfood-utilization-report", "application/json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(outputPath("dogfood-utilization-report", "text/markdown"), renderMarkdown(report), "utf8");
writeResult({
  schema: "script-result/v1",
  ok: summary.red === 0,
  rows: items.length,
  report,
  produced: ["dogfood-utilization-report"],
  error: summary.red === 0 ? undefined : {
    code: "preset_script_result_failed",
    hint: "Dogfood utilization audit found features with no usage signal."
  }
});

function evaluatePreset(presetId) {
  const taskUses = taskPackages.filter((task) => task.preset === presetId);
  const evidenceUses = presetEvidence.filter((artifact) => artifact.presetId === presetId);
  const eventMentions = runtimeEvents.presetMentions[presetId] ?? { count: 0, evidence: [] };
  const genericPresetActions = runtimeEvents.commandCounts["preset-action"] ?? 0;
  const signals = {
    taskUses: taskUses.length,
    presetEvidenceArtifacts: evidenceUses.length,
    runtimeEventMentions: eventMentions.count
  };
  const totalSpecificSignals = signals.taskUses + signals.presetEvidenceArtifacts + signals.runtimeEventMentions;
  const status = totalSpecificSignals > 0 ? "green" : "red";
  return {
    id: presetId,
    kind: "preset",
    status,
    signals,
    genericPresetActions,
    evidence: [
      ...taskUses.slice(0, 5).map((task) => task.sourcePath),
      ...evidenceUses.slice(0, 5).map((artifact) => artifact.sourcePath),
      ...eventMentions.evidence.slice(0, 5)
    ],
    reason: status === "green"
      ? "specific_usage_signal_found"
      : genericPresetActions > 0
        ? "no_specific_usage_signal_found_despite_generic_preset_events"
        : "no_usage_signal_found"
  };
}

function evaluateArtifact(id) {
  const inventory = id === "write-journal"
    ? writeJournal
    : id === "docmap"
      ? docmap
      : generatedInventory.entries.find((entry) => entry.id === id) ?? { files: 0, evidence: [] };
  const signals = id === "runtime-events"
    ? { files: inventory.files, rows: inventory.rows ?? 0 }
    : { files: inventory.files };
  const count = id === "runtime-events" ? signals.rows : signals.files;
  const status = count > 0 ? "green" : "red";
  return {
    id,
    kind: "artifact",
    status,
    signals,
    evidence: inventory.evidence,
    reason: status === "green" ? "artifact_usage_signal_found" : "no_artifact_usage_signal_found"
  };
}

function readPresetEvidence(handle) {
  try {
    const parsed = JSON.parse(readFileSync(handle.path, "utf8"));
    const presetId = inferPresetId(parsed);
    return presetId ? [{ presetId, sourcePath: handle.sourcePath }] : [];
  } catch {
    return [];
  }
}

function inferPresetId(parsed) {
  if (typeof parsed?.presetId === "string") return parsed.presetId;
  const schema = parsed?.report?.schema ?? parsed?.schema;
  if (schema === "doc-canon-drift/v1") return "doc-canon-sync";
  if (schema === "legacy-migration-preset-plan/v1") return "legacy-migration";
  if (schema === "milestone-closeout-parity/v1") return "milestone-closeout";
  if (schema === "milestone-dossier-gather-report/v1") return "milestone-dossier";
  if (schema === "dogfood-utilization-audit/v1") return "dogfood-utilization-audit";
  return undefined;
}

function renderMarkdown(value) {
  const lines = [
    "# Dogfood Utilization Audit", "", `Status: ${value.status}`, `Generated: ${value.generatedAt}`, "",
    `Summary: ${value.summary.red} red, ${value.summary.yellow} yellow, ${value.summary.green} green, ${value.summary.total} total`,
    "", "## Red", ""
  ];
  pushItems(lines, value.orphanCandidates);
  lines.push("", "## Yellow", "");
  pushItems(lines, value.weakSignals);
  lines.push("", "## All Items", "");
  pushItems(lines, value.items);
  return `${lines.join("\n")}\n`;
}

function pushItems(lines, values) {
  if (values.length === 0) return void lines.push("- None");
  for (const item of values) {
    lines.push(`- ${item.status.toUpperCase()} ${item.kind}:${item.id} - ${item.reason}`);
    lines.push(`  - signals: ${JSON.stringify(item.signals)}`);
    if (item.evidence.length > 0) lines.push(`  - evidence: ${item.evidence.join(", ")}`);
  }
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

function outputPath(id, mediaType) {
  const writer = context.capabilities.writes["task-artifacts"]?.[0];
  const representation = writer?.artifacts?.[id]?.representations?.find((entry) => entry.mediaType === mediaType);
  if (!representation) throw new Error(`missing ${id} ${mediaType} writer`);
  return representation.path;
}

function writeResult(value) {
  writeFileSync(context.result.path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
