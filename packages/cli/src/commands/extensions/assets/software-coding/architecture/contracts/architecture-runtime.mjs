import {
  architectureSourceDigest,
  canonicalValue,
  digestJson,
  digestText
} from "./architecture-digests.mjs";
import {
  isArchitectureStableId,
  isPortablePhysicalPath
} from "./architecture-manifest.mjs";
import { compareArchitectureText, findPortableCollisions, portablePathKey } from "./architecture-portable-path.mjs";
import { architectureFindingsHaveUniqueIds } from "./architecture-report-contracts.mjs";
import { architectureSnapshotExtraFieldIssues } from "./architecture-snapshot-shape.mjs";
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

export { architectureSourceDigest, canonicalValue, digestJson, digestText };

export function buildArchitectureSnapshot(input) {
  const snapshot = {
    schema: "architecture-snapshot/v1",
    modelContract: "architecture-model/v1",
    manifest: {
      path: input.manifest.path,
      digest: input.manifest.digest
    },
    provenance: {
      commit: input.provenance.commit,
      sourceDigest: input.provenance.sourceDigest,
      modelDigest: input.provenance.modelDigest,
      tools: sortedRecords(input.provenance.tools, toolSortKey)
    },
    extractors: sortedRecords(input.extractors, (entry) => entry.id).map((entry) => ({
      ...entry,
      sourceScopeIds: [...(entry.sourceScopeIds ?? [])].sort(compareArchitectureText)
    })),
    mappings: sortedRecords(input.mappings, (entry) => `${entry.extractorId}\0${entry.path}`),
    nodeEdges: sortedRecords(input.nodeEdges, (entry) => `${entry.extractorId}\0${entry.sourceNodeId}\0${entry.targetNodeId}`).map((entry) => ({
      ...entry,
      evidence: sortedRecords(entry.evidence, evidenceSortKey)
    })),
    unmapped: sortedRecords(input.unmapped, (entry) => `${entry.extractorId}\0${entry.path}\0${entry.role}`).map((entry) => ({
      ...entry,
      evidence: sortedRecords(entry.evidence, evidenceSortKey)
    })),
    stats: input.stats
  };
  return canonicalValue(snapshot);
}

export function combineArchitectureObservations(observations, providerTools = [], comparisons = []) {
  const ordered = [...observations].sort((left, right) => compareArchitectureText(left.extractor.id, right.extractor.id));
  const mappings = ordered.flatMap((entry) => entry.mappings ?? []);
  const nodeEdges = ordered.flatMap((entry) => entry.nodeEdges ?? []);
  const unmapped = ordered.flatMap((entry) => entry.unmapped ?? []);
  const comparisonFindings = comparisons.flatMap((entry) => entry.findings ?? []);
  if (!architectureFindingsHaveUniqueIds(comparisonFindings)) {
    throw new Error("Architecture comparison finding IDs must be globally unique.");
  }
  const findings = sortedValues(comparisonFindings);
  const warnings = sortedValues(comparisons.flatMap((entry) => entry.warnings ?? []));
  return {
    sourceDigest: architectureSourceDigest(ordered.map((entry) => entry.extractor)),
    tools: sortedRecords([...providerTools, ...ordered.map((entry) => entry.tool)], toolSortKey),
    extractors: ordered.map((entry) => entry.extractor),
    mappings,
    nodeEdges,
    unmapped,
    findings,
    warnings,
    stats: {
      sourceFiles: sumObservationStats(ordered, "sourceFiles"),
      mappedFiles: countMappedPhysicalPaths(mappings),
      nodeEdges: nodeEdges.length,
      evidenceEdges: nodeEdges.reduce((total, edge) => total + (edge.evidence?.length ?? 0), 0),
      unmappedPaths: unmapped.length
    }
  };
}

export function validateArchitectureSnapshot(value) {
  if (!isRecord(value) || value.schema !== "architecture-snapshot/v1") {
    return { ok: false, issues: [{ code: "architecture_snapshot_invalid", path: "$", message: "Snapshot schema must be architecture-snapshot/v1." }] };
  }
  const issues = [];
  issues.push(...architectureSnapshotExtraFieldIssues(value));
  if (value.modelContract !== "architecture-model/v1") {
    issues.push(snapshotIssue("modelContract", "Snapshot modelContract must be architecture-model/v1."));
  }
  if (!isRecord(value.manifest) || !isPortablePhysicalPath(value.manifest.path) || !isDigest(value.manifest.digest)) {
    issues.push(snapshotIssue("manifest", "Snapshot manifest path and digest are invalid."));
  }
  const provenance = value.provenance;
  if (!isRecord(provenance) || !isDigest(provenance.sourceDigest) || !isDigest(provenance.modelDigest) || !Array.isArray(provenance.tools)) {
    issues.push(snapshotIssue("provenance", "Snapshot provenance digests and tools are required.", "architecture_snapshot_provenance_invalid"));
  } else {
    if (!validCommit(provenance.commit)) issues.push(snapshotIssue("provenance.commit", "Snapshot commit provenance is invalid."));
    for (const [index, tool] of provenance.tools.entries()) {
      if (!validTool(tool)) issues.push(snapshotIssue(`provenance.tools[${index}]`, "Snapshot tool records require stable role, declaration, adapter, tool, and version strings."));
    }
    if (!provenance.tools.some((tool) => tool?.role === "provider")) {
      issues.push(snapshotIssue("provenance.tools", "Snapshot provenance must include a provider tool."));
    }
    issues.push(...duplicateSnapshotKeyIssues(provenance.tools, toolSortKey, "provenance.tools"));
  }
  for (const key of ["extractors", "mappings", "nodeEdges", "unmapped"]) {
    if (!Array.isArray(value[key])) {
      issues.push(snapshotIssue(key, `${key} must be an array.`));
    }
  }
  for (const [index, extractor] of (Array.isArray(value.extractors) ? value.extractors : []).entries()) {
    if (!isRecord(extractor) || !isArchitectureStableId(extractor.id) || !nonEmptyString(extractor.adapter) || !isDigest(extractor.inputDigest) || !nonEmptyString(extractor.toolRef) || !Array.isArray(extractor.sourceScopeIds) || extractor.sourceScopeIds.length === 0 || extractor.sourceScopeIds.some((id) => !isArchitectureStableId(id)) || new Set(extractor.sourceScopeIds).size !== extractor.sourceScopeIds.length) {
      issues.push(snapshotIssue(`extractors[${index}]`, "Snapshot extractor records are invalid."));
    }
  }
  for (const [index, mapping] of (Array.isArray(value.mappings) ? value.mappings : []).entries()) {
    if (!isRecord(mapping) || !isArchitectureStableId(mapping.extractorId) || !isPortablePhysicalPath(mapping.path) || !isArchitectureStableId(mapping.sourceScopeId) || !isArchitectureStableId(mapping.nodeId)) {
      issues.push(snapshotIssue(`mappings[${index}]`, "Snapshot mappings require a portable repository path and stable IDs."));
    }
  }
  for (const [index, edge] of (Array.isArray(value.nodeEdges) ? value.nodeEdges : []).entries()) {
    if (!isRecord(edge) || !isArchitectureStableId(edge.extractorId) || edge.kind !== "dependency" || !isArchitectureStableId(edge.sourceNodeId) || !isArchitectureStableId(edge.targetNodeId) || !Array.isArray(edge.evidence)) {
      issues.push(snapshotIssue(`nodeEdges[${index}]`, "Snapshot node edges are invalid."));
      continue;
    }
    for (const [evidenceIndex, evidence] of edge.evidence.entries()) {
      if (!validEvidence(evidence)) issues.push(snapshotIssue(`nodeEdges[${index}].evidence[${evidenceIndex}]`, "Snapshot edge evidence paths are invalid."));
    }
  }
  for (const [index, unmapped] of (Array.isArray(value.unmapped) ? value.unmapped : []).entries()) {
    if (!isRecord(unmapped) || !isArchitectureStableId(unmapped.extractorId) || !isPortablePhysicalPath(unmapped.path) || !["source", "target"].includes(unmapped.role) || !nonEmptyString(unmapped.reason) || !Array.isArray(unmapped.evidence)) {
      issues.push(snapshotIssue(`unmapped[${index}]`, "Snapshot unmapped records are invalid."));
      continue;
    }
    for (const [evidenceIndex, evidence] of unmapped.evidence.entries()) {
      if (!validEvidence(evidence)) issues.push(snapshotIssue(`unmapped[${index}].evidence[${evidenceIndex}]`, "Snapshot unmapped evidence paths are invalid."));
    }
  }
  for (const collision of findPortableCollisions(snapshotPhysicalPaths(value))) issues.push(snapshotIssue(collision.paths.join(", "), "Snapshot physical paths collide after NFC normalization and case folding.", "architecture_snapshot_path_collision"));
  if (!isRecord(value.stats) || ["sourceFiles", "mappedFiles", "nodeEdges", "evidenceEdges", "unmappedPaths"].some((key) => !nonNegativeInteger(value.stats[key]))) {
    issues.push(snapshotIssue("stats", "Snapshot stats require non-negative integer counters."));
  } else {
    const snapshotNodeEdges = Array.isArray(value.nodeEdges) ? value.nodeEdges : [];
    const snapshotUnmapped = Array.isArray(value.unmapped) ? value.unmapped : [];
    const evidenceEdges = snapshotNodeEdges.reduce(
      (total, edge) => total + (Array.isArray(edge?.evidence) ? edge.evidence.length : 0),
      0
    );
    const mappedFiles = countMappedPhysicalPaths(Array.isArray(value.mappings) ? value.mappings : []);
    if (value.stats.mappedFiles !== mappedFiles || value.stats.nodeEdges !== snapshotNodeEdges.length || value.stats.evidenceEdges !== evidenceEdges || value.stats.unmappedPaths !== snapshotUnmapped.length || value.stats.mappedFiles > value.stats.sourceFiles) {
      issues.push(snapshotIssue("stats", "Snapshot stats must reconcile with mappings, node edges, evidence, and unmapped records."));
    }
  }
  const snapshotExtractors = Array.isArray(value.extractors) ? value.extractors : [];
  const snapshotMappings = Array.isArray(value.mappings) ? value.mappings : [];
  const snapshotTools = Array.isArray(provenance?.tools) ? provenance.tools : [];
  const extractorIds = new Set(snapshotExtractors.map((entry) => entry?.id));
  const extractorById = new Map(snapshotExtractors.map((entry) => [entry?.id, entry]));
  const toolByRef = new Map(snapshotTools.map((tool) => [`${tool?.role}:${tool?.declarationId}`, tool]));
  const mappingByExtractorAndPath = new Map(snapshotMappings.map((mapping) => [
    `${mapping?.extractorId}\0${mapping?.path}`,
    mapping
  ]));
  if (isRecord(provenance) &&
    isDigest(provenance.sourceDigest) &&
    snapshotExtractors.every((entry) => isRecord(entry) && isArchitectureStableId(entry.id) && isDigest(entry.inputDigest)) &&
    provenance.sourceDigest !== architectureSourceDigest(snapshotExtractors)) {
    issues.push(snapshotIssue(
      "provenance.sourceDigest",
      "Snapshot sourceDigest must equal the canonical aggregate of extractor input digests.",
      "architecture_snapshot_source_digest_mismatch"
    ));
  }
  issues.push(...duplicateSnapshotKeyIssues(value.extractors, (entry) => entry?.id, "extractors"));
  issues.push(...duplicateSnapshotKeyIssues(value.mappings, (entry) => `${entry?.extractorId}\0${entry?.path}`, "mappings"));
  issues.push(...duplicateSnapshotKeyIssues(value.nodeEdges, (entry) => `${entry?.extractorId}\0${entry?.sourceNodeId}\0${entry?.targetNodeId}`, "nodeEdges"));
  issues.push(...duplicateSnapshotKeyIssues(value.unmapped, (entry) => `${entry?.extractorId}\0${entry?.path}\0${entry?.role}`, "unmapped"));
  for (const [index, extractor] of snapshotExtractors.entries()) {
    const tool = toolByRef.get(extractor?.toolRef);
    if (!tool || tool.role !== "extractor" || tool.declarationId !== extractor?.id || tool.adapter !== extractor?.adapter) {
      issues.push(snapshotIssue(`extractors[${index}].toolRef`, "Snapshot extractor toolRef must resolve to its declared extractor tool."));
    }
  }
  for (const [index, mapping] of snapshotMappings.entries()) {
    const extractor = extractorById.get(mapping?.extractorId);
    if (extractor && (!Array.isArray(extractor.sourceScopeIds) || !extractor.sourceScopeIds.includes(mapping?.sourceScopeId))) {
      issues.push(snapshotIssue(`mappings[${index}].sourceScopeId`, "Snapshot mappings must use a source scope declared by their extractor."));
    }
  }
  for (const [index, edge] of (Array.isArray(value.nodeEdges) ? value.nodeEdges : []).entries()) {
    const extractorMappings = snapshotMappings.filter((mapping) => mapping?.extractorId === edge?.extractorId);
    if (!extractorMappings.some((mapping) => mapping?.nodeId === edge?.sourceNodeId)) {
      issues.push(snapshotIssue(`nodeEdges[${index}].sourceNodeId`, "Snapshot edge source node must be backed by a mapping for the same extractor."));
    }
    if (!extractorMappings.some((mapping) => mapping?.nodeId === edge?.targetNodeId)) {
      issues.push(snapshotIssue(`nodeEdges[${index}].targetNodeId`, "Snapshot edge target node must be backed by a mapping for the same extractor."));
    }
    for (const [evidenceIndex, evidence] of (Array.isArray(edge?.evidence) ? edge.evidence : []).entries()) {
      for (const [role, evidencePath, nodeId] of [["source", evidence?.sourcePath, edge?.sourceNodeId], ["target", evidence?.targetPath, edge?.targetNodeId]]) {
        const mapping = mappingByExtractorAndPath.get(`${edge?.extractorId}\0${evidencePath}`);
        if (!mapping) {
          issues.push(snapshotIssue(`nodeEdges[${index}].evidence[${evidenceIndex}].${role}Path`, "Snapshot edge evidence paths must resolve to mappings for the same extractor."));
        } else if (mapping.nodeId !== nodeId) {
          issues.push(snapshotIssue(`nodeEdges[${index}].evidence[${evidenceIndex}].${role}Path`, "Snapshot edge evidence mappings must match the edge endpoint nodes."));
        }
      }
    }
  }
  for (const [index, unmapped] of (Array.isArray(value.unmapped) ? value.unmapped : []).entries()) {
    for (const [evidenceIndex, evidence] of (Array.isArray(unmapped?.evidence) ? unmapped.evidence : []).entries()) {
      const unmappedEvidencePath = unmapped?.role === "source" ? evidence?.sourcePath : evidence?.targetPath;
      const mappedEvidencePath = unmapped?.role === "source" ? evidence?.targetPath : evidence?.sourcePath;
      if (unmappedEvidencePath !== unmapped?.path) {
        issues.push(snapshotIssue(`unmapped[${index}].evidence[${evidenceIndex}]`, "Snapshot unmapped evidence must identify the unmapped path in its declared role."));
      }
      if (!mappingByExtractorAndPath.has(`${unmapped?.extractorId}\0${mappedEvidencePath}`)) {
        issues.push(snapshotIssue(`unmapped[${index}].evidence[${evidenceIndex}]`, "Snapshot unmapped evidence must link to a mapped counterpart for the same extractor."));
      }
    }
  }
  for (const [collection, records] of [["mappings", value.mappings], ["nodeEdges", value.nodeEdges], ["unmapped", value.unmapped]]) {
    for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
      if (!extractorIds.has(record?.extractorId)) issues.push(snapshotIssue(`${collection}[${index}].extractorId`, "Snapshot records must reference a declared extractor."));
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

export function architectureSnapshotDigest(value) {
  return digestJson(value);
}

export function architectureSnapshotJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function sortedRecords(records, key) {
  return (Array.isArray(records) ? records : []).map(canonicalValue).sort((left, right) => compareArchitectureText(key(left), key(right)));
}

export function sortedValues(values) {
  return (Array.isArray(values) ? values : [])
    .map(canonicalValue)
    .sort((left, right) => compareArchitectureText(JSON.stringify(left), JSON.stringify(right)));
}

export { compareArchitectureText } from "./architecture-portable-path.mjs";

function toolSortKey(entry) {
  return `${entry?.role ?? ""}\0${entry?.declarationId ?? ""}\0${entry?.adapter ?? ""}`;
}

function evidenceSortKey(entry) {
  return `${entry?.mechanism ?? ""}\0${entry?.sourcePath ?? ""}\0${entry?.targetPath ?? ""}\0${entry?.specifier ?? ""}`;
}

function snapshotIssue(pathValue, message, code = "architecture_snapshot_invalid") {
  return { code, path: pathValue, message };
}

export function validCommit(value) {
  if (!isRecord(value) || !["verified", "unverified"].includes(value.verification)) return false;
  return value.verification === "verified"
    ? typeof value.sha === "string" && /^[0-9a-f]{40,64}$/u.test(value.sha)
    : value.sha === null || (typeof value.sha === "string" && /^[0-9a-f]{40,64}$/u.test(value.sha));
}

export function validTool(value) {
  return isRecord(value) &&
    ["provider", "extractor"].includes(value.role) &&
    isArchitectureStableId(value.declarationId) &&
    nonEmptyString(value.adapter) &&
    nonEmptyString(value.tool) &&
    nonEmptyString(value.version);
}

function validEvidence(value) {
  return isRecord(value) &&
    value.mechanism === "import" &&
    isPortablePhysicalPath(value.sourcePath) &&
    isPortablePhysicalPath(value.targetPath) &&
    nonEmptyString(value.specifier);
}

export { isPortablePhysicalPath as isPortableRepositoryPath } from "./architecture-manifest.mjs";

export function isDigest(value) {
  return typeof value === "string" && digestPattern.test(value);
}

function nonEmptyString(value) { return typeof value === "string" && value.length > 0; }

function nonNegativeInteger(value) { return Number.isInteger(value) && value >= 0; }

function duplicateSnapshotKeyIssues(records, keyOf, pathValue) {
  const seen = new Set();
  const issues = [];
  for (const [index, record] of (Array.isArray(records) ? records : []).entries()) {
    const key = keyOf(record);
    if (seen.has(key)) issues.push(snapshotIssue(`${pathValue}[${index}]`, `${pathValue} records must have unique stable identities.`));
    seen.add(key);
  }
  return issues;
}

function sumObservationStats(observations, key) {
  return observations.reduce((total, entry) => total + Number(entry.stats?.[key] ?? 0), 0);
}

function countMappedPhysicalPaths(mappings) {
  return new Set(mappings.flatMap((mapping) => typeof mapping?.path === "string" ? [portablePathKey(mapping.path)] : [])).size;
}

function snapshotPhysicalPaths(value) {
  const evidencePaths = (records) => (Array.isArray(records) ? records : []).flatMap((record) =>
    (Array.isArray(record?.evidence) ? record.evidence : []).flatMap((evidence) => [evidence?.sourcePath, evidence?.targetPath]));
  return [...(Array.isArray(value.mappings) ? value.mappings.map((entry) => entry?.path) : []),
    ...evidencePaths(value.nodeEdges), ...(Array.isArray(value.unmapped) ? value.unmapped.map((entry) => entry?.path) : []),
    ...evidencePaths(value.unmapped)].filter((entry) => typeof entry === "string");
}

function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
