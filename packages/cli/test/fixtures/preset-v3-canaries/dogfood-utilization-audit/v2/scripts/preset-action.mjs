#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const contextPath = process.env.HARNESS_PRESET_CONTEXT;
if (!contextPath) throw new Error("HARNESS_PRESET_CONTEXT is required");
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const artifactsDir = path.join(context.outputRoot, "artifacts");
mkdirSync(artifactsDir, { recursive: true });

const trackedPresets = splitCsv(context.inputs.trackedPresets);
const trackedArtifacts = splitCsv(context.inputs.trackedArtifacts);
const taskPackages = readTaskPackages();
const runtimeEvents = readRuntimeEvents(path.join(context.paths.generatedRoot, "runtime-events"));
const presetEvidence = readPresetEvidence(context.paths.tasksRoot);
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
  taskId: context.taskId,
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

writeFileSync(path.join(artifactsDir, "dogfood-utilization-audit.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
writeFileSync(path.join(artifactsDir, "dogfood-utilization-audit.md"), renderMarkdown(report), "utf8");
writeFileSync(path.join(artifactsDir, "preset-result.json"), `${JSON.stringify({
  ok: summary.red === 0,
  rows: items.length,
  report,
  error: summary.red === 0 ? undefined : {
    code: "preset_script_result_failed",
    hint: "Dogfood utilization audit found features with no usage signal."
  }
}, null, 2)}\n`, "utf8");

function evaluatePreset(presetId) {
  const taskUses = taskPackages.filter((task) => task.preset === presetId);
  const evidenceUses = presetEvidence.filter((artifact) => artifact.presetId === presetId);
  const eventMentions = runtimeEvents.events.filter((event) => event.text.includes(presetId));
  const genericPresetActions = runtimeEvents.commandCounts["preset-action"] ?? 0;
  const signals = {
    taskUses: taskUses.length,
    presetEvidenceArtifacts: evidenceUses.length,
    runtimeEventMentions: eventMentions.length
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
      ...eventMentions.slice(0, 5).map((event) => event.sourcePath)
    ],
    reason: status === "green"
      ? "specific_usage_signal_found"
      : genericPresetActions > 0
        ? "no_specific_usage_signal_found_despite_generic_preset_events"
        : "no_usage_signal_found"
  };
}

function evaluateArtifact(id) {
  const artifact = artifactDefinition(id);
  const stat = artifactStats(artifact.path, artifact.mode);
  const status = stat.count > 0 ? "green" : "red";
  return {
    id,
    kind: "artifact",
    status,
    signals: stat.signals,
    evidence: stat.evidence,
    reason: status === "green" ? "artifact_usage_signal_found" : "no_artifact_usage_signal_found"
  };
}

function artifactDefinition(id) {
  const generated = context.paths.generatedRoot;
  if (id === "runtime-events") return { path: path.join(generated, "runtime-events"), mode: "jsonl-lines" };
  if (id === "distill-candidates") return { path: path.join(generated, "distill"), mode: "files" };
  if (id === "lesson-promotions") return { path: path.join(generated, "lessons"), mode: "files" };
  if (id === "graph-panorama") return { path: path.join(generated, "graph-panorama"), mode: "files" };
  if (id === "write-journal") return { path: path.join(context.paths.localRoot, "write-journal"), mode: "files" };
  if (id === "docmap") return { path: path.join(context.paths.authoredRoot, "docmap.json"), mode: "file" };
  return { path: path.join(generated, id), mode: "files" };
}

function artifactStats(targetPath, mode) {
  if (mode === "file") {
    const exists = existsSync(targetPath) && statSync(targetPath).isFile();
    return {
      count: exists ? 1 : 0,
      signals: { files: exists ? 1 : 0 },
      evidence: exists ? [relative(targetPath)] : []
    };
  }
  const files = walkFiles(targetPath);
  if (mode === "jsonl-lines") {
    const jsonl = files.filter((filePath) => filePath.endsWith(".jsonl"));
    const rows = jsonl.reduce((sum, filePath) => sum + readLines(filePath).filter(Boolean).length, 0);
    return {
      count: rows,
      signals: { files: jsonl.length, rows },
      evidence: jsonl.slice(0, 5).map(relative)
    };
  }
  return {
    count: files.length,
    signals: { files: files.length },
    evidence: files.slice(0, 5).map(relative)
  };
}

function readTaskPackages() {
  if (!Array.isArray(context.taskIndex)) return [];
  return context.taskIndex.map((task) => ({
    taskId: task.taskId,
    preset: task.preset ?? "",
    sourcePath: task.indexPath ?? task.packagePath ?? ""
  }));
}

function readRuntimeEvents(eventsRoot) {
  const files = walkFiles(eventsRoot).filter((filePath) => filePath.endsWith(".jsonl"));
  const events = [];
  const commandCounts = {};
  for (const filePath of files) {
    for (const line of readLines(filePath).filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        const text = JSON.stringify(parsed);
        const summary = parsed?.result?.summary;
        const command = typeof summary === "string" ? /CLI command succeeded: ([A-Za-z0-9_-]+)/u.exec(summary)?.[1] : undefined;
        if (command) commandCounts[command] = (commandCounts[command] ?? 0) + 1;
        events.push({ sourcePath: relative(filePath), text, command });
      } catch {
        events.push({ sourcePath: relative(filePath), text: line, command: undefined });
      }
    }
  }
  return { files: files.length, rows: events.length, events, commandCounts };
}

function readPresetEvidence(tasksRoot) {
  const result = [];
  for (const filePath of walkFiles(tasksRoot)) {
    if (!/(?:^|\/)artifacts\/(?:preset-result|evidence)\.json$/u.test(toSlash(filePath))) continue;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      const presetId = inferPresetId(parsed);
      if (presetId) result.push({ presetId, sourcePath: relative(filePath) });
    } catch {
      // Ignore malformed historical artifacts; this audit only counts positive usage signals.
    }
  }
  return result;
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

function renderMarkdown(report) {
  const lines = [
    "# Dogfood Utilization Audit",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    "",
    `Summary: ${report.summary.red} red, ${report.summary.yellow} yellow, ${report.summary.green} green, ${report.summary.total} total`,
    "",
    "## Red",
    ""
  ];
  pushItems(lines, report.orphanCandidates);
  lines.push("", "## Yellow", "");
  pushItems(lines, report.weakSignals);
  lines.push("", "## All Items", "");
  pushItems(lines, report.items);
  return `${lines.join("\n")}\n`;
}

function pushItems(lines, items) {
  if (items.length === 0) {
    lines.push("- None");
    return;
  }
  for (const item of items) {
    lines.push(`- ${item.status.toUpperCase()} ${item.kind}:${item.id} - ${item.reason}`);
    lines.push(`  - signals: ${JSON.stringify(item.signals)}`);
    if (item.evidence.length > 0) lines.push(`  - evidence: ${item.evidence.join(", ")}`);
  }
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

function readLines(filePath) {
  return readFileSync(filePath, "utf8").split(/\r?\n/u);
}

function splitCsv(value) {
  return String(value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

function relative(filePath) {
  return toSlash(path.relative(context.paths.rootDir, filePath));
}

function toSlash(value) {
  return value.split(path.sep).join("/");
}
