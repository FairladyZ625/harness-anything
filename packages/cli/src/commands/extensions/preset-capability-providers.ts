import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  findTaskPackagePath,
  listTaskIndexPaths,
  queryDecisionProjection,
  readFrontmatter,
  readRelationGraphProjection,
  readScalar,
  readTaskProjection,
  resolveHarnessLayout,
  type HarnessLayoutInput,
  type HarnessLayoutOverrides,
  type PresetCapabilityRequirement
} from "../../../../kernel/src/index.ts";
import { normalizeSlashes, relativePath } from "../../cli/path.ts";
import { repositorySourceProjection } from "./repository-source-capability.ts";
import { isPathInside } from "./script-scope.ts";

export interface ScopeCandidate {
  readonly root: string;
  readonly recursive: boolean;
}

export function materializeRequirement(options: {
  readonly request: PresetCapabilityRequirement;
  readonly index: number;
  readonly executionRootInput: HarnessLayoutInput;
  readonly realRootInput: HarnessLayoutInput;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly currentTaskId: string;
  readonly capabilitiesRoot: string;
}): { readonly ok: true; readonly value: { readonly path: string; readonly extraReadPermissions: ReadonlyArray<string> } } | { readonly ok: false; readonly hint: string } {
  const filename = `${String(options.index).padStart(2, "0")}-${options.request.capability}.json`;
  const projectionPath = path.join(options.capabilitiesRoot, filename);
  let value: unknown;
  let extraReadPermissions: ReadonlyArray<string> = [];
  try {
    switch (options.request.capability) {
      case "tasks":
        value = taskProjection(options.executionRootInput, options.request, options.inputs);
        break;
      case "decisions":
        value = decisionProjection(options.executionRootInput, options.request, options.inputs);
        break;
      case "adrs":
        value = adrProjection(options.executionRootInput, options.request.select.states);
        break;
      case "operating-docs":
        value = operatingDocsProjection(options.executionRootInput, options.request.select.collections);
        break;
      case "task-artifacts": {
        const projection = taskArtifactsProjection(
          options.executionRootInput,
          options.request,
          options.inputs,
          options.currentTaskId,
          path.join(options.capabilitiesRoot, `${String(options.index).padStart(2, "0")}-task-artifacts`)
        );
        value = projection.value;
        extraReadPermissions = projection.readPermissions;
        break;
      }
      case "relation-graph":
        value = relationGraphProjection(options.executionRootInput, options.request, options.inputs);
        break;
      case "runtime-events":
        // CanonicalScriptStage mirrors authoredRoot only. Operational ledgers are
        // copied once from their protected real scope into this immutable run snapshot.
        value = runtimeEventsProjection(options.realRootInput, options.inputs);
        break;
      case "generated-artifacts":
        value = generatedArtifactsProjection(options.realRootInput, options.request.select.familiesFrom, options.inputs);
        break;
      case "write-journal":
        value = presenceInventory(resolveHarnessLayout(options.realRootInput).writeJournalRoot, options.realRootInput, "write-journal-inventory/v1");
        break;
      case "docmap":
        value = filePresence(path.join(resolveHarnessLayout(options.executionRootInput).authoredRoot, "docmap.json"), options.executionRootInput);
        break;
      case "repository-source": {
        const projection = repositorySourceProjection(
          options.realRootInput,
          options.request.select.collections,
          path.join(options.capabilitiesRoot, `${String(options.index).padStart(2, "0")}-repository-source`)
        );
        value = projection.value;
        extraReadPermissions = projection.readPermissions;
        break;
      }
      default:
        return providerUnavailable(`No semantic materializer is registered for ${options.request.capability}@${options.request.version}.`);
    }
  } catch (error) {
    return providerUnavailable(`Capability ${options.request.capability}@${options.request.version} projection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (projectionIsEmpty(options.request.capability, value)) {
    return providerUnavailable(`Capability ${options.request.capability}@${options.request.version} resolved to an empty projection; raw-fs fallback is forbidden.`);
  }
  writeFileSync(projectionPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { ok: true, value: { path: projectionPath, extraReadPermissions } };
}

function taskProjection(
  rootInput: HarnessLayoutInput,
  request: Extract<PresetCapabilityRequirement, { readonly capability: "tasks" }>,
  inputs: Readonly<Record<string, unknown>>
): unknown {
  const rows = readTaskProjection(taskProjectionOptions(rootInput)).rows;
  let selected = rows;
  if ("taskFrom" in request.select) {
    const taskFrom = request.select.taskFrom;
    selected = rows.filter((row) => row.taskId === inputs[taskFrom]);
  }
  return {
    schema: "typed-task-projection/v1",
    view: request.select.view,
    tasks: selected.map((row) => ({
      taskId: row.taskId,
      title: row.title,
      preset: row.preset ?? null,
      sourcePath: row.sourcePath,
      ...(request.select.view === "intent-summary" ? {
        status: row.canonicalStatus,
        parentTaskId: row.parentTaskId ?? null
      } : {})
    }))
  };
}

function decisionProjection(
  rootInput: HarnessLayoutInput,
  request: Extract<PresetCapabilityRequirement, { readonly capability: "decisions" }>,
  inputs: Readonly<Record<string, unknown>>
): unknown {
  const rows = queryDecisionProjection({ ...taskProjectionOptions(rootInput), filters: {} }).rows;
  if ("states" in request.select) {
    const states = request.select.states;
    return {
      schema: "typed-decision-projection/v1",
      view: request.select.view,
      decisions: rows.filter((row) => states.includes(row.state as "active")).map(canonDecision)
    };
  }
  const taskId = String(inputs[request.select.relatedToTaskFrom] ?? "");
  const layout = resolveHarnessLayout(rootInput);
  return {
    schema: "typed-decision-projection/v1",
    view: request.select.view,
    decisions: rows.filter((row) => {
      const filename = path.resolve(layout.rootDir, row.path);
      return isPathInside(layout.decisionsRoot, filename) && existsSync(filename) && readFileSync(filename, "utf8").includes(taskId);
    }).map((row) => ({
      decisionId: row.decisionId,
      ref: `decision/${row.decisionId}`,
      title: row.title,
      sourcePath: row.path,
      question: row.question
    }))
  };
}

function canonDecision(row: ReturnType<typeof queryDecisionProjection>["rows"][number]): Record<string, unknown> {
  return {
    kind: "decision",
    canonicalId: row.decisionId,
    title: row.title,
    state: row.state,
    date: row.decidedAt ?? row.proposedAt ?? "",
    sourcePath: row.path
  };
}

function adrProjection(rootInput: HarnessLayoutInput, states: ReadonlyArray<string>): unknown {
  const layout = resolveHarnessLayout(rootInput);
  const seen = new Set<string>();
  const adrs = walkCapabilityFiles(layout.adrRoot).filter((filename) => filename.endsWith(".md")).flatMap((filename) => {
    const body = readFileSync(filename, "utf8");
    const frontmatter = readFrontmatter(body) ?? "";
    const statusSection = /^##\s+Status\s*\r?\n+([\s\S]*?)(?:\r?\n##\s+|\s*$)/imu.exec(body)?.[1] ?? "";
    const statusLine = statusSection.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "";
    const statusMatch = /^(Accepted|Active|Approved|Proposed|Deprecated|Superseded|Rejected)\b(?:\s+(\d{4}-\d{2}-\d{2}))?/iu.exec(statusLine);
    const status = frontmatterScalar(frontmatter, "status") || statusMatch?.[1]?.toLowerCase() || "unknown";
    const canonicalId = frontmatterScalar(frontmatter, "id") || /(?:^|\/)(ADR-\d{4,})/u.exec(normalizeSlashes(filename))?.[1] || "";
    if (!canonicalId || !states.includes(status) || seen.has(canonicalId)) return [];
    seen.add(canonicalId);
    return [{
      kind: "adr",
      canonicalId,
      title: frontmatterScalar(frontmatter, "title") || /^#\s+(.+)$/mu.exec(body)?.[1]?.trim() || canonicalId,
      status,
      date: frontmatterScalar(frontmatter, "date") || statusMatch?.[2] || "",
      sourcePath: relativePath(layout.rootDir, filename)
    }];
  });
  return { schema: "typed-adr-projection/v1", view: "canon-summary", adrs: adrs.sort(compareCanonical) };
}

function operatingDocsProjection(rootInput: HarnessLayoutInput, collections: ReadonlyArray<string>): unknown {
  const layout = resolveHarnessLayout(rootInput);
  const roots = collections.flatMap((collection) => {
    if (collection === "agents-guide") return [path.join(layout.authoredRoot, "AGENTS.md")];
    if (collection === "governance") return [path.join(layout.authoredRoot, "governance")];
    if (collection === "standards") return [path.join(layout.authoredRoot, "standards")];
    return [];
  });
  const documents = roots.flatMap(walkCapabilityFiles)
    .filter((filename) => /\.(?:md|mdx|txt|ya?ml|json)$/iu.test(filename))
    .map((filename) => ({ relativePath: relativePath(layout.rootDir, filename), body: readFileSync(filename, "utf8") }));
  return { schema: "named-operating-docs/v1", view: "text", documents };
}

function taskArtifactsProjection(
  rootInput: HarnessLayoutInput,
  request: Extract<PresetCapabilityRequirement, { readonly capability: "task-artifacts" }>,
  inputs: Readonly<Record<string, unknown>>,
  currentTaskId: string,
  snapshotRoot: string
): { readonly value: unknown; readonly readPermissions: ReadonlyArray<string> } {
  const layout = resolveHarnessLayout(rootInput);
  const taskIds = "scope" in request.select
    ? listTaskIndexPaths(rootInput).map((indexPath) => taskIdFromIndex(indexPath)).filter(Boolean)
    : [String(inputs[request.select.taskFrom] ?? (request.select.taskFrom === "current-task" ? currentTaskId : ""))];
  const artifacts: Array<Record<string, unknown>> = [];
  const readPermissions: string[] = [];
  for (const taskId of taskIds) {
    const packageRoot = findTaskPackagePath(rootInput, taskId);
    if (!packageRoot) continue;
    const artifactsRoot = path.join(packageRoot, "artifacts");
    for (const artifactId of request.select.artifactIds) {
      for (const source of artifactFiles(artifactsRoot, artifactId)) {
        const target = path.join(snapshotRoot, safeSegment(taskId), path.basename(source));
        copyCapabilityFile(source, target);
        readPermissions.push(target);
        artifacts.push({
          id: artifactId,
          taskId,
          mediaType: mediaTypeForPath(source),
          sourcePath: relativePath(layout.rootDir, source),
          path: target
        });
      }
    }
  }
  return {
    value: { schema: "logical-task-artifacts/v1", view: "immutable-handles", artifacts },
    readPermissions
  };
}

function relationGraphProjection(
  rootInput: HarnessLayoutInput,
  request: Extract<PresetCapabilityRequirement, { readonly capability: "relation-graph" }>,
  inputs: Readonly<Record<string, unknown>>
): unknown {
  const graph = readRelationGraphProjection(taskProjectionOptions(rootInput));
  const tasks = readTaskProjection(taskProjectionOptions(rootInput)).rows;
  const decisions = queryDecisionProjection({ ...taskProjectionOptions(rootInput), filters: {} }).rows;
  const decisionId = typeof inputs[request.select.decisionFrom] === "string" && inputs[request.select.decisionFrom]
    ? String(inputs[request.select.decisionFrom])
    : undefined;
  const focusDecisionRef = decisionId ? `decision/${decisionId}` : undefined;
  const coverageRows = focusDecisionRef
    ? graph.coverageRows.filter((row) => row.decisionRef === focusDecisionRef)
    : graph.coverageRows;
  const selectedDecisionRefs = new Set(coverageRows.map((row) => row.decisionRef));
  if (focusDecisionRef) selectedDecisionRefs.add(focusDecisionRef);
  const relationIds = new Set(coverageRows.flatMap((row) => row.relationPath));
  const relationEdges = graph.edges.filter((edge) => relationIds.has(edge.relationId) ||
    selectedDecisionRefs.has(baseDecisionRef(edge.sourceRef)) || selectedDecisionRefs.has(baseDecisionRef(edge.targetRef)));
  const selectedRefs = new Set<string>();
  for (const row of coverageRows) {
    selectedRefs.add(row.decisionRef);
    selectedRefs.add(row.claimRef);
    if (row.coveringFactRef) selectedRefs.add(row.coveringFactRef);
  }
  for (const edge of relationEdges) {
    selectedRefs.add(edge.sourceRef);
    selectedRefs.add(edge.targetRef);
    selectedRefs.add(edge.ownerRef);
  }
  return {
    schema: "typed-relation-graph-view/v1",
    view: "dossier",
    decisionId: decisionId ?? null,
    tasks: tasks.filter((task) => selectedRefs.has(`task/${task.taskId}`)).map((task) => ({
      taskId: task.taskId,
      title: task.title,
      canonicalStatus: task.canonicalStatus,
      coordinationStatus: task.coordinationStatus,
      sourcePath: task.sourcePath,
      vertical: task.vertical ?? null,
      preset: task.preset ?? null,
      profile: task.profile ?? null
    })),
    decisions: decisions.filter((decision) => selectedDecisionRefs.has(`decision/${decision.decisionId}`)).map((decision) => ({
      decisionId: decision.decisionId,
      title: decision.title,
      state: decision.state,
      question: decision.question,
      path: decision.path,
      chosen: decision.chosen,
      rejected: decision.rejected,
      decidedAt: decision.decidedAt ?? null
    })),
    facts: graph.factAnchors.filter((fact) => selectedRefs.has(fact.factRef)),
    relationEdges,
    coverageRows,
    provenanceRefs: [...selectedRefs].sort()
  };
}

function runtimeEventsProjection(rootInput: HarnessLayoutInput, inputs: Readonly<Record<string, unknown>>): unknown {
  const layout = resolveHarnessLayout(rootInput);
  const files = walkCapabilityFiles(layout.runtimeEventLedgerRoot).filter((filename) => filename.endsWith(".jsonl"));
  const trackedPresets = stringList(inputs.trackedPresets);
  const commandCounts: Record<string, number> = {};
  const mentions = Object.fromEntries(trackedPresets.map((presetId) => [presetId, { count: 0, evidence: [] as string[] }]));
  let rows = 0;
  for (const filename of files) {
    for (const line of readFileSync(filename, "utf8").split(/\r?\n/u).filter(Boolean)) {
      rows += 1;
      let text = line;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        text = JSON.stringify(parsed);
        const result = isCapabilityRecord(parsed.result) ? parsed.result : undefined;
        const summary = typeof result?.summary === "string" ? result.summary : "";
        const command = /CLI command succeeded: ([A-Za-z0-9_-]+)/u.exec(summary)?.[1];
        if (command) commandCounts[command] = (commandCounts[command] ?? 0) + 1;
      } catch {
        // A malformed historical event remains countable but grants no structured command signal.
      }
      for (const presetId of trackedPresets) {
        if (!text.includes(presetId)) continue;
        const entry = mentions[presetId]!;
        entry.count += 1;
        if (entry.evidence.length < 5) entry.evidence.push(relativePath(layout.rootDir, filename));
      }
    }
  }
  return { schema: "runtime-command-usage/v1", files: files.length, rows, commandCounts, presetMentions: mentions };
}

function generatedArtifactsProjection(
  rootInput: HarnessLayoutInput,
  familiesFrom: string,
  inputs: Readonly<Record<string, unknown>>
): unknown {
  const layout = resolveHarnessLayout(rootInput);
  const known: Record<string, string> = {
    "runtime-events": "runtime-events",
    "distill-candidates": "distill",
    "lesson-promotions": "lessons",
    "graph-panorama": "graph-panorama"
  };
  const entries = stringList(inputs[familiesFrom]).flatMap((id) => {
    const relative = known[id];
    if (!relative) return [];
    const root = path.join(layout.generatedRoot, relative);
    const files = walkCapabilityFiles(root);
    const jsonl = files.filter((filename) => filename.endsWith(".jsonl"));
    const rows = jsonl.reduce((sum, filename) => sum + readFileSync(filename, "utf8").split(/\r?\n/u).filter(Boolean).length, 0);
    return [{
      id,
      present: files.length > 0,
      files: files.length,
      ...(id === "runtime-events" ? { rows } : {}),
      evidence: files.slice(0, 5).map((filename) => relativePath(layout.rootDir, filename))
    }];
  });
  return { schema: "generated-artifact-inventory/v1", entries };
}

function presenceInventory(root: string, rootInput: HarnessLayoutInput, schema: string): unknown {
  const layout = resolveHarnessLayout(rootInput);
  const files = walkCapabilityFiles(root);
  return {
    schema,
    present: files.length > 0,
    files: files.length,
    evidence: files.slice(0, 5).map((filename) => relativePath(layout.rootDir, filename))
  };
}

function filePresence(filename: string, rootInput: HarnessLayoutInput): unknown {
  const layout = resolveHarnessLayout(rootInput);
  const present = existsSync(filename) && statSync(filename).isFile();
  return {
    schema: "docmap-presence/v1",
    present,
    files: present ? 1 : 0,
    evidence: present ? [relativePath(layout.rootDir, filename)] : []
  };
}

export function sourceScopesForRequirement(
  layout: ReturnType<typeof resolveHarnessLayout>,
  request: PresetCapabilityRequirement,
  inputs: Readonly<Record<string, unknown>>,
  currentTaskId: string,
  dryRun: boolean
): { readonly ok: true; readonly value: ReadonlyArray<ScopeCandidate> } | { readonly ok: false; readonly hint: string } {
  switch (request.capability) {
    case "tasks":
      return { ok: true, value: [{ root: layout.tasksRoot, recursive: true }] };
    case "decisions":
      return { ok: true, value: [{ root: layout.decisionsRoot, recursive: true }] };
    case "adrs":
      return { ok: true, value: [{ root: layout.adrRoot, recursive: true }] };
    case "operating-docs":
      return { ok: true, value: request.select.collections.flatMap<ScopeCandidate>((collection) => {
        if (collection === "agents-guide") {
          const filename = path.join(layout.authoredRoot, "AGENTS.md");
          return existsSync(filename) ? [{ root: filename, recursive: false }] : [];
        }
        return [{ root: path.join(layout.authoredRoot, collection), recursive: true }];
      }) };
    case "task-artifacts": {
      if ("scope" in request.select) return { ok: true, value: [{ root: layout.tasksRoot, recursive: true }] };
      const taskId = request.select.taskFrom === "current-task"
        ? currentTaskId
        : String(inputs[request.select.taskFrom] ?? "");
      const packageRoot = findTaskPackagePath(layout.rootDir, taskId);
      return packageRoot
        ? { ok: true, value: [{ root: path.join(packageRoot, "artifacts"), recursive: true }] }
        : dryRun
          ? { ok: true, value: [{ root: path.join(layout.tasksRoot, safeSegment(taskId), "artifacts"), recursive: true }] }
        : providerUnavailable(`task-artifacts/v1 selector could not resolve task input ${request.select.taskFrom}.`);
    }
    case "relation-graph":
      return { ok: true, value: [
        { root: layout.tasksRoot, recursive: true },
        { root: layout.decisionsRoot, recursive: true }
      ] };
    case "runtime-events":
      return { ok: true, value: [{ root: layout.runtimeEventLedgerRoot, recursive: true }] };
    case "generated-artifacts": {
      const known: Record<string, string> = {
        "runtime-events": "runtime-events",
        "distill-candidates": "distill",
        "lesson-promotions": "lessons",
        "graph-panorama": "graph-panorama"
      };
      return { ok: true, value: stringList(inputs[request.select.familiesFrom]).flatMap((id) => (
        known[id] ? [{ root: path.join(layout.generatedRoot, known[id]), recursive: true }] : []
      )) };
    }
    case "write-journal":
      return { ok: true, value: [{ root: layout.writeJournalRoot, recursive: true }] };
    case "docmap": {
      const filename = path.join(layout.authoredRoot, "docmap.json");
      return { ok: true, value: existsSync(filename) ? [{ root: filename, recursive: false }] : [] };
    }
    case "repository-source":
      return { ok: true, value: request.select.collections.flatMap<ScopeCandidate>((collection) => {
        if (collection === "project-config") return [
          { root: path.join(layout.rootDir, "package.json"), recursive: false },
          { root: path.join(layout.rootDir, "eslint.config.mjs"), recursive: false },
          { root: path.join(layout.rootDir, ".github"), recursive: true }
        ];
        if (collection === "gate-tooling") return [{ root: path.join(layout.rootDir, "tools"), recursive: true }];
        return [{ root: path.join(layout.rootDir, "packages"), recursive: true }];
      }) };
    default:
      return providerUnavailable(`No semantic source mapping is registered for ${request.capability}@${request.version}.`);
  }
}

function projectionIsEmpty(capability: string, value: unknown): boolean {
  if (!isCapabilityRecord(value)) return true;
  if (capability === "tasks") return !Array.isArray(value.tasks) || value.tasks.length === 0;
  if (capability === "decisions") return !Array.isArray(value.decisions) || value.decisions.length === 0;
  if (capability === "adrs") return !Array.isArray(value.adrs) || value.adrs.length === 0;
  if (capability === "operating-docs") return !Array.isArray(value.documents) || value.documents.length === 0;
  if (capability === "task-artifacts") return false;
  if (capability === "relation-graph") {
    return [value.tasks, value.decisions, value.facts, value.relationEdges, value.coverageRows]
      .every((entry) => !Array.isArray(entry) || entry.length === 0);
  }
  if (capability === "runtime-events") return typeof value.rows !== "number" || value.rows === 0;
  if (capability === "generated-artifacts") return !Array.isArray(value.entries) || value.entries.length === 0;
  if (capability === "repository-source") return !Array.isArray(value.files) || value.files.length === 0;
  return false;
}

function taskProjectionOptions(rootInput: HarnessLayoutInput): { readonly rootDir: string; readonly layoutOverrides?: HarnessLayoutOverrides } {
  const layout = resolveHarnessLayout(rootInput);
  return {
    rootDir: layout.rootDir,
    ...(typeof rootInput === "string" || !rootInput.layoutOverrides ? {} : { layoutOverrides: rootInput.layoutOverrides })
  };
}

function artifactFiles(root: string, artifactId: string): ReadonlyArray<string> {
  if (!existsSync(root)) return [];
  const basenamePrefix = artifactId === "gate-retro-snapshot" ? "gate-retro.snapshot" : artifactId;
  return walkCapabilityFiles(root).filter((filename) => {
    const basename = path.basename(filename);
    return basename === basenamePrefix || basename.startsWith(`${basenamePrefix}.`) || basename.startsWith(`${basenamePrefix}-`);
  });
}

function copyCapabilityFile(source: string, target: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target);
}

function taskIdFromIndex(indexPath: string): string {
  const frontmatter = readFrontmatter(readFileSync(indexPath, "utf8")) ?? "";
  return frontmatterScalar(frontmatter, "task_id") || path.basename(path.dirname(indexPath));
}

function frontmatterScalar(frontmatter: string, key: string): string {
  return readScalar(frontmatter, key).trim().replace(/^["']|["']$/gu, "");
}

function walkCapabilityFiles(root: string): ReadonlyArray<string> {
  if (!root || !existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) return [];
    const candidate = path.join(root, entry.name);
    return entry.isDirectory() ? walkCapabilityFiles(candidate) : entry.isFile() ? [candidate] : [];
  }).sort();
}

function mediaTypeForPath(filename: string): string {
  if (filename.endsWith(".json")) return "application/json";
  if (filename.endsWith(".md")) return "text/markdown";
  return "application/octet-stream";
}

function compareCanonical(left: { readonly date: string; readonly canonicalId: string }, right: { readonly date: string; readonly canonicalId: string }): number {
  const byDate = (Date.parse(right.date) || 0) - (Date.parse(left.date) || 0);
  return byDate !== 0 ? byDate : left.canonicalId.localeCompare(right.canonicalId);
}

function baseDecisionRef(ref: string): string {
  return /^decision\/[A-Za-z0-9_-]+/u.exec(ref)?.[0] ?? "";
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/gu, "_");
}

function stringList(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return [];
}

function isCapabilityRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerUnavailable(hint: string): { readonly ok: false; readonly hint: string } {
  return { ok: false, hint };
}
